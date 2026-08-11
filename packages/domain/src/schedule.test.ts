import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  applyScheduleCommand,
  assertValidScheduleSnapshot,
  isIanaTimezone,
  previewSchedulePublication,
  SchedulePublicationBlockedError,
  ScheduleVersionConflictError,
  type ScheduleSnapshot,
  type ScheduleValidationError,
  type ScheduleValidationReason,
} from "./schedule";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Fixture value is missing.");
  return value;
}

function snapshot(): ScheduleSnapshot {
  return {
    event: {
      days: [
        {
          businessEnd: "17:00",
          businessStart: "09:00",
          date: "2026-09-15",
        },
        {
          businessEnd: "17:00",
          businessStart: "09:00",
          date: "2026-09-16",
        },
      ],
      eventId: "event_demo",
      publicationVersion: 0,
      slug: "demo-event",
      snapMinutes: 15,
      timezone: "America/Los_Angeles",
      version: 1,
    },
    formats: [
      { defaultDurationMinutes: 30, id: "format_talk", name: "Talk", order: 0 },
    ],
    rooms: [{ capacity: 100, id: "room_main", name: "Main room", order: 0 }],
    sessions: [
      {
        abstract: "A complete session abstract.",
        durationMinutes: 30,
        formatId: "format_talk",
        id: "session_one",
        participants: [
          {
            displayName: "Alex Chen",
            personId: "person_alex",
            role: "speaker",
          },
        ],
        slot: null,
        state: "accepted_unscheduled",
        title: "Session one",
        trackId: "track_main",
      },
    ],
    tracks: [{ id: "track_main", name: "Main", order: 0 }],
  };
}

