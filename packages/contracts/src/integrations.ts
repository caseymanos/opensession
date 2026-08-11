import { z } from "zod";

const nullableTimestampSchema = z.iso.datetime({ offset: true }).nullable();

export const airtableTableKeySchema = z.enum([
  "campaigns",
  "contacts",
  "criteria",
  "email_templates",
  "event_contacts",
  "events",
  "external_mappings",
  "form_fields",
  "form_rules",
  "forms",
  "formats",
  "integrations",
  "messages",
  "organizations",
  "resources",
  "review_scores",
  "reviewer_groups",
  "reviews",
  "rooms",
  "rubrics",
  "schedule_slots",
  "session_participants",
  "sessions",
  "submission_answers",
  "submission_notes",
  "submission_participants",
  "submissions",
  "sync_runs",
  "task_assignments",
  "task_definitions",
  "tracks",
]);

export const airtableDivergenceCountSchema = z
  .object({
    create: z.int().nonnegative(),
    missing: z.int().nonnegative(),
    unchanged: z.int().nonnegative(),
    update: z.int().nonnegative(),
  })
  .strict();

export const airtableDivergenceTableSchema = airtableDivergenceCountSchema
  .extend({
    key: airtableTableKeySchema,
    name: z.string().trim().min(1).max(80),
  })
  .strict();

export const airtableReconcilePlanSchema = z
  .object({
    confirmation: z.string().trim().min(1).max(160),
    counts: airtableDivergenceCountSchema,
    plan_id: z.string().regex(/^[0-9a-f]{64}$/),
    scope: z.literal("organization"),
    tables: z.array(airtableDivergenceTableSchema).min(1).max(64),
  })
  .strict();

export const airtableReconcileRequestSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("dry_run") }).strict(),
  z
    .object({
      confirmation: z.string().trim().min(1).max(160),
      mode: z.literal("apply"),
      plan_id: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
]);

export const airtableReconcileResponseSchema = z.discriminatedUnion("mode", [
  z
    .object({
      generated_at: z.iso.datetime({ offset: true }),
      mode: z.literal("dry_run"),
      plan: airtableReconcilePlanSchema,
    })
    .strict(),
  z
    .object({
      audit_id: z.string().regex(/^aud_[A-Za-z0-9_-]{16,80}$/),
      completed_at: z.iso.datetime({ offset: true }),
      mode: z.literal("apply"),
      result: z
        .object({
          deleted: z.int().nonnegative(),
          projected: z.int().nonnegative(),
          table_count: z.int().positive(),
        })
        .strict(),
    })
    .strict(),
]);

const judgeTraceSchema = z
  .object({
    kind: z.enum(["proposal", "session", "task_assignment"]),
    label: z.string().trim().min(1).max(120),
    projected_count: z.int().nonnegative(),
    tables: z.array(z.string().trim().min(1).max(80)).min(1).max(4),
  })
  .strict();

export const airtableIntegrationHealthSchema = z
  .object({
    authority: z
      .object({
        base_suffix: z.string().regex(/^…[A-Za-z0-9]{4,12}$/),
        last_read_at: nullableTimestampSchema,
        last_write_at: nullableTimestampSchema,
        schema_version: z.int().positive(),
      })
      .strict(),
    generated_at: z.iso.datetime({ offset: true }),
    judge_trace: z.array(judgeTraceSchema).length(3),
    projection: z
      .object({
        lag_seconds: z.number().nonnegative().nullable(),
        last_reconcile: z
          .object({
            completed_at: nullableTimestampSchema,
            status: z.enum(["failed", "never", "running", "succeeded"]),
            table_count: z.int().nonnegative(),
          })
          .strict(),
        repair_backlog: z
          .object({
            dead: z.int().nonnegative(),
            failed: z.int().nonnegative(),
            pending: z.int().nonnegative(),
          })
          .strict(),
        watermark_at: nullableTimestampSchema,
      })
      .strict(),
  })
  .strict();

export type AirtableDivergenceCount = z.infer<
  typeof airtableDivergenceCountSchema
>;
export type AirtableDivergenceTable = z.infer<
  typeof airtableDivergenceTableSchema
>;
export type AirtableIntegrationHealth = z.infer<
  typeof airtableIntegrationHealthSchema
>;
export type AirtableReconcilePlan = z.infer<typeof airtableReconcilePlanSchema>;
export type AirtableReconcileRequest = z.infer<
  typeof airtableReconcileRequestSchema
>;
export type AirtableReconcileResponse = z.infer<
  typeof airtableReconcileResponseSchema
>;
