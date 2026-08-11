import { z } from "zod";

import {
  emailTemplateAudienceSchema,
  emailTemplateSchema,
} from "./contracts.js";
import type {
  CampaignAudienceFilter,
  CampaignExclusionReason,
  CampaignPlan,
  CampaignSchedule,
} from "./campaign.js";

const identifierSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const utcInstantSchema = z.iso
  .datetime()
  .refine((value) => value.endsWith("Z"), {
    message: "Timestamp must use UTC (Z).",
  });
const emailSchema = z
  .email()
  .max(320)
  .refine((value) => !/[\r\n\0]/u.test(value), {
    message: "Email address contains unsafe characters.",
  });
const errorCodeSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z][A-Za-z0-9._-]*$/);

export const campaignPortalStateSchema = z.enum([
  "active",
  "invited",
  "not_invited",
  "revoked",
]);
export const campaignReadinessSchema = z.enum(["all", "outstanding", "ready"]);
export const campaignExclusionReasonSchema = z.enum([
  "bounced",
  "complained",
  "cross_event",
  "duplicate_contact",
  "duplicate_email",
  "invalid_email",
  "invalid_merge_values",
  "manual",
  "portal_state_mismatch",
  "provider_suppressed",
  "readiness_mismatch",
  "role_mismatch",
]) satisfies z.ZodType<CampaignExclusionReason>;

export const campaignAudienceFilterSchema = z
  .object({
    portalStates: z.array(campaignPortalStateSchema).max(4),
    readiness: campaignReadinessSchema,
    roles: z.array(emailTemplateAudienceSchema).min(1).max(4),
  })
  .strict() satisfies z.ZodType<CampaignAudienceFilter>;

export const campaignScheduleSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("now") }).strict(),
  z
    .object({ mode: z.literal("scheduled"), scheduledAt: utcInstantSchema })
    .strict(),
]) satisfies z.ZodType<CampaignSchedule>;

const campaignAudienceSampleSchema = z
  .object({
    contactId: identifierSchema,
    displayName: z.string().min(1).max(160),
    email: emailSchema,
  })
  .strict();

const campaignAudienceSnapshotSchema = z
  .object({
    createdAt: utcInstantSchema,
    eventId: identifierSchema,
    excluded: z
      .array(
        z
          .object({
            contactId: identifierSchema,
            reason: campaignExclusionReasonSchema,
          })
          .strict(),
      )
      .max(10_000),
    excludedCount: z.int().nonnegative(),
    filter: campaignAudienceFilterSchema,
    includedContactIds: z.array(identifierSchema).max(10_000),
    includedCount: z.int().nonnegative(),
    samples: z.array(campaignAudienceSampleSchema).max(5),
    totalCandidates: z.int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.excludedCount !== value.excluded.length) {
      context.addIssue({
        code: "custom",
        message: "Excluded count does not match the snapshot.",
        path: ["excludedCount"],
      });
    }
    if (value.includedCount !== value.includedContactIds.length) {
      context.addIssue({
        code: "custom",
        message: "Included count does not match the snapshot.",
        path: ["includedCount"],
      });
    }
    if (value.includedCount + value.excludedCount !== value.totalCandidates) {
      context.addIssue({
        code: "custom",
        message: "Audience totals do not reconcile.",
        path: ["totalCandidates"],
      });
    }
  });

export const campaignPlanSchema = z
  .object({
    audience: campaignAudienceSnapshotSchema,
    schedule: campaignScheduleSchema,
    sender: z
      .object({ address: emailSchema, name: z.string().min(1).max(80) })
      .strict(),
    template: emailTemplateSchema,
  })
  .strict() satisfies z.ZodType<CampaignPlan>;

export const campaignPreviewRequestSchema = z
  .object({
    filter: campaignAudienceFilterSchema,
    schedule: campaignScheduleSchema,
    templateId: identifierSchema,
  })
  .strict();

const exclusionCountSchema = z
  .object({
    count: z.int().positive(),
    reason: campaignExclusionReasonSchema,
  })
  .strict();

