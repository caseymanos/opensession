import {
  calendarInvitationSnapshotSchema,
  type CalendarAttachment,
  type CalendarInvitationSnapshot,
} from "@sessionbox-killer/contracts";

const encoder = new TextEncoder();
const calendarProductId = "-//OpenSession//Calendar Invitations 1.0//EN";

function basicUtc(instant: string): string {
  const date = new Date(instant);
  if (!Number.isFinite(date.valueOf())) {
    throw new TypeError("Calendar timestamp must be valid.");
  }
  return date
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.\d{3}Z$/u, "Z");
}

export function escapeCalendarText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replace(/\r\n|\r|\n/gu, "\\n")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,");
}

export function encodeCalendarParameter(value: string): string {
  return value
    .replaceAll("^", "^^")
    .replace(/\r\n|\r|\n/gu, "^n")
    .replaceAll('"', "^'");
}

export function foldCalendarLine(line: string): string {
  if (/\r|\n/u.test(line)) {
    throw new TypeError("Calendar content line must be unfolded.");
  }
  const physicalLines: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const character of line) {
    const byteLength = encoder.encode(character).byteLength;
    if (currentBytes + byteLength > 75) {
      physicalLines.push(current);
      current = ` ${character}`;
      currentBytes = 1 + byteLength;
    } else {
      current += character;
      currentBytes += byteLength;
    }
  }
  physicalLines.push(current);
  return physicalLines.join("\r\n");
}

function logicalLines(snapshot: CalendarInvitationSnapshot): string[] {
  const organizerName = encodeCalendarParameter(snapshot.organizer.name);
  const attendeeName = encodeCalendarParameter(snapshot.attendee.name);
  const timeLines =
    snapshot.time.kind === "date_time"
      ? [
          `DTSTART:${basicUtc(snapshot.time.startAt)}`,
          `DTEND:${basicUtc(snapshot.time.endAt)}`,
        ]
      : [
          `DTSTART;VALUE=DATE:${snapshot.time.startDate.replaceAll("-", "")}`,
          `DTEND;VALUE=DATE:${snapshot.time.endDateExclusive.replaceAll("-", "")}`,
        ];
  return [
    "BEGIN:VCALENDAR",
    `PRODID:${calendarProductId}`,
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    `METHOD:${snapshot.method}`,
    "BEGIN:VEVENT",
    `UID:${snapshot.uid}`,
    `DTSTAMP:${basicUtc(snapshot.dtstamp)}`,
    ...timeLines,
    `SEQUENCE:${snapshot.sequence}`,
    `STATUS:${snapshot.status}`,
    `ORGANIZER;CN="${organizerName}":mailto:${snapshot.organizer.email}`,
    `ATTENDEE;CN="${attendeeName}";CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:${snapshot.attendee.email}`,
    `SUMMARY:${escapeCalendarText(snapshot.summary)}`,
    `LOCATION:${escapeCalendarText(snapshot.location)}`,
    `DESCRIPTION:${escapeCalendarText(snapshot.description)}`,
    ...(snapshot.publicUrl ? [`URL:${snapshot.publicUrl}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
}

export interface CalendarValidationReport {
  errors: readonly string[];
  valid: boolean;
}

export function validateCalendarContent(
  content: string,
  input: CalendarInvitationSnapshot,
): CalendarValidationReport {
  const errors: string[] = [];
  const parsed = calendarInvitationSnapshotSchema.safeParse(input);
  if (!parsed.success) {
    return {
      errors: parsed.error.issues.map((issue) => issue.message),
      valid: false,
    };
  }
  if (!content.endsWith("\r\n")) {
    errors.push("Calendar content must end with CRLF.");
  }
  if (content.replaceAll("\r\n", "").includes("\n")) {
    errors.push("Calendar content contains a bare LF.");
  }
  if (content.replaceAll("\r\n", "").includes("\r")) {
    errors.push("Calendar content contains a bare CR.");
  }
  const physicalLines = content.split("\r\n").slice(0, -1);
  for (const [index, line] of physicalLines.entries()) {
    if (encoder.encode(line).byteLength > 75) {
      errors.push(`Physical line ${index + 1} exceeds 75 UTF-8 octets.`);
    }
    if (index === 0 && line.startsWith(" ")) {
      errors.push("The first physical line cannot be a continuation.");
    }
  }
  const unfolded: string[] = [];
  for (const line of physicalLines) {
    if (line.startsWith(" ")) {
      const previous = unfolded.at(-1);
      if (previous === undefined) {
        errors.push("Calendar continuation has no preceding content line.");
      } else {
        unfolded[unfolded.length - 1] = previous + line.slice(1);
      }
    } else {
      unfolded.push(line);
    }
  }
  const expected = logicalLines(parsed.data);
  if (JSON.stringify(unfolded) !== JSON.stringify(expected)) {
    errors.push("Calendar logical content does not match its snapshot.");
  }
  return { errors, valid: errors.length === 0 };
}

export function renderCalendarAttachment(
  input: CalendarInvitationSnapshot,
): CalendarAttachment {
  const snapshot = calendarInvitationSnapshotSchema.parse(input);
  const content = `${logicalLines(snapshot).map(foldCalendarLine).join("\r\n")}\r\n`;
  const report = validateCalendarContent(content, snapshot);
  if (!report.valid) {
    throw new Error(`Invalid calendar output: ${report.errors.join(" ")}`);
  }
  return {
    content,
    contentType: `text/calendar; charset=utf-8; method=${snapshot.method}`,
    filename: `invite-${snapshot.sessionId}.ics`,
    method: snapshot.method,
  };
}
