import { z } from "zod";

import { emailMergeFieldDefinitions } from "./types.js";
import type {
  EmailDocument,
  EmailDocumentBlock,
  EmailMergeFieldName,
  EmailTemplate,
  EmailTemplateDraft,
  EmailTemplateIssue,
  RenderedEmailTemplate,
  ResolvedEmailMergeField,
} from "./types.js";

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
const emailAddressValueSchema = z
  .string()
  .min(3)
  .max(320)
  .refine((value) => !/[\r\n\0]/u.test(value), {
    message: "Email address contains unsafe characters.",
  });

const mergeFieldNames = Object.keys(emailMergeFieldDefinitions) as [
  EmailMergeFieldName,
  ...EmailMergeFieldName[],
];

export const emailMergeFieldNameSchema = z.enum(mergeFieldNames);
export const emailTemplateAudienceSchema = z.enum([
  "organizer",
  "reviewer",
  "speaker",
  "submitter",
]);
export const emailTemplateStatusSchema = z.enum([
  "active",
  "archived",
  "draft",
]);

const headingBlockSchema = z
  .object({ text: z.string().max(8_000), type: z.literal("heading") })
  .strict() satisfies z.ZodType<
  Extract<EmailDocumentBlock, { type: "heading" }>
>;
const paragraphBlockSchema = z
  .object({ text: z.string().max(8_000), type: z.literal("paragraph") })
  .strict() satisfies z.ZodType<
  Extract<EmailDocumentBlock, { type: "paragraph" }>
>;
const buttonBlockSchema = z
  .object({
    label: z.string().max(120),
    type: z.literal("button"),
    url: z.string().max(2_048),
  })
  .strict() satisfies z.ZodType<
  Extract<EmailDocumentBlock, { type: "button" }>
>;
const dividerBlockSchema = z
  .object({ type: z.literal("divider") })
  .strict() satisfies z.ZodType<
  Extract<EmailDocumentBlock, { type: "divider" }>
>;

export const emailDocumentBlockSchema = z.discriminatedUnion("type", [
  headingBlockSchema,
  paragraphBlockSchema,
  buttonBlockSchema,
  dividerBlockSchema,
]);

export const emailDocumentSchema = z
  .object({
    blocks: z.array(emailDocumentBlockSchema).min(1).max(100),
    previewText: z.string().max(180),
  })
  .strict() satisfies z.ZodType<EmailDocument>;

const emailAddressSchema = z
  .object({
    address: emailAddressValueSchema,
    name: z.string().min(1).max(80),
  })
  .strict();

export const emailTemplateDraftSchema = z
  .object({
    allowedMergeFields: z.array(emailMergeFieldNameSchema).max(64),
    audience: emailTemplateAudienceSchema,
    body: emailDocumentSchema,
    internalName: z.string().min(1).max(120),
    replyTo: emailAddressValueSchema,
    sender: emailAddressSchema,
    subject: z.string().min(1).max(200),
  })
  .strict() satisfies z.ZodType<EmailTemplateDraft>;

export const emailTemplateSchema = emailTemplateDraftSchema
  .extend({
    createdAt: utcInstantSchema,
    eventId: identifierSchema,
    id: identifierSchema,
    mergeSchemaVersion: z.literal(1),
    status: emailTemplateStatusSchema,
    updatedAt: utcInstantSchema,
    version: z.int().positive(),
  })
  .strict() satisfies z.ZodType<EmailTemplate>;

export const emailTemplateIssueSchema = z
  .object({
    code: z.enum([
      "duplicate_field",
      "field_not_allowed",
      "invalid_address",
      "invalid_field_value",
      "invalid_template",
      "invalid_token",
      "missing_field_value",
      "output_too_large",
      "unknown_field",
      "unsafe_url",
    ]),
    location: z.string().min(1).max(240),
    message: z.string().min(1).max(1_000),
    offset: z.int().nonnegative().optional(),
  })
  .strict() satisfies z.ZodType<EmailTemplateIssue>;

export const renderedEmailTemplateSchema = z
  .object({
    from: z.string().min(1).max(500),
    html: z.string().max(96 * 1_024),
    replyTo: emailAddressValueSchema,
    subject: z.string().min(1).max(200),
    templateId: identifierSchema,
    templateVersion: z.int().positive(),
    text: z.string().max(96 * 1_024),
    usedFields: z.array(emailMergeFieldNameSchema).max(64),
  })
  .strict() satisfies z.ZodType<RenderedEmailTemplate>;

export const resolvedEmailMergeFieldSchema = z
  .object({
    displayValue: z.string().max(4_000),
    name: emailMergeFieldNameSchema,
    type: z.enum(["date_time", "email", "text", "url"]),
  })
  .strict() satisfies z.ZodType<ResolvedEmailMergeField>;

export const emailTemplateRecordSchema = z
  .object({
    sourceVersion: z.int().positive(),
    template: emailTemplateSchema,
  })
  .strict();

export const emailPreviewRecipientSchema = z
  .object({
    email: emailAddressValueSchema,
    id: identifierSchema,
    name: z.string().min(1).max(160),
    roles: z.array(z.string().min(1).max(80)).min(1).max(16),
  })
  .strict();

