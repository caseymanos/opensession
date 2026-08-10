import type { Page } from "@playwright/test";

import {
  scheduleCommandSchema,
  scheduleSnapshotSchema,
} from "../../packages/contracts/src/index";
import { evaluateScheduleConflicts } from "../../packages/domain/src/index";
import { agendaScheduleSnapshotFixture } from "../../apps/web/src/agenda/agendaModel";

export async function mockAgendaApi(page: Page) {
  let snapshot = structuredClone(agendaScheduleSnapshotFixture);
  await page.context().addCookies([
    {
      httpOnly: false,
      name: "__Host-opensession-csrf",
      sameSite: "Lax",
      secure: true,
      url: "https://127.0.0.1:8787",
      value: "agenda-e2e-csrf-token-that-is-at-least-forty-characters",
    },
  ]);

  await page.route("**/api/events/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const eventKey = decodeURIComponent(path.split("/")[3] ?? "");
    if (
      eventKey !== snapshot.event.slug &&
      eventKey !== snapshot.event.eventId
    ) {
      await route.fulfill({
        json: {
          error: {
            code: "schedule_not_found",
            message: "The requested event schedule does not exist.",
          },
          request_id: "agenda_e2e_missing",
        },
        status: 404,
      });
      return;
    }

    if (request.method() === "GET" && path.endsWith("/schedule")) {
      await route.fulfill({
        json: scheduleSnapshotSchema.parse(snapshot),
        status: 200,
      });
      return;
    }

    if (request.method() !== "POST" || !path.endsWith("/schedule/commands")) {
      await route.fulfill({ status: 405 });
      return;
    }

    const command = scheduleCommandSchema.parse(request.postDataJSON());
    if (command.eventId !== snapshot.event.eventId) {
      await route.fulfill({
        json: {
          error: {
            code: "schedule_validation_error",
            field: "eventId",
            message: "Use the canonical event ID returned by the snapshot.",
            reason: "invalid_command",
          },
          ok: false,
        },
        status: 422,
      });
      return;
    }
    if (command.expectedVersion !== snapshot.event.version) {
      await route.fulfill({
        json: {
          error: {
            actualVersion: snapshot.event.version,
            code: "schedule_version_conflict",
            expectedVersion: command.expectedVersion,
            message: "The schedule changed before this command was saved.",
          },
          ok: false,
        },
        status: 409,
      });
      return;
    }

    const nextVersion = snapshot.event.version + 1;
    const changedSessionIds: string[] = [];
    if (
      command.type === "place_session" ||
      command.type === "reschedule_session"
    ) {
      snapshot = scheduleSnapshotSchema.parse({
        ...snapshot,
        event: { ...snapshot.event, version: nextVersion },
        sessions: snapshot.sessions.map((session) => {
          if (session.id !== command.sessionId) return session;
          changedSessionIds.push(session.id);
          return {
            ...session,
            durationMinutes: command.durationMinutes,
            slot: {
              endAt: new Date(
                Date.parse(command.startAt) + command.durationMinutes * 60_000,
              ).toISOString(),
              publicationVersion: 0,
              roomId: command.roomId,
              startAt: command.startAt,
              version: nextVersion,
            },
            state: "scheduled",
          };
        }),
      });
    } else {
      await route.fulfill({ status: 501 });
      return;
    }

    await route.fulfill({
      json: {
        ok: true,
        result: {
          analysis: evaluateScheduleConflicts(snapshot),
          changedSessionIds,
          commandId: command.commandId,
          replayed: false,
          snapshot,
        },
      },
      status: 200,
    });
  });
}
