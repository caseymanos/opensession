import type {
  ScheduleParticipant,
  ScheduleSession,
  ScheduleSnapshot,
} from "./schedule.js";

export const scheduleHardConflictCodes = [
  "room_overlap",
  "participant_overlap",
] as const;

export type ScheduleHardConflictCode =
  (typeof scheduleHardConflictCodes)[number];

export const scheduleSoftWarningCodes = [
  "capacity_exceeded",
  "transition_buffer",
  "missing_readiness",
] as const;

export type ScheduleSoftWarningCode = (typeof scheduleSoftWarningCodes)[number];

export interface ScheduleConflictPolicy {
  transitionBufferMinutes: number;
}

export const defaultScheduleConflictPolicy: ScheduleConflictPolicy = {
  transitionBufferMinutes: 15,
};

export interface ScheduleConflictEntity {
  id: string;
  name: string;
  type: "participant" | "room";
}

export interface ScheduleSessionReference {
  id: string;
  title: string;
}

export interface ScheduleConflictInterval {
  endAt: string;
  startAt: string;
}

export interface ScheduleHardConflict {
  code: ScheduleHardConflictCode;
  entity: ScheduleConflictEntity;
  eventId: string;
  overlap: ScheduleConflictInterval;
  overrideAllowed: false;
  resolutionHref: string;
  sessionA: ScheduleSessionReference;
  sessionB: ScheduleSessionReference;
}

interface ScheduleSoftWarningBase {
  code: ScheduleSoftWarningCode;
  entity: ScheduleConflictEntity;
  eventId: string;
  override: {
    allowed: true;
    reason: string | null;
    sessionId: string | null;
  };
  resolutionHref: string;
}

export interface ScheduleCapacityWarning extends ScheduleSoftWarningBase {
  capacity: number;
  code: "capacity_exceeded";
  expectedAttendance: number;
  session: ScheduleSessionReference;
}

export interface ScheduleTransitionWarning extends ScheduleSoftWarningBase {
  availableMinutes: number;
  code: "transition_buffer";
  requiredMinutes: number;
  sessionA: ScheduleSessionReference;
  sessionB: ScheduleSessionReference;
}

export interface ScheduleReadinessWarning extends ScheduleSoftWarningBase {
  code: "missing_readiness";
  missingRequiredTaskCount: number;
  readinessState: "missing_required_tasks" | "not_configured";
  session: ScheduleSessionReference;
}

export type ScheduleSoftWarning =
  | ScheduleCapacityWarning
  | ScheduleReadinessWarning
  | ScheduleTransitionWarning;

export function scheduleSoftWarningKey(warning: ScheduleSoftWarning): string {
  const sessionIds =
    warning.code === "transition_buffer"
      ? [warning.sessionA.id, warning.sessionB.id].sort()
      : [warning.session.id];
  return [
    warning.code,
    warning.entity.type,
    warning.entity.id,
    ...sessionIds,
  ].join(":");
}

export interface ScheduleConflictReport {
  eventId: string;
  hardConflicts: readonly ScheduleHardConflict[];
  policy: ScheduleConflictPolicy;
  softWarnings: readonly ScheduleSoftWarning[];
}

export class ScheduleHardConflictError extends Error {
  readonly code = "schedule_hard_conflict";
  readonly conflicts: readonly ScheduleHardConflict[];

  constructor(conflicts: readonly ScheduleHardConflict[]) {
    const first = conflicts[0];
    super(
      first
        ? `${first.sessionA.title} and ${first.sessionB.title} conflict on ${first.entity.name} from ${first.overlap.startAt} to ${first.overlap.endAt}.`
        : "The schedule contains a hard conflict.",
    );
    this.name = "ScheduleHardConflictError";
    this.conflicts = conflicts;
  }
}

interface ScheduledSession extends ScheduleSession {
  slot: NonNullable<ScheduleSession["slot"]>;
}

function sessionReference(session: ScheduleSession): ScheduleSessionReference {
  return { id: session.id, title: session.title };
}

function resolutionHref(
  snapshot: ScheduleSnapshot,
  sessionA: ScheduleSession,
  sessionB?: ScheduleSession,
): string {
  const parameters = new URLSearchParams({ session: sessionA.id });
  if (sessionB) parameters.set("conflict", sessionB.id);
  return `/app/${encodeURIComponent(snapshot.event.slug)}/agenda?${parameters.toString()}`;
}

