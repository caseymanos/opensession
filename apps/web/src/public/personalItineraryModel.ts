import type {
  PublicScheduleProjection,
  PublicSessionView,
} from "@sessionbox-killer/contracts";

import { sessionsInPublishedProjection } from "./publicScheduleModel";

export const personalItineraryStorageVersion = 1;

interface PersonalItinerarySnapshot {
  eventSlug: string;
  publicationVersion: number;
  sessionIds: string[];
  version: typeof personalItineraryStorageVersion;
}

export interface RestoredPersonalItinerary {
  removedCount: number;
  sessionIds: string[];
  shouldPersist: boolean;
}

export interface ItineraryConflict {
  firstSessionId: string;
  secondSessionId: string;
}

export function personalItineraryStorageKey(eventSlug: string) {
  return `opensession.personal-itinerary.v${personalItineraryStorageVersion}:${eventSlug}`;
}

function uniqueSessionIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [
    ...new Set(
      value.filter(
        (item): item is string =>
          typeof item === "string" && item.length > 0 && item.length <= 128,
      ),
    ),
  ].slice(0, 2_000);
}

export function restorePersonalItinerary(
  rawValue: string | null,
  projection: PublicScheduleProjection,
): RestoredPersonalItinerary {
  if (!rawValue) {
    return { removedCount: 0, sessionIds: [], shouldPersist: false };
  }

  let parsed: Partial<PersonalItinerarySnapshot>;
  try {
    const value: unknown = JSON.parse(rawValue);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Personal itinerary snapshot must be an object.");
    }
    parsed = value as Partial<PersonalItinerarySnapshot>;
  } catch {
    return { removedCount: 0, sessionIds: [], shouldPersist: true };
  }

  if (
    parsed.version !== personalItineraryStorageVersion ||
    parsed.eventSlug !== projection.event.slug
  ) {
    return { removedCount: 0, sessionIds: [], shouldPersist: true };
  }

  const candidateIds = uniqueSessionIds(parsed.sessionIds);
  const publishedIds = new Set(
    sessionsInPublishedProjection(projection).map((session) => session.id),
  );
  const sessionIds = candidateIds.filter((id) => publishedIds.has(id));

  return {
    removedCount: candidateIds.length - sessionIds.length,
    sessionIds,
    shouldPersist:
      parsed.publicationVersion !== projection.version ||
      sessionIds.length !== candidateIds.length ||
      !Array.isArray(parsed.sessionIds) ||
      parsed.sessionIds.length !== candidateIds.length,
  };
}

export function serializePersonalItinerary(
  projection: PublicScheduleProjection,
  sessionIds: readonly string[],
) {
  const publishedIds = new Set(
    sessionsInPublishedProjection(projection).map((session) => session.id),
  );
  const snapshot: PersonalItinerarySnapshot = {
    eventSlug: projection.event.slug,
    publicationVersion: projection.version,
    sessionIds: [...new Set(sessionIds)].filter((id) => publishedIds.has(id)),
    version: personalItineraryStorageVersion,
  };
  return JSON.stringify(snapshot);
}

export function sortSessionsChronologically(
  sessions: readonly PublicSessionView[],
) {
  return [...sessions].sort((left, right) => {
    const startDifference =
      new Date(left.startAt).getTime() - new Date(right.startAt).getTime();
    return startDifference || left.title.localeCompare(right.title);
  });
}

export function selectedSessionsForItinerary(
  projection: PublicScheduleProjection,
  sessionIds: ReadonlySet<string>,
) {
  return sortSessionsChronologically(
    sessionsInPublishedProjection(projection).filter((session) =>
      sessionIds.has(session.id),
    ),
  );
}

export function findItineraryConflicts(
  sessions: readonly PublicSessionView[],
): ItineraryConflict[] {
  const sorted = sortSessionsChronologically(sessions);
  const conflicts: ItineraryConflict[] = [];

  for (let leftIndex = 0; leftIndex < sorted.length; leftIndex += 1) {
    const left = sorted[leftIndex];
    if (!left) {
      continue;
    }
    const leftEnd = new Date(left.endAt).getTime();

    for (
      let rightIndex = leftIndex + 1;
      rightIndex < sorted.length;
      rightIndex += 1
    ) {
      const right = sorted[rightIndex];
      if (!right) {
        continue;
      }
      const rightStart = new Date(right.startAt).getTime();
      if (rightStart >= leftEnd) {
        break;
      }
      if (new Date(right.endAt).getTime() > new Date(left.startAt).getTime()) {
        conflicts.push({
          firstSessionId: left.id,
          secondSessionId: right.id,
        });
      }
    }
  }

  return conflicts;
}

function formatCalendarDate(value: string) {
  return new Date(value)
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.\d{3}/, "");
}

function escapeCalendarText(value: string) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll(",", "\\,")
    .replaceAll(";", "\\;");
}

function calendarDescription(session: PublicSessionView) {
  return `${session.abstract}\n\nSpeakers: ${session.speakers
    .map(
      (speaker) =>
        `${speaker.name}${speaker.role ? `, ${speaker.role}` : ""}${speaker.company ? ` at ${speaker.company}` : ""}`,
    )
    .join("; ")}`;
}

export function buildItineraryCalendar(
  projection: PublicScheduleProjection,
  sessions: readonly PublicSessionView[],
) {
  const event = projection.event;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//OpenSession//Personal itinerary//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeCalendarText(`${event.name} — My schedule`)}`,
  ];

  for (const session of sortSessionsChronologically(sessions)) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${session.id}.${event.slug}@opensession.dev`,
      `DTSTAMP:${formatCalendarDate(projection.generatedAt)}`,
      `DTSTART:${formatCalendarDate(session.startAt)}`,
      `DTEND:${formatCalendarDate(session.endAt)}`,
      `SUMMARY:${escapeCalendarText(session.title)}`,
      `DESCRIPTION:${escapeCalendarText(calendarDescription(session))}`,
      `LOCATION:${escapeCalendarText(`${session.roomName}, ${event.location}`)}`,
      "END:VEVENT",
    );
  }

  lines.push("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}

export function itineraryCalendarHref(
  projection: PublicScheduleProjection,
  sessions: readonly PublicSessionView[],
) {
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(
    buildItineraryCalendar(projection, sessions),
  )}`;
}
