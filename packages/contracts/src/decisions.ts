import { z } from "zod";

const idSchema = z
  .string()
  .trim()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const instantSchema = z.iso.datetime({ offset: true });

export const decisionActionSchema = z.enum([
  "accepted",
  "waitlisted",
  "declined",
]);
export const decisionStateSchema = z.union([
  decisionActionSchema,
  z.literal("undecided"),
]);
export const decisionMessageModeSchema = z.enum([
  "recorded_only",
  "send_queued",
]);

export const decisionHistoryEntrySchema = z
  .object({
    action: decisionActionSchema,
    actor: z.string().trim().min(1).max(160),
    at: instantSchema,
    audience: z.string().trim().min(1).max(500),
    commandId: idSchema,
    messageMode: decisionMessageModeSchema,
    privateNote: z.string().trim().max(4_000).nullable(),
    reason: z.string().trim().min(1).max(2_000),
    template: z.string().trim().min(1).max(240).nullable(),
  })
  .strict();

export const decisionReviewSchema = z
  .object({
    conflictReason: z.string().trim().max(2_000).nullable(),
    criteria: z
      .array(
        z
          .object({
            criterionId: idSchema,
            label: z.string().trim().min(1).max(160),
            score: z.number().min(1).max(5),
            weight: z.number().positive().max(100),
          })
          .strict(),
      )
      .max(5),
    id: idSchema,
    note: z.string().trim().max(10_000).nullable(),
    overallScore: z.number().min(1).max(5).nullable(),
    reviewer: z.string().trim().min(1).max(160),
    status: z.enum(["conflict", "pending", "submitted"]),
    submittedAt: instantSchema.nullable(),
  })
  .strict();

export const decisionSideEffectsSchema = z
  .object({
    errorCode: z.string().trim().min(1).max(120).nullable(),
    status: z.enum(["complete", "failed", "pending"]),
    updatedAt: instantSchema,
    workflowId: idSchema,
  })
  .strict();

export const decisionSubmissionSchema = z
  .object({
    aggregateScore: z.number().min(1).max(5).nullable(),
    decision: decisionStateSchema,
    format: z.string().trim().min(1).max(160).nullable(),
    history: z.array(decisionHistoryEntrySchema).max(100),
    id: idSchema,
    reference: z.string().trim().min(1).max(64),
    reviews: z.array(decisionReviewSchema).max(256),
    sideEffects: decisionSideEffectsSchema.nullable().default(null),
    sourceVersion: z.int().positive(),
    speakerCount: z.int().nonnegative().max(64),
    title: z.string().trim().min(1).max(300),
    track: z.string().trim().min(1).max(160).nullable(),
  })
  .strict();

export const decisionWorkspaceResponseSchema = z
  .object({
    actor: z.string().trim().min(1).max(160),
    eventId: idSchema,
    eventName: z.string().trim().min(1).max(200),
    submissions: z.array(decisionSubmissionSchema).max(2_000),
  })
  .strict();

export const recordDecisionCommandSchema = z
  .object({
    audience: z.string().trim().min(1).max(500),
    commandId: idSchema,
    decision: decisionActionSchema,
    expectedVersion: z.int().nonnegative(),
    messageMode: decisionMessageModeSchema,
    privateNote: z.string().trim().max(4_000),
    reason: z.string().trim().min(1).max(2_000),
    submissionId: idSchema,
    template: z.string().trim().min(1).max(240).nullable(),
    type: z.literal("record_decision"),
  })
  .strict()
  .superRefine((command, context) => {
    if (command.messageMode === "send_queued" && command.template === null) {
      context.addIssue({
        code: "custom",
        message: "A queued decision message requires a template snapshot.",
        path: ["template"],
      });
    }
    if (command.messageMode === "recorded_only" && command.template !== null) {
      context.addIssue({
        code: "custom",
        message: "A record-only decision cannot select a message template.",
        path: ["template"],
      });
    }
  });

export type DecisionHistoryEntry = z.infer<typeof decisionHistoryEntrySchema>;
export type DecisionSubmission = z.infer<typeof decisionSubmissionSchema>;
export type DecisionWorkspaceResponse = z.infer<
  typeof decisionWorkspaceResponseSchema
>;
export type RecordDecisionCommand = z.infer<typeof recordDecisionCommandSchema>;