function participantEntity(
  participant: ScheduleParticipant,
): ScheduleConflictEntity {
  return {
    id: participant.personId,
    name: participant.displayName,
    type: "participant",
  };
}

function roomEntity(
  snapshot: ScheduleSnapshot,
  roomId: string,
): ScheduleConflictEntity {
  const room = snapshot.rooms.find(({ id }) => id === roomId);
  return { id: roomId, name: room?.name ?? roomId, type: "room" };
}

function participantsByPerson(
  session: ScheduleSession,
): ReadonlyMap<string, ScheduleParticipant> {
  const participants = new Map<string, ScheduleParticipant>();
  for (const participant of session.participants) {
    if (!participants.has(participant.personId)) {
      participants.set(participant.personId, participant);
    }
  }
  return participants;
}

function canonicalSessionPair(
  left: ScheduledSession,
  right: ScheduledSession,
): readonly [ScheduledSession, ScheduledSession] {
  return left.id.localeCompare(right.id) <= 0 ? [left, right] : [right, left];
}

function chronologicalSessions(
  sessions: readonly ScheduledSession[],
): readonly ScheduledSession[] {
  return [...sessions].sort((left, right) => {
    const byStart =
      Date.parse(left.slot.startAt) - Date.parse(right.slot.startAt);
    return byStart === 0 ? left.id.localeCompare(right.id) : byStart;
  });
}

function overlapInterval(
  left: ScheduledSession,
  right: ScheduledSession,
): ScheduleConflictInterval {
  return {
    endAt: new Date(
      Math.min(Date.parse(left.slot.endAt), Date.parse(right.slot.endAt)),
    ).toISOString(),
    startAt: new Date(
      Math.max(Date.parse(left.slot.startAt), Date.parse(right.slot.startAt)),
    ).toISOString(),
  };
}

function overrideFor(
  sessions: readonly ScheduledSession[],
): ScheduleSoftWarningBase["override"] {
  for (const session of sessions) {
    const reason = session.slot.overrideReason?.trim();
    if (reason) {
      return { allowed: true, reason, sessionId: session.id };
    }
  }
  return { allowed: true, reason: null, sessionId: null };
}

function scheduledSessions(
  snapshot: ScheduleSnapshot,
): readonly ScheduledSession[] {
  return snapshot.sessions
    .filter(
      (session): session is ScheduledSession =>
        (session.state === "scheduled" || session.state === "published") &&
        session.slot !== null,
    )
    .sort((left, right) => left.id.localeCompare(right.id));
}

function hardConflictSortKey(conflict: ScheduleHardConflict): string {
  return [
    conflict.sessionA.id,
    conflict.sessionB.id,
    conflict.code,
    conflict.entity.id,
  ].join(":");
}

function softWarningSortKey(warning: ScheduleSoftWarning): string {
  const sessions =
    warning.code === "transition_buffer"
      ? `${warning.sessionA.id}:${warning.sessionB.id}`
      : warning.session.id;
  return [sessions, warning.code, warning.entity.id].join(":");
}

function assertPolicy(policy: ScheduleConflictPolicy): void {
  if (
    !Number.isInteger(policy.transitionBufferMinutes) ||
    policy.transitionBufferMinutes < 0 ||
    policy.transitionBufferMinutes > 24 * 60
  ) {
    throw new RangeError(
      "Schedule transition buffer must be a whole number from 0 to 1440 minutes.",
    );
  }
}

