import { z } from "zod";

import { publicScheduleProjectionSchema } from "./index";

export const publicApiIdentifierSchema = z
  .string()
  .trim()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]+$/);

const publicApiInstantSchema = z.iso.datetime({ offset: true });
const nullablePublicApiInstantSchema = publicApiInstantSchema.nullable();

export const publicApiScopeSchema = z.enum([
  "events:read",
  "submissions:read",
  "submissions:write",
  "sessions:read",
  "speakers:read",
  "tasks:read",
  "schedule:read",
  "integrations:read",
]);

export const publicApiScopes = publicApiScopeSchema.options;

export const apiKeyCreateRequestSchema = z
  .object({
    expires_at: nullablePublicApiInstantSchema,
    name: z.string().trim().min(1).max(120),
    scope: z.enum(["event", "organization"]),
    scopes: z
      .array(publicApiScopeSchema)
      .min(1)
      .max(publicApiScopes.length)
      .refine((scopes) => new Set(scopes).size === scopes.length, {
        message: "API key scopes must be unique.",
      }),
  })
  .strict();

export const apiKeyScopeSchema = z
  .object({
    event_id: publicApiIdentifierSchema.nullable(),
    kind: z.enum(["event", "organization"]),
    organization_id: publicApiIdentifierSchema,
  })
  .strict()
  .refine((scope) => (scope.kind === "event") === (scope.event_id !== null), {
    message: "Event API keys require exactly one event scope.",
  });

export const apiKeyStateSchema = z.enum(["active", "expired", "revoked"]);

export const apiKeyMetadataSchema = z
  .object({
    created_at: publicApiInstantSchema,
    expires_at: nullablePublicApiInstantSchema,
    id: publicApiIdentifierSchema,
    last_used_at: nullablePublicApiInstantSchema,
    name: z.string().trim().min(1).max(120),
    prefix: z
      .string()
      .min(12)
      .max(80)
      .regex(/^osk_[A-Za-z0-9_-]+$/),
    revoked_at: nullablePublicApiInstantSchema,
    scope: apiKeyScopeSchema,
    scopes: z.array(publicApiScopeSchema).min(1).max(publicApiScopes.length),
    state: apiKeyStateSchema,
  })
  .strict();

export const apiKeyAuditReceiptSchema = z
  .object({
    created_at: publicApiInstantSchema,
    id: publicApiIdentifierSchema,
    request_id: publicApiIdentifierSchema,
  })
  .strict();

