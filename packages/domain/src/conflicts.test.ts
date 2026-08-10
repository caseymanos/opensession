import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  evaluateScheduleConflicts,
  ScheduleHardConflictError,
  type ScheduleConflictPolicy,
} from "./conflicts.js";
import {
  applyScheduleCommand,
  type ScheduleParticipant,
  type ScheduleSession,
  type ScheduleSnapshot,
  type ScheduleValidationError,
} from "./schedule.js";

const transitionPolicy: ScheduleConflictPolicy = {
  transitionBufferMinutes: 15,
};

function participant(
  personId: string,
  readiness: ScheduleParticipant["readiness"] = {
    missingRequiredTaskCount: 0,
    state: "ready",
  },
): ScheduleParticipant {
  return {
    displayName: personId.replaceAll("_", " "),
    personId,
    readiness,
    role: "speaker",
  };
}

function scheduledSession(
  id: string,
  startAt: string,
  endAt: string,
  options: {
    expectedAttendance?: number | null;
    participants?: readonly ScheduleParticipant[];
    roomId?: string;
  } = {},
): ScheduleSession {
  return {
    abstract: `${id} abstract`,
    durationMinutes: (Date.parse(endAt) - Date.parse(startAt)) / 60_000,
    expectedAttendance: options.expectedAttendance ?? null,
    formatId: "format_talk",
    id,
    participants: options.participants ?? [],
    slot: {
      endAt,
      overrideReason: null,
      publicationVersion: 0,
      roomId: options.roomId ?? "room_main",
      startAt,
      version: 1,
    },
    state: "scheduled",
    title: `${id} title`,
    trackId: "track_main",
  };
}

function acceptedSession(
  id: string,
  options: {
    expectedAttendance?: number | null;
    participants?: readonly ScheduleParticipant[];
  } = {},
): ScheduleSession {
  return {
    abstract: `${id} abstract`,
    durationMinutes: 30,
    expectedAttendance: options.expectedAttendance ?? null,
    formatId: "format_talk",
    id,
    participants: options.participants ?? [],
    slot: null,
    state: "accepted_unscheduled",
    title: `${id} title`,
    trackId: "track_main",
  };
}

function snapshot(
  sessions: readonly ScheduleSession[],
  eventId = "event_conflicts",
): ScheduleSnapshot {
  return {
    event: {
      days: [
        {
          businessEnd: "23:45",
          businessStart: "00:00",
          date: "2026-11-01",
        },
      ],
      eventId,
      publicationVersion: 0,
      slug: eventId,
      snapMinutes: 15,
      timezone: "UTC",
      version: 1,
    },
    formats: [
      {
        defaultDurationMinutes: 30,
        id: "format_talk",
        name: "Talk",
        order: 0,
      },
    ],
    rooms: [
      { capacity: 100, id: "room_main", name: "Main Room", order: 0 },
      { capacity: 10, id: "room_small", name: "Small Room", order: 1 },
      { capacity: 100, id: "room_side", name: "Side Room", order: 2 },
    ],
    sessions,
    tracks: [{ id: "track_main", name: "Main", order: 0 }],
  };
}

function instant(minutes: number): string {
  return new Date(
    Date.parse("2026-11-01T00:00:00.000Z") + minutes * 60_000,
  ).toISOString();
}

