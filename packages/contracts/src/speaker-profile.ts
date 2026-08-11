import { z } from "zod";

const profileIdSchema = z
  .string()
  .trim()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]+$/);

const publicEventSchema = z
  .object({
    dates: z.string().min(1).max(160),
    location: z.string().min(1).max(240),
    name: z.string().min(1).max(240),
    slug: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
    summary: z.string().max(1_200),
    timezone: z.string().min(1).max(120),
  })
  .strict();

const publicSessionViewSchema = z
  .object({
    abstract: z.string().max(12_000),
    day: z.iso.date(),
    endAt: z.iso.datetime({ offset: true }),
    format: z.string().min(1).max(80),
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
    publicationStatus: z.enum(["canceled", "published", "superseded"]),
    publicationVersion: z.int().nonnegative(),
    roomId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
    roomName: z.string().min(1).max(160),
    speakers: z
      .array(
        z
          .object({
            company: z.string().max(160),
            name: z.string().min(1).max(160),
            role: z.string().max(160),
          })
          .strict(),
      )
      .max(32),
    startAt: z.iso.datetime({ offset: true }),
    title: z.string().min(1).max(300),
    track: z.string().min(1).max(160),
  })
  .strict()
  .refine((session) => Date.parse(session.startAt) < Date.parse(session.endAt));

const profileText = (max: number) => z.string().trim().max(max);
const requiredProfileText = (max: number) => profileText(max).min(1);

function validHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

const optionalProfileUrl = z
  .string()
  .trim()
  .max(2_048)
  .refine((value) => value === "" || validHttpUrl(value), {
    message: "Use a complete http:// or https:// URL.",
  });

export const speakerProfilePublicationStateSchema = z.enum([
  "draft",
  "approved",
  "published",
]);

export const speakerProfilePolicySchema = z
  .object({
    accepted_content_types: z
      .array(z.enum(["image/jpeg", "image/png", "image/webp"]))
      .length(3),
    max_bytes: z.int().positive(),
    min_height: z.int().positive(),
    min_width: z.int().positive(),
    scope: z.literal("organization"),
  })
  .strict();

export const speakerProfileFieldsSchema = z
  .object({
    bio: profileText(400),
    bluesky_url: optionalProfileUrl,
    company: profileText(160),
    display_name: profileText(160),
    headshot_alt: profileText(200),
    linkedin_url: optionalProfileUrl.refine((value) => {
      if (!value) return true;
      try {
        const hostname = new URL(value).hostname.toLowerCase();
        return (
          hostname === "linkedin.com" || hostname.endsWith(".linkedin.com")
        );
      } catch {
        return false;
      }
    }, "Use a linkedin.com profile URL."),
    pronouns: profileText(80),
    title: profileText(160),
    website_url: optionalProfileUrl,
  })
  .strict();

export const speakerProfileSaveFieldsSchema =
  speakerProfileFieldsSchema.superRefine((fields, context) => {
    for (const key of ["display_name", "title", "company", "bio"] as const) {
      if (!fields[key]) {
        context.addIssue({
          code: "custom",
          message: "This field is required.",
          path: [key],
        });
      }
    }
  });

export const speakerProfileHeadshotSchema = z
  .object({
    alt: requiredProfileText(200),
    content_type: z.enum(["image/jpeg", "image/png", "image/webp"]),
    file_name: requiredProfileText(240),
    id: profileIdSchema,
    preview_url: z.string().startsWith("/api/portal/"),
    status: z.literal("ready"),
    version: z.int().positive(),
  })
  .strict();

export const speakerProfileAuditEntrySchema = z
  .object({
    action: z.enum(["saved", "submitted", "approved", "published"]),
    actor: z.enum(["organizer", "speaker", "system"]),
    at: z.iso.datetime(),
    summary: requiredProfileText(240),
  })
  .strict();