export function evaluateScheduleConflicts(
  snapshot: ScheduleSnapshot,
  policy: ScheduleConflictPolicy = defaultScheduleConflictPolicy,
): ScheduleConflictReport {
  assertPolicy(policy);
  const sessions = scheduledSessions(snapshot);
  const hardConflicts: ScheduleHardConflict[] = [];
  const softWarnings: ScheduleSoftWarning[] = [];
  const sessionsByRoom = new Map<string, ScheduledSession[]>();
  const sessionsByParticipant = new Map<
    string,
    { participant: ScheduleParticipant; sessions: ScheduledSession[] }
  >();

  for (const session of sessions) {
    const roomSessions = sessionsByRoom.get(session.slot.roomId) ?? [];
    roomSessions.push(session);
    sessionsByRoom.set(session.slot.roomId, roomSessions);

    const room = snapshot.rooms.find(({ id }) => id === session.slot.roomId);
    if (
      room &&
      session.expectedAttendance !== undefined &&
      session.expectedAttendance !== null &&
      session.expectedAttendance > room.capacity
    ) {
      softWarnings.push({
        capacity: room.capacity,
        code: "capacity_exceeded",
        entity: roomEntity(snapshot, room.id),
        eventId: snapshot.event.eventId,
        expectedAttendance: session.expectedAttendance,
        override: overrideFor([session]),
        resolutionHref: resolutionHref(snapshot, session),
        session: sessionReference(session),
      });
    }

    for (const participant of participantsByPerson(session).values()) {
      const participantSchedule = sessionsByParticipant.get(
        participant.personId,
      ) ?? { participant, sessions: [] };
      participantSchedule.sessions.push(session);
      sessionsByParticipant.set(participant.personId, participantSchedule);
      if (
        participant.readiness?.state !== "missing_required_tasks" &&
        participant.readiness?.state !== "not_configured"
      ) {
        continue;
      }
      softWarnings.push({
        code: "missing_readiness",
        entity: participantEntity(participant),
        eventId: snapshot.event.eventId,
        missingRequiredTaskCount:
          participant.readiness.missingRequiredTaskCount,
        override: overrideFor([session]),
        readinessState: participant.readiness.state,
        resolutionHref: resolutionHref(snapshot, session),
        session: sessionReference(session),
      });
    }
  }

  for (const [roomId, roomSessions] of sessionsByRoom) {
    const chronological = chronologicalSessions(roomSessions);
    for (let leftIndex = 0; leftIndex < chronological.length; leftIndex += 1) {
      const left = chronological[leftIndex];
      if (!left) continue;
      const leftEnd = Date.parse(left.slot.endAt);
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < chronological.length;
        rightIndex += 1
      ) {
        const right = chronological[rightIndex];
        if (!right) continue;
        if (Date.parse(right.slot.startAt) >= leftEnd) break;
        const [sessionA, sessionB] = canonicalSessionPair(left, right);
        hardConflicts.push({
          code: "room_overlap",
          entity: roomEntity(snapshot, roomId),
          eventId: snapshot.event.eventId,
          overlap: overlapInterval(left, right),
          overrideAllowed: false,
          resolutionHref: resolutionHref(snapshot, sessionA, sessionB),
          sessionA: sessionReference(sessionA),
          sessionB: sessionReference(sessionB),
        });
      }
    }
  }

  for (const {
    participant,
    sessions: participantSessions,
  } of sessionsByParticipant.values()) {
    const chronological = chronologicalSessions(participantSessions);
    for (let leftIndex = 0; leftIndex < chronological.length; leftIndex += 1) {
      const left = chronological[leftIndex];
      if (!left) continue;
      const leftEnd = Date.parse(left.slot.endAt);
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < chronological.length;
        rightIndex += 1
      ) {
        const right = chronological[rightIndex];
        if (!right) continue;
        const [sessionA, sessionB] = canonicalSessionPair(left, right);
        const rightStart = Date.parse(right.slot.startAt);
        if (rightStart < leftEnd) {
          hardConflicts.push({
            code: "participant_overlap",
            entity: participantEntity(participant),
            eventId: snapshot.event.eventId,
            overlap: overlapInterval(left, right),
            overrideAllowed: false,
            resolutionHref: resolutionHref(snapshot, sessionA, sessionB),
            sessionA: sessionReference(sessionA),
            sessionB: sessionReference(sessionB),
          });
          continue;
        }
        const availableMinutes = (rightStart - leftEnd) / 60_000;
        if (
          policy.transitionBufferMinutes === 0 ||
          availableMinutes >= policy.transitionBufferMinutes
        ) {
          break;
        }
        softWarnings.push({
          availableMinutes,
          code: "transition_buffer",
          entity: participantEntity(participant),
          eventId: snapshot.event.eventId,
          override: overrideFor([sessionA, sessionB]),
          requiredMinutes: policy.transitionBufferMinutes,
          resolutionHref: resolutionHref(snapshot, sessionA, sessionB),
          sessionA: sessionReference(sessionA),
          sessionB: sessionReference(sessionB),
        });
      }
    }
  }

  hardConflicts.sort((left, right) =>
    hardConflictSortKey(left).localeCompare(hardConflictSortKey(right)),
  );
  softWarnings.sort((left, right) =>
    softWarningSortKey(left).localeCompare(softWarningSortKey(right)),
  );
  return {
    eventId: snapshot.event.eventId,
    hardConflicts,
    policy: { ...policy },
    softWarnings,
  };
}
