import { z } from "zod";

export const cfpFormIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);

export const cfpFormStatusSchema = z.enum(["draft", "published", "closed"]);

export const cfpFormFieldTypeSchema = z.enum([
  "checkbox",
  "file",
  "long_text",
  "multi_select",
  "participant",
  "section",
  "short_text",
  "single_select",
  "url",
]);

export const cfpFormRuleSchema = z
  .object({
    effect: z.enum(["require", "show"]),
    id: cfpFormIdentifierSchema,
    operator: z.enum(["equals", "includes"]),
    sourceKey: cfpFormIdentifierSchema,
    value: z.string().max(4_000),
  })
  .strict();

export const cfpFormFieldValidationSchema = z
  .object({
    maxLength: z.int().positive().max(20_000).optional(),
    minLength: z.int().nonnegative().max(20_000).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.minLength === undefined ||
      value.maxLength === undefined ||
      value.minLength <= value.maxLength,
    { message: "Minimum length cannot exceed maximum length." },
  );

const cfpFormFieldContentShape = {
  helpText: z.string().max(2_000),
  key: cfpFormIdentifierSchema,
  label: z.string().trim().min(1).max(240),
  options: z.array(z.string().trim().min(1).max(240)).max(128),
  required: z.boolean(),
  rules: z.array(cfpFormRuleSchema).max(64),
  type: cfpFormFieldTypeSchema,
  validation: cfpFormFieldValidationSchema,
} as const;

export const publicCfpFieldSchema = z.object(cfpFormFieldContentShape).strict();

export const organizerCfpFormFieldSchema = z
  .object({
    ...cfpFormFieldContentShape,
    id: cfpFormIdentifierSchema,
    order: z.int().positive().max(128),
  })
  .strict();

export const cfpFormDiagnosticCodeSchema = z.enum([
  "cyclic_reference",
  "duplicate_field_id",
  "duplicate_key",
  "duplicate_option",
  "duplicate_rule_id",
  "empty_options",
  "forward_reference",
  "invalid_operator",
  "invalid_options",
  "invalid_order",
  "invalid_validation",
  "missing_abstract_field",
  "missing_option",
  "missing_format_field",
  "missing_outcomes_field",
  "missing_source",
  "missing_title_field",
  "missing_track_field",
  "required_section",
  "source_not_choice",
  "too_many_rules",
  "unroutable_track_option",
  "unsupported_public_field",
  "unsupported_format_option",
]);

export const cfpFormDiagnosticSchema = z
  .object({
    code: cfpFormDiagnosticCodeSchema,
    fieldId: cfpFormIdentifierSchema.optional(),
    fieldKey: cfpFormIdentifierSchema.optional(),
    message: z.string().min(1).max(1_000),
    path: z.string().min(1).max(500),
    ruleId: cfpFormIdentifierSchema.optional(),
  })
  .strict();

export const organizerCfpFormSchema = z
  .object({
    editAfterClose: z.boolean(),
    fields: z.array(organizerCfpFormFieldSchema).min(1).max(128),
    id: cfpFormIdentifierSchema,
    name: z.string().trim().min(1).max(240),
    publishedAt: z.iso.datetime({ offset: true }).nullable(),
    sourceVersion: z.int().positive(),
    status: cfpFormStatusSchema,
    submissionLimit: z.int().positive().nullable(),
    version: z.int().positive(),
    welcomeContent: z.string().max(20_000),
  })
  .strict();

const organizerCfpFormEditableSchema = organizerCfpFormSchema.pick({
  editAfterClose: true,
  fields: true,
  name: true,
  submissionLimit: true,
  welcomeContent: true,
});

export const organizerCfpFormReadResponseSchema = z
  .object({
    diagnostics: z.array(cfpFormDiagnosticSchema).max(512),
    event: z
      .object({
        cfpClosesAt: z.iso.datetime({ offset: true }),
        id: cfpFormIdentifierSchema,
        name: z.string().trim().min(1).max(240),
        slug: cfpFormIdentifierSchema,
        timezone: z.string().trim().min(1).max(120),
      })
      .strict(),
    form: organizerCfpFormSchema,
    publicUrl: z.string().startsWith("/e/").endsWith("/cfp").max(512),
    publishedVersion: z.int().positive().nullable(),
    publishable: z.boolean(),
  })
  .strict();

const organizerCfpMutationBase = {
  commandId: cfpFormIdentifierSchema,
  expectedFormId: cfpFormIdentifierSchema,
  expectedSourceVersion: z.int().positive(),
} as const;

export const organizerCfpFormSaveRequestSchema = z
  .object({
    ...organizerCfpMutationBase,
    form: organizerCfpFormEditableSchema,
  })
  .strict();

export const organizerCfpFormPublishRequestSchema = z
  .object(organizerCfpMutationBase)
  .strict();

export const organizerCfpFormCloseRequestSchema = z
  .object(organizerCfpMutationBase)
  .strict();

export const organizerCfpFormMutationResponseSchema = z
  .object({
    outcome: z.enum(["applied", "replayed"]),
    result: organizerCfpFormReadResponseSchema,
  })
  .strict();

export const publicCfpConfigurationResponseSchema = z
  .object({
    acceptingSubmissions: z.boolean(),
    event: z
      .object({
        cfpClosesAt: z.iso.datetime({ offset: true }),
        cfpOpensAt: z.iso.datetime({ offset: true }).nullable(),
        endsAt: z.iso.datetime({ offset: true }).nullable(),
        name: z.string().trim().min(1).max(240),
        slug: cfpFormIdentifierSchema,
        startsAt: z.iso.datetime({ offset: true }).nullable(),
        timezone: z.string().trim().min(1).max(120),
        venue: z.string().trim().max(240),
      })
      .strict(),
    form: z
      .object({
        editAfterClose: z.boolean(),
        fields: z.array(publicCfpFieldSchema).min(1).max(128),
        name: z.string().trim().min(1).max(240),
        status: z.enum(["closed", "published"]),
        submissionLimit: z.int().positive().nullable(),
        version: z.int().positive(),
        welcomeContent: z.string().max(20_000),
      })
      .strict(),
    formats: z.array(z.string().trim().min(1).max(80)).min(1).max(64),
    tracks: z
      .array(
        z
          .object({
            description: z.string().max(2_000),
            selection: z.string().trim().min(1).max(160),
          })
          .strict(),
      )
      .min(1)
      .max(64),
  })
  .strict();

export function cfpFormEntityTag(form: {
  id: string;
  sourceVersion: number;
}): string {
  return `"cfp-form:${form.id}:${form.sourceVersion}"`;
}

export function cfpFormVersionFromEntityTag(value: string): {
  formId: string;
  sourceVersion: number;
} | null {
  const match = /^"cfp-form:([A-Za-z0-9][A-Za-z0-9_-]*):([1-9][0-9]*)"$/.exec(
    value,
  );
  if (!match?.[1] || !match[2]) return null;
  const sourceVersion = Number(match[2]);
  return Number.isSafeInteger(sourceVersion)
    ? { formId: match[1], sourceVersion }
    : null;
}

export type CfpFormDiagnostic = z.infer<typeof cfpFormDiagnosticSchema>;
export type CfpFormFieldType = z.infer<typeof cfpFormFieldTypeSchema>;
export type CfpFormRule = z.infer<typeof cfpFormRuleSchema>;
export type OrganizerCfpForm = z.infer<typeof organizerCfpFormSchema>;
export type OrganizerCfpFormField = z.infer<typeof organizerCfpFormFieldSchema>;
export type OrganizerCfpFormReadResponse = z.infer<
  typeof organizerCfpFormReadResponseSchema
>;
export type OrganizerCfpFormSaveRequest = z.infer<
  typeof organizerCfpFormSaveRequestSchema
>;
export type OrganizerCfpFormPublishRequest = z.infer<
  typeof organizerCfpFormPublishRequestSchema
>;
export type OrganizerCfpFormCloseRequest = z.infer<
  typeof organizerCfpFormCloseRequestSchema
>;
export type OrganizerCfpFormMutationResponse = z.infer<
  typeof organizerCfpFormMutationResponseSchema
>;
export type PublicCfpConfigurationResponse = z.infer<
  typeof publicCfpConfigurationResponseSchema
>;
