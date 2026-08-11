import { z } from "zod";

export const taskStableIdSchema = z
  .string()
  .trim()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]+$/);

const nullableDateTimeSchema = z.iso.datetime().nullable();
const boundedIds = z.array(taskStableIdSchema).max(500);
const participantRoleSchema = z.enum(["speaker", "moderator", "chair"]);

export const taskAssignmentStateSchema = z.enum([
  "incomplete",
  "submitted",
  "complete",
  "approved",
  "rejected",
]);

export const taskEventLocalDueSchema = z
  .object({
    disambiguation: z.enum(["earlier", "later", "reject"]),
    local_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    local_time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  })
  .strict();

export const taskTargetRuleSchema = z
  .object({
    assignment_scope: z.enum(["contact", "session"]),
    contact: z
      .object({
        exclude_contact_ids: boundedIds,
        include_contact_ids: boundedIds,
        roles: z.array(participantRoleSchema).max(3),
      })
      .strict(),
    session: z
      .object({
        format_ids: boundedIds,
        include_session_ids: boundedIds,
        participant_roles: z.array(participantRoleSchema).min(1).max(3),
        track_ids: boundedIds,
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.assignment_scope === "session" && value.session === null) {
      context.addIssue({
        code: "custom",
        message: "Session-scoped tasks require session targeting rules.",
        path: ["session"],
      });
    }
    if (value.assignment_scope === "contact" && value.session !== null) {
      context.addIssue({
        code: "custom",
        message: "Contact-scoped tasks cannot include session targeting rules.",
        path: ["session"],
      });
    }
    const overlap = value.contact.include_contact_ids.find((id) =>
      value.contact.exclude_contact_ids.includes(id),
    );
    if (overlap) {
      context.addIssue({
        code: "custom",
        message: "A contact cannot be both included and excluded.",
        path: ["contact", "exclude_contact_ids"],
      });
    }
  });

const acknowledgementConfigurationSchema = z
  .object({
    acknowledgement_label: z.string().trim().min(1).max(200),
    kind: z.literal("ack"),
  })
  .strict();

const linkConfigurationSchema = z
  .object({
    acknowledgement_label: z.string().trim().min(1).max(200),
    kind: z.literal("link"),
    url: z
      .url()
      .max(2_048)
      .refine((value) => new URL(value).protocol === "https:", {
        message: "Task links must use HTTPS.",
      }),
  })
  .strict();

const formFieldSchema = z
  .object({
    help_text: z.string().max(1_000),
    id: taskStableIdSchema,
    label: z.string().trim().min(1).max(300),
    options: z.array(z.string().trim().min(1).max(300)).max(100),
    required: z.boolean(),
    type: z.enum(["checkbox", "select", "text", "textarea"]),
  })
  .strict()
  .superRefine((field, context) => {
    if (field.type === "select" && field.options.length === 0) {
      context.addIssue({
        code: "custom",
        message: "Select fields require at least one option.",
        path: ["options"],
      });
    }
    if (field.type !== "select" && field.options.length > 0) {
      context.addIssue({
        code: "custom",
        message: "Only select fields can define options.",
        path: ["options"],
      });
    }
  });

const formConfigurationSchema = z
  .object({
    fields: z.array(formFieldSchema).min(1).max(100),
    kind: z.literal("form"),
  })
  .strict()
  .superRefine((configuration, context) => {
    const ids = new Set<string>();
    configuration.fields.forEach((field, index) => {
      if (ids.has(field.id)) {
        context.addIssue({
          code: "custom",
          message: "Form field identifiers must be unique.",
          path: ["fields", index, "id"],
        });
      }
      ids.add(field.id);
    });
  });

const fileConfigurationSchema = z
  .object({
    extensions: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^[a-z0-9]{1,16}$/),
      )
      .min(1)
      .max(25),
    kind: z.literal("file"),
    max_bytes: z
      .number()
      .int()
      .positive()
      .max(500 * 1024 * 1024),
    max_files: z.number().int().positive().max(20),
    private: z.literal(true),
  })
  .strict();

export const taskConfigurationSchema = z.discriminatedUnion("kind", [
  acknowledgementConfigurationSchema,
  linkConfigurationSchema,
  formConfigurationSchema,
  fileConfigurationSchema,
]);

