import { z } from "zod";

import { taskReadinessSchema } from "./tasks";

const idSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);

export const readinessStatusFilterSchema = z.enum([
  "all",
  "not_configured",
  "outstanding",
  "overdue",
  "ready",
]);

export const readinessDueFilterSchema = z.enum([
  "all",
  "overdue",
  "next_7_days",
  "no_due",
  "complete",
]);

export const readinessDashboardQuerySchema = z
  .object({
    due: readinessDueFilterSchema.default("all"),
    page: z.coerce.number().int().min(1).max(200).default(1),
    page_size: z.coerce.number().int().min(10).max(100).default(25),
    portal: z
      .enum(["all", "active", "invited", "not_invited", "revoked"])
      .default("all"),
    q: z.string().trim().max(160).default(""),
    readiness: readinessStatusFilterSchema.default("all"),
    task: z.union([z.literal("all"), idSchema]).default("all"),
    track: z.union([z.literal("all"), idSchema]).default("all"),
  })
  .strict();

const filterOptionSchema = z
  .object({ id: idSchema, name: z.string().trim().min(1).max(200) })
  .strict();

const readinessProjectionSchema = z
  .object({
    as_of: z.iso.datetime(),
    pending_repairs: z.number().int().nonnegative(),
    reasons: z
      .array(
        z.enum([
          "repair_pending",
          "schedule_unavailable",
          "synchronization_delayed",
          "upstream_rebuilding",
        ]),
      )
      .max(4),
    state: z.enum(["current", "stale", "partial"]),
  })
  .strict();

export const readinessDashboardSpeakerSchema = z
  .object({
    company: z.string().trim().max(200),
    contact_id: idSchema,
    display_name: z.string().trim().min(1).max(200),
    email: z.email().max(320),
    portal_state: z.enum(["active", "invited", "not_invited", "revoked"]),
    readiness: taskReadinessSchema,
    sessions: z
      .array(
        z
          .object({
            id: idSchema,
            title: z.string().trim().min(1).max(300),
            track: filterOptionSchema.nullable(),
          })
          .strict(),
      )
      .max(200),
    task_definition_ids: z.array(idSchema).max(500),
  })
  .strict();

export const readinessDashboardResponseSchema = z
  .object({
    attention: z.array(readinessDashboardSpeakerSchema).max(5),
    event: z
      .object({
        id: idSchema,
        name: z.string().trim().min(1).max(200),
        slug: idSchema,
        timezone: z.string().trim().min(1).max(100),
      })
      .strict(),
    filters: z
      .object({
        tasks: z.array(filterOptionSchema).max(500),
        tracks: z.array(filterOptionSchema).max(500),
      })
      .strict(),
    generated_at: z.iso.datetime(),
    metrics: z
      .object({
        accepted_unscheduled: z.number().int().nonnegative(),
        hard_conflicts: z.number().int().nonnegative().nullable(),
        new_submissions: z.number().int().nonnegative(),
        overdue_assignments: z.number().int().nonnegative(),
        reviews_remaining: z.number().int().nonnegative(),
        speakers_ready: z.number().int().nonnegative(),
        speakers_total: z.number().int().nonnegative(),
      })
      .strict()
      .refine((value) => value.speakers_ready <= value.speakers_total, {
        message: "Ready speakers cannot exceed total speakers.",
      }),
    page: z
      .object({
        number: z.number().int().positive(),
        size: z.number().int().min(10).max(100),
        total: z.number().int().nonnegative(),
        total_pages: z.number().int().nonnegative(),
      })
      .strict(),
    projection: readinessProjectionSchema,
    speakers: z.array(readinessDashboardSpeakerSchema).max(100),
  })
  .strict();

export type ReadinessDashboardQuery = z.infer<
  typeof readinessDashboardQuerySchema
>;
export type ReadinessDashboardResponse = z.infer<
  typeof readinessDashboardResponseSchema
>;
export type ReadinessDashboardSpeaker = z.infer<
  typeof readinessDashboardSpeakerSchema
>;
