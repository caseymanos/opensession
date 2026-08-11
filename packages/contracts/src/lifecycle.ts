import { z } from "zod";

const idSchema = z
  .string()
  .trim()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);

export const taskReminderScheduleCommandSchema = z
  .object({
    command_id: idSchema,
    definition_id: idSchema,
    lead_minutes: z.number().int().min(0).max(43_200),
    type: z.literal("schedule"),
  })
  .strict();

export const taskReminderControlCommandSchema = z
  .object({
    command_id: idSchema,
    type: z.enum(["cancel", "retry"]),
  })
  .strict();

export const taskReminderResultSchema = z
  .object({
    assignment_id: idSchema,
    contact_id: idSchema,
    disposition: z.enum(["queued", "skipped"]),
    evaluated_at: z.iso.datetime(),
    message_id: idSchema.nullable(),
    reason: z.enum([
      "already_queued",
      "completed",
      "missing_due",
      "missing_email",
      "optional",
      "queued",
      "suppressed",
    ]),
  })
  .strict();

export const taskReminderJobSchema = z
  .object({
    created_at: z.iso.datetime(),
    definition_id: idSchema,
    event_id: idSchema,
    id: idSchema,
    lead_minutes: z.number().int().min(0).max(43_200),
    next_wake_at: z.iso.datetime().nullable(),
    provider_instance_id: idSchema.nullable(),
    results: z.array(taskReminderResultSchema).max(5_000),
    status: z.enum([
      "queued",
      "running",
      "sleeping",
      "complete",
      "failed",
      "canceled",
    ]),
    timezone: z.string().trim().min(1).max(100),
    updated_at: z.iso.datetime(),
  })
  .strict();

export const taskReminderCommandResponseSchema = z
  .object({
    job: taskReminderJobSchema,
    ok: z.literal(true),
    replayed: z.boolean(),
  })
  .strict();

export type TaskReminderControlCommand = z.infer<
  typeof taskReminderControlCommandSchema
>;
export type TaskReminderJob = z.infer<typeof taskReminderJobSchema>;
export type TaskReminderScheduleCommand = z.infer<
  typeof taskReminderScheduleCommandSchema
>;
