import {
  publicSpeakerProjectionSchema,
  speakerProfileCommandResponseSchema,
  speakerProfilePolicySchema,
  speakerProfileResponseSchema,
  speakerProfileSaveFieldsSchema,
  type PublicSpeakerProjection,
  type SpeakerProfileAuditEntry,
  type SpeakerProfileFields,
  type SpeakerProfileResponse,
} from "@sessionbox-killer/contracts";

import { getBaseAuthority } from "../authority/binding.js";
import {
  AuthorityCommandFailedError,
  AuthorityIdempotencyConflictError,
  AuthorityOutcomeUnknownError,
  hashAuthorityValue,
  parseBaseAuthorityCommand,
  type AuthorityResponse,
  type BaseAuthorityCommand,
} from "../authority/types.js";
import { hasEventPermission, loadEventAccess } from "../auth/authorization.js";
import type { AuthenticatedSession } from "../auth/service.js";
import {
  D1SpeakerPortalEventResolver,
  type SpeakerPortalEventScope,
} from "../portal/service.js";
import { D1PublicScheduleProjectionReader } from "../public-schedule/projection.js";

export const speakerProfilePolicy = speakerProfilePolicySchema.parse({
  accepted_content_types: ["image/jpeg", "image/png", "image/webp"],
  max_bytes: 8 * 1024 * 1024,
  min_height: 1_200,
  min_width: 1_200,
  scope: "organization",
});

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const profileIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const imageSampleBytes = 64 * 1024;

interface ProfileRow {
  bio: string | null;
  company: string | null;
  display_name: string;
  headshot_alt_text: string | null;
  headshot_content_type: "image/jpeg" | "image/png" | "image/webp" | null;
  headshot_file_name: string | null;
  headshot_file_id: string | null;
  headshot_object_key: string | null;
  headshot_r2_etag: string | null;
  headshot_r2_version: string | null;
  headshot_event_id: string | null;
  headshot_version: number | null;
  id: string;
  profile_approved_at: string | null;
  profile_publication_state: "draft" | "approved" | "published";
  pronouns: string | null;
  projected_at: string | null;
  social_json: string;
  source_version: number;
  title: string | null;
}

interface AuditRow {
  action: string;
  actor_type: "api_key" | "portal" | "system" | "user";
  created_at: string;
  metadata_json: string;
}

interface HeadshotRow {
  byte_size: number;
  content_type: "image/jpeg" | "image/png" | "image/webp";
  file_name: string;
  file_id: string;
  object_key: string;
  r2_etag: string | null;
  r2_version: string | null;
  version: number;
}

interface ProfileReceiptRow {
  original_response_json: string | null;
  request_hash: string;
  status:
    "committed" | "committed_with_repair" | "failed" | "pending" | "unknown";
}

interface ProfileReceiptEnvelope {
  authority_command: BaseAuthorityCommand;
  authority_response?: AuthorityResponse;
  headshot?: HeadshotRow | null;
  profile_response?: unknown;
}

interface PreparedProfileCommand {
  authorityCommand: BaseAuthorityCommand;
  cachedProfileResponse: ReturnType<
    typeof speakerProfileCommandResponseSchema.parse
  > | null;
  created: boolean;
  headshot: HeadshotRow | null | undefined;
}

export type SpeakerProfileErrorCode =
  | "profile_forbidden"
  | "profile_not_found"
  | "profile_projection_invalid"
  | "profile_version_conflict"
  | "profile_idempotency_conflict"
  | "profile_outcome_unknown"
  | "profile_headshot_invalid";

export class SpeakerProfileError extends Error {
  readonly code: SpeakerProfileErrorCode;
  readonly actualVersion: number | null;
  readonly expectedVersion: number | null;

  constructor(
    code: SpeakerProfileErrorCode,
    message: string,
    options: {
      actualVersion?: number | null;
      expectedVersion?: number | null;
    } = {},
  ) {
    super(message);
    this.name = "SpeakerProfileError";
    this.code = code;
    this.actualVersion = options.actualVersion ?? null;
    this.expectedVersion = options.expectedVersion ?? null;
  }
}

export interface SpeakerProfileServiceOptions {
  readonly bucket: R2Bucket;
  readonly database: D1Database;
  readonly environment: Env;
  readonly now?: () => Date;
}

function profileSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 128);
  if (!slugPattern.test(slug)) {
    throw new SpeakerProfileError(
      "profile_projection_invalid",
      "A published speaker profile has an invalid public slug.",
    );
  }
  return slug;
}

function safeSocial(value: string): SpeakerProfileFields {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new SpeakerProfileError(
      "profile_projection_invalid",
      "A speaker profile social projection is invalid.",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SpeakerProfileError(
      "profile_projection_invalid",
      "A speaker profile social projection is invalid.",
    );
  }
  const social = parsed as Record<string, unknown>;
  const text = (key: string): string =>
    typeof social[key] === "string" ? social[key] : "";
  return {
    bio: "",
    bluesky_url: text("bluesky_url") || text("bluesky"),
    company: "",
    display_name: "",
    headshot_alt: "",
    linkedin_url: text("linkedin_url") || text("linkedin"),
    pronouns: "",
    title: "",
    website_url: text("website_url") || text("website"),
  };
}

function socialFields(fields: SpeakerProfileFields): string {
  return JSON.stringify({
    ...(fields.bluesky_url ? { bluesky_url: fields.bluesky_url } : {}),
    ...(fields.linkedin_url ? { linkedin_url: fields.linkedin_url } : {}),
    ...(fields.website_url ? { website_url: fields.website_url } : {}),
  });
}

function actorType(
  value: AuditRow["actor_type"],
): SpeakerProfileAuditEntry["actor"] {
  if (value === "portal") return "speaker";
  if (value === "user") return "organizer";
  return "system";
}

function auditAction(value: string): SpeakerProfileAuditEntry["action"] {
  if (value.endsWith("published")) return "published";
  if (value.endsWith("approved")) return "approved";
  if (value.endsWith("submitted")) return "submitted";
  return "saved";
}

function auditSummary(action: SpeakerProfileAuditEntry["action"]): string {
  return action === "published"
    ? "Profile published to the public speaker directory."
    : action === "approved"
      ? "Profile approved by an organizer."
      : action === "submitted"
        ? "Profile submitted for organizer review."
        : "Profile details updated.";
}

function profilePolicy(): typeof speakerProfilePolicy {
  return speakerProfilePolicy;
}

function profileReceiptOperation(operation: string): string {
  return operation.replace(/^speaker_profile\./, "speaker_profile.receipt.");
}

