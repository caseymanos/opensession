import { describe, expect, it } from "vitest";

import { scheduleSnapshotFixture } from "@sessionbox-killer/contracts";

import {
  agendaLocalDateTimeToUtc,
  agendaScheduleView,
  readyAgendaScheduleView,
  scheduleSnapshotToAgendaView,
} from "./agendaModel";

describe("agenda schedule adapter", () => {
  it("derives concrete days, snap rows, rooms, and session placement", () => {
    expect(agendaScheduleView.days.map(({ date }) => date)).toEqual([
      "2026-08-18",
      "2026-08-19",
    ]);
    expect(agendaScheduleView.days[0]?.times).toContain("11:30 AM");
    expect(agendaScheduleView.snapMinutes).toBe(15);
    expect(agendaScheduleView.rooms.map(({ id }) => id)).toEqual([
      "cowell",
      "gallery",
      "firehouse",
    ]);
    expect(agendaScheduleView.unscheduled).toHaveLength(4);
    expect(agendaScheduleView.scheduled).toHaveLength(4);
    expect(readyAgendaScheduleView.scheduled).toHaveLength(8);
  });

  it("keeps RAL-60 overlap facts neutral until RAL-62 supplies diagnostics", () => {
    const view = scheduleSnapshotToAgendaView(scheduleSnapshotFixture);
    const overlap = view.scheduled.filter(
      (session) =>
        session.startAt === "2026-09-15T17:00:00.000Z" &&
        session.participants.some(({ personId }) => personId === "person_alex"),
    );
    expect(overlap).toHaveLength(2);
    expect(overlap.every(({ status }) => status === undefined)).toBe(true);
  });

  it("converts organizer-local form values to authoritative UTC commands", () => {
    expect(
      agendaLocalDateTimeToUtc("2026-08-18", "11:30 AM", "America/Los_Angeles"),
    ).toBe("2026-08-18T18:30:00.000Z");
  });
});
