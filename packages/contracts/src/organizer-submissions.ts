import { z } from "zod";

const submissionIdentifierSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const submissionInstantSchema = z.iso.datetime({ offset: true });

export const organizerSubmissionStatusSchema = z.enum([
  "draft",
  "submitted",
  "in_review",
  "accepted",
  "waitlisted",
  "declined",
  "withdrawn",
]);

export const organizerSubmissionCommandTypeSchema = z.enum([
  "start_review",
  "reopen",
  "withdraw",
  "add_note",
]);

export const organizerSubmissionProjectionSchema = z
  .object({
    asOf: submissionInstantSchema,
    pendingRepairs: z.int().nonnegative(),
    reasons: z
      .array(
        z.enum([
          "repair_pending",
          "synchronization_delayed",
          "upstream_rebuilding",
        ]),
      )
      .max(3),
    state: z.enum(["current", "stale", "partial"]),
  })
  .strict()
  .superRefine((projection, context) => {
    if (projection.state === "current" && projection.reasons.length > 0) {
      context.addIssue({
        code: "custom",
        message: "A current projection cannot include degraded-state reasons.",
      });
    }
    if (projection.state !== "current" && projection.reasons.length === 0) {
      context.addIssue({
        code: "custom",
        message: "A degraded projection must explain why it is degraded.",
      });
    }
  });

const organizerIdentitySchema = z
  .object({
    displayName: z.string().trim().min(1).max(160),
    id: submissionIdentifierSchema,
  })
  .strict();

const organizerContactIdentitySchema = organizerIdentitySchema.extend({
  company: z.string().trim().max(160).nullable(),
  email: z.email().trim().max(320),
  title: z.string().trim().max(160).nullable(),
});

const organizerSubmissionTrackSchema = z
  .object({
    id: submissionIdentifierSchema,
    name: z.string().trim().min(1).max(160),
  })
  .strict();

const organizerSubmissionRoutingSchema = z
  .object({
    reviewerGroupId: submissionIdentifierSchema.nullable(),
    routeKey: submissionIdentifierSchema.nullable(),
  })
  .strict();

const organizerSubmissionReviewProgressSchema = z
  .object({
    aggregateScore: z.number().finite().nullable(),
    assigned: z.int().nonnegative(),
    submitted: z.int().nonnegative(),
  })
  .strict()
  .refine((progress) => progress.submitted <= progress.assigned, {
    message: "Submitted reviews cannot exceed assigned reviews.",
  });

export const organizerSubmissionListRowSchema = z
  .object({
    id: submissionIdentifierSchema,
    lastActivityAt: submissionInstantSchema,
    reference: z.string().trim().min(1).max(64),
    reviews: organizerSubmissionReviewProgressSchema,
    routing: organizerSubmissionRoutingSchema,
    status: organizerSubmissionStatusSchema,
    submitter: organizerContactIdentitySchema,
    title: z.string().trim().min(1).max(300),
    track: organizerSubmissionTrackSchema.nullable(),
    version: z.int().positive(),
  })
  .strict();

export const organizerSubmissionListQuerySchema = z
  .object({
    cursor: z
      .string()
      .min(1)
      .max(1_024)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    pageSize: z.int().min(1).max(100).default(50),
    search: z.string().trim().min(1).max(160).optional(),
    status: organizerSubmissionStatusSchema.optional(),
    track: submissionIdentifierSchema.optional(),
  })
  .strict();

export const organizerSubmissionListResponseSchema = z
  .object({
    eventId: submissionIdentifierSchema,
    items: z.array(organizerSubmissionListRowSchema).max(100),
    nextCursor: z.string().min(1).max(1_024).nullable(),
    projection: organizerSubmissionProjectionSchema,
  })
  .strict();

const organizerSubmissionAnswerValueSchema = z.union([
  z.string().max(20_000),
  z.boolean(),
  z.array(z.string().max(2_048)).max(128),
]);

export const organizerSubmissionAnswerSchema = z
  .object({
    fieldKey: submissionIdentifierSchema,
    fieldType: z.string().trim().min(1).max(80),
    label: z.string().trim().min(1).max(240),
    order: z.int().nonnegative(),
    redacted: z.boolean(),
    value: organizerSubmissionAnswerValueSchema.nullable(),
  })
  .strict()
  .refine((answer) => answer.redacted === (answer.value === null), {
    message: "Only redacted answers can omit their value.",
  });

export const organizerSubmissionAnswerSnapshotSchema = z
  .object({
    answers: z.array(organizerSubmissionAnswerSchema).max(128),
    formVersion: z.int().positive(),
    state: z.enum(["draft", "submitted"]),
  })
  .strict();