function authorityError(error: unknown, expectedVersion: number): never {
  if (
    error instanceof AuthorityIdempotencyConflictError ||
    (error instanceof Error &&
      error.name === "AirtableIdempotencyConflictError")
  ) {
    throw new SpeakerProfileError(
      "profile_idempotency_conflict",
      "This profile command was already used with different content.",
    );
  }
  const versionConflict =
    (error instanceof AuthorityCommandFailedError && error.status === 409) ||
    (error instanceof Error &&
      [
        "AuthorityCommandFailedError",
        "AirtableManualEditError",
        "AirtableVersionConflictError",
      ].includes(error.name) &&
      ((error as { status?: unknown }).status === 409 ||
        error.name !== "AuthorityCommandFailedError"));
  if (versionConflict) {
    throw new SpeakerProfileError(
      "profile_version_conflict",
      "The profile changed before this command committed. Refresh and try again.",
      { expectedVersion },
    );
  }
  if (
    error instanceof AuthorityOutcomeUnknownError ||
    (error instanceof Error && error.name === "AuthorityOutcomeUnknownError")
  ) {
    throw new SpeakerProfileError(
      "profile_outcome_unknown",
      "The profile command may have committed. Refresh before retrying.",
    );
  }
  throw error;
}

export class SpeakerProfileService {
  readonly #bucket: R2Bucket;
  readonly #database: D1Database;
  readonly #environment: Env;
  readonly #now: () => Date;
  readonly #eventResolver: D1SpeakerPortalEventResolver;

  constructor(options: SpeakerProfileServiceOptions) {
    this.#bucket = options.bucket;
    this.#database = options.database;
    this.#environment = options.environment;
    this.#now = options.now ?? (() => new Date());
    this.#eventResolver = new D1SpeakerPortalEventResolver(options.database);
  }

