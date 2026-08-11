import { z } from "zod";

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u);
const nullableTimestampSchema = z.iso.datetime().nullable();
const timestampSchema = z.iso.datetime();

export const privacyExportRequestSchema = z
  .object({
    email: z.string().trim().pipe(z.email().max(320)),
  })
  .strict();

export const privacyPolicyResponseSchema = z
  .object({
    deletion: z
      .object({
        completion_target_days: z.literal(30),
        mode: z.literal("coordinated_operator_request"),
        partial_delete_api: z.literal(false),
        reason: z.string().min(1).max(500),
        required_steps: z.array(z.string().min(1).max(240)).min(4).max(12),
      })
      .strict(),
    export: z
      .object({
        format: z.literal("application/json"),
        mode: z.literal("organization_owner_api"),
        scope: z.literal("one_organization"),
      })
      .strict(),
    policy_version: z.literal("2026-08-11"),
    retention: z
      .array(
        z
          .object({
            category: z.string().min(1).max(80),
            policy: z.string().min(1).max(500),
          })
          .strict(),
      )
      .min(3)
      .max(12),
  })
  .strict();

const accountSchema = z
  .object({
    created_at: timestampSchema,
    disabled_at: nullableTimestampSchema,
    display_name: z.string().max(160).nullable(),
    id: identifierSchema,
    status: z.enum(["active", "disabled"]),
    updated_at: timestampSchema,
  })
  .strict();

const organizationMembershipSchema = z
  .object({
    created_at: timestampSchema,
    revoked_at: nullableTimestampSchema,
    role: z.enum(["owner", "organizer", "viewer"]),
    updated_at: timestampSchema,
  })
  .strict();

const eventMembershipSchema = z
  .object({
    event_id: identifierSchema,
    revoked_at: nullableTimestampSchema,
    role: z.enum(["organizer", "reviewer", "viewer"]),
  })
  .strict();

const contactSchema = z
  .object({
    bio: z.string().nullable(),
    company: z.string().nullable(),
    display_name: z.string(),
    first_name: z.string().nullable(),
    headshot_alt_text: z.string().nullable(),
    id: identifierSchema,
    last_name: z.string().nullable(),
    profile_publication_state: z.enum(["draft", "approved", "published"]),
    pronouns: z.string().nullable(),
    social: z.unknown(),
    title: z.string().nullable(),
  })
  .strict();

const eventParticipationSchema = z
  .object({
    event_id: identifierSchema,
    invitation_at: nullableTimestampSchema,
    last_active_at: nullableTimestampSchema,
    portal_state: z.enum(["not_invited", "invited", "active", "revoked"]),
    roles: z.array(z.string()),
  })
  .strict();

const submissionAnswerSchema = z
  .object({
    field_label: z.string(),
    field_stable_key: identifierSchema,
    type: z.string(),
    value: z.unknown(),
  })
  .strict();

const submissionSchema = z
  .object({
    answers: z.array(submissionAnswerSchema),
    event_id: identifierSchema,
    friendly_id: z.string(),
    id: identifierSchema,
    relationship: z.enum(["participant", "submitter"]),
    status: z.string(),
    submitted_at: nullableTimestampSchema,
    title: z.string(),
    updated_at: timestampSchema,
  })
  .strict();

const reviewScoreSchema = z
  .object({
    comment: z.string().nullable(),
    criterion_id: identifierSchema,
    numeric_score: z.number().nullable(),
  })
  .strict();

const reviewSchema = z
  .object({
    conflict: z.boolean(),
    conflict_note: z.string().nullable(),
    event_id: identifierSchema,
    id: identifierSchema,
    reviewer_note: z.string().nullable(),
    scores: z.array(reviewScoreSchema),
    status: z.string(),
    submission_id: identifierSchema,
    submitted_at: nullableTimestampSchema,
    updated_at: timestampSchema,
  })
  .strict();

const sessionParticipationSchema = z
  .object({
    confirmed_state: z.string(),
    event_id: identifierSchema,
    friendly_id: z.string(),
    role: z.string(),
    session_id: identifierSchema,
    status: z.string(),
    title: z.string(),
  })
  .strict();

const taskAssignmentSchema = z
  .object({
    completed_at: nullableTimestampSchema,
    due_at: nullableTimestampSchema,
    event_id: identifierSchema,
    file_ids: z.array(identifierSchema),
    id: identifierSchema,
    required: z.boolean(),
    response: z.unknown(),
    status: z.string(),
    task_name: z.string(),
    task_type: z.string(),
    updated_at: timestampSchema,
  })
  .strict();

const fileSchema = z
  .object({
    byte_size: z.int().nonnegative(),
    created_at: timestampSchema,
    declared_mime_type: z.string(),
    detected_mime_type: z.string().nullable(),
    display_filename: z.string(),
    finalized_at: nullableTimestampSchema,
    id: identifierSchema,
    purpose: z.string(),
    status: z.string(),
  })
  .strict();

const messageSchema = z
  .object({
    campaign_id: identifierSchema,
    delivered_at: nullableTimestampSchema,
    event_id: identifierSchema,
    id: identifierSchema,
    queued_at: nullableTimestampSchema,
    sent_at: nullableTimestampSchema,
    status: z.string(),
  })
  .strict();

export const privacyExportResponseSchema = z
  .object({
    account: accountSchema.nullable(),
    contacts: z.array(contactSchema),
    email: z.email(),
    event_memberships: z.array(eventMembershipSchema),
    event_participation: z.array(eventParticipationSchema),
    exclusions: z.array(z.string().min(1).max(500)).min(1).max(12),
    files: z.array(fileSchema),
    generated_at: timestampSchema,
    messages: z.array(messageSchema),
    organization_id: identifierSchema,
    organization_membership: organizationMembershipSchema.nullable(),
    reviews: z.array(reviewSchema),
    schema_version: z.literal(1),
    session_participation: z.array(sessionParticipationSchema),
    subject_found: z.boolean(),
    submissions: z.array(submissionSchema),
    task_assignments: z.array(taskAssignmentSchema),
  })
  .strict();

export const coordinatedDeletionResponseSchema = z
  .object({
    accepted: z.literal(false),
    code: z.literal("coordinated_deletion_required"),
    message: z.string().min(1).max(500),
    policy_url: z.literal("/api/v1/privacy/policy"),
  })
  .strict();

export type PrivacyExportRequest = z.infer<typeof privacyExportRequestSchema>;
export type PrivacyExportResponse = z.infer<typeof privacyExportResponseSchema>;
export type PrivacyPolicyResponse = z.infer<typeof privacyPolicyResponseSchema>;
