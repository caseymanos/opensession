import { describe, expect, it } from "vitest";

import { reviewWorkspaceEventKey } from "./reviewRoute";

describe("review workspace route", () => {
  it("reads direct and refreshed event review paths", () => {
    expect(reviewWorkspaceEventKey("/app/event_alpha/reviews")).toBe(
      "event_alpha",
    );
    expect(reviewWorkspaceEventKey("/app/ai-engineer-summit/reviews/")).toBe(
      "ai-engineer-summit",
    );
  });

  it("rejects unrelated, nested, and malformed paths", () => {
    expect(reviewWorkspaceEventKey("/review/event_alpha")).toBeNull();
    expect(
      reviewWorkspaceEventKey("/app/event_alpha/reviews/history"),
    ).toBeNull();
    expect(reviewWorkspaceEventKey("/app/%E0%A4%A/reviews")).toBeNull();
  });
});