export const taskDefinitionDraftSchema = z
  .object({
    approval_required: z.boolean(),
    configuration: taskConfigurationSchema,
    description: z.string().max(4_000),
    due: taskEventLocalDueSchema.nullable(),
    id: taskStableIdSchema,
    name: z.string().trim().min(1).max(300),
    required: z.boolean(),
    target: taskTargetRuleSchema,
  })
  .strict();

export const taskDefinitionSchema = taskDefinitionDraftSchema.extend({
  event_id: taskStableIdSchema,
  version: z.number().int().positive(),
});

export const taskDefinitionCommandSchema = z
  .object({
    backfill_preview_id: taskStableIdSchema.nullable(),
    command_id: taskStableIdSchema,
    definition: taskDefinitionDraftSchema,
    expected_version: z.number().int().nonnegative(),
    type: z.literal("upsert_definition"),
  })
  .strict();

export const taskAssignmentHistorySchema = z
  .object({
    actor_id: taskStableIdSchema.nullable(),
    actor_type: z.enum(["organizer", "speaker", "system"]),
    at: z.iso.datetime(),
    command_id: taskStableIdSchema,
    from: taskAssignmentStateSchema,
    reason: z.string().trim().min(1).max(2_000).nullable(),
    to: taskAssignmentStateSchema,
    version: z.number().int().positive(),
  })
  .strict()
  .superRefine((entry, context) => {
    if ((entry.actor_type === "system") !== (entry.actor_id === null)) {
      context.addIssue({
        code: "custom",
        message: "Only system history entries omit an actor ID.",
        path: ["actor_id"],
      });
    }
  });

export const taskAssignmentResponseEnvelopeSchema = z
  .object({
    history: z.array(taskAssignmentHistorySchema).max(500),
    schema_version: z.literal(1),
    state: taskAssignmentStateSchema,
    version: z.number().int().positive(),
  })
  .strict();

export const taskAssignmentSchema = z
  .object({
    approval_required: z.boolean(),
    assignment_id: taskStableIdSchema,
    contact_id: taskStableIdSchema,
    definition_id: taskStableIdSchema,
    due_at: nullableDateTimeSchema,
    event_id: taskStableIdSchema,
    history: z.array(taskAssignmentHistorySchema).max(500),
    required: z.boolean(),
    session_id: taskStableIdSchema.nullable(),
    state: taskAssignmentStateSchema,
    version: z.number().int().positive(),
  })
  .strict();

export const taskAssignmentTransitionCommandSchema = z
  .object({
    command_id: taskStableIdSchema,
    expected_version: z.number().int().positive(),
    reason: z.string().trim().min(1).max(2_000).nullable(),
    to: taskAssignmentStateSchema,
    type: z.literal("transition_assignment"),
  })
  .strict();

export const taskAcceptanceMaterializationCommandSchema = z
  .object({
    acceptance_id: taskStableIdSchema,
    command_id: taskStableIdSchema,
    session_ids: z.array(taskStableIdSchema).min(1).max(200),
    type: z.literal("materialize_acceptance"),
  })
  .strict();

export const taskBackfillPreviewRequestSchema = z
  .object({
    definition: taskDefinitionDraftSchema,
    expected_version: z.number().int().nonnegative(),
  })
  .strict();

const assignmentIdentitySchema = z
  .object({
    assignment_id: taskStableIdSchema,
    contact_id: taskStableIdSchema,
    definition_id: taskStableIdSchema,
    event_id: taskStableIdSchema,
    session_id: taskStableIdSchema.nullable(),
  })
  .strict();

const assignmentDraftSchema = assignmentIdentitySchema.extend({
  approval_required: z.boolean(),
  due_at: nullableDateTimeSchema,
  required: z.boolean(),
  state: z.literal("incomplete"),
});

export const taskBackfillPreviewSchema = z
  .object({
    create: z.array(assignmentDraftSchema).max(5_000),
    no_longer_targeted: z.array(assignmentIdentitySchema).max(5_000),
    policy: z.literal("additive_preserve_existing"),
    preserve: z.array(assignmentIdentitySchema).max(5_000),
    preview_id: taskStableIdSchema,
  })
  .strict();

