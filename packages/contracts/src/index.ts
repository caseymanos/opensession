import { z } from "zod";

export const healthResponseSchema = z.object({
  environment: z.enum(["local", "preview", "production"]),
  service: z.literal("sessionbox-killer"),
  status: z.enum(["ok", "ready"]),
  timestamp: z.iso.datetime(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

const publicIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);

export const publicSpeakerViewSchema = z
  .object({
    company: z.string().max(160),
    name: z.string().min(1).max(160),
    role: z.string().max(160),
  })
  .strict();

export const publicSessionViewSchema = z
  .object({
    abstract: z.string().max(12_000),
    day: z.iso.date(),
    endAt: z.iso.datetime({ offset: true }),
    format: z.string().min(1).max(80),
    id: publicIdentifierSchema,
    publicationStatus: z.enum(["canceled", "published", "superseded"]),
    publicationVersion: z.int().nonnegative(),
    roomId: publicIdentifierSchema,
    roomName: z.string().min(1).max(160),
    speakers: z.array(publicSpeakerViewSchema).max(32),
    startAt: z.iso.datetime({ offset: true }),
    title: z.string().min(1).max(300),
    track: z.string().min(1).max(160),
  })
  .strict()
  .refine(
    (session) => Date.parse(session.startAt) < Date.parse(session.endAt),
    { message: "Session end time must be after its start time." },
  );

export const publicScheduleProjectionSchema = z
  .object({
    event: z
      .object({
        dates: z.string().min(1).max(160),
        location: z.string().min(1).max(240),
        name: z.string().min(1).max(240),
        slug: publicIdentifierSchema,
        summary: z.string().max(1_200),
        timezone: z.string().min(1).max(120),
      })
      .strict(),
    generatedAt: z.iso.datetime({ offset: true }),
    sessions: z.array(publicSessionViewSchema).max(2_000),
    version: z.int().nonnegative(),
  })
  .strict();

export type PublicScheduleDay = z.infer<typeof publicSessionViewSchema>["day"];
export type PublicScheduleProjection = z.infer<
  typeof publicScheduleProjectionSchema
>;
export type PublicSessionTrack = z.infer<
  typeof publicSessionViewSchema
>["track"];
export type PublicSessionView = z.infer<typeof publicSessionViewSchema>;
export type PublicSpeakerView = z.infer<typeof publicSpeakerViewSchema>;

const redirectValidationOrigin = "https://opensession.invalid";

function containsUrlControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) {
      return true;
    }
  }
  return false;
}

function isLocalAbsolutePath(value: string): boolean {
  if (
    !value.startsWith("/") ||
    value.includes("\\") ||
    containsUrlControlCharacter(value)
  ) {
    return false;
  }

  try {
    return (
      new URL(value, redirectValidationOrigin).origin ===
      redirectValidationOrigin
    );
  } catch {
    return false;
  }
}

const relativeRedirectPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(
    (value) => isLocalAbsolutePath(value),
    "Redirect path must be a local absolute path.",
  );

export const magicLinkRequestSchema = z
  .object({
    email: z.email().trim().max(320),
    event_id: z.string().trim().min(1).max(128).optional(),
    organization_id: z.string().trim().min(1).max(128).optional(),
    purpose: z.enum(["sign_in", "portal"]).default("sign_in"),
    redirect_path: relativeRedirectPathSchema.default("/"),
  })
  .superRefine((value, context) => {
    if (
      value.purpose === "sign_in" &&
      (value.organization_id || value.event_id)
    ) {
      context.addIssue({
        code: "custom",
        message: "Sign-in links cannot declare portal scope.",
      });
    }
    if (
      value.purpose === "portal" &&
      (!value.organization_id || !value.event_id)
    ) {
      context.addIssue({
        code: "custom",
        message: "Portal links require organization and event scope.",
      });
    }
  });

export const turnstileTokenSchema = z.string().trim().min(1).max(2_048);

export const turnstileActionSchema = z.enum([
  "cfp_account",
  "cfp_submit",
  "sign_in",
]);

export const protectedMagicLinkRequestSchema = z.intersection(
  magicLinkRequestSchema,
  z.object({
    event_slug: publicIdentifierSchema.optional(),
    turnstile_action: turnstileActionSchema,
    turnstile_token: turnstileTokenSchema,
  }),
);

export const turnstileConfigResponseSchema = z
  .object({
    site_key: z.string().trim().min(1).max(128),
  })
  .strict();

const publicCfpRuleSchema = z
  .object({
    effect: z.enum(["require", "show"]),
    id: publicIdentifierSchema,
    operator: z.enum(["equals", "includes"]),
    sourceKey: publicIdentifierSchema,
    value: z.string().max(4_000),
  })
  .strict();

