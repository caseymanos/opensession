export const participantConflictRoles = [
  "speaker",
  "moderator",
  "chair",
] as const;

export type ParticipantConflictRole = (typeof participantConflictRoles)[number];

export const sessionLifecycleStates = [
  "accepted_unscheduled",
  "scheduled",
  "published",
  "canceled",
] as const;

export type SessionLifecycleState = (typeof sessionLifecycleStates)[number];

export interface EventScheduleDay {
  businessEnd: string;
  businessStart: string;
  date: string;
}

export interface EventSchedulingConfig {
  days: readonly EventScheduleDay[];
  eventId: string;
  publicationVersion: number;
  slug: string;
  snapMinutes: number;
  timezone: string;
  version: number;
}

export interface ScheduleRoom {
  capacity: number;
  id: string;
  name: string;
  order: number;
}

export interface ScheduleTrack {
  id: string;
  name: string;
  order: number;
}

export interface ScheduleFormat {
  defaultDurationMinutes: number;
  id: string;
  name: string;
  order: number;
}

export interface ScheduleParticipant {
  displayName: string;
  personId: string;
  role: ParticipantConflictRole;
}

export interface ScheduleSlot {
  endAt: string;
  publicationVersion: number;
  roomId: string;
  startAt: string;
  version: number;
}

export interface ScheduleSession {
  abstract: string;
  durationMinutes: number;
  formatId: string;
  id: string;
  participants: readonly ScheduleParticipant[];
  slot: ScheduleSlot | null;
  state: SessionLifecycleState;
  title: string;
  trackId: string;
}

export interface ScheduleSnapshot {
  event: EventSchedulingConfig;
  formats: readonly ScheduleFormat[];
  rooms: readonly ScheduleRoom[];
  sessions: readonly ScheduleSession[];
  tracks: readonly ScheduleTrack[];
}

export interface ScheduleCommandBase {
  commandId: string;
  eventId: string;
  expectedVersion: number;
}

export interface PlaceSessionCommand extends ScheduleCommandBase {
  roomId: string;
  sessionId: string;
  startAt: string;
  type: "place_session";
}

export interface RescheduleSessionCommand extends ScheduleCommandBase {
  roomId: string;
  sessionId: string;
  startAt: string;
  type: "reschedule_session";
}

export interface UnassignSessionCommand extends ScheduleCommandBase {
  sessionId: string;
  type: "unassign_session";
}

export interface CancelSessionCommand extends ScheduleCommandBase {
  sessionId: string;
  type: "cancel_session";
}

export interface PublishScheduleCommand extends ScheduleCommandBase {
  type: "publish_schedule";
}

export type ScheduleCommand =
  | CancelSessionCommand
  | PlaceSessionCommand
  | PublishScheduleCommand
  | RescheduleSessionCommand
  | UnassignSessionCommand;

export interface ScheduleCommandResult {
  changedSessionIds: readonly string[];
  commandId: string;
  replayed: boolean;
  snapshot: ScheduleSnapshot;
}

export interface ScheduleCommandPort {
  execute(command: ScheduleCommand): Promise<ScheduleCommandResult>;
  read(eventId: string): Promise<ScheduleSnapshot | null>;
}

export const scheduleValidationReasons = [
  "duplicate_id",
  "invalid_business_hours",
  "invalid_command",
  "invalid_day",
  "invalid_duration",
  "invalid_format",
  "invalid_participant",
  "invalid_room",
  "invalid_session_state",
  "invalid_snap_interval",
  "invalid_time",
  "invalid_timezone",
  "invalid_track",
  "invalid_version",
  "session_not_found",
] as const;

export type ScheduleValidationReason =
  (typeof scheduleValidationReasons)[number];

export class ScheduleValidationError extends Error {
  readonly code = "schedule_validation_error";
  readonly field: string;
  readonly reason: ScheduleValidationReason;

  constructor(
    reason: ScheduleValidationReason,
    field: string,
    message: string,
  ) {
    super(message);
    this.name = "ScheduleValidationError";
    this.field = field;
    this.reason = reason;
  }
}

