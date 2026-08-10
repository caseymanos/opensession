import { describe, expect, it } from "vitest";

import {
  createCloneConfigurationRequest,
  emptyEventSetup,
  formatEventDeadline,
  getSetupChecklist,
  seedEventSetup,
  validateEventSetup,
  type EventSetupDraft,
} from "./setupModel";

describe("event setup model", () => {
  it("treats the representative event as launch-ready", () => {
    expect(validateEventSetup(seedEventSetup)).toEqual({});
    expect(
      getSetupChecklist(seedEventSetup)
        .filter((item) => item.category === "blocking")
        .every((item) => item.complete),
    ).toBe(true);
  });

  it("explains every missing blocker for a new event", () => {
    const blocking = getSetupChecklist(emptyEventSetup).filter(
      (item) => item.category === "blocking",
    );

    expect(blocking).toHaveLength(5);
    expect(blocking.every((item) => !item.complete)).toBe(true);
    expect(blocking.every((item) => item.detail.length > 20)).toBe(true);
    expect(blocking.every((item) => item.href.startsWith("#"))).toBe(true);
  });

  it("rejects reversed windows and durations outside five-minute increments", () => {
    const invalid = {
      ...seedEventSetup,
      cfpClosesAt: seedEventSetup.cfpOpensAt,
      defaultDurationMinutes: 32,
      endsAt: seedEventSetup.startsAt,
      formats: [
        { durationMinutes: 7, id: "format-lightning", name: "Lightning" },
      ],
    } satisfies EventSetupDraft;

    expect(validateEventSetup(invalid)).toMatchObject({
      "cfp-closes": "CFP close must be after CFP open.",
      "default-duration":
        "Default duration must be 5–480 minutes in 5-minute increments.",
      "event-end": "Event end must be after event start.",
      "format-format-lightning-duration":
        "Duration must be 5–480 minutes in 5-minute increments.",
    });
  });

  it("renders CFP deadlines in the event timezone", () => {
    expect(
      formatEventDeadline(seedEventSetup.cfpClosesAt, seedEventSetup.timezone),
    ).toBe("August 12, 2026 at 11:59 PM PDT · America/Los_Angeles");
    expect(formatEventDeadline("not-a-date", "UTC")).toBeNull();
  });

  it("builds a configuration-only clone with deep-copied ordered settings", () => {
    const pollutedSource = {
      ...seedEventSetup,
      externalMappings: ["airtable-record"],
      secrets: ["never-copy"],
      submissions: ["submission-1"],
      users: ["user-1"],
    } as EventSetupDraft;
    const request = createCloneConfigurationRequest(pollutedSource, {
      name: "AI Engineer Summit Europe",
      slug: "ai-engineer-summit-europe",
    });

    expect(request.sourceEventId).toBe(seedEventSetup.eventId);
    expect(request.configuration.name).toBe("AI Engineer Summit Europe");
    expect(request.configuration.tracks).toEqual(
      seedEventSetup.tracks.map(({ color, name }) => ({ color, name })),
    );
    expect(request.configuration.tracks[0]).not.toHaveProperty("id");
    expect(Object.keys(request.configuration)).not.toEqual(
      expect.arrayContaining([
        "eventId",
        "externalMappings",
        "secrets",
        "submissions",
        "users",
      ]),
    );
  });
});
