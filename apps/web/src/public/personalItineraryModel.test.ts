import { describe, expect, it } from "vitest";

import { publicScheduleProjectionFixture } from "./publicScheduleModel";
import {
  buildItineraryCalendar,
  findItineraryConflicts,
  personalItineraryStorageKey,
  restorePersonalItinerary,
  selectedSessionsForItinerary,
  serializePersonalItinerary,
} from "./personalItineraryModel";

const currentSessionIds = [
  "opening-state-ai-engineering",
  "benchmarks-after-benchmark",
] as const;

describe("personal itinerary persistence", () => {
  it("round-trips an event-scoped selection", () => {
    const raw = serializePersonalItinerary(
      publicScheduleProjectionFixture,
      currentSessionIds,
    );
    const restored = restorePersonalItinerary(
      raw,
      publicScheduleProjectionFixture,
    );

    expect(restored).toEqual({
      removedCount: 0,
      sessionIds: currentSessionIds,
      shouldPersist: false,
    });
    expect(
      personalItineraryStorageKey(publicScheduleProjectionFixture.event.slug),
    ).toBe("opensession.personal-itinerary.v1:ai-engineer-summit");
  });

  it("drops stale, canceled, superseded, duplicate, and cross-event data", () => {
    const stale = JSON.stringify({
      eventSlug: publicScheduleProjectionFixture.event.slug,
      publicationVersion: 3,
      sessionIds: [
        currentSessionIds[0],
        currentSessionIds[0],
        "agent-runtime-product-v3",
        "canceled-eval-patterns",
      ],
      version: 1,
    });

    expect(
      restorePersonalItinerary(stale, publicScheduleProjectionFixture),
    ).toEqual({
      removedCount: 2,
      sessionIds: [currentSessionIds[0]],
      shouldPersist: true,
    });

    expect(
      restorePersonalItinerary(
        JSON.stringify({
          eventSlug: "another-event",
          publicationVersion: 4,
          sessionIds: currentSessionIds,
          version: 1,
        }),
        publicScheduleProjectionFixture,
      ),
    ).toEqual({ removedCount: 0, sessionIds: [], shouldPersist: true });
  });

  it("recovers safely from malformed storage", () => {
    expect(
      restorePersonalItinerary("not-json", publicScheduleProjectionFixture),
    ).toEqual({ removedCount: 0, sessionIds: [], shouldPersist: true });
  });
});

describe("personal itinerary planning", () => {
  it("sorts selected sessions and reports time overlaps", () => {
    const selected = selectedSessionsForItinerary(
      publicScheduleProjectionFixture,
      new Set(currentSessionIds),
    );

    expect(selected.map((session) => session.id)).toEqual([
      currentSessionIds[0],
      currentSessionIds[1],
    ]);
    const [first, second] = selected;
    if (!first || !second) {
      throw new Error("Expected both selected fixture sessions");
    }
    expect(
      findItineraryConflicts([
        { ...first, endAt: "2026-08-18T10:00:00-07:00" },
        second,
      ]),
    ).toEqual([
      {
        firstSessionId: currentSessionIds[0],
        secondSessionId: currentSessionIds[1],
      },
    ]);
  });

  it("exports every selected session with stable event-scoped UIDs", () => {
    const selected = selectedSessionsForItinerary(
      publicScheduleProjectionFixture,
      new Set(currentSessionIds),
    );
    const calendar = buildItineraryCalendar(
      publicScheduleProjectionFixture,
      selected,
    );

    expect(calendar.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(calendar).toContain(
      "UID:opening-state-ai-engineering.ai-engineer-summit@opensession.dev",
    );
    expect(calendar).toContain(
      "UID:benchmarks-after-benchmark.ai-engineer-summit@opensession.dev",
    );
    expect(calendar).toContain("DTSTART:20260818T160000Z");
    expect(calendar.endsWith("\r\n")).toBe(true);
  });
});