describe("schedule conflict policy", () => {
  it("provides demo proof for room, shared-speaker, adjacency, and each soft warning", () => {
    const roomCollision = evaluateScheduleConflicts(
      snapshot([
        scheduledSession("session_alpha", instant(60), instant(120)),
        scheduledSession("session_beta", instant(90), instant(150)),
      ]),
      transitionPolicy,
    );
    expect(roomCollision.hardConflicts).toEqual([
      expect.objectContaining({
        code: "room_overlap",
        entity: { id: "room_main", name: "Main Room", type: "room" },
        overlap: { endAt: instant(120), startAt: instant(90) },
        overrideAllowed: false,
        sessionA: {
          id: "session_alpha",
          title: "session_alpha title",
        },
        sessionB: { id: "session_beta", title: "session_beta title" },
      }),
    ]);

    const speakerCollision = evaluateScheduleConflicts(
      snapshot([
        scheduledSession("session_alpha", instant(60), instant(120), {
          participants: [participant("person_shared")],
        }),
        scheduledSession("session_beta", instant(75), instant(105), {
          participants: [participant("person_shared")],
          roomId: "room_side",
        }),
      ]),
      transitionPolicy,
    );
    expect(speakerCollision.hardConflicts).toEqual([
      expect.objectContaining({
        code: "participant_overlap",
        entity: {
          id: "person_shared",
          name: "person shared",
          type: "participant",
        },
        overlap: { endAt: instant(105), startAt: instant(75) },
      }),
    ]);

    const adjacent = evaluateScheduleConflicts(
      snapshot([
        scheduledSession("session_alpha", instant(60), instant(120)),
        scheduledSession("session_beta", instant(120), instant(150)),
      ]),
      transitionPolicy,
    );
    expect(adjacent.hardConflicts).toEqual([]);

    const warnings = evaluateScheduleConflicts(
      snapshot([
        scheduledSession("session_alpha", instant(60), instant(120), {
          participants: [participant("person_shared")],
        }),
        scheduledSession("session_beta", instant(125), instant(155), {
          participants: [participant("person_shared")],
          roomId: "room_side",
        }),
        scheduledSession("session_capacity", instant(180), instant(210), {
          expectedAttendance: 25,
          participants: [
            participant("person_unready", {
              missingRequiredTaskCount: 2,
              state: "missing_required_tasks",
            }),
          ],
          roomId: "room_small",
        }),
      ]),
      transitionPolicy,
    );
    expect(new Set(warnings.softWarnings.map(({ code }) => code))).toEqual(
      new Set(["capacity_exceeded", "transition_buffer", "missing_readiness"]),
    );
  });

  it("fails closed for hard placement and publication conflicts", () => {
    const existing = scheduledSession(
      "session_existing",
      instant(60),
      instant(120),
      { participants: [participant("person_shared")] },
    );
    const candidate = acceptedSession("session_candidate", {
      participants: [participant("person_shared")],
    });

    expect(() =>
      applyScheduleCommand(snapshot([existing, candidate]), {
        commandId: "command_collision",
        durationMinutes: 30,
        eventId: "event_conflicts",
        expectedVersion: 1,
        overrideReason: "Attempted hard conflict override",
        roomId: "room_side",
        sessionId: "session_candidate",
        startAt: instant(75),
        type: "place_session",
      }),
    ).toThrow(ScheduleHardConflictError);

    expect(() =>
      applyScheduleCommand(
        snapshot([
          existing,
          scheduledSession("session_conflicting", instant(90), instant(150)),
        ]),
        {
          commandId: "command_publish",
          eventId: "event_conflicts",
          expectedVersion: 1,
          type: "publish_schedule",
        },
      ),
    ).toThrow(ScheduleHardConflictError);
  });

  it("accepts an authoritative placement exactly adjacent in the same room", () => {
    const result = applyScheduleCommand(
      snapshot([
        scheduledSession("session_existing", instant(60), instant(120)),
        acceptedSession("session_candidate"),
      ]),
      {
        commandId: "command_adjacent",
        durationMinutes: 30,
        eventId: "event_conflicts",
        expectedVersion: 1,
        roomId: "room_main",
        sessionId: "session_candidate",
        startAt: instant(120),
        type: "place_session",
      },
    );

    expect(result.analysis.hardConflicts).toEqual([]);
    expect(result.snapshot.sessions[1]).toMatchObject({
      id: "session_candidate",
      slot: { startAt: instant(120) },
      state: "scheduled",
    });
  });

  it("persists an allowed soft-warning override and rejects gratuitous reasons", () => {
    const warningPlacement = applyScheduleCommand(
      snapshot([
        acceptedSession("session_candidate", { expectedAttendance: 25 }),
      ]),
      {
        commandId: "command_soft_override",
        durationMinutes: 30,
        eventId: "event_conflicts",
        expectedVersion: 1,
        overrideReason: "Audience overflow approved by operations",
        roomId: "room_small",
        sessionId: "session_candidate",
        startAt: instant(60),
        type: "place_session",
      },
    );
    expect(warningPlacement.analysis.softWarnings).toEqual([
      expect.objectContaining({
        code: "capacity_exceeded",
        override: {
          allowed: true,
          reason: "Audience overflow approved by operations",
          sessionId: "session_candidate",
        },
      }),
    ]);
    expect(warningPlacement.snapshot.sessions[0]?.slot?.overrideReason).toBe(
      "Audience overflow approved by operations",
    );

    expect(() =>
      applyScheduleCommand(snapshot([acceptedSession("session_clear")]), {
        commandId: "command_invalid_override",
        durationMinutes: 30,
        eventId: "event_conflicts",
        expectedVersion: 1,
        overrideReason: "No warning exists for this placement",
        roomId: "room_main",
        sessionId: "session_clear",
        startAt: instant(60),
        type: "place_session",
      }),
    ).toThrow(
      expect.objectContaining<Partial<ScheduleValidationError>>({
        reason: "override_not_allowed",
      }),
    );
  });

  it("is symmetric for arbitrary interval and participant ordering", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 600 }),
        fc.integer({ min: 15, max: 180 }),
        fc.integer({ min: 0, max: 600 }),
        fc.integer({ min: 15, max: 180 }),
        (startA, durationA, startB, durationB) => {
          const sessions = [
            scheduledSession(
              "session_alpha",
              instant(startA),
              instant(startA + durationA),
              { participants: [participant("person_shared")] },
            ),
            scheduledSession(
              "session_beta",
              instant(startB),
              instant(startB + durationB),
              {
                participants: [participant("person_shared")],
                roomId: "room_side",
              },
            ),
          ];
          expect(
            evaluateScheduleConflicts(snapshot(sessions), transitionPolicy),
          ).toEqual(
            evaluateScheduleConflicts(
              snapshot([...sessions].reverse()),
              transitionPolicy,
            ),
          );
        },
      ),
      { numRuns: 200, seed: 0x52414c62 },
    );
  });

  it("treats arbitrary adjacent intervals as non-overlapping", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 600 }),
        fc.integer({ min: 1, max: 180 }),
        fc.integer({ min: 1, max: 180 }),
        (start, leftDuration, rightDuration) => {
          const boundary = start + leftDuration;
          const report = evaluateScheduleConflicts(
            snapshot([
              scheduledSession(
                "session_alpha",
                instant(start),
                instant(boundary),
              ),
              scheduledSession(
                "session_beta",
                instant(boundary),
                instant(boundary + rightDuration),
              ),
            ]),
            { transitionBufferMinutes: 0 },
          );
          expect(report.hardConflicts).toEqual([]);
        },
      ),
      { numRuns: 200, seed: 0x41444a41 },
    );
  });

  it("reports the exact inner interval for arbitrary containment", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 300 }),
        fc.integer({ min: 2, max: 180 }),
        fc.integer({ min: 0, max: 60 }),
        (start, outerDuration, rawOffset) => {
          const offset = rawOffset % outerDuration;
          const innerDuration = Math.max(1, outerDuration - offset);
          const report = evaluateScheduleConflicts(
            snapshot([
              scheduledSession(
                "session_outer",
                instant(start),
                instant(start + outerDuration),
              ),
              scheduledSession(
                "session_inner",
                instant(start + offset),
                instant(start + offset + innerDuration),
              ),
            ]),
            transitionPolicy,
          );
          expect(report.hardConflicts).toEqual([
            expect.objectContaining({
              code: "room_overlap",
              overlap: {
                endAt: instant(start + offset + innerDuration),
                startAt: instant(start + offset),
              },
            }),
          ]);
        },
      ),
      { numRuns: 200, seed: 0x434f4e54 },
    );
  });

  it("finds every shared participant without duplicate role findings", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 20 }), {
          minLength: 1,
          maxLength: 8,
        }),
        (identifiers) => {
          const shared = identifiers.map((id) => participant(`person_${id}`));
          const report = evaluateScheduleConflicts(
            snapshot([
              scheduledSession("session_alpha", instant(60), instant(120), {
                participants: shared,
                roomId: "room_main",
              }),
              scheduledSession("session_beta", instant(75), instant(105), {
                participants: [...shared].reverse(),
                roomId: "room_side",
              }),
            ]),
            transitionPolicy,
          );
          expect(
            report.hardConflicts
              .filter(({ code }) => code === "participant_overlap")
              .map(({ entity }) => entity.id),
          ).toEqual(
            identifiers
              .map((id) => `person_${id}`)
              .sort((a, b) => a.localeCompare(b)),
          );
        },
      ),
      { numRuns: 100, seed: 0x4d554c54 },
    );
  });

  it("isolates arbitrary events even when room and participant IDs match", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z][a-z0-9]{2,16}$/),
        fc.stringMatching(/^[a-z][a-z0-9]{2,16}$/),
        (leftId, rightId) => {
          fc.pre(leftId !== rightId);
          const session = scheduledSession(
            "session_shared",
            instant(60),
            instant(120),
            { participants: [participant("person_shared")] },
          );
          const left = evaluateScheduleConflicts(
            snapshot([session], `event_${leftId}`),
          );
          const right = evaluateScheduleConflicts(
            snapshot([session], `event_${rightId}`),
          );
          expect(left.hardConflicts).toEqual([]);
          expect(right.hardConflicts).toEqual([]);
          expect(left.eventId).not.toBe(right.eventId);
        },
      ),
      { numRuns: 100, seed: 0x4556454e },
    );
  });

  it("keeps half-open arithmetic stable across arbitrary DST boundaries", () => {
    const boundaries = [
      Date.parse("2026-03-08T10:00:00.000Z"),
      Date.parse("2026-11-01T09:00:00.000Z"),
    ];
    fc.assert(
      fc.property(
        fc.constantFrom(...boundaries),
        fc.integer({ min: 1, max: 120 }),
        (boundary, duration) => {
          const leftStart = new Date(
            boundary - duration * 60_000,
          ).toISOString();
          const atBoundary = new Date(boundary).toISOString();
          const rightEnd = new Date(boundary + duration * 60_000).toISOString();
          const report = evaluateScheduleConflicts(
            snapshot([
              scheduledSession("session_before", leftStart, atBoundary),
              scheduledSession("session_after", atBoundary, rightEnd),
            ]),
            { transitionBufferMinutes: 0 },
          );
          expect(report.hardConflicts).toEqual([]);
        },
      ),
      { numRuns: 100, seed: 0x44535462 },
    );
  });
});