export const emailTemplateWorkspaceSchema = z
  .object({
    event: z
      .object({
        id: identifierSchema,
        name: z.string().min(1).max(240),
        slug: identifierSchema,
      })
      .strict(),
    mergeFields: z
      .array(
        z
          .object({
            name: emailMergeFieldNameSchema,
            type: z.enum(["date_time", "email", "text", "url"]),
          })
          .strict(),
      )
      .max(64),
    recipients: z.array(emailPreviewRecipientSchema).max(200),
    templates: z.array(emailTemplateRecordSchema).max(100),
  })
  .strict();

export const emailTemplatePreviewSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("seed") }).strict(),
  z
    .object({ kind: z.literal("recipient"), recipientId: identifierSchema })
    .strict(),
]);

export const emailTemplatePreviewRequestSchema = z
  .object({
    baseTemplateId: identifierSchema,
    source: emailTemplatePreviewSourceSchema,
    template: emailTemplateDraftSchema,
  })
  .strict();

export const emailTemplatePreviewResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      preview: renderedEmailTemplateSchema,
      resolvedFields: z.array(resolvedEmailMergeFieldSchema).max(64),
      source: emailTemplatePreviewSourceSchema,
    })
    .strict(),
  z
    .object({
      issues: z.array(emailTemplateIssueSchema).min(1).max(200),
      ok: z.literal(false),
      resolvedFields: z.array(resolvedEmailMergeFieldSchema).max(64),
      source: emailTemplatePreviewSourceSchema,
    })
    .strict(),
]);

const commandBaseSchema = {
  baseTemplateId: identifierSchema,
  commandId: identifierSchema,
  expectedSourceVersion: z.int().positive(),
} as const;

export const emailTemplateCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...commandBaseSchema,
      template: emailTemplateDraftSchema,
      type: z.literal("create_revision"),
    })
    .strict(),
  z
    .object({
      ...commandBaseSchema,
      source: emailTemplatePreviewSourceSchema,
      template: emailTemplateDraftSchema,
      type: z.literal("activate_version"),
    })
    .strict(),
  z
    .object({
      ...commandBaseSchema,
      type: z.literal("archive_version"),
    })
    .strict(),
]);

const emailTemplateCommandErrorSchema = z
  .object({
    actualSourceVersion: z.int().positive().optional(),
    code: z.enum([
      "email_template_historical_version",
      "email_template_validation_error",
      "email_template_version_conflict",
    ]),
    expectedSourceVersion: z.int().positive().optional(),
    issues: z.array(emailTemplateIssueSchema).max(200).optional(),
    message: z.string().min(1).max(1_000),
  })
  .strict();

export const emailTemplateCommandResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      result: z
        .object({
          projection: z.enum(["durable", "repair_pending"]),
          record: emailTemplateRecordSchema,
          replayed: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      error: emailTemplateCommandErrorSchema,
      ok: z.literal(false),
    })
    .strict(),
]);

export interface EmailPreviewRecipient {
  readonly email: string;
  readonly id: string;
  readonly name: string;
  readonly roles: readonly string[];
}

export type EmailTemplatePreviewSource =
  | { readonly kind: "seed" }
  | { readonly kind: "recipient"; readonly recipientId: string };

export interface EmailTemplateRecord {
  readonly sourceVersion: number;
  readonly template: EmailTemplate;
}

export interface EmailTemplateWorkspace {
  readonly event: {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
  };
  readonly mergeFields: readonly {
    readonly name: EmailMergeFieldName;
    readonly type: (typeof emailMergeFieldDefinitions)[EmailMergeFieldName]["type"];
  }[];
  readonly recipients: readonly EmailPreviewRecipient[];
  readonly templates: readonly EmailTemplateRecord[];
}

export interface EmailTemplatePreviewRequest {
  readonly baseTemplateId: string;
  readonly source: EmailTemplatePreviewSource;
  readonly template: EmailTemplateDraft;
}

export type EmailTemplatePreviewResponse =
  | {
      readonly ok: true;
      readonly preview: RenderedEmailTemplate;
      readonly resolvedFields: readonly ResolvedEmailMergeField[];
      readonly source: EmailTemplatePreviewSource;
    }
  | {
      readonly issues: readonly EmailTemplateIssue[];
      readonly ok: false;
      readonly resolvedFields: readonly ResolvedEmailMergeField[];
      readonly source: EmailTemplatePreviewSource;
    };

interface EmailTemplateCommandBase {
  readonly baseTemplateId: string;
  readonly commandId: string;
  readonly expectedSourceVersion: number;
}

export type EmailTemplateCommand =
  | (EmailTemplateCommandBase & {
      readonly template: EmailTemplateDraft;
      readonly type: "create_revision";
    })
  | (EmailTemplateCommandBase & {
      readonly source: EmailTemplatePreviewSource;
      readonly template: EmailTemplateDraft;
      readonly type: "activate_version";
    })
  | (EmailTemplateCommandBase & { readonly type: "archive_version" });

export type EmailTemplateCommandResponse =
  | {
      readonly ok: true;
      readonly result: {
        readonly projection: "durable" | "repair_pending";
        readonly record: EmailTemplateRecord;
        readonly replayed: boolean;
      };
    }
  | {
      readonly error: {
        readonly actualSourceVersion?: number | undefined;
        readonly code:
          | "email_template_historical_version"
          | "email_template_validation_error"
          | "email_template_version_conflict";
        readonly expectedSourceVersion?: number | undefined;
        readonly issues?: readonly EmailTemplateIssue[] | undefined;
        readonly message: string;
      };
      readonly ok: false;
    };
