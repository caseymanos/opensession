import { z } from "zod";

const stableIdentifierSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);

export const demoBootstrapRequestSchema = z
  .object({
    owner_email: z.email().trim().max(320),
  })
  .strict();

export const demoResetRequestSchema = z
  .object({
    confirmation: z.string().min(1).max(128),
  })
  .strict();

export const demoOperationReceiptSchema = z
  .object({
    audit_event_id: stableIdentifierSchema,
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    operation_count: z.int().positive(),
    outcome: z.enum(["applied", "replayed"]),
    reset_run_id: stableIdentifierSchema,
    snapshot_id: stableIdentifierSchema,
  })
  .strict();

export const demoBootstrapResponseSchema = z
  .object({
    asset_count: z.int().nonnegative(),
    authority_ready: z.literal(true),
    receipt: demoOperationReceiptSchema,
    root_lineage_verified: z.literal(true),
  })
  .strict();

export const demoResetResponseSchema = z
  .object({ receipt: demoOperationReceiptSchema })
  .strict();

export type DemoBootstrapRequest = z.infer<typeof demoBootstrapRequestSchema>;
export type DemoBootstrapResponse = z.infer<typeof demoBootstrapResponseSchema>;
export type DemoResetRequest = z.infer<typeof demoResetRequestSchema>;
export type DemoResetResponse = z.infer<typeof demoResetResponseSchema>;
