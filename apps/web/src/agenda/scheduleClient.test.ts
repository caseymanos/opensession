import { describe, expect, it, vi } from "vitest";

import { scheduleSnapshotFixture } from "@sessionbox-killer/contracts";

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
        headers: expect.objectContaining({ "X-CSRF-Token": token }),
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
        409,
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
