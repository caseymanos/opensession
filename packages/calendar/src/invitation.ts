import {
  calendarInvitationIntentSchema,
  calendarInvitationSnapshotSchema,
  calendarChangeIntentSchema,
  calendarPartySchema,
  scheduleSnapshotSchema,
  type CalendarChangeIntent,
  type CalendarInvitationIntent,
  type CalendarInvitationSnapshot,
  type CalendarParty,
  type ScheduleSnapshot,
} from "@sessionbox-killer/contracts";

import { canonicalJson, freezeDeep, sha256Hex } from "./canonical.js";
import { renderCalendarAttachment } from "./render.js";
import { eventZoneHumanTime } from "./time.js";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const uidDomainPattern =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;

export class CalendarScheduleUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarScheduleUnavailableError";
  }
}

export interface CalendarInvitationBuildInput {
  attendee: CalendarParty;
  eventLocation: string;
  eventName: string;
  occurredAt: string;
  organizationId: string;
  organizer: CalendarParty;
  previous?: CalendarInvitationIntent | undefined;
  publicUrl?: string | null | undefined;
  schedule: ScheduleSnapshot;
  sessionId: string;
  uidDomain: string;
}

export interface CalendarInvitationBuildResult {
  disposition: "created" | "updated" | "unchanged";
  intent: Readonly<CalendarInvitationIntent>;
}

export interface CalendarCancellationInput {
  change: CalendarChangeIntent;
  previous: CalendarInvitationIntent;
}

function normalizeParty(input: CalendarParty): CalendarParty {
  const party = calendarPartySchema.parse(input);
  return { email: party.email.toLowerCase(), name: party.name.trim() };
}

function calendarInstant(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new TypeError("Calendar timestamp must be valid.");
  }
  date.setUTCMilliseconds(0);
  return date.toISOString();
}

function assertBuildIdentity(input: CalendarInvitationBuildInput): void {
  if (!identifierPattern.test(input.organizationId)) {
    throw new TypeError("Calendar organization ID is invalid.");
  }
  if (!uidDomainPattern.test(input.uidDomain)) {
    throw new TypeError("Calendar UID domain is invalid.");
  }
  if (
    !input.occurredAt.endsWith("Z") ||
    !Number.isFinite(Date.parse(input.occurredAt))
  ) {
    throw new TypeError("Calendar command timestamp must use UTC.");
  }
}

async function invitationIdentity(
  organizationId: string,
  eventId: string,
  sessionId: string,
  attendeeEmail: string,
  uidDomain: string,
): Promise<{ seriesId: string; uid: string }> {
  const uidHash = await sha256Hex(
    ["calendar-uid-v1", organizationId, eventId, sessionId].join("\u0000"),
  );
  const seriesHash = await sha256Hex(
    [
      "calendar-series-v1",
      organizationId,
      eventId,
      sessionId,
      attendeeEmail,
    ].join("\u0000"),
  );
  return {
    seriesId: `cal_${seriesHash.slice(0, 48)}`,
    uid: `evt_${uidHash.slice(0, 48)}@${uidDomain.toLowerCase()}`,
  };
}

function materialSnapshot(snapshot: CalendarInvitationSnapshot): unknown {
  const material: Record<string, unknown> = { ...snapshot };
  delete material.dtstamp;
  delete material.sequence;
  delete material.sourcePublicationVersion;
  delete material.sourceScheduleVersion;
  return material;
}

async function finalizeIntent(
  snapshotInput: CalendarInvitationSnapshot,
): Promise<Readonly<CalendarInvitationIntent>> {
  const snapshot = calendarInvitationSnapshotSchema.parse(snapshotInput);
  const snapshotHash = await sha256Hex(canonicalJson(snapshot));
  const intent = calendarInvitationIntentSchema.parse({
    attachment: renderCalendarAttachment(snapshot),
    idempotencyKey: `calendar-invitation:v1:${snapshot.seriesId}:${snapshot.sequence}:${snapshotHash}`,
    snapshot,
    snapshotHash,
    version: 1,
  });
  return freezeDeep(structuredClone(intent));
}

export async function assertCalendarIntentIntegrity(
  input: CalendarInvitationIntent,
): Promise<CalendarInvitationIntent> {
  const intent = calendarInvitationIntentSchema.parse(input);
  const snapshotHash = await sha256Hex(canonicalJson(intent.snapshot));
  const attachment = renderCalendarAttachment(intent.snapshot);
  const idempotencyKey = `calendar-invitation:v1:${intent.snapshot.seriesId}:${intent.snapshot.sequence}:${snapshotHash}`;
  if (
    intent.snapshotHash !== snapshotHash ||
    intent.idempotencyKey !== idempotencyKey ||
    canonicalJson(intent.attachment) !== canonicalJson(attachment)
  ) {
    throw new TypeError(
      "Calendar invitation intent failed its integrity check.",
    );
  }
  return intent;
}

