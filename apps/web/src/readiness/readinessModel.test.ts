import { describe, expect, it } from "vitest";

import { scheduleSnapshotFixture } from "@sessionbox-killer/contracts";

import {
  agendaSpeakerScheduleFacts,
  speakerReadinessFixture,
  speakerScheduleFactsFromSnapshot,
} from "./readinessModel";

describe("readiness schedule facts adapter", () => {
  it("derives accepted-unscheduled and speaker-session facts from RAL-60", () => {
    expect(agendaSpeakerScheduleFacts.acceptedUnscheduledCount).toBe(4);
    expect(
      agendaSpeakerScheduleFacts.sessionTitlesBySpeakerId.get("speaker-priya"),
    ).toEqual(["Your Eval Suite Is Lying to You"]);
    expect(
      speakerReadinessFixture.find(({ id }) => id === "speaker-mina")?.sessions,
    ).toEqual(["The Reliability Gap in Production Agents"]);
  });

  it("does not treat moderator or chair roles as speaker readiness policy", () => {
    const facts = speakerScheduleFactsFromSnapshot(scheduleSnapshotFixture);
    expect(facts.sessionTitlesBySpeakerId.get("person_alex")).toEqual([
      "Opening the reliable-agent stack",
    ]);
    expect(facts.sessionTitlesBySpeakerId.get("person_elena")).toBeUndefined();
  });
});
