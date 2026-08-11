import { z } from "zod";

export * from "./schedule";
export * from "./schedule-fixture";
export * from "./demo";
export * from "./organizer-submissions";
export * from "./calendar";
export * from "./speaker-profile";
export * from "./cfp-forms";
export * from "./public-api";
export * from "./reviews";
export * from "./decisions";
export * from "./readiness";

export const healthResponseSchema = z.object({
  environment: z.enum(["local", "preview", "production"]),
  service: z.literal("sessionbox-killer"),
  status: z.enum(["ok", "ready"]),
  timestamp: z.iso.datetime(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const apiErrorDetailSchema = z
  .object({
    actual_version: z.int().nonnegative().optional(),
    code: z.string().trim().min(1).max(120),
    expected_version: z.int().nonnegative().optional(),
    message: z.string().trim().min(1).max(500),
    retryable: z.boolean().optional(),
  })
  .strict();

export const apiErrorResponseSchema = z
  .object({
    error: apiErrorDetailSchema,
    request_id: z.string().trim().min(1).max(128),
  })
  .strict();

export type ApiErrorDetail = z.infer<typeof apiErrorDetailSchema>;
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

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

const publicCfpAnswerValueSchema = z.union([
  z.string().max(20_000),
  z.boolean(),
  z.array(z.string().max(2_048)).max(128),
]);

const publicCfpSubmissionAnswersSchema = z
  .record(publicIdentifierSchema, publicCfpAnswerValueSchema)
  .refine((answers) => Object.keys(answers).length <= 128, {
    message: "A submission cannot contain more than 128 answers.",
  });

export const publicCfpParticipantEmailSchema = z.email().trim().max(320);

const publicCfpDraftParticipantSchema = z
  .object({
    email: publicCfpParticipantEmailSchema,
    id: publicIdentifierSchema,
    name: z.string().trim().max(160),
    role: z.string().trim().max(160),
  })
  .strict();

function uniquePublicCfpParticipants<
  T extends typeof publicCfpDraftParticipantSchema,
>(participantSchema: T) {
  return z
    .array(participantSchema)
    .min(1)
    .max(8)
    .refine(
      (participants) =>
        new Set(participants.map((participant) => participant.id)).size ===
          participants.length &&
        new Set(
          participants.map((participant) =>
            participant.email.toLocaleLowerCase("en-US"),
          ),
        ).size === participants.length,
      "Participant IDs and email addresses must be unique.",
    );
}

const publicCfpSubmissionBase = {
  answers: publicCfpSubmissionAnswersSchema,
  form_version: z.int().positive(),
} as const;

export const publicCfpDraftContentSchema = z
  .object({
    answers: publicCfpSubmissionAnswersSchema,
    participants: uniquePublicCfpParticipants(publicCfpDraftParticipantSchema),
  })
  .strict();

const publicCfpFinalParticipantSchema = publicCfpDraftParticipantSchema.extend({
  name: z.string().trim().min(1).max(160),
});
const publicCfpFinalParticipantsSchema = uniquePublicCfpParticipants(
  publicCfpFinalParticipantSchema,
);

const draftSubmissionRequestShape = {
  ...publicCfpSubmissionBase,
  mode: z.literal("draft"),
  participants: uniquePublicCfpParticipants(publicCfpDraftParticipantSchema),
} as const;

const finalSubmissionRequestShape = {
  ...publicCfpSubmissionBase,
  mode: z.literal("submit"),
  participant_consent: z.literal(true),
  participants: publicCfpFinalParticipantsSchema,
  turnstile_action: z.literal("cfp_submit"),
  turnstile_token: turnstileTokenSchema,
} as const;

export const protectedPublicCfpSubmissionRequestSchema = z.discriminatedUnion(
  "mode",
  [
    z.object(draftSubmissionRequestShape).strict(),
    z.object(finalSubmissionRequestShape).strict(),
  ],
);

export const protectedPublicCfpSubmissionUpdateRequestSchema =
  z.discriminatedUnion("mode", [
    z
      .object({
        ...draftSubmissionRequestShape,
        expected_source_version: z.int().positive(),
      })
      .strict(),
    z
      .object({
        ...finalSubmissionRequestShape,
        expected_source_version: z.int().positive(),
      })
      .strict(),
  ]);

export const publicCfpSubmissionResponseSchema = z
  .object({
    friendly_id: z.string().trim().min(1).max(64),
    outcome: z.enum(["applied", "replayed"]),
    source_version: z.int().positive(),
    status: z.enum(["draft", "submitted"]),
    submission_id: publicIdentifierSchema,
  })
  .strict();

export const publicCfpOwnedDraftSchema = z
  .object({
    content: publicCfpDraftContentSchema,
    form_version: z.int().positive(),
    friendly_id: z.string().trim().min(1).max(64),
    source_version: z.int().positive(),
    submission_id: publicIdentifierSchema,
    updated_at: z.iso.datetime({ offset: true }),
  })
  .strict();

export const publicCfpOwnedSubmissionSchema = publicCfpOwnedDraftSchema.extend({
  status: z.enum([
    "draft",
    "submitted",
    "in_review",
    "accepted",
    "waitlisted",
    "declined",
    "withdrawn",
  ]),
});

export const publicCfpOwnedSubmissionsResponseSchema = z
  .object({
    submissions: z.array(publicCfpOwnedSubmissionSchema).max(32),
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
export type ProtectedPublicCfpSubmissionRequest = z.infer<
  typeof protectedPublicCfpSubmissionRequestSchema
>;
export type ProtectedPublicCfpSubmissionUpdateRequest = z.infer<
  typeof protectedPublicCfpSubmissionUpdateRequestSchema
>;
export type PublicCfpDraftContent = z.infer<typeof publicCfpDraftContentSchema>;
export type PublicCfpOwnedDraft = z.infer<typeof publicCfpOwnedDraftSchema>;
export type PublicCfpOwnedSubmission = z.infer<
  typeof publicCfpOwnedSubmissionSchema
>;
export type PublicCfpOwnedSubmissionsResponse = z.infer<
  typeof publicCfpOwnedSubmissionsResponseSchema
>;
export type PublicCfpSubmissionResponse = z.infer<
  typeof publicCfpSubmissionResponseSchema
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