export class ScheduleVersionConflictError extends Error {
  readonly actualVersion: number;
  readonly code = "schedule_version_conflict";
  readonly expectedVersion: number;

  constructor(expectedVersion: number, actualVersion: number) {
    super(
      `Schedule version ${expectedVersion} is stale; current version is ${actualVersion}.`,
    );
    this.name = "ScheduleVersionConflictError";
    this.actualVersion = actualVersion;
    this.expectedVersion = expectedVersion;
  }
}

const stableIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const localDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const localTimePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function validationError(
  reason: ScheduleValidationReason,
  field: string,
  message: string,
): never {
  throw new ScheduleValidationError(reason, field, message);
}

function assertStableIdentifier(value: string, field: string): void {
  if (!stableIdentifierPattern.test(value)) {
    validationError(
      "invalid_command",
      field,
      `${field} must be a stable identifier.`,
    );
  }
}

function isValidLocalDate(value: string): boolean {
  if (!localDatePattern.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day ?? 0));
  return date.toISOString().slice(0, 10) === value;
}

function localTimeMinutes(value: string): number {
  if (!localTimePattern.test(value)) return Number.NaN;
  const [hour, minute] = value.split(":").map(Number);
  return (hour ?? Number.NaN) * 60 + (minute ?? Number.NaN);
}

export function isIanaTimezone(value: string): boolean {
  if (value !== "UTC" && !value.includes("/")) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function zonedLocalDateTime(
  instant: string,
  timezone: string,
): { date: string; time: string } {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime()) || !instant.endsWith("Z")) {
    validationError(
      "invalid_time",
      "slot.startAt",
      "Schedule slot times must be UTC ISO timestamps.",
    );
  }

  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  };
}

function assertOrderedEntities(
  entities: readonly { id: string; order: number }[],
  field: "formats" | "rooms" | "tracks",
): void {
  const ids = new Set<string>();
  entities.forEach((entity, index) => {
    assertStableIdentifier(entity.id, `${field}.${index}.id`);
    if (ids.has(entity.id)) {
      validationError(
        "duplicate_id",
        `${field}.${entity.id}`,
        `${field} contains a duplicate ID.`,
      );
    }
    ids.add(entity.id);
    if (entity.order !== index) {
      validationError(
        "invalid_command",
        `${field}.${entity.id}.order`,
        `${field} must use contiguous zero-based order values.`,
      );
    }
  });
}

function assertSlot(
  snapshot: ScheduleSnapshot,
  session: ScheduleSession,
  slot: ScheduleSlot,
): void {
  assertStableIdentifier(slot.roomId, `sessions.${session.id}.slot.roomId`);
  if (!snapshot.rooms.some((room) => room.id === slot.roomId)) {
    validationError(
      "invalid_room",
      `sessions.${session.id}.slot.roomId`,
      `Room ${slot.roomId} does not belong to this event.`,
    );
  }
  if (
    !Number.isInteger(slot.version) ||
    slot.version < 1 ||
    slot.version > snapshot.event.version ||
    !Number.isInteger(slot.publicationVersion) ||
    slot.publicationVersion < 0 ||
    slot.publicationVersion > snapshot.event.publicationVersion ||
    slot.publicationVersion > slot.version
  ) {
    validationError(
      "invalid_version",
      `sessions.${session.id}.slot.version`,
      "Slot versions must be valid event schedule versions.",
    );
  }

  const start = new Date(slot.startAt);
  const end = new Date(slot.endAt);
  if (
    !slot.startAt.endsWith("Z") ||
    !slot.endAt.endsWith("Z") ||
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime())
  ) {
    validationError(
      "invalid_time",
      `sessions.${session.id}.slot`,
      "Schedule slot times must be UTC ISO timestamps.",
    );
  }
  if (end.getTime() - start.getTime() !== session.durationMinutes * 60_000) {
    validationError(
      "invalid_duration",
      `sessions.${session.id}.durationMinutes`,
      "Schedule slot duration must equal the session duration.",
    );
  }

  const startLocal = zonedLocalDateTime(slot.startAt, snapshot.event.timezone);
  const endLocal = zonedLocalDateTime(slot.endAt, snapshot.event.timezone);
  const day = snapshot.event.days.find(({ date }) => date === startLocal.date);
  if (!day || endLocal.date !== day.date) {
    validationError(
      "invalid_day",
      `sessions.${session.id}.slot.startAt`,
      "Schedule slot must fall on one configured event day.",
    );
  }
  const startMinutes = localTimeMinutes(startLocal.time);
  const endMinutes = localTimeMinutes(endLocal.time);
  const businessStart = localTimeMinutes(day.businessStart);
  const businessEnd = localTimeMinutes(day.businessEnd);
  if (startMinutes < businessStart || endMinutes > businessEnd) {
    validationError(
      "invalid_business_hours",
      `sessions.${session.id}.slot`,
      "Schedule slot must fit inside the event day's business hours.",
    );
  }
  if ((startMinutes - businessStart) % snapshot.event.snapMinutes !== 0) {
    validationError(
      "invalid_snap_interval",
      `sessions.${session.id}.slot.startAt`,
      "Schedule slot start must align to the event snap interval.",
    );
  }
}

