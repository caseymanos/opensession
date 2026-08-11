import { z } from "zod";

import { speakerPortalBrandSchema } from "./portal";

const reviewIdentifierSchema = z
  .string()
  .trim()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const reviewInstantSchema = z.iso.datetime({ offset: true });

export const reviewCriterionSchema = z
  .object({
    guidance: z.string().trim().min(1).max(4_000),
    id: reviewIdentifierSchema,
    label: z.string().trim().min(1).max(160),
    weight: z.int().min(1).max(100),
  })
  .strict();

export const reviewCriteriaSchema = z
  .array(reviewCriterionSchema)
  .min(1)
  .max(5)
  .superRefine((criteria, context) => {
    const ids = new Set(criteria.map(({ id }) => id));
    if (ids.size !== criteria.length) {
      context.addIssue({
        code: "custom",
        message: "Criterion IDs must be unique.",
      });
    }
    if (
      criteria.reduce((total, criterion) => total + criterion.weight, 0) !== 100
    ) {
      context.addIssue({
        code: "custom",
        message: "Criterion weights must total 100%.",
      });
    }
  });

export const reviewRubricSchema = z
  .object({
    criteria: reviewCriteriaSchema,
    id: reviewIdentifierSchema,
    name: z.string().trim().min(1).max(160),
    sourceVersion: z.int().positive(),
    version: z.int().positive(),
  })
  .strict();

export const reviewPersonSchema = z
  .object({
    displayName: z.string().trim().min(1).max(160),
    id: reviewIdentifierSchema,
  })
  .strict();

export const reviewerGroupSchema = z
  .object({
    id: reviewIdentifierSchema,
    members: z.array(reviewPersonSchema).max(256),
    name: z.string().trim().min(1).max(160),
    routeKey: reviewIdentifierSchema,
    sourceVersion: z.int().positive(),
    status: z.enum(["active", "archived"]),
  })
  .strict();

export const reviewAssignmentStatusSchema = z.enum([
  "conflict",
  "in_progress",
  "pending",
  "removed",
  "submitted",
]);

const reviewAssignmentSubmissionSchema = z
  .object({
    id: reviewIdentifierSchema,
    reference: z.string().trim().min(1).max(64),
    title: z.string().trim().min(1).max(300),
    track: z.string().trim().min(1).max(160).nullable(),
  })
  .strict();

export const reviewProposalSchema = reviewAssignmentSubmissionSchema.extend({
  reviewerGroupId: reviewIdentifierSchema,
  routeKey: reviewIdentifierSchema,
});

