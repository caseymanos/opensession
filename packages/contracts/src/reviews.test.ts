import { describe, expect, it } from "vitest";

import {
  reviewAssignmentSchema,
  reviewCriteriaSchema,
  reviewOperationsResponseSchema,
  reviewScoringCommandSchema,
  reviewerWorkspaceAssignmentSchema,
} from "./index";

const criteria = [
  {
    guidance: "Assess audience value.",
    id: "value",
    label: "Value",
    weight: 60,
  },
  {
    guidance: "Assess evidence.",
    id: "evidence",
    label: "Evidence",
    weight: 40,
  },
];

const assignment = {
  assignedAt: "2026-08-11T12:00:00.000Z",
  audit: [
    {
      action: "reviews.assignment.create",
      actorDisplayName: "Owen Organizer",
      at: "2026-08-11T12:00:00.000Z",
      id: "audit_assignment_create",
    },
  ],
  conflictNote: null,
  id: "assignment_one",
  reviewer: { displayName: "Riley Reviewer", id: "reviewer_one" },
  reviewerGroupId: "group_one",
  rubric: { criteria, id: "rubric_one", name: "Program quality", version: 2 },
  scoringRequired: true,
  sourceVersion: 1,
  status: "pending",
  submission: {
    id: "submission_one",
    reference: "SUB-001",
    title: "Reliable agents",
    track: "Reliability",
  },
  updatedAt: "2026-08-11T12:00:00.000Z",
};

describe("review operations contract", () => {
  it("preserves ordered criteria while enforcing one to five unique weights totaling 100", () => {
    expect(reviewCriteriaSchema.parse(criteria).map(({ id }) => id)).toEqual([
      "value",
      "evidence",
    ]);
    expect(
      reviewCriteriaSchema.safeParse([
        ...criteria,
        { ...criteria[0], weight: 1 },
      ]).success,
    ).toBe(false);
    expect(
      reviewCriteriaSchema.safeParse([{ ...criteria[0], weight: 99 }]).success,
    ).toBe(false);
  });

  it("rejects scoring requirements for removed or conflicted assignments", () => {
    expect(reviewAssignmentSchema.safeParse(assignment).success).toBe(true);
    expect(
      reviewAssignmentSchema.safeParse({
        ...assignment,
        conflictNote: "Prior collaborator",
        status: "conflict",
      }).success,
    ).toBe(false);
  });

  it("requires routable proposal candidates and provider-neutral audit history", () => {
    const response = {
      activeRubric: {
        criteria,
        id: "rubric_one",
        name: "Program quality",
        sourceVersion: 2,
        version: 2,
      },
      assignments: [assignment],
      eventId: "event_one",
      groups: [
        {
          id: "group_one",
          members: [assignment.reviewer],
          name: "Reliability reviewers",
          routeKey: "reliability",
          sourceVersion: 1,
          status: "active",
        },
      ],
      proposals: [
        {
          ...assignment.submission,
          reviewerGroupId: "group_one",
          routeKey: "reliability",
        },
      ],
      reviewers: [assignment.reviewer],
    };
    expect(reviewOperationsResponseSchema.safeParse(response).success).toBe(
      true,
    );
    expect(
      reviewOperationsResponseSchema.safeParse({
        ...response,
        providerRecordId: "rec_private",
      }).success,
    ).toBe(false);
  });

  it("requires complete immutable-rubric scores only when submitting", () => {
    const workspaceAssignment = {
      assignment: { ...assignment, status: "submitted" },
      context: {
        abstract: "A proposal abstract.",
        audience: null,
        format: "Talk",
        outcomes: ["Apply one pattern."],
      },
      draft: {
        note: "Strong evidence.",
        scores: [
          { criterionId: "value", score: 4 },
          { criterionId: "evidence", score: 5 },
        ],
      },
      submittedAt: "2026-08-11T13:00:00.000Z",
    };
    expect(
      reviewerWorkspaceAssignmentSchema.safeParse(workspaceAssignment).success,
    ).toBe(true);
    expect(
      reviewerWorkspaceAssignmentSchema.safeParse({
        ...workspaceAssignment,
        draft: {
          ...workspaceAssignment.draft,
          scores: workspaceAssignment.draft.scores.slice(0, 1),
        },
      }).success,
    ).toBe(false);
    expect(
      reviewScoringCommandSchema.safeParse({
        assignmentId: "assignment_one",
        commandId: "command_submit_one",
        draft: workspaceAssignment.draft,
        expectedVersion: 2,
        type: "submit_review",
      }).success,
    ).toBe(true);
  });
});