export const campaignPreviewResponseSchema = z
  .object({
    audience: z
      .object({
        excludedByReason: z.array(exclusionCountSchema).max(16),
        excludedCount: z.int().nonnegative(),
        includedCount: z.int().nonnegative(),
        samples: z.array(campaignAudienceSampleSchema).max(5),
        totalCandidates: z.int().nonnegative(),
      })
      .strict(),
    createdAt: utcInstantSchema,
    expiresAt: utcInstantSchema,
    filter: campaignAudienceFilterSchema,
    previewId: z.string().regex(/^campaign_preview_[a-f\d]{64}$/),
    schedule: campaignScheduleSchema,
    sender: z
      .object({ address: emailSchema, name: z.string().min(1).max(80) })
      .strict(),
    template: z
      .object({
        audience: emailTemplateAudienceSchema,
        id: identifierSchema,
        internalName: z.string().min(1).max(120),
        subject: z.string().min(1).max(200),
        version: z.int().positive(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.audience.includedCount + value.audience.excludedCount !==
      value.audience.totalCandidates
    ) {
      context.addIssue({
        code: "custom",
        message: "Preview audience totals do not reconcile.",
        path: ["audience", "totalCandidates"],
      });
    }
    if (value.audience.samples.length > value.audience.includedCount) {
      context.addIssue({
        code: "custom",
        message: "Preview samples exceed the included audience.",
        path: ["audience", "samples"],
      });
    }
    const exclusionTotal = value.audience.excludedByReason.reduce(
      (total, item) => total + item.count,
      0,
    );
    if (exclusionTotal !== value.audience.excludedCount) {
      context.addIssue({
        code: "custom",
        message: "Preview exclusion reasons do not reconcile.",
        path: ["audience", "excludedByReason"],
      });
    }
  });

export const campaignConfirmRequestSchema = campaignPreviewRequestSchema
  .extend({
    commandId: identifierSchema,
    previewCreatedAt: utcInstantSchema,
    previewId: z.string().regex(/^campaign_preview_[a-f\d]{64}$/),
  })
  .strict();

export const campaignConfirmResponseSchema = z
  .object({
    campaignId: identifierSchema,
    messages: z
      .object({
        alreadyQueued: z.int().nonnegative(),
        queued: z.int().nonnegative(),
        suppressed: z.int().nonnegative(),
        total: z.int().nonnegative(),
      })
      .strict(),
    projection: z.enum(["durable", "repair_pending"]),
    replayed: z.boolean(),
    scheduledAt: utcInstantSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.messages.alreadyQueued +
        value.messages.queued +
        value.messages.suppressed !==
      value.messages.total
    ) {
      context.addIssue({
        code: "custom",
        message: "Campaign message totals do not reconcile.",
        path: ["messages", "total"],
      });
    }
  });

export const campaignDeliveryStatusSchema = z.enum([
  "bounced",
  "complained",
  "delivered",
  "failed",
  "queued",
  "sending",
  "sent",
  "suppressed",
]);

export const campaignDeliveryCountsSchema = z
  .object({
    bounced: z.int().nonnegative(),
    complained: z.int().nonnegative(),
    delivered: z.int().nonnegative(),
    failed: z.int().nonnegative(),
    queued: z.int().nonnegative(),
    sending: z.int().nonnegative(),
    sent: z.int().nonnegative(),
    suppressed: z.int().nonnegative(),
  })
  .strict();

export const campaignDeliveryMessageSchema = z
  .object({
    attemptCount: z.int().nonnegative(),
    errorCode: errorCodeSchema.nullable(),
    lastEventAt: utcInstantSchema.nullable(),
    messageId: z.string().regex(/^email_[a-f\d]{64}$/),
    providerMessageId: z.string().min(1).max(256).nullable(),
    replayable: z.boolean(),
    status: campaignDeliveryStatusSchema,
  })
  .strict();

export const campaignSummarySchema = z
  .object({
    campaignId: identifierSchema,
    counts: campaignDeliveryCountsSchema,
    createdAt: utcInstantSchema,
    messageCount: z.int().nonnegative(),
    scheduledAt: utcInstantSchema,
    status: z.enum(["complete", "draft", "failed", "scheduled", "sending"]),
    templateId: identifierSchema,
    templateName: z.string().min(1).max(120),
    templateVersion: z.int().positive(),
  })
  .strict()
  .superRefine((value, context) => {
    const count = Object.values(value.counts).reduce(
      (total, item) => total + item,
      0,
    );
    if (count !== value.messageCount) {
      context.addIssue({
        code: "custom",
        message: "Campaign delivery counts do not reconcile.",
        path: ["messageCount"],
      });
    }
  });

export const campaignWorkspaceSchema = z
  .object({
    campaigns: z.array(campaignSummarySchema).max(100),
    deliveryMode: z.enum(["allowlist", "live", "sink"]),
    event: z
      .object({
        id: identifierSchema,
        name: z.string().min(1).max(240),
        slug: identifierSchema,
      })
      .strict(),
    templates: z
      .array(
        z
          .object({
            audience: emailTemplateAudienceSchema,
            id: identifierSchema,
            internalName: z.string().min(1).max(120),
            sender: z
              .object({
                address: emailSchema,
                name: z.string().min(1).max(80),
              })
              .strict(),
            subject: z.string().min(1).max(200),
            version: z.int().positive(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

export const campaignDeliveryLogSchema = z
  .object({
    campaign: campaignSummarySchema,
    messages: z.array(campaignDeliveryMessageSchema).max(10_000),
  })
  .strict();

export const campaignReplayRequestSchema = z
  .object({
    messageId: z
      .string()
      .regex(/^email_[a-f\d]{64}$/)
      .optional(),
  })
  .strict();

export const campaignReplayResponseSchema = z
  .object({
    campaignId: identifierSchema,
    notReplayable: z.int().nonnegative(),
    queued: z.int().nonnegative(),
    suppressed: z.int().nonnegative(),
  })
  .strict();

export type CampaignPreviewRequest = z.infer<
  typeof campaignPreviewRequestSchema
>;
export type CampaignPreviewResponse = z.infer<
  typeof campaignPreviewResponseSchema
>;
export type CampaignConfirmRequest = z.infer<
  typeof campaignConfirmRequestSchema
>;
export type CampaignConfirmResponse = z.infer<
  typeof campaignConfirmResponseSchema
>;
export type CampaignWorkspace = z.infer<typeof campaignWorkspaceSchema>;
export type CampaignSummary = z.infer<typeof campaignSummarySchema>;
export type CampaignDeliveryLog = z.infer<typeof campaignDeliveryLogSchema>;
export type CampaignDeliveryCounts = z.infer<
  typeof campaignDeliveryCountsSchema
>;
export type CampaignDeliveryMessage = z.infer<
  typeof campaignDeliveryMessageSchema
>;
export type CampaignReplayRequest = z.infer<typeof campaignReplayRequestSchema>;
export type CampaignReplayResponse = z.infer<
  typeof campaignReplayResponseSchema
>;