export const organizerSubmissionParticipantSchema = z
  .object({
    contact: organizerContactIdentitySchema,
    id: submissionIdentifierSchema,
    isPrimary: z.boolean(),
    order: z.int().nonnegative(),
    role: z.string().trim().min(1).max(160),
  })
  .strict();

export const organizerSubmissionReviewSchema = z
  .object({
    conflict: z.boolean(),
    id: submissionIdentifierSchema,
    reviewer: organizerIdentitySchema,
    score: z.number().finite().nullable(),
    status: z.enum(["assigned", "draft", "submitted", "withdrawn"]),
    submittedAt: submissionInstantSchema.nullable(),
    summary: z.string().max(4_000).nullable(),
    updatedAt: submissionInstantSchema,
  })
  .strict();

export const organizerSubmissionNoteSchema = z
  .object({
    actor: organizerIdentitySchema,
    body: z.string().trim().min(1).max(4_000),
    createdAt: submissionInstantSchema,
    id: submissionIdentifierSchema,
    version: z.int().positive(),
  })
  .strict();

export const organizerSubmissionHistoryEntrySchema = z
  .object({
    action: organizerSubmissionCommandTypeSchema,
    actor: organizerIdentitySchema,
    commandId: submissionIdentifierSchema,
    createdAt: submissionInstantSchema,
    fromStatus: organizerSubmissionStatusSchema.nullable(),
    id: submissionIdentifierSchema,
    reason: z.string().trim().min(1).max(2_000).nullable(),
    toStatus: organizerSubmissionStatusSchema.nullable(),
  })
  .strict();

export const organizerSubmissionDetailSchema = z
  .object({
    allowedCommands: z.array(organizerSubmissionCommandTypeSchema).max(4),
    answerSnapshot: organizerSubmissionAnswerSnapshotSchema,
    history: z.array(organizerSubmissionHistoryEntrySchema).max(200),
    notes: z.array(organizerSubmissionNoteSchema).max(100),
    participants: z.array(organizerSubmissionParticipantSchema).max(32),
    projection: organizerSubmissionProjectionSchema,
    reviews: z.array(organizerSubmissionReviewSchema).max(256),
    submission: organizerSubmissionListRowSchema,
    submittedAt: submissionInstantSchema.nullable(),
  })
  .strict();

const organizerSubmissionCommandBaseSchema = z.object({
  commandId: submissionIdentifierSchema,
  expectedVersion: z.int().positive(),
  submissionId: submissionIdentifierSchema,
});

const organizerSubmissionReasonSchema = z.string().trim().min(1).max(2_000);

export const organizerStartReviewCommandSchema =
  organizerSubmissionCommandBaseSchema
    .extend({
      reason: organizerSubmissionReasonSchema,
      type: z.literal("start_review"),
    })
    .strict();

export const organizerReopenSubmissionCommandSchema =
  organizerSubmissionCommandBaseSchema
    .extend({
      reason: organizerSubmissionReasonSchema,
      type: z.literal("reopen"),
    })
    .strict();

export const organizerWithdrawSubmissionCommandSchema =
  organizerSubmissionCommandBaseSchema
    .extend({
      reason: organizerSubmissionReasonSchema,
      type: z.literal("withdraw"),
    })
    .strict();

export const organizerAddSubmissionNoteCommandSchema =
  organizerSubmissionCommandBaseSchema
    .extend({
      body: z.string().trim().min(1).max(4_000),
      type: z.literal("add_note"),
    })
    .strict();

export const organizerSubmissionCommandSchema = z.discriminatedUnion("type", [
  organizerStartReviewCommandSchema,
  organizerReopenSubmissionCommandSchema,
  organizerWithdrawSubmissionCommandSchema,
  organizerAddSubmissionNoteCommandSchema,
]);

export const organizerSubmissionCommandResultSchema = z
  .object({
    appliedAt: submissionInstantSchema,
    commandId: submissionIdentifierSchema,
    note: organizerSubmissionNoteSchema.nullable(),
    outcome: z.enum(["applied", "replayed"]),
    projection: z.enum(["durable", "repair_pending"]),
    status: organizerSubmissionStatusSchema,
    submissionId: submissionIdentifierSchema,
    version: z.int().positive(),
  })
  .strict();

export const organizerSubmissionValidationReasonSchema = z.enum([
  "illegal_transition",
  "invalid_command",
  "invalid_cursor",
  "invalid_query",
]);

export const organizerSubmissionValidationErrorSchema = z
  .object({
    code: z.literal("submission_validation_error"),
    field: z.string().min(1).max(240),
    message: z.string().min(1).max(1_000),
    reason: organizerSubmissionValidationReasonSchema,
  })
  .strict();

