import { z } from "zod";

import { taskAssignmentStateSchema, taskReadinessSchema } from "./tasks";

const stableIdSchema = z
  .string()
  .trim()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]+$/);

export const speakerPortalSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);

const nullableDateTimeSchema = z.iso.datetime().nullable();
const colorSchema = z.string().regex(/^#[0-9a-f]{6}$/i);

function relativeLuminance(color: string): number {
  const channels = [1, 3, 5].map((offset) =>
    Number.parseInt(color.slice(offset, offset + 2), 16),
  );
  const linear = channels.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045
      ? value / 12.92
      : Math.pow((value + 0.055) / 1.055, 2.4);
  });
  return (
    0.2126 * (linear[0] ?? 0) +
    0.7152 * (linear[1] ?? 0) +
    0.0722 * (linear[2] ?? 0)
  );
}

function contrastRatio(first: string, second: string): number {
  const light = Math.max(relativeLuminance(first), relativeLuminance(second));
  const dark = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (light + 0.05) / (dark + 0.05);
}

export const speakerPortalBrandSchema = z
  .object({
    accent: colorSchema,
    background: colorSchema,
    ink: colorSchema,
  })
  .strict()
  .superRefine((brand, context) => {
    if (
      contrastRatio(brand.ink, brand.background) < 4.5 ||
      contrastRatio(brand.ink, brand.accent) < 4.5
    ) {
      context.addIssue({
        code: "custom",
        message: "Speaker portal brand colors must remain readable.",
      });
    }
  });

export const speakerPortalInvitationRequestSchema = z
  .object({
    email: z.email().trim().max(320),
    turnstile_action: z.literal("sign_in"),
    turnstile_token: z.string().trim().min(1).max(2_048),
  })
  .strict();

export const speakerPortalInvitationRecoverySchema = z
  .object({
    email_hint: z.string().trim().min(3).max(320),
    event: z
      .object({
        brand: speakerPortalBrandSchema,
        name: z.string().trim().min(1).max(200),
        slug: speakerPortalSlugSchema,
      })
      .strict(),
    reason: z.enum(["expired", "redeemed", "revoked"]),
  })
  .strict();

export const speakerPortalTaskSchema = z
  .object({
    approval_required: z.boolean(),
    assignment_state: taskAssignmentStateSchema,
    completed_at: nullableDateTimeSchema,
    description: z.string().max(4_000),
    due_at: nullableDateTimeSchema,
    id: stableIdSchema,
    required: z.boolean(),
    session_id: stableIdSchema.nullable(),
    source_status: z.enum([
      "not_started",
      "in_progress",
      "submitted",
      "complete",
      "rejected",
      "waived",
    ]),
    status: z.enum(["complete", "open", "overdue"]),
    title: z.string().trim().min(1).max(300),
  })
  .strict();

export const speakerPortalSessionSchema = z
  .object({
    co_speakers: z.array(z.string().trim().min(1).max(200)).max(50),
    confirmed_state: z.enum(["pending", "confirmed"]),
    duration_minutes: z.number().int().positive().nullable(),
    format: z.string().trim().min(1).max(200),
    friendly_id: z.string().trim().min(1).max(128),
    id: stableIdSchema,
    role: z.enum(["speaker", "moderator", "chair"]),
    schedule: z
      .object({
        ends_at: z.iso.datetime(),
        room: z.string().trim().min(1).max(300),
        starts_at: z.iso.datetime(),
      })
      .strict()
      .nullable(),
    source_status: z.enum(["draft", "accepted", "scheduled", "published"]),
    title: z.string().trim().min(1).max(500),
    track: z.string().trim().min(1).max(200),
  })
  .strict();

export const speakerPortalBootstrapResponseSchema = z
  .object({
    event: z
      .object({
        brand: speakerPortalBrandSchema,
        days_remaining: z.number().int().nonnegative().nullable(),
        ends_at: nullableDateTimeSchema,
        id: stableIdSchema,
        name: z.string().trim().min(1).max(200),
        slug: speakerPortalSlugSchema,
        starts_at: nullableDateTimeSchema,
        status: z.enum(["draft", "open", "closed", "published", "archived"]),
        timezone: z.string().trim().min(1).max(100),
        venue: z.string().max(500).nullable(),
      })
      .strict(),
    generated_at: z.iso.datetime(),
    portal_status: z.enum(["invited", "active"]),
    readiness: z
      .object({
        next_due_at: nullableDateTimeSchema,
        outstanding_task_count: z.number().int().nonnegative(),
        overdue_task_count: z.number().int().nonnegative(),
        policy: taskReadinessSchema,
        required_complete: z.number().int().nonnegative(),
        required_total: z.number().int().nonnegative(),
        status: z.enum(["not_configured", "outstanding", "overdue", "ready"]),
      })
      .strict(),
    sessions: z.array(speakerPortalSessionSchema).max(200),
    speaker: z
      .object({
        contact_id: stableIdSchema,
        display_name: z.string().trim().min(1).max(200),
        email: z.email().max(320),
      })
      .strict(),
    tasks: z.array(speakerPortalTaskSchema).max(500),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.readiness.required_complete > value.readiness.required_total) {
      context.addIssue({
        code: "custom",
        message: "Completed required tasks cannot exceed the required total.",
        path: ["readiness", "required_complete"],
      });
    }
  });

export type SpeakerPortalBootstrapResponse = z.infer<
  typeof speakerPortalBootstrapResponseSchema
>;
export type SpeakerPortalBrand = z.infer<typeof speakerPortalBrandSchema>;
export type SpeakerPortalInvitationRecovery = z.infer<
  typeof speakerPortalInvitationRecoverySchema
>;
export type SpeakerPortalInvitationRequest = z.infer<
  typeof speakerPortalInvitationRequestSchema
>;
export type SpeakerPortalSession = z.infer<typeof speakerPortalSessionSchema>;
export type SpeakerPortalTask = z.infer<typeof speakerPortalTaskSchema>;
