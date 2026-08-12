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

export const demoProvisionedRoleSchema = z.enum([
  "organizer",
  "reviewer",
  "speaker",
]);

const demoRoleIdentitySchema = z
  .object({
    email: z.email().trim().max(320),
    role: demoProvisionedRoleSchema,
  })
  .strict();

export const demoRoleProvisioningRequestSchema = z
  .object({
    confirmation: z.string().min(1).max(128),
    fixture_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    identities: z.array(demoRoleIdentitySchema).length(3),
  })
  .strict()
  .superRefine((value, context) => {
    const roles = new Set(value.identities.map(({ role }) => role));
    if (
      roles.size !== 3 ||
      !demoProvisionedRoleSchema.options.every((role) => roles.has(role))
    ) {
      context.addIssue({
        code: "custom",
        message: "Each supported demo role must be supplied exactly once.",
        path: ["identities"],
      });
    }
    const normalizedEmails = value.identities.map(({ email }) =>
      email.toLowerCase(),
    );
    if (new Set(normalizedEmails).size !== normalizedEmails.length) {
      context.addIssue({
        code: "custom",
        message: "Demo role aliases must normalize to distinct addresses.",
        path: ["identities"],
      });
    }
  });

const demoRolePlanIdentitySchema = z
  .object({
    display_name: z.string().trim().min(1).max(200),
    role: demoProvisionedRoleSchema,
  })
  .strict();

export const demoRoleProvisioningPlanResponseSchema = z
  .object({
    confirmation: z.string().min(1).max(128),
    event_id: stableIdentifierSchema,
    fixture_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    identities: z.array(demoRolePlanIdentitySchema).length(3),
    organization_id: stableIdentifierSchema,
  })
  .strict();

const demoProvisionedIdentityReceiptSchema = z
  .object({
    identity_id: stableIdentifierSchema,
    role: demoProvisionedRoleSchema,
  })
  .strict();

export const demoRoleProvisioningResponseSchema = z
  .object({
    receipt: z
      .object({
        audit_event_id: stableIdentifierSchema,
        fixture_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
        identities: z.array(demoProvisionedIdentityReceiptSchema).length(3),
        outcome: z.enum(["applied", "replayed"]),
      })
      .strict(),
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
export type DemoProvisionedRole = z.infer<typeof demoProvisionedRoleSchema>;
export type DemoRoleProvisioningRequest = z.infer<
  typeof demoRoleProvisioningRequestSchema
>;
export type DemoRoleProvisioningPlanResponse = z.infer<
  typeof demoRoleProvisioningPlanResponseSchema
>;
export type DemoRoleProvisioningResponse = z.infer<
  typeof demoRoleProvisioningResponseSchema
>;
