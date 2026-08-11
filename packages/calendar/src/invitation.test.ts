import { scheduleSnapshotFixture } from "@sessionbox-killer/contracts";
import fc from "fast-check";
import ICAL from "ical.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CalendarScheduleUnavailableError,
  allDayHumanTime,
  buildCalendarInvitation,
  cancelCalendarInvitation,
  eventZoneHumanTime,
  renderCalendarAttachment,
  validateCalendarContent,
} from "./index.js";
import type {
  CalendarChangeIntent,
  CalendarInvitationIntent,
  CalendarInvitationSnapshot,
  ScheduleSnapshot,
} from "@sessionbox-killer/contracts";

const initialAt = "2026-08-10T18:00:00.000Z";
const organizer = {
  email: "program@example.test",
  name: "OpenSession Program Team",
};
const attendee = {
  email: "alex@example.test",
  name: "Alex Chen",
};

function cloneSchedule(): ScheduleSnapshot {
  return structuredClone(scheduleSnapshotFixture);
}

function invitationInput(
  schedule = cloneSchedule(),
  previous?: CalendarInvitationIntent,
) {
  return {
    attendee,
    eventLocation: "Fort Mason Center, San Francisco",
    eventName: "AI Engineer World's Fair",
    occurredAt: initialAt,
    organizationId: "org_open_session",
    organizer,
    previous,
    publicUrl: "https://events.example.test/ai-engineering-summit",
    schedule,
    sessionId: "session_opening",
    uidDomain: "calendar.example.test",
  };
}

function rescheduledSnapshot(): ScheduleSnapshot {
  const schedule = cloneSchedule();
  schedule.event.publicationVersion = 5;
  schedule.event.version = 8;
  const session = schedule.sessions.find(
    (candidate) => candidate.id === "session_opening",
  );
  if (!session?.slot) throw new Error("Fixture session is not scheduled.");
  session.slot = {
    ...session.slot,
    endAt: "2026-09-15T18:30:00.000Z",
    publicationVersion: 5,
    startAt: "2026-09-15T18:00:00.000Z",
    version: 5,
  };
  return schedule;
}

function changeIntent(
  changeType: CalendarChangeIntent["changeType"],
): CalendarChangeIntent {
  return {
    actor: { id: "user_program_lead", type: "user" },
    changeType,
    commandId: `command_${changeType}`,
    eventId: "event_ai_engineering_summit",
    kind: "calendar.change",
    occurredAt: "2026-08-10T20:00:00.000Z",
    organizationId: "org_open_session",
    previousPlacement: {
      endAt: "2026-09-15T18:30:00.000Z",
      roomId: "room_cowell",
      startAt: "2026-09-15T18:00:00.000Z",
    },
    requestId: `request_${changeType}`,
    sessionId: "session_opening",
    sourcePublicationVersion: 6,
    version: 1,
  };
}

function parseEvent(content: string): InstanceType<typeof ICAL.Component> {
  const calendar = new ICAL.Component(ICAL.parse(content));
  const event = calendar.getFirstSubcomponent("vevent");
  if (!event) throw new Error("Independent parser did not find VEVENT.");
  return event;
}

function physicalLines(content: string): string[] {
  return content.split("\r\n").slice(0, -1);
}