export const taskReadinessSchema = z
  .object({
    configuration: z.enum(["configured", "no_assignments", "optional_only"]),
    explanation: z.string().trim().min(1).max(1_000),
    next_due: z
      .object({
        at: z.iso.datetime(),
        local_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        local_time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
        timezone: z.string().trim().min(1).max(100),
      })
      .strict()
      .nullable(),
    outstanding_count: z.number().int().nonnegative(),
    overdue_count: z.number().int().nonnegative(),
    ratio: z
      .object({
        complete: z.number().int().nonnegative(),
        percent: z.number().int().min(0).max(100).nullable(),
        total: z.number().int().nonnegative(),
      })
      .strict(),
    status: z.enum(["not_configured", "outstanding", "overdue", "ready"]),
  })
  .strict()
  .superRefine((readiness, context) => {
    if (readiness.ratio.complete > readiness.ratio.total) {
      context.addIssue({
        code: "custom",
        message: "Readiness completion cannot exceed its required total.",
        path: ["ratio", "complete"],
      });
    }
    if (
      (readiness.configuration === "configured") !==
      readiness.ratio.total > 0
    ) {
      context.addIssue({
        code: "custom",
        message: "Configured readiness requires at least one required task.",
        path: ["configuration"],
      });
    }
    if (
      readiness.status === "ready" &&
      (readiness.configuration !== "configured" ||
        readiness.ratio.complete !== readiness.ratio.total)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Ready requires every configured required task to be complete.",
        path: ["status"],
      });
    }
  });

export const taskReadinessSpeakerSchema = z
  .object({
    assignments: z.array(taskAssignmentSchema).max(500),
    contact_id: taskStableIdSchema,
    display_name: z.string().trim().min(1).max(200),
    email: z.email().max(320),
    readiness: taskReadinessSchema,
    session_ids: z.array(taskStableIdSchema).max(200),
  })
  .strict();

export const taskReadinessResponseSchema = z
  .object({
    event_id: taskStableIdSchema,
    generated_at: z.iso.datetime(),
    speakers: z.array(taskReadinessSpeakerSchema).max(5_000),
    timezone: z.string().trim().min(1).max(100),
  })
  .strict();

const taskCommandErrorSchema = z
  .object({
    code: z.enum([
      "task_authority_pending",
      "task_authority_unavailable",
      "task_idempotency_conflict",
      "task_illegal_transition",
      "task_invalid_request",
      "task_not_found",
      "task_preview_conflict",
      "task_version_conflict",
    ]),
    message: z.string().trim().min(1).max(1_000),
    retryable: z.boolean(),
  })
  .strict();

export const taskCommandResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      repair_pending: z.boolean(),
      replayed: z.boolean(),
      result: z.union([
        taskDefinitionSchema,
        taskAssignmentSchema,
        z
          .object({
            assignment_ids: z.array(taskStableIdSchema).max(5_000),
            boundary_id: taskStableIdSchema,
            created_count: z.number().int().nonnegative(),
          })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      error: taskCommandErrorSchema,
      ok: z.literal(false),
    })
    .strict(),
]);

export type TaskAcceptanceMaterializationCommand = z.infer<
  typeof taskAcceptanceMaterializationCommandSchema
>;
export type TaskAssignment = z.infer<typeof taskAssignmentSchema>;
export type TaskAssignmentState = z.infer<typeof taskAssignmentStateSchema>;
export type TaskAssignmentResponseEnvelope = z.infer<
  typeof taskAssignmentResponseEnvelopeSchema
>;
export type TaskAssignmentTransitionCommand = z.infer<
  typeof taskAssignmentTransitionCommandSchema
>;
export type TaskBackfillPreview = z.infer<typeof taskBackfillPreviewSchema>;
export type TaskBackfillPreviewRequest = z.infer<
  typeof taskBackfillPreviewRequestSchema
>;
export type TaskCommandResponse = z.infer<typeof taskCommandResponseSchema>;
export type TaskDefinition = z.infer<typeof taskDefinitionSchema>;
export type TaskDefinitionCommand = z.infer<typeof taskDefinitionCommandSchema>;
export type TaskDefinitionDraft = z.infer<typeof taskDefinitionDraftSchema>;
export type TaskReadiness = z.infer<typeof taskReadinessSchema>;
export type TaskReadinessResponse = z.infer<typeof taskReadinessResponseSchema>;