const publicCfpFieldSchema = z
  .object({
    helpText: z.string().max(2_000),
    key: publicIdentifierSchema,
    label: z.string().trim().min(1).max(240),
    options: z.array(z.string().trim().min(1).max(240)).max(128),
    required: z.boolean(),
    rules: z.array(publicCfpRuleSchema).max(64),
    type: z.enum([
      "checkbox",
      "file",
      "long_text",
      "multi_select",
      "participant",
      "short_text",
      "single_select",
    ]),
    validation: z
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
      ),
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
        slug: publicIdentifierSchema,
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

export const protectedPublicCfpSubmissionRequestSchema = z
  .object({
    answers: z
      .object({
        abstract: z.string().trim().min(120).max(12_000),
        format: z.string().trim().min(1).max(80),
        outcomes: z.string().trim().min(1).max(4_000),
        title: z.string().trim().min(8).max(300),
        track: z.string().trim().min(1).max(160),
        workshop_prerequisites: z.string().trim().max(4_000),
      })
      .strict(),
    participants: z
      .array(
        z
          .object({
            email: z.email().trim().max(320),
            id: publicIdentifierSchema,
            name: z.string().trim().min(1).max(160),
            role: z.string().trim().max(160),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    routing: z
      .object({
        default_reviewer_group_id: publicIdentifierSchema,
        route_key: publicIdentifierSchema,
        submission_track: z.string().trim().min(1).max(160),
      })
      .strict(),
    turnstile_action: z.literal("cfp_submit"),
    turnstile_token: turnstileTokenSchema,
  })
  .strict();

export const magicLinkExchangeSchema = z.object({
  token: z
    .string()
    .min(40)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
});

export const magicLinkAcceptedResponseSchema = z.object({
  accepted: z.literal(true),
  message: z.string(),
});

export const authSessionResponseSchema = z.object({
  csrf_token: z.string().min(40),
  expires_at: z.iso.datetime(),
  redirect_path: relativeRedirectPathSchema,
  user: z.object({
    display_name: z.string().nullable(),
    email: z.email(),
    id: z.string(),
  }),
});

export type MagicLinkRequest = z.infer<typeof magicLinkRequestSchema>;
export type MagicLinkExchange = z.infer<typeof magicLinkExchangeSchema>;
export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>;
export type ProtectedMagicLinkRequest = z.infer<
  typeof protectedMagicLinkRequestSchema
>;
export type TurnstileAction = z.infer<typeof turnstileActionSchema>;
export type TurnstileConfigResponse = z.infer<
  typeof turnstileConfigResponseSchema
>;
export type PublicCfpConfigurationResponse = z.infer<
  typeof publicCfpConfigurationResponseSchema
>;
export type ProtectedPublicCfpSubmissionRequest = z.infer<
  typeof protectedPublicCfpSubmissionRequestSchema
>;

export const uploadPurposeSchema = z.enum([
  "headshot",
  "slides",
  "submission_attachment",
  "task_attachment",
  "resource",
]);

export const uploadContentTypeSchema = z.enum([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const unsafeFilenameFormatCharacterPattern =
  /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u;

const uploadFilenameSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      !value.includes("/") &&
      !value.includes("\\") &&
      !containsUrlControlCharacter(value) &&
      value.isWellFormed() &&
      !unsafeFilenameFormatCharacterPattern.test(value),
    "Filename must not contain a path, control, or deceptive format characters.",
  );

export const uploadIntentRequestSchema = z
  .object({
    byte_size: z
      .int()
      .positive()
      .max(50 * 1024 * 1024),
    checksum_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    content_type: uploadContentTypeSchema,
    event_id: publicIdentifierSchema,
    filename: uploadFilenameSchema,
    organization_id: publicIdentifierSchema,
    owner_contact_id: publicIdentifierSchema.optional(),
    purpose: uploadPurposeSchema,
    replaces_file_id: publicIdentifierSchema.optional(),
  })
  .strict();

export const uploadIntentResponseSchema = z
  .object({
    file: z
      .object({
        id: publicIdentifierSchema,
        lineage_id: publicIdentifierSchema,
        status: z.literal("pending"),
        version: z.int().positive(),
      })
      .strict(),
    upload: z
      .object({
        expires_at: z.iso.datetime(),
        headers: z.record(z.string(), z.string()),
        method: z.literal("PUT"),
        url: z.string().startsWith("/api/uploads/"),
      })
      .strict(),
  })
  .strict();

export const uploadFinalizeResponseSchema = z
  .object({
    byte_size: z.int().nonnegative(),
    checksum_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    content_type: uploadContentTypeSchema,
    detected_content_type: z.enum([
      "application/pdf",
      "application/zip",
      "image/jpeg",
      "image/png",
      "image/webp",
    ]),
    id: publicIdentifierSchema,
    status: z.literal("ready"),
    version: z.int().positive(),
  })
  .strict();

export type UploadContentType = z.infer<typeof uploadContentTypeSchema>;
export type UploadFinalizeResponse = z.infer<
  typeof uploadFinalizeResponseSchema
>;
export type UploadIntentRequest = z.infer<typeof uploadIntentRequestSchema>;
export type UploadIntentResponse = z.infer<typeof uploadIntentResponseSchema>;
export type UploadPurpose = z.infer<typeof uploadPurposeSchema>;