export async function buildCalendarInvitation(
  input: CalendarInvitationBuildInput,
): Promise<CalendarInvitationBuildResult> {
  assertBuildIdentity(input);
  const schedule = scheduleSnapshotSchema.parse(input.schedule);
  const session = schedule.sessions.find(
    (candidate) => candidate.id === input.sessionId,
  );
  if (
    !session ||
    (session.state !== "scheduled" && session.state !== "published") ||
    !session.slot
  ) {
    throw new CalendarScheduleUnavailableError(
      "A canonical scheduled session is required before creating a calendar invitation.",
    );
  }
  const room = schedule.rooms.find(
    (candidate) => candidate.id === session.slot?.roomId,
  );
  if (!room) {
    throw new CalendarScheduleUnavailableError(
      "The canonical scheduled room is unavailable.",
    );
  }
  const attendee = normalizeParty(input.attendee);
  const organizer = normalizeParty(input.organizer);
  const identity = await invitationIdentity(
    input.organizationId,
    schedule.event.eventId,
    session.id,
    attendee.email,
    input.uidDomain,
  );
  const eventName = input.eventName.trim();
  const eventLocation = input.eventLocation.trim();
  if (!eventName || !eventLocation) {
    throw new TypeError("Calendar event name and location are required.");
  }
  const startAt = calendarInstant(session.slot.startAt);
  const endAt = calendarInstant(session.slot.endAt);
  const humanTime = eventZoneHumanTime(startAt, endAt, schedule.event.timezone);
  const location = `${room.name}, ${eventLocation}`;
  const description = [
    `Event: ${eventName}`,
    `When: ${humanTime}`,
    `Where: ${location}`,
    "",
    session.abstract.trim(),
    ...(input.publicUrl ? ["", `Details: ${input.publicUrl}`] : []),
  ].join("\n");
  const previous = input.previous
    ? await assertCalendarIntentIntegrity(input.previous)
    : undefined;
  if (
    previous &&
    (previous.snapshot.seriesId !== identity.seriesId ||
      previous.snapshot.uid !== identity.uid)
  ) {
    throw new TypeError(
      "Previous invitation belongs to a different calendar series.",
    );
  }
  if (previous?.snapshot.method === "CANCEL") {
    throw new TypeError("A canceled invitation series cannot be rescheduled.");
  }
  const candidate = calendarInvitationSnapshotSchema.parse({
    attendee,
    description,
    dtstamp: calendarInstant(input.occurredAt),
    eventId: schedule.event.eventId,
    humanTime,
    location,
    method: "REQUEST",
    organizationId: input.organizationId,
    organizer,
    publicUrl: input.publicUrl ?? null,
    roomId: room.id,
    sequence: previous?.snapshot.sequence ?? 0,
    seriesId: identity.seriesId,
    sessionId: session.id,
    sourcePublicationVersion: session.slot.publicationVersion,
    sourceScheduleVersion: schedule.event.version,
    status: "CONFIRMED",
    summary: session.title,
    time: {
      endAt,
      kind: "date_time",
      startAt,
    },
    timezone: schedule.event.timezone,
    uid: identity.uid,
    version: 1,
  });
  if (
    previous &&
    canonicalJson(materialSnapshot(previous.snapshot)) ===
      canonicalJson(materialSnapshot(candidate))
  ) {
    return {
      disposition: "unchanged",
      intent: freezeDeep(structuredClone(previous)),
    };
  }
  const snapshot = previous
    ? { ...candidate, sequence: previous.snapshot.sequence + 1 }
    : candidate;
  return {
    disposition: previous ? "updated" : "created",
    intent: await finalizeIntent(snapshot),
  };
}

export async function cancelCalendarInvitation(
  input: CalendarCancellationInput,
): Promise<CalendarInvitationBuildResult> {
  const change = calendarChangeIntentSchema.parse(input.change);
  const previous = await assertCalendarIntentIntegrity(input.previous);
  if (change.changeType !== "canceled" && change.changeType !== "unassigned") {
    throw new TypeError(
      "Only canceled or unassigned changes cancel an invitation.",
    );
  }
  if (
    change.organizationId !== previous.snapshot.organizationId ||
    change.eventId !== previous.snapshot.eventId ||
    change.sessionId !== previous.snapshot.sessionId ||
    previous.snapshot.time.kind !== "date_time" ||
    Date.parse(change.previousPlacement.startAt) !==
      Date.parse(previous.snapshot.time.startAt) ||
    Date.parse(change.previousPlacement.endAt) !==
      Date.parse(previous.snapshot.time.endAt) ||
    change.previousPlacement.roomId !== previous.snapshot.roomId
  ) {
    throw new TypeError(
      "Calendar cancellation does not match its prior invitation.",
    );
  }
  if (previous.snapshot.method === "CANCEL") {
    return {
      disposition: "unchanged",
      intent: freezeDeep(structuredClone(previous)),
    };
  }
  const snapshot = calendarInvitationSnapshotSchema.parse({
    ...previous.snapshot,
    dtstamp: calendarInstant(change.occurredAt),
    method: "CANCEL",
    sequence: previous.snapshot.sequence + 1,
    sourcePublicationVersion: change.sourcePublicationVersion,
    status: "CANCELLED",
  });
  return { disposition: "updated", intent: await finalizeIntent(snapshot) };
}