export const organizerSubmissionVersionConflictErrorSchema = z
  .object({
    actualVersion: z.int().positive(),
    code: z.literal("submission_version_conflict"),
    expectedVersion: z.int().positive(),
    message: z.string().min(1).max(1_000),
  })
  .strict();

export const organizerSubmissionIdempotencyConflictErrorSchema = z
  .object({
    code: z.literal("submission_idempotency_conflict"),
    commandId: submissionIdentifierSchema,
    message: z.string().min(1).max(1_000),
  })
  .strict();

export const organizerSubmissionSimpleErrorSchema = z
  .object({
    code: z.enum([
      "ambiguous_event_slug",
      "forbidden",
      "invalid_csrf",
      "invalid_origin",
      "invalid_session",
      "request_too_large",
      "submission_authority_unavailable",
      "submission_not_found",
      "submission_projection_unavailable",
      "writes_disabled",
    ]),
    message: z.string().min(1).max(1_000),
  })
  .strict();

export const organizerSubmissionCommandErrorSchema = z.union([
  organizerSubmissionValidationErrorSchema,
  organizerSubmissionVersionConflictErrorSchema,
  organizerSubmissionIdempotencyConflictErrorSchema,
]);

export const organizerSubmissionErrorSchema = z.union([
  organizerSubmissionCommandErrorSchema,
  organizerSubmissionSimpleErrorSchema,
]);

export const organizerSubmissionErrorResponseSchema = z
  .object({
    error: organizerSubmissionErrorSchema,
    request_id: submissionIdentifierSchema,
  })
  .strict();

export const organizerSubmissionCommandResponseSchema = z.discriminatedUnion(
  "ok",
  [
    z
      .object({
        ok: z.literal(true),
        result: organizerSubmissionCommandResultSchema,
      })
      .strict(),
    z
      .object({
        error: organizerSubmissionCommandErrorSchema,
        ok: z.literal(false),
      })
      .strict(),
  ],
);

export type OrganizerSubmissionStatus = z.infer<
  typeof organizerSubmissionStatusSchema
>;
export type OrganizerSubmissionCommandType = z.infer<
  typeof organizerSubmissionCommandTypeSchema
>;
export type OrganizerSubmissionProjection = z.infer<
  typeof organizerSubmissionProjectionSchema
>;
export type OrganizerSubmissionListQuery = z.infer<
  typeof organizerSubmissionListQuerySchema
>;
export type OrganizerSubmissionListRow = z.infer<
  typeof organizerSubmissionListRowSchema
>;
export type OrganizerSubmissionListResponse = z.infer<
  typeof organizerSubmissionListResponseSchema
>;
export type OrganizerSubmissionDetail = z.infer<
  typeof organizerSubmissionDetailSchema
>;
export type OrganizerSubmissionAnswer = z.infer<
  typeof organizerSubmissionAnswerSchema
>;
export type OrganizerSubmissionParticipant = z.infer<
  typeof organizerSubmissionParticipantSchema
>;
export type OrganizerSubmissionReview = z.infer<
  typeof organizerSubmissionReviewSchema
>;
export type OrganizerSubmissionNote = z.infer<
  typeof organizerSubmissionNoteSchema
>;
export type OrganizerSubmissionHistoryEntry = z.infer<
  typeof organizerSubmissionHistoryEntrySchema
>;
export type OrganizerSubmissionCommand = z.infer<
  typeof organizerSubmissionCommandSchema
>;
export type OrganizerSubmissionCommandResult = z.infer<
  typeof organizerSubmissionCommandResultSchema
>;
export type OrganizerSubmissionCommandResponse = z.infer<
  typeof organizerSubmissionCommandResponseSchema
>;
export type OrganizerSubmissionCommandError = z.infer<
  typeof organizerSubmissionCommandErrorSchema
>;
export type OrganizerSubmissionValidationError = z.infer<
  typeof organizerSubmissionValidationErrorSchema
>;
export type OrganizerSubmissionVersionConflictError = z.infer<
  typeof organizerSubmissionVersionConflictErrorSchema
>;
export type OrganizerSubmissionIdempotencyConflictError = z.infer<
  typeof organizerSubmissionIdempotencyConflictErrorSchema
>;
export type OrganizerSubmissionSimpleError = z.infer<
  typeof organizerSubmissionSimpleErrorSchema
>;
export type OrganizerSubmissionError = z.infer<
  typeof organizerSubmissionErrorSchema
>;
export type OrganizerSubmissionErrorResponse = z.infer<
  typeof organizerSubmissionErrorResponseSchema
>;
