import { describe, expect, it } from "vitest";

import {
  decisionWorkspaceResponseSchema,
  recordDecisionCommandSchema,
} from "./decisions";

describe("decision contracts", () => {
  it("requires a template only when a message intent is queued", () => {
    const command = {
      audience: "Primary speaker",
      commandId: "decision_command_alpha",
      decision: "accepted",
      expectedVersion: 1,
      messageMode: "send_queued",
      privateNote: "Anchor the reliability track.",
      reason: "Strong program fit",
      submissionId: "submission_alpha",
      template: null,
      type: "record_decision",
    };
    expect(recordDecisionCommandSchema.safeParse(command).success).toBe(false);
    expect(
      recordDecisionCommandSchema.parse({
        ...command,
        template: "Accept · AI Engineer Summit",
      }),
    ).toMatchObject({ decision: "accepted", expectedVersion: 1 });
    expect(
      recordDecisionCommandSchema.safeParse({
        ...command,
        messageMode: "recorded_only",
        template: "Accept · AI Engineer Summit",
      }).success,
    ).toBe(false);
  });

  it("accepts transparent submitted, missing, and conflict evidence", () => {
    expect(
      decisionWorkspaceResponseSchema.parse({
        actor: "Owen Organizer",
        eventId: "event_alpha",
        eventName: "OpenSession Summit",
        submissions: [
          {
            aggregateScore: 4.4,
            decision: "undecided",
            format: "Talk",
            history: [],
            id: "submission_alpha",
            reference: "SUB-001",
            reviews: [
              {
                conflictReason: null,
                criteria: [
                  {
                    criterionId: "criterion_value",
                    label: "Audience value",
                    score: 4,
                    weight: 60,
                  },
                ],
                id: "review_submitted",
                note: null,
                overallScore: 4,
                reviewer: "Riley Reviewer",
                status: "submitted",
                submittedAt: "2026-08-11T12:00:00.000Z",
              },
              {
                conflictReason: "Prior collaborator",
                criteria: [],
                id: "review_conflict",
                note: null,
                overallScore: null,
                reviewer: "Morgan Reviewer",
                status: "conflict",
                submittedAt: null,
              },
            ],
            sourceVersion: 1,
            speakerCount: 1,
            title: "Reliable agents",
            track: "Reliability",
          },
        ],
      }).submissions[0],
    ).toMatchObject({ aggregateScore: 4.4, decision: "undecided" });
  });
});