describe("schedule domain", () => {
  it("recognizes IANA timezones and rejects display labels", () => {
    expect(isIanaTimezone("America/Los_Angeles")).toBe(true);
    expect(isIanaTimezone("UTC")).toBe(true);
    expect(isIanaTimezone("Pacific Time")).toBe(false);
  });

  it("places, publishes, reschedules, unassigns, and cancels a session", () => {
    const placed = applyScheduleCommand(snapshot(), {
      commandId: "command_place",
      durationMinutes: 30,
      eventId: "event_demo",
      expectedVersion: 1,
      roomId: "room_main",
      sessionId: "session_one",
      startAt: "2026-09-15T16:00:00.000Z",
      type: "place_session",
    });
    expect(placed.snapshot.sessions[0]).toMatchObject({
      slot: {
        endAt: "2026-09-15T16:30:00.000Z",
        publicationVersion: 0,
        version: 2,
      },
      state: "scheduled",
    });

    const published = applyScheduleCommand(placed.snapshot, {
      commandId: "command_publish",
      eventId: "event_demo",
      expectedVersion: 2,
      type: "publish_schedule",
    });
    expect(published.snapshot.event).toMatchObject({
      publicationVersion: 3,
      version: 3,
    });
    expect(published.snapshot.sessions[0]).toMatchObject({
      slot: { publicationVersion: 3, version: 3 },
      state: "published",
    });

    const rescheduled = applyScheduleCommand(published.snapshot, {
      commandId: "command_reschedule",
      durationMinutes: 45,
      eventId: "event_demo",
      expectedVersion: 3,
      roomId: "room_main",
      sessionId: "session_one",
      startAt: "2026-09-16T17:00:00.000Z",
      type: "reschedule_session",
    });
    expect(rescheduled.snapshot.sessions[0]).toMatchObject({
      durationMinutes: 45,
      slot: {
        endAt: "2026-09-16T17:45:00.000Z",
        publicationVersion: 0,
        version: 4,
      },
      state: "scheduled",
    });

    const unassigned = applyScheduleCommand(rescheduled.snapshot, {
      commandId: "command_unassign",
      eventId: "event_demo",
      expectedVersion: 4,
      sessionId: "session_one",
      type: "unassign_session",
    });
    expect(unassigned.snapshot.sessions[0]).toMatchObject({
      slot: null,
      state: "accepted_unscheduled",
    });

    const canceled = applyScheduleCommand(unassigned.snapshot, {
      commandId: "command_cancel",
      eventId: "event_demo",
      expectedVersion: 5,
      sessionId: "session_one",
      type: "cancel_session",
    });
    expect(canceled.snapshot.sessions[0]).toMatchObject({
      slot: null,
      state: "canceled",
    });
    expect(() => assertValidScheduleSnapshot(canceled.snapshot)).not.toThrow();
  });

  it("names every accepted-public publication blocker server-side", () => {
    const preview = previewSchedulePublication(snapshot());

    expect(preview).toMatchObject({
      acceptedPublicSessionCount: 1,
      canPublish: false,
      counts: {
        hardConflicts: 0,
        missingRoomOrTime: 1,
        softWarnings: 0,
        unscheduled: 1,
      },
      currentPublicationVersion: 0,
      nextPublicationVersion: 2,
      scheduleVersion: 1,
      unscheduledSessions: [
        {
          resolutionHref: "/app/demo-event/agenda?session=session_one",
          session: { id: "session_one", title: "Session one" },
        },
      ],
    });
    expect(() =>
      applyScheduleCommand(snapshot(), {
        commandId: "command_blocked_publish",
        eventId: "event_demo",
        expectedVersion: 1,
        type: "publish_schedule",
      }),
    ).toThrow(SchedulePublicationBlockedError);
  });

  it("requires an exact soft-warning override before publication", () => {
    const base = snapshot();
    const warningSnapshot: ScheduleSnapshot = {
      ...base,
      sessions: [
        {
          ...required(base.sessions[0]),
          expectedAttendance: 150,
        },
      ],
    };
    const placed = applyScheduleCommand(warningSnapshot, {
      commandId: "command_warning_place",
      durationMinutes: 30,
      eventId: "event_demo",
      expectedVersion: 1,
      roomId: "room_main",
      sessionId: "session_one",
      startAt: "2026-09-15T16:00:00.000Z",
      type: "place_session",
    });
    const preview = previewSchedulePublication(placed.snapshot);
    expect(preview.counts.softWarnings).toBe(1);
    const warningKey = required(preview.softWarnings[0]).key;

    expect(() =>
      applyScheduleCommand(placed.snapshot, {
        commandId: "command_warning_publish_missing",
        eventId: "event_demo",
        expectedVersion: 2,
        type: "publish_schedule",
      }),
    ).toThrow(
      expect.objectContaining<Partial<ScheduleValidationError>>({
        reason: "soft_warning_override_required",
      }),
    );

    expect(
      applyScheduleCommand(placed.snapshot, {
        commandId: "command_warning_publish",
        eventId: "event_demo",
        expectedVersion: 2,
        softWarningOverride: {
          reason: "Operations approved the audience overflow plan",
          warningKeys: [warningKey],
        },
        type: "publish_schedule",
      }).snapshot.event.publicationVersion,
    ).toBe(3);
  });

  it("excludes private accepted sessions from publication blockers and output", () => {
    const base = snapshot();
    const publicSession = {
      ...required(base.sessions[0]),
      id: "session_public",
      slot: {
        endAt: "2026-09-15T16:30:00.000Z",
        publicationVersion: 0,
        roomId: "room_main",
        startAt: "2026-09-15T16:00:00.000Z",
        version: 1,
      },
      state: "scheduled" as const,
    };
    const privateSession = {
      ...required(base.sessions[0]),
      id: "session_private",
      isPublic: false,
    };
    const candidate = {
      ...base,
      sessions: [publicSession, privateSession],
    };

    expect(previewSchedulePublication(candidate)).toMatchObject({
      acceptedPublicSessionCount: 1,
      canPublish: true,
      counts: { unscheduled: 0 },
    });
    const published = applyScheduleCommand(candidate, {
      commandId: "command_public_only",
      eventId: "event_demo",
      expectedVersion: 1,
      type: "publish_schedule",
    });
    expect(published.snapshot.sessions).toEqual([
      expect.objectContaining({ id: "session_public", state: "published" }),
      expect.objectContaining({
        id: "session_private",
        slot: null,
        state: "accepted_unscheduled",
      }),
    ]);
  });

  it("property-checks accepted-public blocker counts", () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { maxLength: 40 }), (publicFlags) => {
        const base = snapshot();
        const scheduled = {
          ...required(base.sessions[0]),
          id: "session_scheduled_public",
          slot: {
            endAt: "2026-09-15T16:30:00.000Z",
            publicationVersion: 0,
            roomId: "room_main",
            startAt: "2026-09-15T16:00:00.000Z",
            version: 1,
          },
          state: "scheduled" as const,
        };
        const candidate: ScheduleSnapshot = {
          ...base,
          sessions: [
            scheduled,
            ...publicFlags.map((isPublic, index) => ({
              ...required(base.sessions[0]),
              id: `session_candidate_${index}`,
              isPublic,
            })),
          ],
        };
        const preview = previewSchedulePublication(candidate);
        const expectedUnscheduled = publicFlags.filter(Boolean).length;
        expect(preview.acceptedPublicSessionCount).toBe(
          expectedUnscheduled + 1,
        );
        expect(preview.counts.unscheduled).toBe(expectedUnscheduled);
        expect(preview.counts.missingRoomOrTime).toBe(expectedUnscheduled);
      }),
    );
  });

  it.each([
    {
      mutate(value: ScheduleSnapshot) {
        value.event.timezone = "Pacific Time";
      },
      reason: "invalid_timezone",
    },
    {
      mutate(value: ScheduleSnapshot) {
        value.event.days = [
          { ...required(value.event.days[0]), businessEnd: "09:00" },
          required(value.event.days[1]),
        ];
      },
      reason: "invalid_business_hours",
    },
    {
      mutate(value: ScheduleSnapshot) {
        value.sessions = [
          { ...required(value.sessions[0]), durationMinutes: 32 },
        ];
      },
      reason: "invalid_duration",
    },
    {
      mutate(value: ScheduleSnapshot) {
        value.event.days = [
          { ...required(value.event.days[0]), date: "2026-02-30" },
          required(value.event.days[1]),
        ];
      },
      reason: "invalid_day",
    },
    {
      mutate(value: ScheduleSnapshot) {
        value.event.snapMinutes = 7;
      },
      reason: "invalid_snap_interval",
    },
    {
      mutate(value: ScheduleSnapshot) {
        value.rooms = [{ ...required(value.rooms[0]), id: "not a stable id" }];
      },
      reason: "invalid_command",
    },
    {
      mutate(value: ScheduleSnapshot) {
        value.sessions = [
          {
            ...required(value.sessions[0]),
            state: "invented" as "scheduled",
          },
        ];
      },
      reason: "invalid_session_state",
    },
    {
      mutate(value: ScheduleSnapshot) {
        const session = required(value.sessions[0]);
        value.sessions = [
          {
            ...session,
            participants: [
              {
                ...required(session.participants[0]),
                role: "host" as "speaker",
              },
            ],
          },
        ];
      },
      reason: "invalid_participant",
    },
  ])("rejects $reason snapshots", ({ mutate, reason }) => {
    const value = snapshot();
    mutate(value);
    expect(() => assertValidScheduleSnapshot(value)).toThrowError(
      expect.objectContaining<Partial<ScheduleValidationError>>({
        reason: reason as ScheduleValidationReason,
      }),
    );
  });

  it("rejects nonexistent rooms and stale schedule versions", () => {
    expect(() =>
      applyScheduleCommand(snapshot(), {
        commandId: "command_duration",
        durationMinutes: 32,
        eventId: "event_demo",
        expectedVersion: 1,
        roomId: "room_main",
        sessionId: "session_one",
        startAt: "2026-09-15T16:00:00.000Z",
        type: "place_session",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ScheduleValidationError>>({
        reason: "invalid_duration",
      }),
    );
    expect(() =>
      applyScheduleCommand(snapshot(), {
        commandId: "command_room",
        durationMinutes: 30,
        eventId: "event_demo",
        expectedVersion: 1,
        roomId: "room_missing",
        sessionId: "session_one",
        startAt: "2026-09-15T16:00:00.000Z",
        type: "place_session",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ScheduleValidationError>>({
        reason: "invalid_room",
      }),
    );
    expect(() =>
      applyScheduleCommand(snapshot(), {
        commandId: "command_stale",
        eventId: "event_demo",
        expectedVersion: 0,
        type: "publish_schedule",
      }),
    ).toThrow(ScheduleVersionConflictError);
  });

  it.each([
    ["2026-09-17T16:00:00.000Z", "invalid_day"],
    ["2026-09-15T15:00:00.000Z", "invalid_business_hours"],
    ["2026-09-15T16:07:00.000Z", "invalid_snap_interval"],
  ] as const)("rejects invalid placement time %s", (startAt, reason) => {
    expect(() =>
      applyScheduleCommand(snapshot(), {
        commandId: "command_invalid_time",
        durationMinutes: 30,
        eventId: "event_demo",
        expectedVersion: 1,
        roomId: "room_main",
        sessionId: "session_one",
        startAt,
        type: "place_session",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ScheduleValidationError>>({ reason }),
    );
  });
});
