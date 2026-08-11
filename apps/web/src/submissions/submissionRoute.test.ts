import { describe, expect, it } from "vitest";

import { organizerSubmissionRoute } from "./submissionRoute";

describe("organizer submission route", () => {
  it("resolves list and detail routes", () => {
    expect(
      organizerSubmissionRoute("/app/ai-engineer-summit/submissions"),
    ).toEqual({ eventKey: "ai-engineer-summit", submissionId: null });
    expect(
      organizerSubmissionRoute(
        "/app/ai-engineer-summit/submissions/submission_alpha",
      ),
    ).toEqual({
      eventKey: "ai-engineer-summit",
      submissionId: "submission_alpha",
    });
  });

  it("rejects fixtures and malformed paths", () => {
    expect(
      organizerSubmissionRoute("/fixtures/submissions/partial"),
    ).toBeNull();
    expect(
      organizerSubmissionRoute("/app/event/submissions/id/extra"),
    ).toBeNull();
    expect(organizerSubmissionRoute("/app/!/submissions")).toBeNull();
  });
});