  async readForPortal(
    session: AuthenticatedSession,
    event: SpeakerPortalEventScope,
  ): Promise<SpeakerProfileResponse> {
    const access = await loadEventAccess(
      this.#database,
      session.user,
      event.organizationId,
      event.eventId,
    );
    if (
      !access.speakerContactId ||
      !hasEventPermission(access, "portal:read:self")
    ) {
      throw new SpeakerProfileError(
        "profile_forbidden",
        "This account cannot access the requested speaker profile.",
      );
    }
    const row = await this.#readRow(
      event.organizationId,
      access.speakerContactId,
    );
    if (!row) {
      throw new SpeakerProfileError(
        "profile_not_found",
        "The requested speaker profile does not exist.",
      );
    }
    const profile = this.#response(event, row);
    return {
      ...profile,
      audit: await this.#audit(event.organizationId, row.id),
    };
  }

  async readForOrganizer(
    session: AuthenticatedSession,
    event: SpeakerPortalEventScope,
    profileId: string,
  ): Promise<SpeakerProfileResponse> {
    const access = await loadEventAccess(
      this.#database,
      session.user,
      event.organizationId,
      event.eventId,
    );
    if (!hasEventPermission(access, "event:manage")) {
      throw new SpeakerProfileError(
        "profile_forbidden",
        "Organizer access is required to inspect speaker profiles.",
      );
    }
    await this.#assertProfileParticipant(event, profileId);
    const row = await this.#readRow(event.organizationId, profileId);
    if (!row) {
      throw new SpeakerProfileError(
        "profile_not_found",
        "The requested speaker profile does not exist.",
      );
    }
    const profile = this.#response(event, row);
    return {
      ...profile,
      audit: await this.#audit(event.organizationId, row.id),
    };
  }

  async saveForPortal(
    session: AuthenticatedSession,
    event: SpeakerPortalEventScope,
    input: {
      command_id: string;
      expected_version: number;
      fields: SpeakerProfileFields;
      headshot_file_id?: string | null | undefined;
      reuse_organization: true;
    },
    requestId: string,
  ): Promise<ReturnType<typeof speakerProfileCommandResponseSchema.parse>> {
    const access = await loadEventAccess(
      this.#database,
      session.user,
      event.organizationId,
      event.eventId,
    );
    const contactId = access.speakerContactId;
    if (!contactId || !hasEventPermission(access, "portal:write:self")) {
      throw new SpeakerProfileError(
        "profile_forbidden",
        "This account cannot update the requested speaker profile.",
      );
    }
    const requestHash = await hashAuthorityValue({
      command: "speaker_profile.save",
      entity_id: contactId,
      expected_version: input.expected_version,
      fields: input.fields,
      headshot_file_id:
        input.headshot_file_id === undefined
          ? "preserve"
          : input.headshot_file_id,
      reuse_organization: input.reuse_organization,
    });
    const existingReceipt = await this.#readProfileReceipt(
      event.organizationId,
      "speaker_profile.save",
      input.command_id,
      requestHash,
    );
    let prepared: PreparedProfileCommand;
    let current: ProfileRow | null;
    if (existingReceipt) {
      prepared = await this.#prepareProfileCommand(
        event.organizationId,
        "speaker_profile.save",
        input.command_id,
        requestHash,
      );
      if (prepared.cachedProfileResponse) {
        return {
          ...prepared.cachedProfileResponse,
          outcome: "replayed",
        };
      }
      current = await this.#readRow(event.organizationId, contactId);
    } else {
      current = await this.#readRow(event.organizationId, contactId);
      if (!current) {
        throw new SpeakerProfileError(
          "profile_not_found",
          "The requested speaker profile does not exist.",
        );
      }
      const headshot =
        input.headshot_file_id === undefined
          ? undefined
          : input.headshot_file_id === null
            ? null
            : await this.#authorizeHeadshot(
                event.organizationId,
                event.eventId,
                contactId,
                input.headshot_file_id,
              );
      if (
        !input.fields.headshot_alt &&
        (headshot !== undefined
          ? headshot !== null
          : current.headshot_object_key !== null)
      ) {
        throw new SpeakerProfileError(
          "profile_headshot_invalid",
          "Headshot alt text is required while a headshot is attached.",
        );
      }
      const authorityFields: BaseAuthorityCommand["fields"] = {
        Bio: input.fields.bio || null,
        Company: input.fields.company || null,
        "Display name": input.fields.display_name,
        "Headshot alt text": input.fields.headshot_alt || null,
        Pronouns: input.fields.pronouns || null,
        "Profile approved at": null,
        "Profile approved by": null,
        "Profile publication state": "draft",
        "Social JSON": socialFields(input.fields),
        Title: input.fields.title || null,
        ...(input.headshot_file_id === undefined
          ? {}
          : { "Headshot object key": headshot?.object_key ?? null }),
      };
      prepared = await this.#prepareProfileCommand(
        event.organizationId,
        "speaker_profile.save",
        input.command_id,
        requestHash,
        {
          audit: {
            action: "speaker_profile.saved",
            actorId: session.user.id,
            actorType: "portal",
            eventId: event.eventId,
            requestId,
            safeDiff: {
              changed_fields: ["bio", "identity", "social"],
              headshot_replaced: input.headshot_file_id !== undefined,
              publication_state: "draft",
              reuse_scope: "organization",
            },
          },
          commandId: input.command_id,
          entityId: contactId,
          expectedVersion: input.expected_version,
          fields: authorityFields,
          operation: "speaker_profile.save",
          organizationId: event.organizationId,
          table: "contacts",
        },
        headshot,
      );
    }
    if (!current) {
      throw new SpeakerProfileError(
        "profile_not_found",
        "The requested speaker profile does not exist.",
      );
    }
    const authorityResponse = await this.#executeProfileCommand(
      event.organizationId,
      "speaker_profile.save",
      input.command_id,
      requestHash,
      prepared,
      input.expected_version,
    );
    const next = await this.#readRow(event.organizationId, contactId);
    const projectionReady =
      next !== null &&
      next.source_version >= authorityResponse.authority.sourceVersion;
    const response = projectionReady
      ? {
          ...authorityResponse,
          projection: "durable" as const,
          status: "committed" as const,
        }
      : authorityResponse;
    const projected = projectionReady
      ? next
      : this.#rowFromCommand(
          current,
          response,
          prepared.authorityCommand.fields,
          prepared.headshot,
        );
    const profile = this.#response(
      event,
      projected,
      response.authority.sourceVersion,
    );
    const result = speakerProfileCommandResponseSchema.parse({
      ok: true,
      outcome:
        prepared.created && !response.authority.replayed
          ? "applied"
          : "replayed",
      profile: {
        ...profile,
        audit: await this.#audit(event.organizationId, contactId),
      },
      projection: response.projection,
    });
    await this.#completeProfileReceipt(
      event.organizationId,
      "speaker_profile.save",
      input.command_id,
      prepared,
      response,
      result,
    );
    return result;
  }

  async publishForOrganizer(
    session: AuthenticatedSession,
    event: SpeakerPortalEventScope,
    profileId: string,
    input: {
      command_id: string;
      expected_version: number;
      state: "approved" | "published";
    },
    requestId: string,
  ): Promise<ReturnType<typeof speakerProfileCommandResponseSchema.parse>> {
    const access = await loadEventAccess(
      this.#database,
      session.user,
      event.organizationId,
      event.eventId,
    );
    if (!hasEventPermission(access, "event:manage")) {
      throw new SpeakerProfileError(
        "profile_forbidden",
        "Organizer access is required to publish a speaker profile.",
      );
    }
    await this.#assertProfileParticipant(event, profileId);
    const operation = `speaker_profile.${input.state}`;
    const requestHash = await hashAuthorityValue({
      command: operation,
      entity_id: profileId,
      expected_version: input.expected_version,
      state: input.state,
    });
    const existingReceipt = await this.#readProfileReceipt(
      event.organizationId,
      operation,
      input.command_id,
      requestHash,
    );
    let prepared: PreparedProfileCommand;
    let current: ProfileRow | null;
    if (existingReceipt) {
      prepared = await this.#prepareProfileCommand(
        event.organizationId,
        operation,
        input.command_id,
        requestHash,
      );
      if (prepared.cachedProfileResponse) {
        return {
          ...prepared.cachedProfileResponse,
          outcome: "replayed",
        };
      }
      current = await this.#readRow(event.organizationId, profileId);
    } else {
      current = await this.#readRow(event.organizationId, profileId);
      if (!current) {
        throw new SpeakerProfileError(
          "profile_not_found",
          "The requested speaker profile does not exist.",
        );
      }
      await this.#assertPublishable(event, profileId, current, input.state);
      const now = this.#now().toISOString();
      prepared = await this.#prepareProfileCommand(
        event.organizationId,
        operation,
        input.command_id,
        requestHash,
        {
          audit: {
            action: operation,
            actorId: session.user.id,
            actorType: "user",
            eventId: event.eventId,
            requestId,
            safeDiff: {
              publication_state: input.state,
              reuse_scope: "organization",
            },
          },
          commandId: input.command_id,
          entityId: profileId,
          expectedVersion: input.expected_version,
          fields: {
            "Profile approved at": now,
            "Profile approved by": session.user.id,
            "Profile publication state": input.state,
          },
          operation,
          organizationId: event.organizationId,
          table: "contacts",
        },
      );
    }
    if (!current) {
      throw new SpeakerProfileError(
        "profile_not_found",
        "The requested speaker profile does not exist.",
      );
    }
    const authorityResponse = await this.#executeProfileCommand(
      event.organizationId,
      operation,
      input.command_id,
      requestHash,
      prepared,
      input.expected_version,
    );
    const next = await this.#readRow(event.organizationId, profileId);
    const projectionReady =
      next !== null &&
      next.source_version >= authorityResponse.authority.sourceVersion;
    const response = projectionReady
      ? {
          ...authorityResponse,
          projection: "durable" as const,
          status: "committed" as const,
        }
      : authorityResponse;
    const projected = projectionReady
      ? next
      : this.#rowFromCommand(
          current,
          response,
          prepared.authorityCommand.fields,
          prepared.headshot,
        );
    const profile = this.#response(
      event,
      projected,
      response.authority.sourceVersion,
    );
    const result = speakerProfileCommandResponseSchema.parse({
      ok: true,
      outcome:
        prepared.created && !response.authority.replayed
          ? "applied"
          : "replayed",
      profile: {
        ...profile,
        audit: await this.#audit(event.organizationId, profileId),
      },
      projection: response.projection,
    });
    await this.#completeProfileReceipt(
      event.organizationId,
      operation,
      input.command_id,
      prepared,
      response,
      result,
    );
    return result;
  }

  async publicProjection(
    slug: string,
  ): Promise<PublicSpeakerProjection | null> {
    const schedule = await new D1PublicScheduleProjectionReader(
      this.#database,
    ).readBySlug(slug);
    if (!schedule) return null;
    const event = await this.#eventResolver.resolve(slug);
    if (!event) return null;
    const rows = await this.#database
      .prepare(
        `SELECT contact.bio, contact.company, contact.display_name,
                contact.headshot_alt_text, contact.headshot_object_key,
                contact.pronouns, contact.projected_at, contact.social_json,
                contact.title, contact.id,
                file.id AS headshot_file_id, file.version_number AS headshot_version
         FROM p_session_participants participant
         JOIN p_sessions session
           ON session.organization_id = participant.organization_id
          AND session.event_id = participant.event_id
          AND session.id = participant.session_id
          AND session.status = 'published'
          AND session.is_public = 1
          AND session.source_deleted_at IS NULL
         JOIN p_schedule_slots slot
           ON slot.organization_id = session.organization_id
          AND slot.event_id = session.event_id
          AND slot.session_id = session.id
          AND slot.published_version = ?3
          AND slot.source_deleted_at IS NULL
         JOIN p_contacts contact
           ON contact.organization_id = participant.organization_id
          AND contact.id = participant.contact_id
          AND contact.profile_publication_state = 'published'
          AND contact.source_deleted_at IS NULL
         LEFT JOIN file_objects file
           ON file.organization_id = contact.organization_id
          AND file.owner_contact_id = contact.id
          AND file.object_key = contact.headshot_object_key
          AND file.purpose = 'headshot'
          AND file.status = 'ready'
          AND file.r2_etag IS NOT NULL
          AND file.r2_version IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM file_objects newer
            WHERE newer.organization_id = file.organization_id
              AND newer.owner_contact_id = file.owner_contact_id
              AND COALESCE(newer.lineage_id, newer.id) = COALESCE(file.lineage_id, file.id)
              AND newer.status = 'ready'
              AND newer.version_number > file.version_number
          )
         WHERE participant.organization_id = ?1
           AND participant.event_id = ?2
           AND participant.confirmed_state = 'confirmed'
           AND participant.role = 'speaker'
           AND participant.source_deleted_at IS NULL
         ORDER BY contact.display_name, session.friendly_id, participant.sort_order`,
      )
      .bind(event.organizationId, event.eventId, schedule.projection.version)
      .all<{
        bio: string | null;
        company: string | null;
        display_name: string;
        headshot_alt_text: string | null;
        headshot_object_key: string | null;
        headshot_file_id: string | null;
        headshot_version: number | null;
        id: string;
        pronouns: string | null;
        projected_at: string;
        social_json: string;
        title: string | null;
      }>();
    const byContact = new Map<string, (typeof rows.results)[number]>();
    for (const row of rows.results) {
      if (!byContact.has(row.id)) byContact.set(row.id, row);
    }
    const publishedSessionIdsByName = new Map<string, Set<string>>();
    for (const session of schedule.projection.sessions) {
      for (const speaker of session.speakers) {
        const sessionIds =
          publishedSessionIdsByName.get(speaker.name) ?? new Set();
        sessionIds.add(session.id);
        publishedSessionIdsByName.set(speaker.name, sessionIds);
      }
    }
    const publishedProfiles = [...byContact.values()].flatMap((row) => {
      const social = safeSocial(row.social_json);
      const name = row.display_name.trim();
      const publishedSessionIds = publishedSessionIdsByName.get(name);
      if (!publishedSessionIds?.size) return [];
      const slugValue = profileSlug(name);
      return [
        {
          profile: {
            ...(row.bio?.trim() ? { bio: row.bio.trim() } : {}),
            company: row.company?.trim() ?? "",
            ...(row.headshot_object_key &&
            row.headshot_file_id &&
            row.headshot_version !== null &&
            row.headshot_alt_text?.trim()
              ? {
                  headshot: {
                    alt: row.headshot_alt_text.trim(),
                    url: `/api/v1/public/events/${event.slug}/speakers/${slugValue}/headshot?v=${encodeURIComponent(`${row.headshot_file_id}-${row.headshot_version}`)}`,
                  },
                }
              : {}),
            links: [
              ...(social.linkedin_url
                ? [{ label: "LinkedIn" as const, url: social.linkedin_url }]
                : []),
              ...(social.bluesky_url
                ? [{ label: "Bluesky" as const, url: social.bluesky_url }]
                : []),
              ...(social.website_url
                ? [{ label: "Website" as const, url: social.website_url }]
                : []),
            ],
            name,
            ...(row.pronouns?.trim() ? { pronouns: row.pronouns.trim() } : {}),
            sessionIds: [...publishedSessionIds].sort(),
            slug: slugValue,
            title: row.title?.trim() ?? "",
          },
          projectedAt: row.projected_at,
        },
      ];
    });
    const speakers = publishedProfiles.map(({ profile }) => profile);
    const names = new Set<string>();
    const slugs = new Set<string>();
    for (const speaker of speakers) {
      if (names.has(speaker.name) || slugs.has(speaker.slug)) {
        throw new SpeakerProfileError(
          "profile_projection_invalid",
          "Published speaker profiles contain duplicate public identities.",
        );
      }
      names.add(speaker.name);
      slugs.add(speaker.slug);
    }
    const profilesByName = new Map(
      speakers.map((speaker) => [speaker.name, speaker]),
    );
    const sessions = schedule.projection.sessions.map((session) => ({
      ...session,
      speakers: session.speakers.filter((speaker) =>
        profilesByName.get(speaker.name)?.sessionIds.includes(session.id),
      ),
    }));
    const generatedAt =
      [
        ...publishedProfiles.map(({ projectedAt }) => projectedAt),
        schedule.projection.generatedAt,
      ]
        .sort()
        .at(-1) ?? schedule.projection.generatedAt;
    return publicSpeakerProjectionSchema.parse({
      event: schedule.projection.event,
      generatedAt,
      sessions,
      speakers,
      version: schedule.projection.version,
    });
  }

  async publicHeadshot(
    slug: string,
    speakerSlug: string,
  ): Promise<{
    body: ReadableStream;
    contentType: string;
    etag: string | null;
  } | null> {
    const event = await this.#eventResolver.resolve(slug);
    if (!event || !slugPattern.test(speakerSlug)) return null;
    const profile = await this.publicProjection(slug);
    const speaker = profile?.speakers.find(
      (candidate) => candidate.slug === speakerSlug,
    );
    if (!profile || !speaker?.headshot) return null;
    const row = await this.#database
      .prepare(
        `SELECT file.object_key, file.declared_mime_type AS content_type,
                file.r2_etag, file.r2_version
         FROM p_contacts contact
         JOIN p_event_contacts event_contact
           ON event_contact.organization_id = contact.organization_id
          AND event_contact.event_id = ?3
          AND event_contact.contact_id = contact.id
          AND event_contact.source_deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM json_each(event_contact.roles_json)
            WHERE json_each.value = 'speaker'
          )
         JOIN p_session_participants participant
           ON participant.organization_id = contact.organization_id
          AND participant.event_id = event_contact.event_id
          AND participant.contact_id = contact.id
          AND participant.role = 'speaker'
          AND participant.confirmed_state = 'confirmed'
          AND participant.source_deleted_at IS NULL
         JOIN p_sessions session
           ON session.organization_id = participant.organization_id
          AND session.event_id = participant.event_id
          AND session.id = participant.session_id
          AND session.status = 'published'
          AND session.is_public = 1
          AND session.source_deleted_at IS NULL
         JOIN p_schedule_slots slot
           ON slot.organization_id = session.organization_id
          AND slot.event_id = session.event_id
          AND slot.session_id = session.id
          AND slot.published_version = ?4
          AND slot.source_deleted_at IS NULL
         JOIN file_objects file
           ON file.organization_id = contact.organization_id
          AND file.owner_contact_id = contact.id
          AND file.object_key = contact.headshot_object_key
          AND file.purpose = 'headshot'
          AND file.status = 'ready'
          AND file.r2_etag IS NOT NULL
          AND file.r2_version IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM file_objects newer
            WHERE newer.organization_id = file.organization_id
              AND newer.owner_contact_id = file.owner_contact_id
              AND COALESCE(newer.lineage_id, newer.id) = COALESCE(file.lineage_id, file.id)
              AND newer.status = 'ready'
              AND newer.version_number > file.version_number
          )
         WHERE contact.organization_id = ?1
           AND contact.display_name = ?2
           AND contact.profile_publication_state = 'published'
           AND contact.source_deleted_at IS NULL
         LIMIT 2`,
      )
      .bind(event.organizationId, speaker.name, event.eventId, profile.version)
      .all<{
        content_type: string;
        object_key: string;
        r2_etag: string | null;
        r2_version: string | null;
      }>();
    if (row.results.length !== 1) return null;
    const file = row.results[0];
    if (!file) return null;
    const object = await this.#bucket.get(file.object_key);
    if (
      !object ||
      (file.r2_version && object.version !== file.r2_version) ||
      (file.r2_etag && object.etag !== file.r2_etag)
    ) {
      if (object) await object.body.cancel().catch(() => undefined);
      return null;
    }
    return {
      body: object.body,
      contentType: file.content_type,
      etag: object.httpEtag,
    };
  }

  async portalHeadshot(
    session: AuthenticatedSession,
    event: SpeakerPortalEventScope,
  ): Promise<{
    body: ReadableStream;
    contentType: string;
    etag: string | null;
  } | null> {
    const access = await loadEventAccess(
      this.#database,
      session.user,
      event.organizationId,
      event.eventId,
    );
    if (
      !access.speakerContactId ||
      !hasEventPermission(access, "portal:read:self")
    ) {
      throw new SpeakerProfileError(
        "profile_forbidden",
        "This account cannot access the requested headshot.",
      );
    }
    const row = await this.#readRow(
      event.organizationId,
      access.speakerContactId,
    );
    if (!row?.headshot_object_key) return null;
    const object = await this.#bucket.get(row.headshot_object_key);
    if (
      !object ||
      !row.headshot_r2_etag ||
      !row.headshot_r2_version ||
      object.etag !== row.headshot_r2_etag ||
      object.version !== row.headshot_r2_version
    ) {
      if (object) await object.body.cancel().catch(() => undefined);
      return null;
    }
    return {
      body: object.body,
      contentType: row.headshot_content_type ?? "application/octet-stream",
      etag: object.httpEtag,
    };
  }

  async resolveEventKey(
    eventKey: string,
  ): Promise<SpeakerPortalEventScope | null> {
    const result = await this.#database
      .prepare(
        `SELECT slug FROM p_events
         WHERE (id = ?1 OR slug = ?1) AND source_deleted_at IS NULL
         ORDER BY organization_id, id LIMIT 2`,
      )
      .bind(eventKey)
      .all<{ slug: string }>();
    if (result.results.length > 1) {
      throw new SpeakerProfileError(
        "profile_projection_invalid",
        "The event key resolves to more than one event.",
      );
    }
    const slug = result.results[0]?.slug;
    return slug ? this.#eventResolver.resolve(slug) : null;
  }

  async resolveEvent(slug: string): Promise<SpeakerPortalEventScope | null> {
    return this.#eventResolver.resolve(slug);
  }

  async #readProfileReceipt(
    organizationId: string,
    operation: string,
    commandId: string,
    requestHash: string,
  ): Promise<ProfileReceiptRow | null> {
    const receiptOperation = profileReceiptOperation(operation);
    const receipt = await this.#database
      .prepare(
        `SELECT original_response_json, request_hash, status
         FROM idempotency_keys
         WHERE tenant_key = ?1 AND operation = ?2 AND command_id = ?3
         LIMIT 1`,
      )
      .bind(organizationId, receiptOperation, commandId)
      .first<ProfileReceiptRow>();
    if (receipt && receipt.request_hash !== requestHash) {
      throw new SpeakerProfileError(
        "profile_idempotency_conflict",
        "This profile command was already used with different content.",
      );
    }
    return receipt;
  }

  #parseProfileReceipt(receipt: ProfileReceiptRow): ProfileReceiptEnvelope {
    if (!receipt.original_response_json) {
      throw new SpeakerProfileError(
        "profile_projection_invalid",
        "The profile command receipt is incomplete.",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(receipt.original_response_json) as unknown;
    } catch {
      throw new SpeakerProfileError(
        "profile_projection_invalid",
        "The profile command receipt is invalid.",
      );
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !("authority_command" in parsed)
    ) {
      throw new SpeakerProfileError(
        "profile_projection_invalid",
        "The profile command receipt is invalid.",
      );
    }
    const value = parsed as { authority_command?: unknown } & Record<
      string,
      unknown
    >;
    try {
      return {
        authority_command: parseBaseAuthorityCommand(value.authority_command),
        ...(value.authority_response
          ? {
              authority_response: value.authority_response as AuthorityResponse,
            }
          : {}),
        ...(value.headshot !== undefined
          ? { headshot: value.headshot as HeadshotRow | null }
          : {}),
        ...(value.profile_response !== undefined
          ? { profile_response: value.profile_response }
          : {}),
      };
    } catch {
      throw new SpeakerProfileError(
        "profile_projection_invalid",
        "The profile command receipt is invalid.",
      );
    }
  }

  async #prepareProfileCommand(
    organizationId: string,
    operation: string,
    commandId: string,
    requestHash: string,
    command?: BaseAuthorityCommand,
    headshot?: HeadshotRow | null,
  ): Promise<PreparedProfileCommand> {
    const receiptOperation = profileReceiptOperation(operation);
    let receipt = await this.#readProfileReceipt(
      organizationId,
      operation,
      commandId,
      requestHash,
    );
    let created = false;
    if (!receipt) {
      if (!command) {
        throw new SpeakerProfileError(
          "profile_projection_invalid",
          "The profile command receipt is missing its authority command.",
        );
      }
      const initialEnvelope: ProfileReceiptEnvelope = {
        authority_command: command,
        ...(headshot === undefined ? {} : { headshot }),
      };
      const inserted = await this.#database
        .prepare(
          `INSERT OR IGNORE INTO idempotency_keys (
             tenant_key, operation, command_id, request_hash, status,
             entity_type, entity_id, original_response_json,
             created_at, updated_at, expires_at
           ) VALUES (?1, ?2, ?3, ?4, 'pending', 'speaker_profile', ?5, ?6,
                     ?7, ?7, ?8)`,
        )
        .bind(
          organizationId,
          receiptOperation,
          commandId,
          requestHash,
          command.entityId,
          JSON.stringify(initialEnvelope),
          this.#now().toISOString(),
          new Date(
            this.#now().getTime() + 90 * 24 * 60 * 60 * 1_000,
          ).toISOString(),
        )
        .run();
      created = inserted.meta.changes === 1;
      receipt = await this.#readProfileReceipt(
        organizationId,
        operation,
        commandId,
        requestHash,
      );
    }
    if (!receipt) {
      throw new SpeakerProfileError(
        "profile_projection_invalid",
        "The profile command receipt could not be read.",
      );
    }
    const envelope = this.#parseProfileReceipt(receipt);
    const cachedProfileResponse =
      receipt.status === "committed" && envelope.profile_response !== undefined
        ? speakerProfileCommandResponseSchema.parse(envelope.profile_response)
        : null;
    return {
      authorityCommand: envelope.authority_command,
      cachedProfileResponse,
      created,
      headshot: envelope.headshot,
    };
  }

  async #executeProfileCommand(
    organizationId: string,
    operation: string,
    commandId: string,
    requestHash: string,
    prepared: PreparedProfileCommand,
    expectedVersion: number,
  ): Promise<AuthorityResponse> {
    const receiptOperation = profileReceiptOperation(operation);
    try {
      // The RPC stub is typed as synchronous but resolves asynchronously in Workerd.
      // eslint-disable-next-line @typescript-eslint/await-thenable
      return await getBaseAuthority(this.#environment).execute(
        prepared.authorityCommand,
      );
    } catch (error) {
      const status =
        error instanceof AuthorityOutcomeUnknownError ||
        (error instanceof Error &&
          error.name === "AuthorityOutcomeUnknownError")
          ? "unknown"
          : "failed";
      await this.#database
        .prepare(
          `UPDATE idempotency_keys
           SET status = ?4, error_code = ?5, updated_at = ?6
           WHERE tenant_key = ?1 AND operation = ?2 AND command_id = ?3
             AND request_hash = ?7`,
        )
        .bind(
          organizationId,
          receiptOperation,
          commandId,
          status,
          error instanceof Error ? error.name : "UnknownError",
          this.#now().toISOString(),
          requestHash,
        )
        .run();
      return authorityError(error, expectedVersion);
    }
  }

  async #completeProfileReceipt(
    organizationId: string,
    operation: string,
    commandId: string,
    prepared: PreparedProfileCommand,
    response: AuthorityResponse,
    profileResponse: ReturnType<
      typeof speakerProfileCommandResponseSchema.parse
    >,
  ): Promise<void> {
    const receiptOperation = profileReceiptOperation(operation);
    const envelope: ProfileReceiptEnvelope = {
      authority_command: prepared.authorityCommand,
      authority_response: response,
      ...(prepared.headshot === undefined
        ? {}
        : { headshot: prepared.headshot }),
      profile_response: profileResponse,
    };
    await this.#database
      .prepare(
        `UPDATE idempotency_keys
         SET status = ?4, original_response_status = ?5,
             original_response_json = ?6, error_code = NULL, updated_at = ?7
         WHERE tenant_key = ?1 AND operation = ?2 AND command_id = ?3`,
      )
      .bind(
        organizationId,
        receiptOperation,
        commandId,
        response.projection === "repair_pending"
          ? "committed_with_repair"
          : "committed",
        response.projection === "repair_pending" ? 202 : 200,
        JSON.stringify(envelope),
        this.#now().toISOString(),
      )
      .run();
  }

  async #readRow(
    organizationId: string,
    contactId: string,
  ): Promise<ProfileRow | null> {
    return this.#database
      .prepare(
        `SELECT contact.bio, contact.company, contact.display_name,
                contact.headshot_alt_text,
                file.declared_mime_type AS headshot_content_type,
                file.display_filename AS headshot_file_name,
                file.id AS headshot_file_id,
                contact.headshot_object_key,
                file.version_number AS headshot_version,
                file.r2_etag AS headshot_r2_etag,
                file.r2_version AS headshot_r2_version,
                file.event_id AS headshot_event_id,
                contact.id, contact.profile_approved_at,
                contact.profile_publication_state, contact.pronouns,
                contact.projected_at, contact.social_json,
                contact.source_version, contact.title
         FROM p_contacts contact
         LEFT JOIN file_objects file
           ON file.organization_id = contact.organization_id
          AND file.owner_contact_id = contact.id
          AND file.object_key = contact.headshot_object_key
          AND file.purpose = 'headshot'
          AND file.status = 'ready'
          AND NOT EXISTS (
            SELECT 1 FROM file_objects newer
            WHERE newer.organization_id = file.organization_id
              AND newer.owner_contact_id = file.owner_contact_id
              AND COALESCE(newer.lineage_id, newer.id) = COALESCE(file.lineage_id, file.id)
              AND newer.status = 'ready'
              AND newer.version_number > file.version_number
          )
         WHERE contact.organization_id = ?1
           AND contact.id = ?2
           AND contact.source_deleted_at IS NULL
         LIMIT 1`,
      )
      .bind(organizationId, contactId)
      .first<ProfileRow>();
  }

  async #assertProfileParticipant(
    event: SpeakerPortalEventScope,
    profileId: string,
  ): Promise<void> {
    const participant = await this.#database
      .prepare(
        `SELECT 1 AS valid
         FROM p_event_contacts event_contact
         WHERE event_contact.organization_id = ?1
           AND event_contact.event_id = ?2
           AND event_contact.contact_id = ?3
           AND event_contact.source_deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM json_each(event_contact.roles_json)
             WHERE json_each.value = 'speaker'
           )
         LIMIT 1`,
      )
      .bind(event.organizationId, event.eventId, profileId)
      .first<{ valid: number }>();
    if (participant?.valid !== 1) {
      throw new SpeakerProfileError(
        "profile_not_found",
        "The requested speaker profile is not part of this event.",
      );
    }
  }

  async #audit(
    organizationId: string,
    contactId: string,
  ): Promise<SpeakerProfileAuditEntry[]> {
    const result = await this.#database
      .prepare(
        `SELECT action, actor_type, created_at, metadata_json
         FROM audit_events
         WHERE organization_id = ?1
           AND entity_type = 'contacts'
           AND entity_id = ?2
           AND action LIKE 'speaker_profile.%'
         ORDER BY created_at DESC, id DESC
         LIMIT 20`,
      )
      .bind(organizationId, contactId)
      .all<AuditRow>();
    return result.results.flatMap((row) => {
      try {
        const metadata = JSON.parse(row.metadata_json) as {
          outcome?: unknown;
        };
        if (metadata.outcome === "failed") return [];
      } catch {
        return [];
      }
      const action = auditAction(row.action);
      return [
        {
          action,
          actor: actorType(row.actor_type),
          at: row.created_at,
          summary: auditSummary(action),
        },
      ];
    });
  }

  #response(
    event: SpeakerPortalEventScope,
    row: ProfileRow,
    version = row.source_version,
  ): SpeakerProfileResponse {
    const social = safeSocial(row.social_json);
    const fields: SpeakerProfileFields = {
      bio: row.bio?.trim() ?? "",
      bluesky_url: social.bluesky_url,
      company: row.company?.trim() ?? "",
      display_name: row.display_name.trim(),
      headshot_alt: row.headshot_alt_text?.trim() ?? "",
      linkedin_url: social.linkedin_url,
      pronouns: row.pronouns?.trim() ?? "",
      title: row.title?.trim() ?? "",
      website_url: social.website_url,
    };
    return speakerProfileResponseSchema.parse({
      audit: [],
      fields,
      headshot:
        row.headshot_file_id &&
        row.headshot_content_type &&
        row.headshot_file_name &&
        row.headshot_version
          ? {
              alt: fields.headshot_alt || `Portrait of ${fields.display_name}`,
              content_type: row.headshot_content_type,
              file_name: row.headshot_file_name,
              id: row.headshot_file_id,
              preview_url: `/api/portal/${event.slug}/profile/headshot`,
              status: "ready",
              version: row.headshot_version,
            }
          : null,
      upload_context: {
        event_id: event.eventId,
        organization_id: event.organizationId,
        owner_contact_id: row.id,
        purpose: "headshot",
        ...(row.headshot_event_id === event.eventId && row.headshot_file_id
          ? { replacement_file_id: row.headshot_file_id }
          : {}),
      },
      policy: profilePolicy(),
      publication_state: row.profile_publication_state,
      profile_id: row.id,
      reuse_scope: "organization",
      updated_at: row.projected_at,
      version,
    });
  }

  #rowFromCommand(
    current: ProfileRow,
    response: AuthorityResponse,
    fields: BaseAuthorityCommand["fields"],
    headshot: HeadshotRow | null | undefined,
  ): ProfileRow {
    const social =
      typeof fields["Social JSON"] === "string"
        ? fields["Social JSON"]
        : current.social_json;
    const has = (key: string): boolean =>
      Object.prototype.hasOwnProperty.call(fields, key);
    return {
      ...current,
      bio: has("Bio")
        ? typeof fields.Bio === "string"
          ? fields.Bio
          : null
        : current.bio,
      company: has("Company")
        ? typeof fields.Company === "string"
          ? fields.Company
          : null
        : current.company,
      display_name:
        has("Display name") && typeof fields["Display name"] === "string"
          ? fields["Display name"]
          : current.display_name,
      headshot_alt_text: has("Headshot alt text")
        ? typeof fields["Headshot alt text"] === "string"
          ? fields["Headshot alt text"]
          : null
        : current.headshot_alt_text,
      headshot_content_type:
        headshot === undefined
          ? current.headshot_content_type
          : (headshot?.content_type ?? null),
      headshot_file_id:
        headshot === undefined
          ? current.headshot_file_id
          : (headshot?.file_id ?? null),
      headshot_file_name:
        headshot === undefined
          ? current.headshot_file_name
          : (headshot?.file_name ?? null),
      headshot_object_key:
        headshot === undefined
          ? current.headshot_object_key
          : (headshot?.object_key ?? null),
      headshot_version:
        headshot === undefined
          ? current.headshot_version
          : (headshot?.version ?? null),
      profile_approved_at: has("Profile approved at")
        ? typeof fields["Profile approved at"] === "string"
          ? fields["Profile approved at"]
          : null
        : current.profile_approved_at,
      profile_publication_state:
        fields["Profile publication state"] === "approved" ||
        fields["Profile publication state"] === "published"
          ? fields["Profile publication state"]
          : has("Profile publication state")
            ? "draft"
            : current.profile_publication_state,
      pronouns: has("Pronouns")
        ? typeof fields.Pronouns === "string"
          ? fields.Pronouns
          : null
        : current.pronouns,
      projected_at: this.#now().toISOString(),
      social_json: has("Social JSON") ? social : current.social_json,
      source_version: response.authority.sourceVersion,
      title: has("Title")
        ? typeof fields.Title === "string"
          ? fields.Title
          : null
        : current.title,
    };
  }

  async #assertPublishable(
    event: SpeakerPortalEventScope,
    profileId: string,
    current: ProfileRow,
    state: "approved" | "published",
  ): Promise<void> {
    const social = safeSocial(current.social_json);
    let fields: SpeakerProfileFields;
    try {
      fields = speakerProfileSaveFieldsSchema.parse({
        bio: current.bio?.trim() ?? "",
        bluesky_url: social.bluesky_url,
        company: current.company?.trim() ?? "",
        display_name: current.display_name.trim(),
        headshot_alt: current.headshot_alt_text?.trim() ?? "",
        linkedin_url: social.linkedin_url,
        pronouns: current.pronouns?.trim() ?? "",
        title: current.title?.trim() ?? "",
        website_url: social.website_url,
      });
    } catch {
      throw new SpeakerProfileError(
        "profile_projection_invalid",
        "The profile cannot be published with its current public fields.",
      );
    }
    const name = fields.display_name.trim();
    if (current.headshot_object_key && !fields.headshot_alt) {
      throw new SpeakerProfileError(
        "profile_headshot_invalid",
        "Headshot alt text is required while a headshot is attached.",
      );
    }
    if (state === "approved") return;
    const slug = profileSlug(name);
    const schedule = await new D1PublicScheduleProjectionReader(
      this.#database,
    ).readBySlug(event.slug);
    if (!schedule) {
      throw new SpeakerProfileError(
        "profile_projection_invalid",
        "The event public schedule is not available.",
      );
    }
    const query = [
      "SELECT DISTINCT contact.display_name FROM p_event_contacts event_contact",
      "JOIN p_session_participants participant ON participant.organization_id = event_contact.organization_id",
      "AND participant.event_id = event_contact.event_id AND participant.contact_id = event_contact.contact_id",
      "AND participant.role = 'speaker' AND participant.confirmed_state = 'confirmed'",
      "AND participant.source_deleted_at IS NULL",
      "JOIN p_sessions session ON session.organization_id = participant.organization_id",
      "AND session.event_id = participant.event_id AND session.id = participant.session_id",
      "AND session.status = 'published' AND session.is_public = 1 AND session.source_deleted_at IS NULL",
      "JOIN p_schedule_slots slot ON slot.organization_id = session.organization_id",
      "AND slot.event_id = session.event_id AND slot.session_id = session.id",
      "AND slot.published_version = ?3 AND slot.source_deleted_at IS NULL",
      "JOIN p_contacts contact ON contact.organization_id = event_contact.organization_id",
      "AND contact.id = event_contact.contact_id AND contact.source_deleted_at IS NULL",
      "WHERE event_contact.organization_id = ?1 AND event_contact.event_id = ?2",
      "AND event_contact.source_deleted_at IS NULL",
      "AND EXISTS (SELECT 1 FROM json_each(event_contact.roles_json) WHERE json_each.value = 'speaker')",
      "AND (contact.profile_publication_state = 'published' OR contact.id = ?4)",
    ].join(" ");
    const rows = await this.#database
      .prepare(query)
      .bind(
        event.organizationId,
        event.eventId,
        schedule.projection.version,
        profileId,
      )
      .all<{ display_name: string }>();
    const names = new Set<string>();
    const slugs = new Set<string>();
    for (const row of rows.results) {
      const rowName = row.display_name.trim();
      const rowSlug = profileSlug(rowName);
      if (names.has(rowName) || slugs.has(rowSlug)) {
        throw new SpeakerProfileError(
          "profile_projection_invalid",
          "Published speaker profiles contain duplicate public identities.",
        );
      }
      names.add(rowName);
      slugs.add(rowSlug);
    }
    if (!names.has(name) || !slugs.has(slug)) {
      throw new SpeakerProfileError(
        "profile_projection_invalid",
        "The profile is not present in the public speaker projection.",
      );
    }
  }

  async #authorizeHeadshot(
    organizationId: string,
    eventId: string,
    contactId: string,
    fileId: string,
  ): Promise<HeadshotRow> {
    if (!profileIdPattern.test(fileId)) {
      throw new SpeakerProfileError(
        "profile_headshot_invalid",
        "The headshot file is invalid.",
      );
    }
    const file = await this.#database
      .prepare(
        `SELECT byte_size, declared_mime_type AS content_type,
                display_filename AS file_name, id AS file_id, object_key,
                r2_etag, r2_version, version_number AS version
         FROM file_objects
         WHERE organization_id = ?1 AND event_id = ?2
           AND owner_contact_id = ?3 AND id = ?4
           AND purpose = 'headshot' AND status = 'ready'
           AND r2_etag IS NOT NULL AND r2_version IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM file_objects newer
             WHERE newer.organization_id = file_objects.organization_id
               AND newer.owner_contact_id = file_objects.owner_contact_id
               AND COALESCE(newer.lineage_id, newer.id) = COALESCE(file_objects.lineage_id, file_objects.id)
               AND newer.status = 'ready'
               AND newer.version_number > file_objects.version_number
           )
         LIMIT 1`,
      )
      .bind(organizationId, eventId, contactId, fileId)
      .first<HeadshotRow>();
    if (!file || file.byte_size > speakerProfilePolicy.max_bytes) {
      throw new SpeakerProfileError(
        "profile_headshot_invalid",
        "The headshot is unavailable or outside this profile scope.",
      );
    }
    const object = await this.#bucket.get(file.object_key, {
      range: { length: imageSampleBytes, offset: 0 },
    });
    if (!object) {
      throw new SpeakerProfileError(
        "profile_headshot_invalid",
        "The finalized headshot is unavailable.",
      );
    }
    if (object.etag !== file.r2_etag || object.version !== file.r2_version) {
      await object.body.cancel().catch(() => undefined);
      throw new SpeakerProfileError(
        "profile_headshot_invalid",
        "The finalized headshot changed before it could be associated.",
      );
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    const dimensions = imageDimensions(bytes, file.content_type);
    if (
      !dimensions ||
      dimensions.width < speakerProfilePolicy.min_width ||
      dimensions.height < speakerProfilePolicy.min_height
    ) {
      throw new SpeakerProfileError(
        "profile_headshot_invalid",
        "Choose a headshot at least 1200 × 1200 pixels.",
      );
    }
    return file;
  }
}

