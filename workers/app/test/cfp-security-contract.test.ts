import { protectedPublicCfpSubmissionRequestSchema } from "@sessionbox-killer/contracts";
import { describe, expect, it } from "vitest";

function submission() {
  return {
    answers: {
      abstract: "A".repeat(120),
      format: "30-minute talk",
      outcomes: "Attendees can apply the method.",
      title: "A bounded proposal",
      track: "AI Engineering",
      workshop_prerequisites: "",
    },
    participants: [
      {
        email: "speaker@example.test",
        id: "speaker-primary",
        name: "Sam Speaker",
        role: "Principal engineer",
      },
    ],
    routing: {
      default_reviewer_group_id: "group-ai",
      route_key: "ai-track-a",
      submission_track: "AI Engineering · Track A",
    },
    turnstile_action: "cfp_submit",
    turnstile_token: "XXXX.DUMMY.TOKEN.XXXX",
  };
}

describe("protected CFP submission contract", () => {
  it("accepts one bounded canonical submission", () => {
    expect(
      protectedPublicCfpSubmissionRequestSchema.safeParse(submission()).success,
    ).toBe(true);
  });

  it("rejects oversized fields and participant lists", () => {
    const oversized = submission();
    oversized.answers.abstract = "A".repeat(12_001);
    expect(
      protectedPublicCfpSubmissionRequestSchema.safeParse(oversized).success,
    ).toBe(false);

    const crowded = submission();
    crowded.participants = Array.from({ length: 9 }, (_, index) => ({
      email: `speaker-${index}@example.test`,
      id: `speaker-${index}`,
      name: `Speaker ${index}`,
      role: "Engineer",
    }));
    expect(
      protectedPublicCfpSubmissionRequestSchema.safeParse(crowded).success,
    ).toBe(false);
  });

  it("rejects unknown payload fields and the wrong challenge action", () => {
    expect(
      protectedPublicCfpSubmissionRequestSchema.safeParse({
        ...submission(),
        organizer_override: true,
      }).success,
    ).toBe(false);
    expect(
      protectedPublicCfpSubmissionRequestSchema.safeParse({
        ...submission(),
        turnstile_action: "sign_in",
      }).success,
    ).toBe(false);
  });
});