export function assertValidScheduleSnapshot(snapshot: ScheduleSnapshot): void {
  assertStableIdentifier(snapshot.event.eventId, "event.eventId");
  assertStableIdentifier(snapshot.event.slug, "event.slug");
  if (!isIanaTimezone(snapshot.event.timezone)) {
    validationError(
      "invalid_timezone",
      "event.timezone",
      "Event timezone must be a valid IANA timezone.",
    );
  }
  if (
    !Number.isInteger(snapshot.event.snapMinutes) ||
    ![5, 10, 15, 20, 30, 60].includes(snapshot.event.snapMinutes)
  ) {
    validationError(
      "invalid_snap_interval",
      "event.snapMinutes",
      "Snap interval must be 5, 10, 15, 20, 30, or 60 minutes.",
    );
  }
  if (
    !Number.isInteger(snapshot.event.version) ||
    snapshot.event.version < 0 ||
    !Number.isInteger(snapshot.event.publicationVersion) ||
    snapshot.event.publicationVersion < 0 ||
    snapshot.event.publicationVersion > snapshot.event.version
  ) {
    validationError(
      "invalid_version",
      "event.version",
      "Event schedule versions are invalid.",
    );
  }

  const dates = new Set<string>();
  let previousDate = "";
  for (const day of snapshot.event.days) {
    if (
      !isValidLocalDate(day.date) ||
      dates.has(day.date) ||
      day.date <= previousDate
    ) {
      validationError(
        dates.has(day.date) ? "duplicate_id" : "invalid_day",
        `event.days.${day.date}`,
        "Event days must be unique, valid local dates in ascending order.",
      );
    }
    dates.add(day.date);
    previousDate = day.date;
    const start = localTimeMinutes(day.businessStart);
    const end = localTimeMinutes(day.businessEnd);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start >= end ||
      (end - start) % snapshot.event.snapMinutes !== 0
    ) {
      validationError(
        "invalid_business_hours",
        `event.days.${day.date}`,
        "Business hours must be valid and divisible by the snap interval.",
      );
    }
  }
  if (snapshot.event.days.length === 0) {
    validationError(
      "invalid_day",
      "event.days",
      "At least one event day is required.",
    );
  }

  assertOrderedEntities(snapshot.rooms, "rooms");
  assertOrderedEntities(snapshot.tracks, "tracks");
  assertOrderedEntities(snapshot.formats, "formats");
  if (snapshot.rooms.length === 0) {
    validationError("invalid_room", "rooms", "At least one room is required.");
  }
  for (const room of snapshot.rooms) {
    if (!Number.isInteger(room.capacity) || room.capacity < 1) {
      validationError(
        "invalid_room",
        `rooms.${room.id}.capacity`,
        "Room capacity must be a positive whole number.",
      );
    }
  }
  for (const format of snapshot.formats) {
    if (
      !Number.isInteger(format.defaultDurationMinutes) ||
      format.defaultDurationMinutes < snapshot.event.snapMinutes ||
      format.defaultDurationMinutes % snapshot.event.snapMinutes !== 0
    ) {
      validationError(
        "invalid_duration",
        `formats.${format.id}.defaultDurationMinutes`,
        "Format duration must be a positive multiple of the snap interval.",
      );
    }
  }

  const sessionIds = new Set<string>();
  for (const session of snapshot.sessions) {
    assertStableIdentifier(session.id, "sessions.id");
    assertStableIdentifier(session.formatId, `sessions.${session.id}.formatId`);
    assertStableIdentifier(session.trackId, `sessions.${session.id}.trackId`);
    if (sessionIds.has(session.id)) {
      validationError(
        "duplicate_id",
        `sessions.${session.id}`,
        "Schedule contains a duplicate session ID.",
      );
    }
    sessionIds.add(session.id);
    if (!snapshot.formats.some((format) => format.id === session.formatId)) {
      validationError(
        "invalid_format",
        `sessions.${session.id}.formatId`,
        "Session format does not belong to this event.",
      );
    }
    if (!snapshot.tracks.some((track) => track.id === session.trackId)) {
      validationError(
        "invalid_track",
        `sessions.${session.id}.trackId`,
        "Session track does not belong to this event.",
      );
    }
    if (
      !Number.isInteger(session.durationMinutes) ||
      session.durationMinutes < snapshot.event.snapMinutes ||
      session.durationMinutes % snapshot.event.snapMinutes !== 0
    ) {
      validationError(
        "invalid_duration",
        `sessions.${session.id}.durationMinutes`,
        "Session duration must be a positive multiple of the snap interval.",
      );
    }
    const participantKeys = new Set<string>();
    for (const participant of session.participants) {
      assertStableIdentifier(
        participant.personId,
        `sessions.${session.id}.participants.personId`,
      );
      const key = `${participant.personId}:${participant.role}`;
      if (participantKeys.has(key)) {
        validationError(
          "invalid_participant",
          `sessions.${session.id}.participants`,
          "A participant role may appear only once per session.",
        );
      }
      participantKeys.add(key);
    }

    if (session.state === "accepted_unscheduled" && session.slot !== null) {
      validationError(
        "invalid_session_state",
        `sessions.${session.id}.slot`,
        "Accepted-unscheduled sessions cannot own a slot.",
      );
    }
    if (
      (session.state === "scheduled" || session.state === "published") &&
      session.slot === null
    ) {
      validationError(
        "invalid_session_state",
        `sessions.${session.id}.slot`,
        `${session.state} sessions require a slot.`,
      );
    }
    if (session.state === "canceled" && session.slot !== null) {
      validationError(
        "invalid_session_state",
        `sessions.${session.id}.slot`,
        "Canceled sessions cannot retain a draft slot.",
      );
    }
    if (session.slot) {
      assertSlot(snapshot, session, session.slot);
      if (
        session.state === "scheduled" &&
        session.slot.publicationVersion !== 0
      ) {
        validationError(
          "invalid_version",
          `sessions.${session.id}.slot.publicationVersion`,
          "Scheduled draft slots cannot claim a publication version.",
        );
      }
      if (
        session.state === "published" &&
        (session.slot.publicationVersion === 0 ||
          session.slot.publicationVersion !== snapshot.event.publicationVersion)
      ) {
        validationError(
          "invalid_version",
          `sessions.${session.id}.slot.publicationVersion`,
          "Published slots must match the event publication version.",
        );
      }
    }
  }
}

