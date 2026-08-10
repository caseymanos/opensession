import { describe, expect, it } from "vitest";

import {
  scheduleFilterFixture,
  scheduleSnapshotFixture,
} from "./schedule-fixture";
import {
  placeSessionCommandSchema,
  scheduleCommandResponseSchema,
  scheduleSnapshotSchema,
} from "./schedule";

describe("schedule contracts", () => {
  it("parses the provider-neutral two-day fixture", () => {
    const parsed = scheduleSnapshotSchema.parse(scheduleSnapshotFixture);
    expect(parsed.event.days).toHaveLength(2);
    expect(parsed.rooms).toHaveLength(3);
    expect(
      parsed.sessions.some(({ state }) => state === "accepted_unscheduled"),
    ).toBe(true);
    expect(scheduleFilterFixture.roomIds).toEqual([
      "room_cowell",
      "room_gallery",
    ]);
    const deliberateOverlap = parsed.sessions.filter(
      (session) =>
        session.participants.some(
          ({ personId }) => personId === "person_alex",
        ) && session.slot?.startAt === "2026-09-15T17:00:00.000Z",
    );
    expect(deliberateOverlap).toHaveLength(2);
  });

  it("parses an authoritative placement command", () => {
    expect(
      placeSessionCommandSchema.parse({
        commandId: "command_place_session",
        durationMinutes: 45,
        eventId: scheduleSnapshotFixture.event.eventId,
        expectedVersion: scheduleSnapshotFixture.event.version,
        roomId: "room_firehouse",
        sessionId: "session_small_models",
        startAt: "2026-09-16T16:00:00.000Z",
        type: "place_session",
      }),
    ).toMatchObject({
      durationMinutes: 45,
      expectedVersion: 7,
      type: "place_session",
    });
  });

  it("rejects non-UTC commands and non-IANA schedule configuration", () => {
    expect(() =>
      placeSessionCommandSchema.parse({
        commandId: "command_missing_duration",
        eventId: scheduleSnapshotFixture.event.eventId,
        expectedVersion: 7,
        roomId: "room_firehouse",
        sessionId: "session_small_models",
        startAt: "2026-09-16T16:00:00.000Z",
        type: "place_session",
      }),
    ).toThrow();
    expect(() =>
      placeSessionCommandSchema.parse({
        commandId: "command_place_session",
        durationMinutes: 45,
        eventId: scheduleSnapshotFixture.event.eventId,
        expectedVersion: 7,
        roomId: "room_firehouse",
        sessionId: "session_small_models",
        startAt: "2026-09-16T09:00:00-07:00",
        type: "place_session",
      }),
    ).toThrow();
    expect(() =>
      scheduleSnapshotSchema.parse({
        ...scheduleSnapshotFixture,
        event: { ...scheduleSnapshotFixture.event, timezone: "Pacific Time" },
      }),
    ).toThrow();
  });

  it("keeps typed command failures distinct", () => {
    expect(
      scheduleCommandResponseSchema.parse({
        error: {
          actualVersion: 9,
          code: "schedule_version_conflict",
          expectedVersion: 8,
          message: "Schedule changed.",
        },
        ok: false,
      }),
    ).toMatchObject({
      error: { code: "schedule_version_conflict" },
      ok: false,
    });
  });
});