export const speakerProfileResponseSchema = z
  .object({
    audit: z.array(speakerProfileAuditEntrySchema).max(20),
    fields: speakerProfileFieldsSchema,
    headshot: speakerProfileHeadshotSchema.nullable(),
    upload_context: z
      .object({
        event_id: profileIdSchema,
        organization_id: profileIdSchema,
        owner_contact_id: profileIdSchema,
        purpose: z.literal("headshot"),
        replacement_file_id: profileIdSchema.optional(),
      })
      .strict(),
    policy: speakerProfilePolicySchema,
    publication_state: speakerProfilePublicationStateSchema,
    profile_id: profileIdSchema,
    reuse_scope: z.literal("organization"),
    version: z.int().nonnegative(),
    updated_at: z.iso.datetime().nullable(),
  })
  .strict();

export const speakerProfileSaveCommandSchema = z
  .object({
    command_id: profileIdSchema,
    expected_version: z.int().nonnegative(),
    fields: speakerProfileSaveFieldsSchema,
    headshot_file_id: profileIdSchema.nullable().optional(),
    reuse_organization: z.literal(true),
  })
  .strict()
  .superRefine((command, context) => {
    if (command.headshot_file_id && !command.fields.headshot_alt) {
      context.addIssue({
        code: "custom",
        message: "Headshot alt text is required when attaching a headshot.",
        path: ["fields", "headshot_alt"],
      });
    }
  });

export const speakerProfilePublicationCommandSchema = z
  .object({
    command_id: profileIdSchema,
    expected_version: z.int().nonnegative(),
    state: z.enum(["approved", "published"]),
  })
  .strict();

export const speakerProfileCommandResponseSchema = z
  .object({
    ok: z.literal(true),
    outcome: z.enum(["applied", "replayed"]),
    profile: speakerProfileResponseSchema,
    projection: z.enum(["durable", "repair_pending"]),
  })
  .strict();

export const publicSpeakerProfileSchema = z
  .object({
    bio: z.string().max(400).optional(),
    company: z.string().max(160),
    headshot: z
      .object({
        alt: requiredProfileText(200),
        url: z.string().startsWith("/api/v1/public/events/").max(512),
      })
      .strict()
      .optional(),
    links: z
      .array(
        z
          .object({
            label: z.enum(["Bluesky", "LinkedIn", "Website"]),
            url: z.string().max(2_048).refine(validHttpUrl),
          })
          .strict(),
      )
      .max(3),
    name: requiredProfileText(160),
    pronouns: z.string().max(80).optional(),
    sessionIds: z.array(profileIdSchema).max(32),
    slug: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    title: z.string().max(160),
  })
  .strict();

export const publicSpeakerProjectionSchema = z
  .object({
    event: publicEventSchema,
    generatedAt: z.iso.datetime({ offset: true }),
    sessions: z.array(publicSessionViewSchema).max(2_000),
    speakers: z.array(publicSpeakerProfileSchema).max(2_000),
    version: z.int().positive(),
  })
  .strict();

export type PublicSpeakerProfile = z.infer<typeof publicSpeakerProfileSchema>;
export type PublicSpeakerProjection = z.infer<
  typeof publicSpeakerProjectionSchema
>;
export type SpeakerProfileAuditEntry = z.infer<
  typeof speakerProfileAuditEntrySchema
>;
export type SpeakerProfileCommandResponse = z.infer<
  typeof speakerProfileCommandResponseSchema
>;
export type SpeakerProfileFields = z.infer<typeof speakerProfileFieldsSchema>;
export type SpeakerProfilePublicationCommand = z.infer<
  typeof speakerProfilePublicationCommandSchema
>;
export type SpeakerProfilePublicationState = z.infer<
  typeof speakerProfilePublicationStateSchema
>;
export type SpeakerProfileResponse = z.infer<
  typeof speakerProfileResponseSchema
>;
export type SpeakerProfileSaveCommand = z.infer<
  typeof speakerProfileSaveCommandSchema
>;