export function imageDimensions(
  bytes: Uint8Array,
  contentType: "image/jpeg" | "image/png" | "image/webp",
): { height: number; width: number } | null {
  if (contentType === "image/png" && bytes.length >= 24) {
    return {
      height: new DataView(bytes.buffer, bytes.byteOffset).getUint32(20),
      width: new DataView(bytes.buffer, bytes.byteOffset).getUint32(16),
    };
  }
  if (
    contentType === "image/webp" &&
    bytes.length >= 16 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    const uintLe = (offset: number, length: number): number =>
      [...Array(length)].reduce(
        (value, _, index) =>
          value + view.getUint8(offset + index) * 2 ** (8 * index),
        0,
      );
    const chunk = String.fromCharCode(...bytes.slice(12, 16));
    if (chunk === "VP8X" && bytes.length >= 30) {
      return {
        height: 1 + uintLe(27, 3),
        width: 1 + uintLe(24, 3),
      };
    }
    if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
      const byte22 = bytes[22] ?? 0;
      const byte23 = bytes[23] ?? 0;
      const byte24 = bytes[24] ?? 0;
      const byte21 = bytes[21] ?? 0;
      return {
        height: 1 + ((byte22 >> 6) | (byte23 << 2) | ((byte24 & 0x0f) << 10)),
        width: 1 + (byte21 | ((byte22 & 0x3f) << 8)),
      };
    }
    if (
      chunk === "VP8 " &&
      bytes.length >= 30 &&
      bytes[23] === 0x9d &&
      bytes[24] === 0x01 &&
      bytes[25] === 0x2a
    ) {
      return {
        height: uintLe(28, 2) & 0x3fff,
        width: uintLe(26, 2) & 0x3fff,
      };
    }
  }
  if (
    contentType !== "image/jpeg" ||
    bytes.length < 4 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8
  )
    return null;
  let offset = 2;
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > bytes.length) return null;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    const sof =
      marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (sof && length >= 7) {
      return {
        height: view.getUint16(offset + 3),
        width: view.getUint16(offset + 5),
      };
    }
    offset += length;
  }
  return null;
}