describe("calendar invitation lifecycle", () => {
  it("renders an independently parseable initial request and exact replay", async () => {
    const created = await buildCalendarInvitation(invitationInput());
    const replay = await buildCalendarInvitation(
      invitationInput(cloneSchedule(), created.intent),
    );

    expect(created.disposition).toBe("created");
    expect(replay).toEqual({
      disposition: "unchanged",
      intent: created.intent,
    });
    expect(Object.isFrozen(replay.intent)).toBe(true);
    expect(Object.isFrozen(replay.intent.snapshot)).toBe(true);
    expect(created.intent.attachment.content).toContain(
      "\r\nMETHOD:REQUEST\r\n",
    );
    expect(created.intent.attachment.content).not.toMatch(/(?<!\r)\n/u);
    const event = parseEvent(created.intent.attachment.content);
    expect(event.getFirstPropertyValue("uid")).toBe(
      created.intent.snapshot.uid,
    );
    expect(event.getFirstPropertyValue("sequence")).toBe(0);
    expect(event.getFirstPropertyValue("status")).toBe("CONFIRMED");
    expect(created.intent).toMatchSnapshot();
  });

  it("keeps UID, advances sequence, and emits cancellation semantics", async () => {
    const initial = await buildCalendarInvitation(invitationInput());
    const rescheduled = await buildCalendarInvitation({
      ...invitationInput(rescheduledSnapshot(), initial.intent),
      occurredAt: "2026-08-10T19:00:00.000Z",
    });
    const canceled = await cancelCalendarInvitation({
      change: changeIntent("canceled"),
      previous: rescheduled.intent,
    });
    const cancelReplay = await cancelCalendarInvitation({
      change: changeIntent("canceled"),
      previous: canceled.intent,
    });

    expect(rescheduled.disposition).toBe("updated");
    expect(rescheduled.intent.snapshot.uid).toBe(initial.intent.snapshot.uid);
    expect(rescheduled.intent.snapshot.sequence).toBe(1);
    expect(rescheduled.intent.snapshot.time).toEqual({
      endAt: "2026-09-15T18:30:00.000Z",
      kind: "date_time",
      startAt: "2026-09-15T18:00:00.000Z",
    });
    expect(canceled.intent.snapshot.uid).toBe(initial.intent.snapshot.uid);
    expect(canceled.intent.snapshot.sequence).toBe(2);
    expect(canceled.intent.snapshot.method).toBe("CANCEL");
    expect(canceled.intent.snapshot.status).toBe("CANCELLED");
    expect(canceled.intent.attachment.content).toContain("METHOD:CANCEL");
    expect(cancelReplay).toEqual({
      disposition: "unchanged",
      intent: canceled.intent,
    });
    expect({
      canceled: canceled.intent,
      initial: initial.intent,
      rescheduled: rescheduled.intent,
    }).toMatchSnapshot();
  });

  it("suppresses non-material schedule-version churn", async () => {
    const initial = await buildCalendarInvitation(invitationInput());
    const schedule = cloneSchedule();
    schedule.event.version += 1;
    const unchanged = await buildCalendarInvitation({
      ...invitationInput(schedule, initial.intent),
      occurredAt: "2026-08-11T19:00:00.000Z",
    });

    expect(unchanged.disposition).toBe("unchanged");
    expect(unchanged.intent).toEqual(initial.intent);
  });

  it("canonicalizes equivalent UTC timestamp representations", async () => {
    const initial = await buildCalendarInvitation(invitationInput());
    const timestamped = await buildCalendarInvitation({
      ...invitationInput(),
      occurredAt: "2026-08-10T18:00:00.987Z",
    });
    const schedule = cloneSchedule();
    const session = schedule.sessions.find(
      (candidate) => candidate.id === "session_opening",
    );
    if (!session?.slot) throw new Error("Fixture session is not scheduled.");
    session.slot = {
      ...session.slot,
      endAt: "2026-09-15T17:30:00Z",
      startAt: "2026-09-15T17:00:00Z",
    };
    const unchanged = await buildCalendarInvitation({
      ...invitationInput(schedule, initial.intent),
      occurredAt: "2026-08-11T19:00:00.987Z",
    });

    expect(unchanged.disposition).toBe("unchanged");
    expect(unchanged.intent).toEqual(initial.intent);
    expect(timestamped.intent).toEqual(initial.intent);
  });

  it("requires canonical scheduled data and a prior invite for cancellation", async () => {
    await expect(
      buildCalendarInvitation({
        ...invitationInput(),
        sessionId: "session_small_models",
      }),
    ).rejects.toBeInstanceOf(CalendarScheduleUnavailableError);
    const initial = await buildCalendarInvitation(invitationInput());
    await expect(
      cancelCalendarInvitation({
        change: changeIntent("rescheduled"),
        previous: initial.intent,
      }),
    ).rejects.toThrow("Only canceled or unassigned changes");
    await expect(
      cancelCalendarInvitation({
        change: changeIntent("canceled"),
        previous: initial.intent,
      }),
    ).rejects.toThrow("does not match its prior invitation");
  });

  it("uses METHOD:REQUEST for canonical accepted scheduled sessions", async () => {
    const accepted = await buildCalendarInvitation({
      ...invitationInput(),
      attendee: { email: "noor@example.test", name: "Noor Malik" },
      sessionId: "session_benchmarks",
    });

    expect(accepted.intent.snapshot.method).toBe("REQUEST");
    expect(accepted.intent.snapshot.status).toBe("CONFIRMED");
    expect(accepted.intent.attachment.content).toContain("SEQUENCE:0");
  });

  it("keeps redacted import artifacts byte-identical to the renderer", async () => {
    const initial = await buildCalendarInvitation(invitationInput());
    const rescheduled = await buildCalendarInvitation({
      ...invitationInput(rescheduledSnapshot(), initial.intent),
      occurredAt: "2026-08-10T19:00:00.000Z",
    });
    const canceled = await cancelCalendarInvitation({
      change: changeIntent("canceled"),
      previous: rescheduled.intent,
    });
    const evidenceDirectory = resolve(
      process.cwd(),
      "examples/calendar-invitations/ral-58-stable-uid",
    );

    expect(
      readFileSync(
        resolve(evidenceDirectory, "01-initial-request.ics"),
        "utf8",
      ),
    ).toBe(initial.intent.attachment.content);
    expect(
      readFileSync(
        resolve(evidenceDirectory, "02-rescheduled-request.ics"),
        "utf8",
      ),
    ).toBe(rescheduled.intent.attachment.content);
    expect(
      readFileSync(resolve(evidenceDirectory, "03-cancellation.ics"), "utf8"),
    ).toBe(canceled.intent.attachment.content);
  });
});