export const apiKeyCreateResponseSchema = z
  .object({
    audit_receipt: apiKeyAuditReceiptSchema,
    data: apiKeyMetadataSchema.extend({
      plaintext: z
        .string()
        .min(48)
        .max(256)
        .regex(/^osk_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
    }),
  })
  .strict();

export const apiKeyListResponseSchema = z
  .object({ data: z.array(apiKeyMetadataSchema).max(500) })
  .strict();

export const apiKeyRevokeResponseSchema = z
  .object({
    audit_receipt: apiKeyAuditReceiptSchema,
    data: apiKeyMetadataSchema,
  })
  .strict();

export const publicApiProblemSchema = z
  .object({
    code: z
      .string()
      .min(3)
      .max(80)
      .regex(/^[a-z][a-z0-9_]+$/),
    detail: z.string().min(1).max(2_000),
    errors: z
      .array(
        z
          .object({
            field: z.string().min(1).max(160),
            message: z.string().min(1).max(1_000),
          })
          .strict(),
      )
      .max(64)
      .optional(),
    request_id: publicApiIdentifierSchema,
    status: z.int().min(400).max(599),
    title: z.string().min(1).max(160),
    type: z.url(),
  })
  .strict();

export const publicApiCursorSchema = z
  .string()
  .min(1)
  .max(1_024)
  .regex(/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);

export const publicApiPaginationQuerySchema = z
  .object({
    cursor: publicApiCursorSchema.optional(),
    limit: z.int().min(1).max(100).default(25),
  })
  .strict();

export const publicApiPageSchema = z
  .object({
    limit: z.int().min(1).max(100),
    next_cursor: publicApiCursorSchema.nullable(),
  })
  .strict();

function listEnvelope<T extends z.ZodType>(item: T) {
  return z
    .object({
      data: z.array(item).max(100),
      page: publicApiPageSchema,
    })
    .strict();
}

export const publicApiEventSchema = z
  .object({
    ends_at: nullablePublicApiInstantSchema,
    id: publicApiIdentifierSchema,
    name: z.string().trim().min(1).max(240),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
    starts_at: nullablePublicApiInstantSchema,
    status: z.enum(["archived", "closed", "draft", "open", "published"]),
    timezone: z.string().trim().min(1).max(120),
    updated_at: publicApiInstantSchema,
    venue: z.string().trim().max(240).nullable(),
    version: z.int().nonnegative(),
  })
  .strict();

export const publicApiEventListSchema = listEnvelope(publicApiEventSchema);

export const publicApiSubmissionStatusSchema = z.enum([
  "accepted",
  "declined",
  "draft",
  "in_review",
  "submitted",
  "waitlisted",
  "withdrawn",
]);

export const publicApiSubmissionSchema = z
  .object({
    id: publicApiIdentifierSchema,
    reference: z.string().trim().min(1).max(64),
    status: publicApiSubmissionStatusSchema,
    submitted_at: nullablePublicApiInstantSchema,
    title: z.string().trim().min(1).max(300),
    track_id: publicApiIdentifierSchema.nullable(),
    updated_at: publicApiInstantSchema,
    version: z.int().positive(),
  })
  .strict();

export const publicApiSubmissionListSchema = listEnvelope(
  publicApiSubmissionSchema,
);

export const publicApiSubmissionPatchSchema = z
  .object({
    reason: z.string().trim().min(1).max(2_000),
    status: z.enum(["in_review", "submitted", "withdrawn"]),
  })
  .strict();

export const publicApiSessionSchema = z
  .object({
    abstract: z.string().max(12_000).nullable(),
    duration_minutes: z.int().positive().max(1_440).nullable(),
    format_id: publicApiIdentifierSchema.nullable(),
    id: publicApiIdentifierSchema,
    is_public: z.boolean(),
    reference: z.string().trim().min(1).max(64),
    status: z.enum(["accepted", "canceled", "draft", "published", "scheduled"]),
    title: z.string().trim().min(1).max(300),
    track_id: publicApiIdentifierSchema.nullable(),
    updated_at: publicApiInstantSchema,
    version: z.int().positive(),
  })
  .strict();

export const publicApiSessionListSchema = listEnvelope(publicApiSessionSchema);

export const publicApiSpeakerSchema = z
  .object({
    bio: z.string().max(20_000).nullable(),
    company: z.string().trim().max(160).nullable(),
    display_name: z.string().trim().min(1).max(200),
    id: publicApiIdentifierSchema,
    readiness: z
      .object({
        overdue: z.int().nonnegative(),
        ready: z.boolean(),
        required_complete: z.int().nonnegative(),
        required_total: z.int().nonnegative(),
      })
      .strict(),
    title: z.string().trim().max(160).nullable(),
    updated_at: publicApiInstantSchema,
  })
  .strict();

export const publicApiSpeakerListSchema = listEnvelope(publicApiSpeakerSchema);

export const publicApiTaskSchema = z
  .object({
    contact_id: publicApiIdentifierSchema,
    definition: z
      .object({
        id: publicApiIdentifierSchema,
        name: z.string().trim().min(1).max(240),
        type: z.enum(["ack", "file", "form", "link"]),
      })
      .strict(),
    due_at: nullablePublicApiInstantSchema,
    id: publicApiIdentifierSchema,
    required: z.boolean(),
    session_id: publicApiIdentifierSchema.nullable(),
    state: z.enum([
      "approved",
      "complete",
      "incomplete",
      "rejected",
      "submitted",
    ]),
    updated_at: publicApiInstantSchema,
    version: z.int().positive(),
  })
  .strict();

export const publicApiTaskListSchema = listEnvelope(publicApiTaskSchema);

export const publicApiScheduleSchema = z
  .object({ data: z.lazy(() => publicScheduleProjectionSchema) })
  .strict();

export const publicApiExportRunSchema = z
  .object({
    counts: z.record(z.string(), z.int().nonnegative()),
    created_at: publicApiInstantSchema,
    error_code: z.string().trim().min(1).max(120).nullable(),
    finished_at: nullablePublicApiInstantSchema,
    id: publicApiIdentifierSchema,
    mode: z.enum(["apply", "dry_run"]),
    provider: z.string().trim().min(1).max(80),
    started_at: nullablePublicApiInstantSchema,
    status: z.enum(["canceled", "complete", "failed", "queued", "running"]),
  })
  .strict();

export const publicApiExportRunListSchema = listEnvelope(
  publicApiExportRunSchema,
);

export type ApiKeyCreateRequest = z.infer<typeof apiKeyCreateRequestSchema>;
export type ApiKeyCreateResponse = z.infer<typeof apiKeyCreateResponseSchema>;
export type ApiKeyMetadata = z.infer<typeof apiKeyMetadataSchema>;
export type ApiKeyScope = z.infer<typeof publicApiScopeSchema>;
export type PublicApiEvent = z.infer<typeof publicApiEventSchema>;
export type PublicApiExportRun = z.infer<typeof publicApiExportRunSchema>;
export type PublicApiPaginationQuery = z.infer<
  typeof publicApiPaginationQuerySchema
>;
export type PublicApiProblem = z.infer<typeof publicApiProblemSchema>;
export type PublicApiSession = z.infer<typeof publicApiSessionSchema>;
export type PublicApiSpeaker = z.infer<typeof publicApiSpeakerSchema>;
export type PublicApiSubmission = z.infer<typeof publicApiSubmissionSchema>;
export type PublicApiTask = z.infer<typeof publicApiTaskSchema>;