function nextSlot(
  snapshot: ScheduleSnapshot,
  session: ScheduleSession,
  roomId: string,
  startAt: string,
  version: number,
): ScheduleSlot {
  const start = new Date(startAt);
  if (!Number.isFinite(start.getTime()) || !startAt.endsWith("Z")) {
    validationError(
      "invalid_time",
      "command.startAt",
      "Command start time must be a UTC ISO timestamp.",
    );
  }
  const slot = {
    endAt: new Date(
      start.getTime() + session.durationMinutes * 60_000,
    ).toISOString(),
    publicationVersion: 0,
    roomId,
    startAt,
    version,
  };
  assertSlot(
    { ...snapshot, event: { ...snapshot.event, version } },
    session,
    slot,
  );
  return slot;
}

function replaceSession(
  snapshot: ScheduleSnapshot,
  sessionId: string,
  replace: (session: ScheduleSession) => ScheduleSession,
): readonly ScheduleSession[] {
  let found = false;
  const sessions = snapshot.sessions.map((session) => {
    if (session.id !== sessionId) return session;
    found = true;
    return replace(session);
  });
  if (!found) {
    validationError(
      "session_not_found",
      "command.sessionId",
      `Session ${sessionId} does not exist.`,
    );
  }
  return sessions;
}

export function applyScheduleCommand(
  snapshot: ScheduleSnapshot,
  command: ScheduleCommand,
): ScheduleCommandResult {
  assertValidScheduleSnapshot(snapshot);
  assertStableIdentifier(command.commandId, "command.commandId");
  assertStableIdentifier(command.eventId, "command.eventId");
  if (command.type !== "publish_schedule") {
    assertStableIdentifier(command.sessionId, "command.sessionId");
  }
  if (
    command.type === "place_session" ||
    command.type === "reschedule_session"
  ) {
    assertStableIdentifier(command.roomId, "command.roomId");
  }
  if (command.eventId !== snapshot.event.eventId) {
    validationError(
      "invalid_command",
      "command.eventId",
      "Schedule command targets a different event.",
    );
  }
  if (command.expectedVersion !== snapshot.event.version) {
    throw new ScheduleVersionConflictError(
      command.expectedVersion,
      snapshot.event.version,
    );
  }

  const nextVersion = snapshot.event.version + 1;
  let sessions: readonly ScheduleSession[];
  let changedSessionIds: readonly string[];

  if (command.type === "publish_schedule") {
    sessions = snapshot.sessions.map((session) => {
      if (session.state !== "scheduled" && session.state !== "published") {
        return session;
      }
      if (!session.slot) {
        validationError(
          "invalid_session_state",
          `sessions.${session.id}.slot`,
          "A publishable session is missing its slot.",
        );
      }
      return {
        ...session,
        slot: {
          ...session.slot,
          publicationVersion: nextVersion,
          version: nextVersion,
        },
        state: "published",
      };
    });
    changedSessionIds = sessions
      .filter((session) => session.state === "published")
      .map(({ id }) => id);
  } else {
    sessions = replaceSession(snapshot, command.sessionId, (session) => {
      if (command.type === "place_session") {
        if (session.state !== "accepted_unscheduled") {
          validationError(
            "invalid_session_state",
            "command.sessionId",
            "Only accepted-unscheduled sessions can be placed.",
          );
        }
        return {
          ...session,
          slot: nextSlot(
            snapshot,
            session,
            command.roomId,
            command.startAt,
            nextVersion,
          ),
          state: "scheduled",
        };
      }
      if (command.type === "reschedule_session") {
        if (session.state !== "scheduled" && session.state !== "published") {
          validationError(
            "invalid_session_state",
            "command.sessionId",
            "Only scheduled or published sessions can be rescheduled.",
          );
        }
        return {
          ...session,
          slot: nextSlot(
            snapshot,
            session,
            command.roomId,
            command.startAt,
            nextVersion,
          ),
          state: "scheduled",
        };
      }
      if (command.type === "unassign_session") {
        if (session.state !== "scheduled" && session.state !== "published") {
          validationError(
            "invalid_session_state",
            "command.sessionId",
            "Only scheduled or published sessions can be unassigned.",
          );
        }
        return { ...session, slot: null, state: "accepted_unscheduled" };
      }
      if (session.state === "canceled") {
        validationError(
          "invalid_session_state",
          "command.sessionId",
          "Canceled sessions are terminal.",
        );
      }
      return { ...session, slot: null, state: "canceled" };
    });
    changedSessionIds = [command.sessionId];
  }

  const result: ScheduleCommandResult = {
    changedSessionIds,
    commandId: command.commandId,
    replayed: false,
    snapshot: {
      ...snapshot,
      event: {
        ...snapshot.event,
        publicationVersion:
          command.type === "publish_schedule"
            ? nextVersion
            : snapshot.event.publicationVersion,
        version: nextVersion,
      },
      sessions,
    },
  };
  assertValidScheduleSnapshot(result.snapshot);
  return result;
}