export const reviewAssignmentAuditEntrySchema = z
  .object({
    action: z.enum([
      "reviews.assignment.conflict",
      "reviews.assignment.create",
      "reviews.assignment.remove",
      "reviews.assignment.restore",
      "reviews.review.reopen",
      "reviews.review.submit",
    ]),
    actorDisplayName: z.string().trim().min(1).max(160),
    at: reviewInstantSchema,
    id: reviewIdentifierSchema,
    reason: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

export const reviewAssignmentSchema = z
  .object({
    assignedAt: reviewInstantSchema,
    audit: z.array(reviewAssignmentAuditEntrySchema).max(50),
    conflictNote: z.string().trim().max(2_000).nullable(),
    id: reviewIdentifierSchema,
    reviewer: reviewPersonSchema,
    reviewerGroupId: reviewIdentifierSchema,
    rubric: reviewRubricSchema.omit({ sourceVersion: true }),
    scoringRequired: z.boolean(),
    sourceVersion: z.int().positive(),
    status: reviewAssignmentStatusSchema,
    submission: reviewAssignmentSubmissionSchema,
    updatedAt: reviewInstantSchema,
  })
  .strict()
  .superRefine((assignment, context) => {
    if (assignment.status === "conflict" && assignment.scoringRequired) {
      context.addIssue({
        code: "custom",
        message: "A conflicted assignment cannot require scoring.",
      });
    }
    if (assignment.status === "removed" && assignment.scoringRequired) {
      context.addIssue({
        code: "custom",
        message: "A removed assignment cannot require scoring.",
      });
    }
  });

export const reviewScoreSchema = z
  .object({
    criterionId: reviewIdentifierSchema,
    score: z.int().min(1).max(5),
  })
  .strict();

export const reviewDraftSchema = z
  .object({
    note: z.string().trim().max(10_000),
    scores: z.array(reviewScoreSchema).max(5),
  })
  .strict()
  .superRefine((draft, context) => {
    if (
      new Set(draft.scores.map(({ criterionId }) => criterionId)).size !==
      draft.scores.length
    ) {
      context.addIssue({
        code: "custom",
        message: "A review criterion can be scored only once.",
        path: ["scores"],
      });
    }
  });

export const reviewerProposalContextSchema = z
  .object({
    abstract: z.string().trim().max(20_000).nullable(),
    audience: z.string().trim().max(10_000).nullable(),
    format: z.string().trim().max(300).nullable(),
    outcomes: z.array(z.string().trim().min(1).max(2_000)).max(20),
  })
  .strict();

export const reviewerWorkspaceAssignmentSchema = z
  .object({
    assignment: reviewAssignmentSchema,
    context: reviewerProposalContextSchema,
    draft: reviewDraftSchema,
    submittedAt: reviewInstantSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const criterionIds = new Set(
      value.assignment.rubric.criteria.map(({ id }) => id),
    );
    const scoreIds = new Set(
      value.draft.scores.map(({ criterionId }) => criterionId),
    );
    if ([...scoreIds].some((id) => !criterionIds.has(id))) {
      context.addIssue({
        code: "custom",
        message: "Review scores must use the assignment rubric snapshot.",
        path: ["draft", "scores"],
      });
    }
    if (value.assignment.status === "submitted") {
      if (value.submittedAt === null) {
        context.addIssue({
          code: "custom",
          message: "A submitted review must include its submission time.",
          path: ["submittedAt"],
        });
      }
      if (scoreIds.size !== criterionIds.size) {
        context.addIssue({
          code: "custom",
          message: "A submitted review must score every criterion.",
          path: ["draft", "scores"],
        });
      }
    } else if (value.submittedAt !== null) {
      context.addIssue({
        code: "custom",
        message: "Only a submitted review can include a submission time.",
        path: ["submittedAt"],
      });
    }
  });

export const reviewOperationsResponseSchema = z
  .object({
    activeRubric: reviewRubricSchema,
    assignments: z.array(reviewAssignmentSchema).max(2_000),
    eventId: reviewIdentifierSchema,
    groups: z.array(reviewerGroupSchema).max(128),
    proposals: z.array(reviewProposalSchema).max(2_000),
    reviewers: z.array(reviewPersonSchema).max(2_000),
  })
  .strict();

const reviewCommandBaseSchema = z.object({
  commandId: reviewIdentifierSchema,
  expectedVersion: z.int().nonnegative(),
});

export const publishReviewRubricCommandSchema = reviewCommandBaseSchema
  .extend({
    criteria: reviewCriteriaSchema,
    name: z.string().trim().min(1).max(160),
    rubricId: reviewIdentifierSchema,
    type: z.literal("publish_rubric"),
  })
  .strict();

export const upsertReviewerGroupCommandSchema = reviewCommandBaseSchema
  .extend({
    groupId: reviewIdentifierSchema,
    memberIds: z.array(reviewIdentifierSchema).max(256),
    name: z.string().trim().min(1).max(160),
    routeKey: reviewIdentifierSchema,
    status: z.literal("active").default("active"),
    type: z.literal("upsert_group"),
  })
  .strict()
  .superRefine((command, context) => {
    if (new Set(command.memberIds).size !== command.memberIds.length) {
      context.addIssue({
        code: "custom",
        message: "Reviewer group members must be unique.",
      });
    }
  });

export const assignReviewerCommandSchema = reviewCommandBaseSchema
  .extend({
    assignmentId: reviewIdentifierSchema,
    reviewerGroupId: reviewIdentifierSchema,
    reviewerId: reviewIdentifierSchema,
    submissionId: reviewIdentifierSchema,
    type: z.literal("assign_reviewer"),
  })
  .strict();

export const removeReviewAssignmentCommandSchema = reviewCommandBaseSchema
  .extend({
    assignmentId: reviewIdentifierSchema,
    type: z.literal("remove_assignment"),
  })
  .strict();

export const discloseReviewConflictCommandSchema = reviewCommandBaseSchema
  .extend({
    assignmentId: reviewIdentifierSchema,
    note: z.string().trim().min(1).max(2_000),
    type: z.literal("disclose_conflict"),
  })
  .strict();

const reviewDraftCommandFields = {
  assignmentId: reviewIdentifierSchema,
  draft: reviewDraftSchema,
};

export const saveReviewDraftCommandSchema = reviewCommandBaseSchema
  .extend({
    ...reviewDraftCommandFields,
    type: z.literal("save_review_draft"),
  })
  .strict();

export const submitReviewCommandSchema = reviewCommandBaseSchema
  .extend({
    ...reviewDraftCommandFields,
    type: z.literal("submit_review"),
  })
  .strict();

export const reopenReviewCommandSchema = reviewCommandBaseSchema
  .extend({
    assignmentId: reviewIdentifierSchema,
    reason: z.string().trim().min(1).max(2_000),
    type: z.literal("reopen_review"),
  })
  .strict();

export const reviewScoringCommandSchema = z.discriminatedUnion("type", [
  saveReviewDraftCommandSchema,
  submitReviewCommandSchema,
  reopenReviewCommandSchema,
]);

export const reviewOperationsCommandSchema = z.discriminatedUnion("type", [
  publishReviewRubricCommandSchema,
  upsertReviewerGroupCommandSchema,
  assignReviewerCommandSchema,
  removeReviewAssignmentCommandSchema,
  discloseReviewConflictCommandSchema,
]);

export const reviewOperationsCommandResultSchema = z
  .object({
    appliedAt: reviewInstantSchema,
    commandId: reviewIdentifierSchema,
    entityId: reviewIdentifierSchema,
    entityType: z.enum(["assignment", "group", "rubric", "submission"]),
    outcome: z.enum(["applied", "replayed"]),
    projection: z.enum(["durable", "repair_pending"]),
    version: z.int().positive(),
  })
  .strict();

export const reviewOperationsCommandResponseSchema = z.discriminatedUnion(
  "ok",
  [
    z
      .object({
        ok: z.literal(true),
        result: reviewOperationsCommandResultSchema,
      })
      .strict(),
    z
      .object({
        error: z
          .object({
            actualVersion: z.int().nonnegative().optional(),
            code: z.string().trim().min(1).max(120),
            commandId: reviewIdentifierSchema.optional(),
            expectedVersion: z.int().nonnegative().optional(),
            field: z.string().trim().min(1).max(160).optional(),
            message: z.string().trim().min(1).max(2_000),
          })
          .strict(),
        ok: z.literal(false),
      })
      .strict(),
  ],
);

export const reviewerAssignmentListResponseSchema = z
  .object({
    assignments: z.array(reviewerWorkspaceAssignmentSchema).max(2_000),
    event: z
      .object({
        brand: speakerPortalBrandSchema,
        id: reviewIdentifierSchema,
        name: z.string().trim().min(1).max(200),
        reviewDueAt: reviewInstantSchema.nullable(),
        slug: z.string().trim().min(1).max(128),
        timezone: z.string().trim().min(1).max(100),
      })
      .strict(),
    reviewer: reviewPersonSchema,
  })
  .strict();

export type ReviewCriterion = z.infer<typeof reviewCriterionSchema>;
export type ReviewRubric = z.infer<typeof reviewRubricSchema>;
export type ReviewerGroup = z.infer<typeof reviewerGroupSchema>;
export type ReviewProposal = z.infer<typeof reviewProposalSchema>;
export type ReviewAssignment = z.infer<typeof reviewAssignmentSchema>;
export type ReviewDraft = z.infer<typeof reviewDraftSchema>;
export type ReviewScore = z.infer<typeof reviewScoreSchema>;
export type ReviewerWorkspaceAssignment = z.infer<
  typeof reviewerWorkspaceAssignmentSchema
>;
export type ReviewOperationsResponse = z.infer<
  typeof reviewOperationsResponseSchema
>;
export type ReviewOperationsCommand = z.infer<
  typeof reviewOperationsCommandSchema
>;
export type ReviewOperationsCommandResult = z.infer<
  typeof reviewOperationsCommandResultSchema
>;
export type ReviewScoringCommand = z.infer<typeof reviewScoringCommandSchema>;
export type ReviewerAssignmentListResponse = z.infer<
  typeof reviewerAssignmentListResponseSchema
>;