describe("RFC 5545 rendering", () => {
  it("escapes text and parameters and folds UTF-8 without splitting code points", async () => {
    const initial = await buildCalendarInvitation({
      ...invitationInput(),
      attendee: {
        email: "speaker@example.test",
        name: 'Zoë ^ "Quoted"\nSpeaker',
      },
    });
    const snapshot: CalendarInvitationSnapshot = {
      ...initial.intent.snapshot,
      description:
        "Backslash \\, comma, semicolon; newline\n" +
        "🧪résumé—東京 ".repeat(30),
    };
    const attachment = renderCalendarAttachment(snapshot);
    const report = validateCalendarContent(attachment.content, snapshot);

    expect(report).toEqual({ errors: [], valid: true });
    expect(attachment.content).toContain(
      "ATTENDEE;CN=\"Zoë ^^ ^'Quoted^'^nSpeaker\";",
    );
    expect(attachment.content).toContain("DESCRIPTION:Backslash \\\\");
    expect(attachment.content).toContain("comma\\, semicolon\\; newline\\n");
    expect(
      physicalLines(attachment.content).every(
        (line) => new TextEncoder().encode(line).byteLength <= 75,
      ),
    ).toBe(true);
    expect(() => parseEvent(attachment.content)).not.toThrow();
  });

  it("handles DST offset transitions in event-zone copy", () => {
    expect(
      eventZoneHumanTime(
        "2026-03-08T09:30:00.000Z",
        "2026-03-08T10:30:00.000Z",
        "America/Los_Angeles",
      ),
    ).toContain("UTC-08:00 to UTC-07:00");
    expect(
      eventZoneHumanTime(
        "2026-11-01T08:30:00.000Z",
        "2026-11-01T10:30:00.000Z",
        "America/Los_Angeles",
      ),
    ).toContain("UTC-07:00 to UTC-08:00");
    expect(() =>
      eventZoneHumanTime(
        "2026-03-08T10:30:00.000Z",
        "2026-03-08T09:30:00.000Z",
        "America/Los_Angeles",
      ),
    ).toThrow("must end after it starts");
    expect(() =>
      allDayHumanTime("2026-03-02", "2026-03-01", "America/Los_Angeles"),
    ).toThrow("end date must be exclusive");
    expect(() =>
      allDayHumanTime("2026-02-31", "2026-03-02", "America/Los_Angeles"),
    ).toThrow("valid start date");
  });

  it.each([
    ["2028-02-29", "2028-03-01"],
    ["2026-12-31", "2027-01-01"],
    ["2026-09-15", "2026-09-17"],
  ])("renders exclusive all-day boundary %s to %s", async (start, end) => {
    const initial = await buildCalendarInvitation(invitationInput());
    const snapshot: CalendarInvitationSnapshot = {
      ...initial.intent.snapshot,
      humanTime: allDayHumanTime(start, end, "America/Los_Angeles"),
      time: { endDateExclusive: end, kind: "date", startDate: start },
    };
    const content = renderCalendarAttachment(snapshot).content;

    expect(content).toContain(
      `DTSTART;VALUE=DATE:${start.replaceAll("-", "")}`,
    );
    expect(content).toContain(`DTEND;VALUE=DATE:${end.replaceAll("-", "")}`);
    expect(() => parseEvent(content)).not.toThrow();
  });

  it("preserves byte limits and parser validity for arbitrary Unicode text", async () => {
    const initial = await buildCalendarInvitation(invitationInput());
    const scalar = fc
      .integer({ min: 0x20, max: 0x10ffff })
      .filter((value) => value < 0xd800 || value > 0xdfff)
      .map((value) => String.fromCodePoint(value));

    fc.assert(
      fc.property(fc.array(scalar, { maxLength: 180 }), (characters) => {
        const snapshot: CalendarInvitationSnapshot = {
          ...initial.intent.snapshot,
          description: characters.join(""),
        };
        const attachment = renderCalendarAttachment(snapshot);
        expect(
          physicalLines(attachment.content).every(
            (line) => new TextEncoder().encode(line).byteLength <= 75,
          ),
        ).toBe(true);
        expect(
          validateCalendarContent(attachment.content, snapshot).valid,
        ).toBe(true);
        expect(() => parseEvent(attachment.content)).not.toThrow();
      }),
      { numRuns: 150 },
    );
  });
});
