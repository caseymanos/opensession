import {
  protectedPublicCfpSubmissionRequestSchema,
  protectedPublicCfpSubmissionUpdateRequestSchema,
} from "@sessionbox-killer/contracts";
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
    form_version: 2,
    mode: "submit" as const,
    participant_consent: true as const,
    participants: [
      {
        email: "speaker@example.test",
        id: "speaker-primary",
        name: "Sam Speaker",
        role: "Principal engineer",
      },
    ],
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
    oversized.answers.abstract = "A".repeat(20_001);
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
        routing: {
          default_reviewer_group_id: "group-ai",
          route_key: "ai-track-a",
          submission_track: "AI Engineering · Track A",
        },
      }).success,
    ).toBe(false);
    expect(
      protectedPublicCfpSubmissionRequestSchema.safeParse({
        ...submission(),
        turnstile_action: "sign_in",
      }).success,
    ).toBe(false);
  });

  it("requires participant consent and unique participant identities", () => {
    const withoutConsent = submission();
    expect(
      protectedPublicCfpSubmissionRequestSchema.safeParse({
        ...withoutConsent,
        participant_consent: false,
      }).success,
    ).toBe(false);
    const duplicate = submission();
    duplicate.participants.push({
      email: "co-speaker@example.test",
      id: duplicate.participants[0]?.id ?? "speaker-primary",
      name: "Co-speaker",
      role: "Engineer",
    });
    expect(
      protectedPublicCfpSubmissionRequestSchema.safeParse(duplicate).success,
    ).toBe(false);
  });

  it("allows bounded drafts without a reusable security token", () => {
    const draft = submission();
    const {
      participant_consent,
      turnstile_action,
      turnstile_token,
      ...withoutChallenge
    } = draft;
    void participant_consent;
    void turnstile_action;
    void turnstile_token;
    expect(
      protectedPublicCfpSubmissionRequestSchema.safeParse({
        ...withoutChallenge,
        answers: { title: "A partial proposal" },
        mode: "draft",
      }).success,
    ).toBe(true);
  });

  it("requires an exact projected version for owned updates", () => {
    const draft = submission();
    const {
      participant_consent,
      turnstile_action,
      turnstile_token,
      ...withoutChallenge
    } = draft;
    void participant_consent;
    void turnstile_action;
    void turnstile_token;
    const update = {
      ...withoutChallenge,
      expected_source_version: 3,
      mode: "draft" as const,
    };
    expect(
      protectedPublicCfpSubmissionUpdateRequestSchema.safeParse(update).success,
    ).toBe(true);
    const { expected_source_version, ...withoutVersion } = update;
    void expected_source_version;
    expect(
      protectedPublicCfpSubmissionUpdateRequestSchema.safeParse(withoutVersion)
        .success,
    ).toBe(false);
  });
});
