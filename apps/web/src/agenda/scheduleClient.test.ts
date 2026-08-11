import { describe, expect, it, vi } from "vitest";

import { scheduleSnapshotFixture } from "@sessionbox-killer/contracts";
import { previewSchedulePublication } from "@sessionbox-killer/domain";

import { createScheduleCommandPort, ScheduleApiError } from "./scheduleClient";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

const command = {
  commandId: "command_place_session",
  durationMinutes: 45,
  eventId: scheduleSnapshotFixture.event.eventId,
  expectedVersion: scheduleSnapshotFixture.event.version,
  roomId: scheduleSnapshotFixture.rooms[0]?.id ?? "room_main",
  sessionId: scheduleSnapshotFixture.sessions[0]?.id ?? "session_opening",
  startAt: "2026-09-15T16:00:00.000Z",
  type: "place_session" as const,
};

function commandSuccess() {
  return {
    ok: true,
    result: {
      analysis: {
        eventId: command.eventId,
        hardConflicts: [],
        policy: { transitionBufferMinutes: 15 },
        softWarnings: [],
      },
      changedSessionIds: [command.sessionId],
      commandId: command.commandId,
      replayed: false,
      snapshot: scheduleSnapshotFixture,
    },
  };
}

describe("schedule HTTP command port", () => {
  it("reads and validates the authoritative schedule snapshot", async () => {
    const fetcher = vi.fn(async () => response(scheduleSnapshotFixture));
    const port = createScheduleCommandPort(fetcher);

    await expect(port.read(command.eventId)).resolves.toEqual(
      scheduleSnapshotFixture,
    );
    expect(fetcher).toHaveBeenCalledWith(
      `/api/events/${command.eventId}/schedule`,
      {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      },
    );
  });

  it("reads a typed server-revalidated publication preview", async () => {
    const preview = previewSchedulePublication(scheduleSnapshotFixture);
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify(preview), {
          headers: {
            "Content-Type": "application/json",
            ETag: `"schedule-v${preview.scheduleVersion}"`,
          },
        }),
    );
    const port = createScheduleCommandPort(fetcher);

    await expect(
      port.previewPublication(command.eventId),
    ).resolves.toEqual(preview);
    expect(fetcher).toHaveBeenCalledWith(
      `/api/events/${command.eventId}/schedule/publication-preview`,
      {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      },
    );
  });

  it("reads the CSRF cookie and returns the typed command result", async () => {
    const token = "a".repeat(40);
    const fetcher = vi.fn().mockResolvedValueOnce(response(commandSuccess()));
    const port = createScheduleCommandPort(fetcher, () => token);

    await expect(port.execute(command)).resolves.toMatchObject({
      commandId: command.commandId,
      replayed: false,
    });
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      `/api/events/${command.eventId}/schedule/commands`,
      expect.objectContaining({
        body: expect.any(String),
        credentials: "same-origin",
        headers: expect.objectContaining({
          "If-Match": `"schedule-v${command.expectedVersion}"`,
          "X-CSRF-Token": token,
        }),
        method: "POST",
      }),
    );
    const commandRequest = fetcher.mock.calls[0]?.[1];
    expect(JSON.parse(String(commandRequest?.body))).toEqual(command);
  });

  it("preserves typed version conflicts for UI recovery", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(
      response(
        {
          error: {
            actualVersion: command.expectedVersion + 1,
            code: "schedule_version_conflict",
            expectedVersion: command.expectedVersion,
            message: "The schedule changed before this command was saved.",
          },
          ok: false,
        },
        412,
      ),
    );
    const port = createScheduleCommandPort(fetcher, () => "b".repeat(40));

    const error = await port.execute(command).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ScheduleApiError);
    expect(error).toMatchObject({
      code: "schedule_version_conflict",
      domainError: {
        actualVersion: command.expectedVersion + 1,
        expectedVersion: command.expectedVersion,
      },
      status: 412,
    });
  });

  it("preserves a retryable pending authority result for UI recovery", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(
      response(
        {
          error: {
            code: "schedule_authority_pending",
            commandId: command.commandId,
            message:
              "The authoritative write committed and is still being reconciled.",
            retryable: true,
            state: "projection_pending",
          },
          ok: false,
        },
        202,
      ),
    );
    const port = createScheduleCommandPort(fetcher, () => "f".repeat(40));

    const error = await port.execute(command).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ScheduleApiError);
    expect(error).toMatchObject({
      code: "schedule_authority_pending",
      domainError: {
        commandId: command.commandId,
        retryable: true,
        state: "projection_pending",
      },
      status: 202,
    });
  });

  it("rejects a schedule body that disagrees with its ETag", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify(scheduleSnapshotFixture), {
          headers: {
            "Content-Type": "application/json",
            ETag: `"schedule-v${scheduleSnapshotFixture.event.version + 1}"`,
          },
        }),
    );
    const port = createScheduleCommandPort(fetcher);

    const error = await port
      .read(command.eventId)
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ScheduleApiError);
    expect(error).toMatchObject({
      code: "invalid_schedule_response",
      status: 200,
    });
  });

  it("preserves structured hard conflicts for direct resolution", async () => {
    const conflict = {
      code: "room_overlap",
      entity: { id: "room_main", name: "Main room", type: "room" },
      eventId: command.eventId,
      overlap: {
        endAt: "2026-09-15T17:30:00.000Z",
        startAt: "2026-09-15T17:15:00.000Z",
      },
      overrideAllowed: false,
      resolutionHref:
        "/app/ai-engineering-summit/agenda?session=session_opening&conflict=session_benchmarks",
      sessionA: { id: "session_opening", title: "Opening" },
      sessionB: { id: "session_benchmarks", title: "Benchmarks" },
    } as const;
    const fetcher = vi.fn().mockResolvedValueOnce(
      response(
        {
          error: {
            code: "schedule_hard_conflict",
            conflicts: [conflict],
            message: "Opening and Benchmarks overlap in Main room.",
          },
          ok: false,
        },
        409,
      ),
    );
    const port = createScheduleCommandPort(fetcher, () => "e".repeat(40));

    const error = await port.execute(command).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ScheduleApiError);
    expect(error).toMatchObject({
      code: "schedule_hard_conflict",
      domainError: {
        code: "schedule_hard_conflict",
        conflicts: [conflict],
      },
      status: 409,
    });
  });

  it("refreshes a rejected CSRF token once before retrying the command", async () => {
    const firstToken = "c".repeat(40);
    const refreshedToken = "d".repeat(40);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          {
            error: {
              code: "invalid_csrf",
              message: "The request could not be verified.",
            },
            request_id: "request_1",
          },
          403,
        ),
      )
      .mockResolvedValueOnce(response(commandSuccess()));
    const csrfReader = vi
      .fn()
      .mockReturnValueOnce(firstToken)
      .mockReturnValueOnce(refreshedToken);
    const port = createScheduleCommandPort(fetcher, csrfReader);

    await expect(port.execute(command)).resolves.toMatchObject({
      commandId: command.commandId,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(csrfReader).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      `/api/events/${command.eventId}/schedule/commands`,
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-CSRF-Token": refreshedToken,
        }),
      }),
    );
  });

  it("fails before a mutation when the CSRF cookie is unavailable", async () => {
    const fetcher = vi.fn();
    const port = createScheduleCommandPort(fetcher, () => null);

    const error = await port.execute(command).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ScheduleApiError);
    expect(error).toMatchObject({ code: "missing_csrf", status: 0 });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
