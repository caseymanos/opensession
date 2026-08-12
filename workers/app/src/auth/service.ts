import {
  magicLinkRequestSchema,
  type MagicLinkRequest,
} from "@sessionbox-killer/contracts";
import {
  speakerPortalInvitationRecoverySchema,
  type SpeakerPortalInvitationRecovery,
} from "@sessionbox-killer/contracts/portal";

import {
  canReadSession,
  loadEventAccess,
  type EventAccess,
} from "./authorization";
import {
  constantTimeEqual,
  createOpaqueToken,
  fingerprint,
  sha256Hex,
} from "./crypto";
import { durableOperationalEventStatement } from "../observability";
import {
  serializeMagicLinkDeliveryBinding,
  type MagicLinkEmailQueueMessage,
} from "../email/messages";
import { safeSpeakerPortalBrand } from "../portal/brand";

const magicLinkLifetimeMs = 15 * 60 * 1000;
const sessionLifetimeMs = 12 * 60 * 60 * 1000;
const throttleWindowMs = 15 * 60 * 1000;
const throttleBlockMs = 30 * 60 * 1000;
const emailRequestLimit = 3;
const ipRequestLimit = 12;
const stableIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const idempotencyLifetimeMs = 30 * 24 * 60 * 60 * 1_000;
const invitationLeaseMs = 30 * 1_000;

export type AuthErrorCode =
  | "idempotency_conflict"
  | "invalid_magic_link"
  | "invalid_session"
  | "invalid_csrf";

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly recovery: SpeakerPortalInvitationRecovery | null;

  constructor(
    code: AuthErrorCode,
    message: string,
    recovery: SpeakerPortalInvitationRecovery | null = null,
  ) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.recovery = recovery;
  }
}

export interface AuthRequestMetadata {
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export interface AuthenticatedSession {
  readonly csrfTokenHash: string;
  readonly expiresAt: string;
  readonly id: string;
  readonly tokenHash: string;
  readonly user: {
    readonly displayName: string | null;
    readonly email: string;
    readonly id: string;
  };
}

export interface CreatedSession extends AuthenticatedSession {
  readonly csrfToken: string;
  readonly sessionToken: string;
}

export interface ScopedSessionAccess {
  readonly access: EventAccess;
  readonly canReadSession: boolean | null;
}

export type MagicLinkRequestOutcome =
  | "delivery_cleanup_failed"
  | "delivery_failed"
  | "finalization_failed"
  | "queued"
  | "suppressed";

export interface MagicLinkRequestResult {
  readonly deliveryId: string | null;
  readonly outcome: MagicLinkRequestOutcome;
}

export interface MagicLinkRequestOptions {
  readonly registerUnprivilegedUser?: boolean;
  readonly portalInvitation?: {
    readonly commandId: string;
    readonly deliveryId: string;
  };
}

export interface PortalInvitationCommand {
  readonly commandId: string;
  readonly email: string;
  readonly eventId: string;
  readonly eventSlug: string;
  readonly organizationId: string;
}

interface MagicLinkCandidate {
  browser_binding_hash: string | null;
  contact_id: string | null;
  created_at: string;
  delivery_state: "pending" | "queued";
  display_name: string | null;
  email_normalized: string;
  event_id: string | null;
  id: string;
  organization_id: string | null;
  purpose: "portal" | "sign_in";
  portal_grant_id: string | null;
  redirect_path: string;
  user_id: string;
}

interface PortalRecoveryRow {
  brand_json: string;
  email_normalized: string;
  event_name: string;
  event_slug: string;
  grant_consumed_at: string | null;
  grant_expires_at: string;
  grant_revoked_at: string | null;
  link_consumed_at: string | null;
  link_expires_at: string;
  link_revoked_at: string | null;
  contact_deleted_at: string | null;
  event_deleted_at: string | null;
  portal_state: "active" | "invited" | "not_invited" | "revoked" | null;
  relationship_deleted_at: string | null;
  tenant_status: "active" | "deleted" | "suspended";
}

interface SessionRow {
  csrf_token_hash: string;
  display_name: string | null;
  email_normalized: string;
  expires_at: string;
  id: string;
  last_seen_at: string;
  token_hash: string;
  user_id: string;
}

interface ThrottleRow {
  blocked_until: string | null;
}

interface ThrottleKey {
  dimension: "email" | "ip";
  hash: string;
  limit: number;
}

interface PortalInvitationIdempotencyRow {
  entity_id: string | null;
  lease_expires_at: string | null;
  lease_owner: string | null;
  original_response_json: string | null;
  request_hash: string;
  status:
    "committed" | "committed_with_repair" | "failed" | "pending" | "unknown";
}

interface PortalInvitationDeliveryRow {
  contact_id: string | null;
  created_at: string;
  delivery_state: "failed" | "pending" | "queued";
  email_normalized: string;
  event_id: string | null;
  organization_id: string | null;
  purpose: "portal" | "sign_in";
  redirect_path: string;
}

interface PortalMagicLinkRepairRow extends PortalInvitationDeliveryRow {
  id: string;
}

interface PortalInvitationEventRow {
  slug: string;
}

export interface AuthServiceOptions {
  readonly database: D1Database;
  readonly emailEnabled: boolean;
  readonly emailQueue: Queue<MagicLinkEmailQueueMessage>;
  readonly hashPepper: string;
  readonly now?: () => Date;
  readonly tokenFactory?: () => string;
}

function isoAt(date: Date, deltaMs: number): string {
  return new Date(date.getTime() + deltaMs).toISOString();
}

function maskedEmail(email: string): string {
  const separator = email.lastIndexOf("@");
  if (separator <= 0) return "***";
  const local = email.slice(0, separator);
  const domain = email.slice(separator + 1);
  return `${local[0] ?? "*"}${"*".repeat(Math.min(3, local.length))}@${domain}`;
}

export class AuthService {
  readonly #database: D1Database;
  readonly #emailEnabled: boolean;
  readonly #emailQueue: Queue<MagicLinkEmailQueueMessage>;
  readonly #hashPepper: string;
  readonly #now: () => Date;
  readonly #tokenFactory: () => string;

  constructor(options: AuthServiceOptions) {
    if (options.hashPepper.length < 32) {
      throw new Error("AUTH_HASH_PEPPER must contain at least 32 characters.");
    }

    this.#database = options.database;
    this.#emailEnabled = options.emailEnabled;
    this.#emailQueue = options.emailQueue;
    this.#hashPepper = options.hashPepper;
    this.#now = options.now ?? (() => new Date());
    this.#tokenFactory = options.tokenFactory ?? (() => createOpaqueToken());
  }

  async issuePortalInvitation(
    command: PortalInvitationCommand,
    metadata: AuthRequestMetadata,
    origin: string,
    requestId: string,
  ): Promise<MagicLinkRequestResult> {
    if (
      !stableIdPattern.test(command.commandId) ||
      !stableIdPattern.test(command.organizationId) ||
      !stableIdPattern.test(command.eventId) ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(command.eventSlug)
    ) {
      throw new TypeError("The portal invitation command is invalid.");
    }
    const invitationOrigin = new URL(origin);
    if (
      invitationOrigin.username ||
      invitationOrigin.password ||
      invitationOrigin.pathname !== "/" ||
      invitationOrigin.search ||
      invitationOrigin.hash ||
      (invitationOrigin.protocol !== "https:" &&
        !(
          invitationOrigin.protocol === "http:" &&
          ["127.0.0.1", "localhost"].includes(invitationOrigin.hostname)
        ))
    ) {
      throw new TypeError("The portal invitation origin is unsafe.");
    }
    const email = command.email.trim().toLowerCase();
    const redirectPath = `/portal/${command.eventSlug}`;
    const invitationRequest = magicLinkRequestSchema.parse({
      email,
      event_id: command.eventId,
      organization_id: command.organizationId,
      purpose: "portal",
      redirect_path: redirectPath,
    });
    const requestHash = await sha256Hex(
      JSON.stringify([
        1,
        email,
        command.organizationId,
        command.eventId,
        redirectPath,
      ]),
    );
    const operation = "portal.invitation.issue";
    let ownsReservation = false;
    const existing = await this.#database
      .prepare(
        `SELECT entity_id, lease_expires_at, lease_owner,
                original_response_json, request_hash, status
         FROM idempotency_keys
         WHERE tenant_key = ?1 AND operation = ?2 AND command_id = ?3`,
      )
      .bind(command.organizationId, operation, command.commandId)
      .first<PortalInvitationIdempotencyRow>();
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw new AuthError(
          "idempotency_conflict",
          "This invitation command was already used for different input.",
        );
      }
      const replay = await this.#replayPortalInvitation(
        command,
        existing,
        requestId,
        operation,
      );
      if (
        replay.outcome !== "finalization_failed" ||
        !(await this.#claimOrphanPortalInvitation(
          command,
          existing,
          requestHash,
          requestId,
          operation,
        ))
      ) {
        return replay;
      }
      ownsReservation = true;
    }

    const canonicalEvent = await this.#database
      .prepare(
        `SELECT event.slug
         FROM tenant_registry tenant
         JOIN p_events event
           ON event.organization_id = tenant.organization_id
          AND event.id = ?2
          AND event.source_deleted_at IS NULL
         WHERE tenant.organization_id = ?1
           AND tenant.status = 'active'
           AND tenant.authority_ready_at IS NOT NULL
         LIMIT 1`,
      )
      .bind(command.organizationId, command.eventId)
      .first<PortalInvitationEventRow>();
    if (!canonicalEvent || canonicalEvent.slug !== command.eventSlug) {
      throw new TypeError(
        "The portal invitation event slug does not match its canonical scope.",
      );
    }

    const deliveryId = `inv_${(
      await sha256Hex(
        JSON.stringify([
          command.organizationId,
          operation,
          command.commandId,
          requestHash,
        ]),
      )
    ).slice(0, 26)}`;
    if (!ownsReservation) {
      const reservationTime = this.#now();
      const reserved = await this.#database
        .prepare(
          `INSERT INTO idempotency_keys (
           tenant_key, operation, command_id, request_hash, status,
           entity_type, entity_id, lease_owner, lease_expires_at,
           created_at, updated_at, expires_at
         ) VALUES (?1, ?2, ?3, ?4, 'pending', 'portal_grant', ?5, ?6, ?7,
                   ?8, ?8, ?9)
         ON CONFLICT (tenant_key, operation, command_id) DO NOTHING`,
        )
        .bind(
          command.organizationId,
          operation,
          command.commandId,
          requestHash,
          deliveryId,
          requestId,
          isoAt(reservationTime, invitationLeaseMs),
          reservationTime.toISOString(),
          isoAt(reservationTime, idempotencyLifetimeMs),
        )
        .run();
      if (reserved.meta.changes !== 1) {
        const replay = await this.#loadPortalInvitationIdempotency(
          command,
          operation,
        );
        if (!replay) {
          throw new Error("The invitation command reservation was lost.");
        }
        if (replay.request_hash !== requestHash) {
          throw new AuthError(
            "idempotency_conflict",
            "This invitation command was already used for different input.",
          );
        }
        const result = await this.#replayPortalInvitation(
          command,
          replay,
          requestId,
          operation,
        );
        if (
          result.outcome !== "finalization_failed" ||
          !(await this.#claimOrphanPortalInvitation(
            command,
            replay,
            requestHash,
            requestId,
            operation,
          ))
        ) {
          return result;
        }
      }
    }
    const existingDelivery = await this.#database
      .prepare(
        `SELECT link.email_normalized, link.purpose, link.redirect_path,
                link.created_at, link.delivery_state, scope.organization_id,
                scope.event_id, scope.contact_id
         FROM magic_link_tokens link
         LEFT JOIN magic_link_scopes scope ON scope.token_id = link.id
         WHERE link.id = ?1
         LIMIT 1`,
      )
      .bind(deliveryId)
      .first<PortalInvitationDeliveryRow>();
    if (existingDelivery) {
      if (
        existingDelivery.email_normalized !== email ||
        existingDelivery.purpose !== "portal" ||
        existingDelivery.redirect_path !== redirectPath ||
        existingDelivery.organization_id !== command.organizationId ||
        existingDelivery.event_id !== command.eventId
      ) {
        throw new AuthError(
          "idempotency_conflict",
          "This invitation command was already used for different input.",
        );
      }
      const replay = await this.#repairPortalInvitationDelivery(
        existingDelivery,
        deliveryId,
        command.commandId,
        requestId,
      );
      await this.#recordPortalInvitationIdempotency(
        command,
        operation,
        requestHash,
        replay,
      );
      return replay;
    }
    const result = await this.requestMagicLink(
      invitationRequest,
      metadata,
      null,
      origin,
      requestId,
      {
        portalInvitation: { commandId: command.commandId, deliveryId },
        registerUnprivilegedUser: true,
      },
    );
    await this.#recordPortalInvitationIdempotency(
      command,
      operation,
      requestHash,
      result,
    );
    return result;
  }

  async requestMagicLink(
    request: MagicLinkRequest,
    metadata: AuthRequestMetadata,
    browserBindingToken: string | null,
    origin: string,
    requestId: string,
    options: MagicLinkRequestOptions = {},
  ): Promise<MagicLinkRequestResult> {
    const email = request.email.toLowerCase();
    const now = this.#now();
    const nowIso = now.toISOString();
    const portalInvitation = options.portalInvitation ?? null;
    if (
      browserBindingToken === null &&
      (request.purpose !== "portal" || portalInvitation === null)
    ) {
      throw new Error(
        "Only a trusted event-scoped portal invitation may cross browsers.",
      );
    }

    if (!this.#emailEnabled) {
      return { deliveryId: null, outcome: "suppressed" };
    }

    const throttled =
      portalInvitation === null
        ? await this.#isRequestThrottled(email, metadata, now)
        : false;

    if (throttled) {
      return { deliveryId: null, outcome: "suppressed" };
    }

    const identity = await this.#eligibleIdentity(
      request,
      email,
      nowIso,
      options.registerUnprivilegedUser ?? false,
    );
    if (!identity) {
      return { deliveryId: null, outcome: "suppressed" };
    }

    const token = this.#tokenFactory();
    const [browserBindingHash, tokenHash] = await Promise.all([
      browserBindingToken ? sha256Hex(browserBindingToken) : null,
      sha256Hex(token),
    ]);
    const tokenId = portalInvitation?.deliveryId ?? crypto.randomUUID();
    const expiresAt = isoAt(now, magicLinkLifetimeMs);
    const requestIpHash = metadata.ipAddress
      ? await fingerprint(metadata.ipAddress, this.#hashPepper, "request-ip")
      : null;
    const emailMessage: MagicLinkEmailQueueMessage = {
      delivery_id: tokenId,
      expires_at: expiresAt,
      kind: "auth.magic_link.requested",
      link: `${origin}/auth/magic#token=${encodeURIComponent(token)}`,
      purpose: request.purpose,
      request_id: requestId,
      to: email,
      version: 1,
    };
    const deliveryRecipientHash = await sha256Hex(email);
    const deliveryPayloadHash = await sha256Hex(
      serializeMagicLinkDeliveryBinding(emailMessage),
    );
    const statements = [
      this.#database
        .prepare(
          `INSERT INTO magic_link_tokens
            (id, email_normalized, user_id, purpose, token_hash, redirect_path,
             created_at, expires_at, request_ip_hash, browser_binding_hash,
             delivery_state, delivery_recipient_hash, delivery_payload_hash)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'pending', ?11, ?12)`,
        )
        .bind(
          tokenId,
          email,
          identity.userId,
          request.purpose,
          tokenHash,
          request.redirect_path,
          nowIso,
          expiresAt,
          requestIpHash,
          browserBindingHash,
          deliveryRecipientHash,
          deliveryPayloadHash,
        ),
    ];

    if (request.organization_id && request.event_id) {
      statements.push(
        this.#database
          .prepare(
            `INSERT INTO magic_link_scopes
              (token_id, organization_id, event_id, contact_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)`,
          )
          .bind(
            tokenId,
            request.organization_id,
            request.event_id,
            identity.contactId,
            nowIso,
          ),
      );
    }

    await this.#database.batch(statements);

    try {
      await this.#emailQueue.send(emailMessage);
    } catch {
      try {
        const failed = await this.#database
          .prepare(
            `UPDATE magic_link_tokens
             SET delivery_state = 'failed', revoked_at = ?1,
                 delivery_error_code = 'queue_rejected'
             WHERE id = ?2
               AND delivery_state = 'pending'
               AND consumed_at IS NULL
               AND revoked_at IS NULL`,
          )
          .bind(this.#now().toISOString(), tokenId)
          .run();
        const outcome =
          failed.meta.changes === 1
            ? "delivery_failed"
            : "delivery_cleanup_failed";
        try {
          await durableOperationalEventStatement(
            this.#database,
            {
              attempt: 1,
              dedupe_key: `email:${tokenId}:enqueue_failed`,
              delivery_id: tokenId,
              error_type: "queue_rejected",
              event: "email.magic_link.enqueue_failed",
              outcome: "failure",
              queue: "email_send",
              request_id: requestId,
              ...(request.organization_id
                ? { organization_id: request.organization_id }
                : {}),
              ...(request.event_id ? { event_id: request.event_id } : {}),
            },
            now,
          ).run();
        } catch {
          // The request event still reaches aggregate telemetry at the route boundary.
        }
        return { deliveryId: tokenId, outcome };
      } catch {
        return { deliveryId: tokenId, outcome: "delivery_cleanup_failed" };
      }
    }

    try {
      const queued = await this.#database
        .prepare(
          `UPDATE magic_link_tokens
           SET delivery_state = 'queued'
           WHERE id = ?1
             AND delivery_state = 'pending'
             AND consumed_at IS NULL
             AND revoked_at IS NULL`,
        )
        .bind(tokenId)
        .run();
      if (queued.meta.changes !== 1) {
        const state = await this.#database
          .prepare(
            `SELECT delivery_state
             FROM magic_link_tokens
             WHERE id = ?1 AND consumed_at IS NULL AND revoked_at IS NULL`,
          )
          .bind(tokenId)
          .first<{ delivery_state: "failed" | "pending" | "queued" }>();
        if (state?.delivery_state !== "queued") {
          return { deliveryId: tokenId, outcome: "finalization_failed" };
        }
      }
      const finalized = await this.#finalizeQueuedMagicLink({
        commandId: portalInvitation?.commandId ?? null,
        contactId: identity.contactId,
        createdAt: nowIso,
        email,
        eventId: request.event_id ?? null,
        invitationKind: portalInvitation ? "acceptance" : "recovery",
        now,
        organizationId: request.organization_id ?? null,
        purpose: request.purpose,
        requestId,
        tokenId,
      });
      return {
        deliveryId: tokenId,
        outcome: finalized ? "queued" : "finalization_failed",
      };
    } catch {
      return { deliveryId: tokenId, outcome: "finalization_failed" };
    }
  }

  async exchangeMagicLink(
    token: string,
    browserBindingToken: string | null,
    metadata: AuthRequestMetadata,
    currentSessionToken: string | null,
  ): Promise<CreatedSession & { redirectPath: string }> {
    const now = this.#now();
    const nowIso = now.toISOString();
    const [browserBindingHash, tokenHash] = await Promise.all([
      sha256Hex(browserBindingToken ?? ""),
      sha256Hex(token),
    ]);
    const repairablePortal = await this.#database
      .prepare(
        `SELECT link.id, link.email_normalized, link.purpose,
                link.redirect_path, link.created_at, link.delivery_state,
                scope.organization_id, scope.event_id, scope.contact_id
         FROM magic_link_tokens link
         JOIN magic_link_scopes scope ON scope.token_id = link.id
         LEFT JOIN portal_grants grant ON grant.id = link.id
         WHERE link.token_hash = ?1
           AND link.purpose = 'portal'
           AND link.delivery_state = 'queued'
           AND link.expires_at > ?2
           AND link.consumed_at IS NULL
           AND link.revoked_at IS NULL
           AND grant.id IS NULL
         LIMIT 1`,
      )
      .bind(tokenHash, nowIso)
      .first<PortalMagicLinkRepairRow>();
    if (
      repairablePortal?.organization_id &&
      repairablePortal.event_id &&
      repairablePortal.contact_id
    ) {
      try {
        await this.#finalizeQueuedMagicLink({
          commandId: null,
          contactId: repairablePortal.contact_id,
          createdAt: repairablePortal.created_at,
          email: repairablePortal.email_normalized,
          eventId: repairablePortal.event_id,
          invitationKind: "recovery",
          now,
          organizationId: repairablePortal.organization_id,
          purpose: "portal",
          requestId: `exchange:${repairablePortal.id}`,
          tokenId: repairablePortal.id,
        });
      } catch {
        // The normal candidate query below remains fail closed.
      }
    }
    const candidate = await this.#database
      .prepare(
        `SELECT
          link.id,
          link.browser_binding_hash,
          link.created_at,
          link.delivery_state,
          link.email_normalized,
          link.user_id,
          link.purpose,
          link.redirect_path,
          user.display_name,
          scope.organization_id,
          scope.event_id,
          scope.contact_id,
          grant.id AS portal_grant_id
         FROM magic_link_tokens link
         JOIN users user ON user.id = link.user_id AND user.status = 'active'
         LEFT JOIN magic_link_scopes scope ON scope.token_id = link.id
         LEFT JOIN portal_grants grant
           ON grant.id = link.id
          AND grant.token_hash = link.token_hash
          AND grant.organization_id = scope.organization_id
          AND grant.event_id = scope.event_id
          AND grant.contact_id = scope.contact_id
          AND grant.expires_at > ?2
          AND grant.consumed_at IS NULL
          AND grant.revoked_at IS NULL
         WHERE link.token_hash = ?1
           AND link.delivery_state IN ('pending', 'queued')
           AND link.expires_at > ?2
           AND link.consumed_at IS NULL
           AND link.revoked_at IS NULL
           AND (link.purpose != 'portal' OR grant.id IS NOT NULL)
         LIMIT 1`,
      )
      .bind(tokenHash, nowIso)
      .first<MagicLinkCandidate>();

    const bindingIsValid = candidate?.browser_binding_hash
      ? browserBindingToken !== null &&
        constantTimeEqual(candidate.browser_binding_hash, browserBindingHash)
      : candidate?.purpose === "portal" && candidate.portal_grant_id !== null;
    if (!candidate || !bindingIsValid) {
      throw await this.#invalidMagicLink(tokenHash, nowIso, false);
    }
    if (!(await this.#scopeRemainsEligible(candidate))) {
      if (candidate.purpose === "portal") {
        await this.#revokePortalCandidate(candidate, tokenHash, nowIso);
        throw await this.#invalidMagicLink(tokenHash, nowIso, true);
      }
      throw await this.#invalidMagicLink(tokenHash, nowIso, false);
    }

    const consumptionStatements = [
      this.#database
        .prepare(
          `UPDATE magic_link_tokens
           SET consumed_at = ?1, delivery_state = 'queued'
           WHERE id = ?2
             AND token_hash = ?3
             AND expires_at > ?1
             AND delivery_state IN ('pending', 'queued')
             AND consumed_at IS NULL
             AND revoked_at IS NULL
             AND (
               purpose != 'portal'
               OR EXISTS (
                 SELECT 1 FROM portal_grants grant
                 WHERE grant.id = magic_link_tokens.id
                   AND grant.token_hash = magic_link_tokens.token_hash
                   AND grant.expires_at > ?1
                   AND grant.consumed_at IS NULL
                   AND grant.revoked_at IS NULL
               )
             )`,
        )
        .bind(nowIso, candidate.id, tokenHash),
    ];
    const grantConsumptionIndex =
      candidate.purpose === "portal" ? consumptionStatements.length : null;
    if (candidate.purpose === "portal") {
      consumptionStatements.push(
        this.#database
          .prepare(
            `UPDATE portal_grants
             SET consumed_at = ?1
             WHERE id = ?2
               AND token_hash = ?3
               AND expires_at > ?1
               AND consumed_at IS NULL
               AND revoked_at IS NULL`,
          )
          .bind(nowIso, candidate.id, tokenHash),
      );
    }
    consumptionStatements.push(
      this.#supersessionStatement({
        consumedAt: nowIso,
        createdAt: candidate.created_at,
        email: candidate.email_normalized,
        eventId: candidate.event_id,
        organizationId: candidate.organization_id,
        purpose: candidate.purpose,
        revokeAll: true,
        revokeAt: nowIso,
        tokenId: candidate.id,
      }),
    );
    const consumed = await this.#database.batch(consumptionStatements);

    if (
      consumed[0]?.meta.changes !== 1 ||
      (grantConsumptionIndex !== null &&
        consumed[grantConsumptionIndex]?.meta.changes !== 1)
    ) {
      throw await this.#invalidMagicLink(tokenHash, nowIso, false);
    }

    if (
      candidate.purpose === "portal" &&
      !(await this.#scopeRemainsEligible(candidate))
    ) {
      await this.#revokePortalCandidate(candidate, tokenHash, nowIso);
      throw await this.#invalidMagicLink(tokenHash, nowIso, true);
    }

    let session: CreatedSession;
    try {
      session = await this.#createSession(
        {
          displayName: candidate.display_name,
          email: candidate.email_normalized,
          id: candidate.user_id,
        },
        metadata,
        currentSessionToken,
        now,
      );
    } catch (error) {
      const rollback = [
        this.#database
          .prepare(
            `UPDATE magic_link_tokens
             SET consumed_at = NULL, delivery_state = ?4
             WHERE id = ?1 AND token_hash = ?2 AND consumed_at = ?3
               AND revoked_at IS NULL`,
          )
          .bind(candidate.id, tokenHash, nowIso, candidate.delivery_state),
      ];
      if (candidate.purpose === "portal") {
        rollback.push(
          this.#database
            .prepare(
              `UPDATE portal_grants
               SET consumed_at = NULL
               WHERE id = ?1 AND token_hash = ?2 AND consumed_at = ?3
                 AND revoked_at IS NULL`,
            )
            .bind(candidate.id, tokenHash, nowIso),
        );
      }
      await this.#database.batch(rollback);
      throw error;
    }

    if (candidate.purpose === "portal") {
      await this.#recordPortalRedemption(candidate, nowIso);
    }

    return { ...session, redirectPath: candidate.redirect_path };
  }

  async authenticate(
    sessionToken: string | null,
  ): Promise<AuthenticatedSession> {
    if (!sessionToken) {
      throw new AuthError("invalid_session", "Authentication is required.");
    }

    const nowIso = this.#now().toISOString();
    const tokenHash = await sha256Hex(sessionToken);
    const row = await this.#database
      .prepare(
        `SELECT
          session.id,
          session.user_id,
          session.token_hash,
          session.expires_at,
          session.last_seen_at,
          secret.csrf_token_hash,
          user.email_normalized,
          user.display_name
         FROM auth_sessions session
         JOIN auth_session_secrets secret ON secret.session_id = session.id
         JOIN users user ON user.id = session.user_id AND user.status = 'active'
         WHERE session.token_hash = ?1
           AND session.expires_at > ?2
           AND session.revoked_at IS NULL
         LIMIT 1`,
      )
      .bind(tokenHash, nowIso)
      .first<SessionRow>();

    if (!row) {
      throw new AuthError("invalid_session", "Authentication is required.");
    }

    const lastSeenAt = Date.parse(row.last_seen_at);
    if (
      !Number.isFinite(lastSeenAt) ||
      lastSeenAt + 5 * 60 * 1000 <= Date.parse(nowIso)
    ) {
      await this.#database
        .prepare(
          `UPDATE auth_sessions
           SET last_seen_at = ?1
           WHERE id = ?2 AND revoked_at IS NULL`,
        )
        .bind(nowIso, row.id)
        .run();
    }

    return {
      csrfTokenHash: row.csrf_token_hash,
      expiresAt: row.expires_at,
      id: row.id,
      tokenHash: row.token_hash,
      user: {
        displayName: row.display_name,
        email: row.email_normalized,
        id: row.user_id,
      },
    };
  }

  async verifyCsrf(
    session: AuthenticatedSession,
    csrfToken: string | null,
  ): Promise<void> {
    const candidateHash = await sha256Hex(csrfToken ?? "");
    if (
      !csrfToken ||
      !constantTimeEqual(candidateHash, session.csrfTokenHash)
    ) {
      throw new AuthError("invalid_csrf", "The request could not be verified.");
    }
  }

  async rotateSession(
    session: AuthenticatedSession,
    metadata: AuthRequestMetadata,
    currentSessionToken: string,
  ): Promise<CreatedSession> {
    return this.#createSession(
      session.user,
      metadata,
      currentSessionToken,
      this.#now(),
    );
  }

  async logout(session: AuthenticatedSession): Promise<void> {
    const nowIso = this.#now().toISOString();
    await this.#database
      .prepare(
        `UPDATE auth_sessions
         SET revoked_at = ?1
         WHERE id = ?2 AND revoked_at IS NULL`,
      )
      .bind(nowIso, session.id)
      .run();
  }

  async scopedAccess(
    session: AuthenticatedSession,
    scope: {
      eventId: string;
      organizationId: string;
      sessionId: string | null;
    },
  ): Promise<ScopedSessionAccess> {
    const access = await loadEventAccess(
      this.#database,
      session.user,
      scope.organizationId,
      scope.eventId,
    );
    const sessionAccess = scope.sessionId
      ? await canReadSession(
          this.#database,
          access,
          scope.organizationId,
          scope.eventId,
          scope.sessionId,
        )
      : null;

    return { access, canReadSession: sessionAccess };
  }

  async #createSession(
    user: AuthenticatedSession["user"],
    metadata: AuthRequestMetadata,
    currentSessionToken: string | null,
    now: Date,
  ): Promise<CreatedSession> {
    const sessionToken = this.#tokenFactory();
    const csrfToken = this.#tokenFactory();
    const [
      sessionTokenHash,
      csrfTokenHash,
      currentTokenHash,
      ipHash,
      userAgentHash,
    ] = await Promise.all([
      sha256Hex(sessionToken),
      sha256Hex(csrfToken),
      currentSessionToken ? sha256Hex(currentSessionToken) : null,
      metadata.ipAddress
        ? fingerprint(metadata.ipAddress, this.#hashPepper, "session-ip")
        : null,
      metadata.userAgent
        ? fingerprint(metadata.userAgent, this.#hashPepper, "user-agent")
        : null,
    ]);
    const id = crypto.randomUUID();
    const nowIso = now.toISOString();
    const expiresAt = isoAt(now, sessionLifetimeMs);
    const statements: D1PreparedStatement[] = [];

    if (currentTokenHash) {
      statements.push(
        this.#database
          .prepare(
            `UPDATE auth_sessions
             SET rotated_at = ?1, revoked_at = ?1
             WHERE user_id = ?2
               AND token_hash = ?3
               AND revoked_at IS NULL`,
          )
          .bind(nowIso, user.id, currentTokenHash),
      );
    }

    statements.push(
      this.#database
        .prepare(
          `INSERT INTO auth_sessions
            (id, user_id, token_hash, created_at, expires_at, last_seen_at,
             ip_hash, user_agent_hash)
           VALUES (?1, ?2, ?3, ?4, ?5, ?4, ?6, ?7)`,
        )
        .bind(
          id,
          user.id,
          sessionTokenHash,
          nowIso,
          expiresAt,
          ipHash,
          userAgentHash,
        ),
      this.#database
        .prepare(
          `INSERT INTO auth_session_secrets
            (session_id, csrf_token_hash, created_at)
           VALUES (?1, ?2, ?3)`,
        )
        .bind(id, csrfTokenHash, nowIso),
    );

    await this.#database.batch(statements);

    return {
      csrfToken,
      csrfTokenHash,
      expiresAt,
      id,
      sessionToken,
      tokenHash: sessionTokenHash,
      user,
    };
  }

  async #finalizeQueuedMagicLink(options: {
    commandId: string | null;
    contactId: string | null;
    createdAt: string;
    email: string;
    eventId: string | null;
    invitationKind: "acceptance" | "recovery";
    now: Date;
    organizationId: string | null;
    purpose: "portal" | "sign_in";
    requestId: string;
    tokenId: string;
  }): Promise<boolean> {
    const nowIso = options.now.toISOString();
    const statements: D1PreparedStatement[] = [];
    const scopedPortal =
      options.purpose === "portal" &&
      options.organizationId !== null &&
      options.eventId !== null &&
      options.contactId !== null;
    if (options.purpose === "portal" && !scopedPortal) return false;

    if (scopedPortal) {
      statements.push(
        this.#database
          .prepare(
            `UPDATE portal_grants
             SET revoked_at = ?1
             WHERE organization_id = ?2
               AND event_id = ?3
               AND contact_id = ?4
               AND id != ?5
               AND consumed_at IS NULL
               AND revoked_at IS NULL
               AND (
                 created_at < ?6
                 OR (created_at = ?6 AND id < ?5)
               )
               AND EXISTS (
                 SELECT 1
                 FROM magic_link_tokens replacement
                 JOIN magic_link_scopes replacement_scope
                   ON replacement_scope.token_id = replacement.id
                 WHERE replacement.id = ?5
                   AND replacement.delivery_state = 'queued'
                   AND replacement.consumed_at IS NULL
                   AND replacement.revoked_at IS NULL
                   AND replacement_scope.organization_id = ?2
                   AND replacement_scope.event_id = ?3
                   AND replacement_scope.contact_id = ?4
               )`,
          )
          .bind(
            nowIso,
            options.organizationId,
            options.eventId,
            options.contactId,
            options.tokenId,
            options.createdAt,
          ),
        this.#database
          .prepare(
            `INSERT OR IGNORE INTO portal_grants (
               id, organization_id, event_id, contact_id, token_hash,
               created_at, expires_at
             )
             SELECT link.id, scope.organization_id, scope.event_id,
                    scope.contact_id, link.token_hash, link.created_at,
                    link.expires_at
             FROM magic_link_tokens link
             JOIN magic_link_scopes scope ON scope.token_id = link.id
             WHERE link.id = ?1
               AND link.delivery_state = 'queued'
               AND link.consumed_at IS NULL
               AND link.revoked_at IS NULL
               AND scope.organization_id = ?2
               AND scope.event_id = ?3
               AND scope.contact_id = ?4
               AND NOT EXISTS (
                 SELECT 1
                 FROM portal_grants newer
                 WHERE newer.organization_id = scope.organization_id
                   AND newer.event_id = scope.event_id
                   AND newer.contact_id = scope.contact_id
                   AND newer.consumed_at IS NULL
                   AND newer.revoked_at IS NULL
                   AND (
                     newer.created_at > link.created_at
                     OR (newer.created_at = link.created_at AND newer.id > link.id)
                   )
               )`,
          )
          .bind(
            options.tokenId,
            options.organizationId,
            options.eventId,
            options.contactId,
          ),
        this.#database
          .prepare(
            `UPDATE magic_link_tokens
             SET revoked_at = ?1
             WHERE id = ?2
               AND delivery_state = 'queued'
               AND consumed_at IS NULL
               AND revoked_at IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM portal_grants current_grant
                 WHERE current_grant.id = ?2
               )
               AND EXISTS (
                 SELECT 1
                 FROM magic_link_scopes scope
                 JOIN portal_grants newer
                   ON newer.organization_id = scope.organization_id
                  AND newer.event_id = scope.event_id
                  AND newer.contact_id = scope.contact_id
                  AND newer.consumed_at IS NULL
                  AND newer.revoked_at IS NULL
                 JOIN magic_link_tokens current_link ON current_link.id = ?2
                 WHERE scope.token_id = ?2
                   AND (
                     newer.created_at > current_link.created_at
                     OR (
                       newer.created_at = current_link.created_at
                       AND newer.id > current_link.id
                     )
                   )
               )`,
          )
          .bind(nowIso, options.tokenId),
        this.#database
          .prepare(
            `INSERT OR IGNORE INTO audit_events (
               id, organization_id, event_id, actor_type, actor_id, action,
               entity_type, entity_id, request_id, command_id,
               redaction_version, safe_diff_json, metadata_json, created_at
             )
             SELECT ?1, grant.organization_id, grant.event_id, 'system', NULL,
                    'portal.invitation.issued', 'portal_grant', grant.id, ?2,
                    ?3, 1, '{"state":"issued"}', ?4, ?5
             FROM portal_grants grant
             WHERE grant.id = ?6`,
          )
          .bind(
            `aud_${options.tokenId}`,
            options.requestId,
            options.commandId,
            JSON.stringify({
              invitation_kind: options.invitationKind,
              version: 1,
            }),
            nowIso,
            options.tokenId,
          ),
      );
    }

    statements.push(
      this.#supersessionStatement({
        createdAt: options.createdAt,
        email: options.email,
        eventId: options.eventId,
        organizationId: options.organizationId,
        purpose: options.purpose,
        revokeAll: false,
        revokeAt: nowIso,
        tokenId: options.tokenId,
      }),
      durableOperationalEventStatement(
        this.#database,
        {
          attempt: 1,
          dedupe_key: `email:${options.tokenId}:queued`,
          delivery_id: options.tokenId,
          event: "email.magic_link.queued",
          outcome: "accepted",
          queue: "email_send",
          request_id: options.requestId,
          ...(options.organizationId
            ? { organization_id: options.organizationId }
            : {}),
          ...(options.eventId ? { event_id: options.eventId } : {}),
        },
        options.now,
      ),
    );
    await this.#database.batch(statements);

    if (!scopedPortal) {
      const queued = await this.#database
        .prepare(
          `SELECT 1 AS valid
           FROM magic_link_tokens
           WHERE id = ?1 AND delivery_state = 'queued'
             AND consumed_at IS NULL AND revoked_at IS NULL`,
        )
        .bind(options.tokenId)
        .first<{ valid: number }>();
      return queued?.valid === 1;
    }
    const finalized = await this.#database
      .prepare(
        `SELECT 1 AS valid
         FROM magic_link_tokens link
         WHERE link.id = ?1
           AND (
             EXISTS (
               SELECT 1 FROM portal_grants grant
               WHERE grant.id = link.id
                 AND grant.consumed_at IS NULL
                 AND grant.revoked_at IS NULL
             )
             OR (
               link.revoked_at IS NOT NULL
               AND EXISTS (
                 SELECT 1
                 FROM magic_link_scopes scope
                 JOIN portal_grants newer
                   ON newer.organization_id = scope.organization_id
                  AND newer.event_id = scope.event_id
                  AND newer.contact_id = scope.contact_id
                  AND newer.consumed_at IS NULL
                  AND newer.revoked_at IS NULL
                 WHERE scope.token_id = link.id
                   AND (
                     newer.created_at > link.created_at
                     OR (newer.created_at = link.created_at AND newer.id > link.id)
                   )
               )
             )
           )`,
      )
      .bind(options.tokenId)
      .first<{ valid: number }>();
    return finalized?.valid === 1;
  }

  #supersessionStatement(options: {
    consumedAt?: string | null;
    createdAt: string;
    email: string;
    eventId: string | null;
    organizationId: string | null;
    purpose: "portal" | "sign_in";
    revokeAll: boolean;
    revokeAt: string;
    tokenId: string;
  }): D1PreparedStatement {
    const scoped = options.organizationId !== null && options.eventId !== null;
    if ((options.organizationId === null) !== (options.eventId === null)) {
      throw new Error("A magic-link scope must be complete.");
    }
    const scopeFilter = scoped
      ? `AND EXISTS (
          SELECT 1 FROM magic_link_scopes existing_scope
          WHERE existing_scope.token_id = magic_link_tokens.id
            AND existing_scope.organization_id = ?6
            AND existing_scope.event_id = ?7
        )`
      : `AND NOT EXISTS (
          SELECT 1 FROM magic_link_scopes existing_scope
          WHERE existing_scope.token_id = magic_link_tokens.id
        )`;
    const orderFilter = options.revokeAll
      ? ""
      : `AND (
           created_at < ?5
           OR (created_at = ?5 AND id < ?2)
         )`;
    const statement = this.#database.prepare(
      `UPDATE magic_link_tokens
       SET revoked_at = ?1
       WHERE id != ?2
         AND email_normalized = ?3 COLLATE NOCASE
         AND purpose = ?4
         ${orderFilter}
         AND delivery_state IN ('pending', 'queued')
         AND consumed_at IS NULL
         AND revoked_at IS NULL
         AND EXISTS (
           SELECT 1
           FROM magic_link_tokens replacement
           WHERE replacement.id = ?2
             AND replacement.delivery_state = 'queued'
             AND replacement.revoked_at IS NULL
             AND (
               (?8 IS NULL AND replacement.consumed_at IS NULL)
               OR replacement.consumed_at = ?8
             )
         )
         ${scopeFilter}`,
    );

    return scoped
      ? statement.bind(
          options.revokeAt,
          options.tokenId,
          options.email,
          options.purpose,
          options.createdAt,
          options.organizationId,
          options.eventId,
          options.consumedAt ?? null,
        )
      : statement.bind(
          options.revokeAt,
          options.tokenId,
          options.email,
          options.purpose,
          options.createdAt,
          null,
          null,
          options.consumedAt ?? null,
        );
  }

  async #recordPortalInvitationIdempotency(
    command: PortalInvitationCommand,
    operation: string,
    requestHash: string,
    result: MagicLinkRequestResult,
  ): Promise<void> {
    const now = this.#now();
    const repairable = result.outcome === "finalization_failed";
    const updated = await this.#database
      .prepare(
        `UPDATE idempotency_keys
         SET status = ?1,
             entity_id = COALESCE(entity_id, ?2),
             original_response_status = ?3,
             original_response_json = ?4,
             lease_owner = NULL,
             lease_expires_at = NULL,
             updated_at = ?5,
             expires_at = ?6
         WHERE tenant_key = ?7
           AND operation = ?8
           AND command_id = ?9
           AND request_hash = ?10`,
      )
      .bind(
        repairable ? "unknown" : "committed",
        result.deliveryId,
        repairable ? null : 202,
        repairable ? null : JSON.stringify(result),
        now.toISOString(),
        isoAt(now, idempotencyLifetimeMs),
        command.organizationId,
        operation,
        command.commandId,
        requestHash,
      )
      .run();
    if (updated.meta.changes !== 1) {
      const replay = await this.#loadPortalInvitationIdempotency(
        command,
        operation,
      );
      if (replay?.request_hash !== requestHash) {
        throw new Error("The invitation command reservation was replaced.");
      }
    }
  }

  async #loadPortalInvitationIdempotency(
    command: PortalInvitationCommand,
    operation: string,
  ): Promise<PortalInvitationIdempotencyRow | null> {
    return this.#database
      .prepare(
        `SELECT entity_id, lease_expires_at, lease_owner,
                original_response_json, request_hash, status
         FROM idempotency_keys
         WHERE tenant_key = ?1 AND operation = ?2 AND command_id = ?3`,
      )
      .bind(command.organizationId, operation, command.commandId)
      .first<PortalInvitationIdempotencyRow>();
  }

  async #claimOrphanPortalInvitation(
    command: PortalInvitationCommand,
    replay: PortalInvitationIdempotencyRow,
    requestHash: string,
    requestId: string,
    operation: string,
  ): Promise<boolean> {
    if (
      replay.original_response_json ||
      !replay.entity_id ||
      (replay.lease_expires_at !== null &&
        Date.parse(replay.lease_expires_at) > this.#now().getTime())
    ) {
      return false;
    }
    const now = this.#now();
    const claimed = await this.#database
      .prepare(
        `UPDATE idempotency_keys
         SET status = 'pending', lease_owner = ?1, lease_expires_at = ?2,
             updated_at = ?3
         WHERE tenant_key = ?4
           AND operation = ?5
           AND command_id = ?6
           AND request_hash = ?7
           AND original_response_json IS NULL
           AND (lease_expires_at IS NULL OR lease_expires_at <= ?3)
           AND NOT EXISTS (
             SELECT 1 FROM magic_link_tokens delivery
             WHERE delivery.id = idempotency_keys.entity_id
           )`,
      )
      .bind(
        requestId,
        isoAt(now, invitationLeaseMs),
        now.toISOString(),
        command.organizationId,
        operation,
        command.commandId,
        requestHash,
      )
      .run();
    return claimed.meta.changes === 1;
  }

  #parsePortalInvitationReplay(responseJson: string): MagicLinkRequestResult {
    const response = JSON.parse(responseJson) as {
      deliveryId?: unknown;
      outcome?: unknown;
    };
    if (
      (typeof response.deliveryId === "string" ||
        response.deliveryId === null) &&
      [
        "delivery_cleanup_failed",
        "delivery_failed",
        "finalization_failed",
        "queued",
        "suppressed",
      ].includes(String(response.outcome))
    ) {
      return response as MagicLinkRequestResult;
    }
    throw new Error("The stored invitation response is invalid.");
  }

  async #portalInvitationDelivery(
    deliveryId: string,
  ): Promise<PortalInvitationDeliveryRow | null> {
    return this.#database
      .prepare(
        `SELECT link.email_normalized, link.purpose, link.redirect_path,
                link.created_at, link.delivery_state, scope.organization_id,
                scope.event_id, scope.contact_id
         FROM magic_link_tokens link
         LEFT JOIN magic_link_scopes scope ON scope.token_id = link.id
         WHERE link.id = ?1
         LIMIT 1`,
      )
      .bind(deliveryId)
      .first<PortalInvitationDeliveryRow>();
  }

  async #repairPortalInvitationDelivery(
    delivery: PortalInvitationDeliveryRow,
    deliveryId: string,
    commandId: string,
    requestId: string,
  ): Promise<MagicLinkRequestResult> {
    if (delivery.delivery_state === "failed") {
      return { deliveryId, outcome: "delivery_failed" };
    }
    if (
      delivery.delivery_state !== "queued" ||
      delivery.purpose !== "portal" ||
      !delivery.organization_id ||
      !delivery.event_id ||
      !delivery.contact_id
    ) {
      return { deliveryId, outcome: "finalization_failed" };
    }
    try {
      const finalized = await this.#finalizeQueuedMagicLink({
        commandId,
        contactId: delivery.contact_id,
        createdAt: delivery.created_at,
        email: delivery.email_normalized,
        eventId: delivery.event_id,
        invitationKind: "acceptance",
        now: this.#now(),
        organizationId: delivery.organization_id,
        purpose: "portal",
        requestId,
        tokenId: deliveryId,
      });
      return {
        deliveryId,
        outcome: finalized ? "queued" : "finalization_failed",
      };
    } catch {
      return { deliveryId, outcome: "finalization_failed" };
    }
  }

  async #replayPortalInvitation(
    command: PortalInvitationCommand,
    initial: PortalInvitationIdempotencyRow,
    requestId: string,
    operation: string,
  ): Promise<MagicLinkRequestResult> {
    let replay = initial;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (replay.original_response_json) {
        return this.#parsePortalInvitationReplay(replay.original_response_json);
      }
      if (replay.entity_id) {
        const delivery = await this.#portalInvitationDelivery(replay.entity_id);
        if (delivery && delivery.delivery_state !== "pending") {
          const result = await this.#repairPortalInvitationDelivery(
            delivery,
            replay.entity_id,
            command.commandId,
            requestId,
          );
          await this.#recordPortalInvitationIdempotency(
            command,
            operation,
            replay.request_hash,
            result,
          );
          return result;
        }
      }
      if (attempt < 49) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        replay =
          (await this.#loadPortalInvitationIdempotency(command, operation)) ??
          replay;
      }
    }
    return {
      deliveryId: replay.entity_id,
      outcome: "finalization_failed",
    };
  }

  async #eligibleIdentity(
    request: MagicLinkRequest,
    email: string,
    nowIso: string,
    registerUnprivilegedUser: boolean,
  ): Promise<{ contactId: string | null; userId: string } | null> {
    if (request.purpose === "portal") {
      if (registerUnprivilegedUser) {
        await this.#database
          .prepare(
            `INSERT INTO users (
               id, email_normalized, display_name, created_at, updated_at
             )
             SELECT ?4, contact.email_normalized, contact.display_name, ?5, ?5
             FROM tenant_registry tenant_scope
             JOIN p_contacts contact
               ON contact.organization_id = tenant_scope.organization_id
              AND contact.email_normalized = ?3 COLLATE NOCASE
              AND contact.source_deleted_at IS NULL
             JOIN p_event_contacts event_contact
               ON event_contact.organization_id = contact.organization_id
              AND event_contact.event_id = ?2
              AND event_contact.contact_id = contact.id
              AND event_contact.portal_state IN ('invited', 'active')
              AND event_contact.source_deleted_at IS NULL
             JOIN p_events event_scope
               ON event_scope.organization_id = event_contact.organization_id
              AND event_scope.id = event_contact.event_id
              AND event_scope.source_deleted_at IS NULL
             WHERE tenant_scope.organization_id = ?1
               AND tenant_scope.status = 'active'
               AND tenant_scope.authority_ready_at IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM json_each(event_contact.roles_json)
                 WHERE json_each.value = 'speaker'
               )
             LIMIT 1
             ON CONFLICT(email_normalized) DO NOTHING`,
          )
          .bind(
            request.organization_id,
            request.event_id,
            email,
            `usr_${crypto.randomUUID().replaceAll("-", "")}`,
            nowIso,
          )
          .run();
      }
      const identity = await this.#database
        .prepare(
          `SELECT user.id AS user_id, contact.id AS contact_id
           FROM users user
           JOIN tenant_registry tenant_scope
             ON tenant_scope.organization_id = ?1
            AND tenant_scope.status = 'active'
            AND tenant_scope.authority_ready_at IS NOT NULL
           JOIN p_contacts contact
             ON contact.organization_id = ?1
            AND contact.source_deleted_at IS NULL
           JOIN p_event_contacts event_contact
             ON event_contact.organization_id = contact.organization_id
            AND event_contact.event_id = ?2
            AND event_contact.contact_id = contact.id
            AND event_contact.portal_state IN ('invited', 'active')
            AND event_contact.source_deleted_at IS NULL
           WHERE user.email_normalized = ?3 COLLATE NOCASE
             AND user.status = 'active'
             AND (
               contact.email_normalized = user.email_normalized COLLATE NOCASE
               OR EXISTS (
                 SELECT 1 FROM event_contact_identity_bindings binding
                 WHERE binding.organization_id = contact.organization_id
                   AND binding.event_id = event_contact.event_id
                   AND binding.contact_id = contact.id
                   AND binding.user_id = user.id
                   AND binding.relationship_role = 'speaker'
                   AND binding.revoked_at IS NULL
               )
             )
             AND EXISTS (
               SELECT 1 FROM json_each(event_contact.roles_json)
               WHERE json_each.value = 'speaker'
             )
           LIMIT 1`,
        )
        .bind(request.organization_id, request.event_id, email)
        .first<{ contact_id: string; user_id: string }>();

      return identity
        ? { contactId: identity.contact_id, userId: identity.user_id }
        : null;
    }

    if (registerUnprivilegedUser) {
      await this.#database
        .prepare(
          `INSERT INTO users
            (id, email_normalized, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?3)
           ON CONFLICT(email_normalized) DO NOTHING`,
        )
        .bind(`usr_${crypto.randomUUID().replaceAll("-", "")}`, email, nowIso)
        .run();
    }

    const identity = await this.#database
      .prepare(
        `SELECT id AS user_id
         FROM users
         WHERE email_normalized = ?1 COLLATE NOCASE
           AND status = 'active'
         LIMIT 1`,
      )
      .bind(email)
      .first<{ user_id: string }>();

    return identity ? { contactId: null, userId: identity.user_id } : null;
  }

  async #invalidMagicLink(
    tokenHash: string,
    nowIso: string,
    includeActiveRecovery: boolean,
  ): Promise<AuthError> {
    const recovery = await this.#portalRecovery(
      tokenHash,
      nowIso,
      includeActiveRecovery,
    );
    return new AuthError(
      "invalid_magic_link",
      recovery
        ? "This speaker invitation is no longer available."
        : "This sign-in link is invalid or has expired.",
      recovery,
    );
  }

  async #portalRecovery(
    tokenHash: string,
    nowIso: string,
    includeActive: boolean,
  ): Promise<SpeakerPortalInvitationRecovery | null> {
    const row = await this.#database
      .prepare(
        `SELECT link.email_normalized,
                link.expires_at AS link_expires_at,
                link.consumed_at AS link_consumed_at,
                link.revoked_at AS link_revoked_at,
                grant.expires_at AS grant_expires_at,
                grant.consumed_at AS grant_consumed_at,
                grant.revoked_at AS grant_revoked_at,
                event.name AS event_name, event.slug AS event_slug,
                event.brand_json, event.source_deleted_at AS event_deleted_at,
                contact.source_deleted_at AS contact_deleted_at,
                tenant.status AS tenant_status,
                event_contact.portal_state,
                event_contact.source_deleted_at AS relationship_deleted_at
         FROM magic_link_tokens link
         JOIN portal_grants grant
           ON grant.id = link.id AND grant.token_hash = link.token_hash
         JOIN p_events event
           ON event.organization_id = grant.organization_id
          AND event.id = grant.event_id
         JOIN p_contacts contact
           ON contact.organization_id = grant.organization_id
          AND contact.id = grant.contact_id
         JOIN tenant_registry tenant
           ON tenant.organization_id = grant.organization_id
         LEFT JOIN p_event_contacts event_contact
           ON event_contact.organization_id = grant.organization_id
          AND event_contact.event_id = grant.event_id
          AND event_contact.contact_id = grant.contact_id
         WHERE link.token_hash = ?1
           AND link.purpose = 'portal'
         LIMIT 1`,
      )
      .bind(tokenHash)
      .first<PortalRecoveryRow>();
    if (!row) return null;

    const relationshipInactive =
      row.tenant_status !== "active" ||
      row.event_deleted_at !== null ||
      row.contact_deleted_at !== null ||
      row.relationship_deleted_at !== null ||
      (row.portal_state !== "active" && row.portal_state !== "invited");
    const reason = relationshipInactive
      ? "revoked"
      : row.grant_consumed_at !== null || row.link_consumed_at !== null
        ? "redeemed"
        : row.grant_expires_at <= nowIso || row.link_expires_at <= nowIso
          ? "expired"
          : row.grant_revoked_at !== null || row.link_revoked_at !== null
            ? "revoked"
            : includeActive
              ? "revoked"
              : null;
    if (!reason) return null;

    return speakerPortalInvitationRecoverySchema.parse({
      email_hint: maskedEmail(row.email_normalized),
      event: {
        brand: safeSpeakerPortalBrand(row.brand_json),
        name: row.event_name,
        slug: row.event_slug,
      },
      reason,
    });
  }

  async #revokePortalCandidate(
    candidate: MagicLinkCandidate,
    tokenHash: string,
    nowIso: string,
  ): Promise<void> {
    if (
      !candidate.organization_id ||
      !candidate.event_id ||
      !candidate.contact_id ||
      !candidate.portal_grant_id
    ) {
      return;
    }
    await this.#database.batch([
      this.#database
        .prepare(
          `UPDATE magic_link_tokens
           SET revoked_at = COALESCE(revoked_at, ?1)
           WHERE id = ?2 AND token_hash = ?3`,
        )
        .bind(nowIso, candidate.id, tokenHash),
      this.#database
        .prepare(
          `UPDATE portal_grants
           SET revoked_at = COALESCE(revoked_at, ?1)
           WHERE id = ?2 AND token_hash = ?3`,
        )
        .bind(nowIso, candidate.id, tokenHash),
    ]);
    try {
      await this.#database
        .prepare(
          `INSERT OR IGNORE INTO audit_events (
             id, organization_id, event_id, actor_type, actor_id, action,
             entity_type, entity_id, request_id, redaction_version,
             safe_diff_json, metadata_json, created_at
           ) VALUES (?1, ?2, ?3, 'system', NULL,
                     'portal.invitation.revoked', 'portal_grant', ?4, ?5, 1,
                     '{"state":"revoked"}', '{"reason":"speaker_relationship_inactive","version":1}', ?6)`,
        )
        .bind(
          `aud_${candidate.id}_revoked`,
          candidate.organization_id,
          candidate.event_id,
          candidate.portal_grant_id,
          `auth_${candidate.id}`,
          nowIso,
        )
        .run();
    } catch {
      // Revocation remains authoritative when operational audit storage is unavailable.
    }
  }

  async #recordPortalRedemption(
    candidate: MagicLinkCandidate,
    nowIso: string,
  ): Promise<void> {
    if (
      !candidate.organization_id ||
      !candidate.event_id ||
      !candidate.contact_id ||
      !candidate.portal_grant_id
    ) {
      return;
    }
    try {
      await this.#database
        .prepare(
          `INSERT OR IGNORE INTO audit_events (
             id, organization_id, event_id, actor_type, actor_id, action,
             entity_type, entity_id, request_id, redaction_version,
             safe_diff_json, metadata_json, created_at
           ) VALUES (?1, ?2, ?3, 'portal', ?4,
                     'portal.invitation.redeemed', 'portal_grant', ?5, ?6, 1,
                     '{"state":"redeemed"}', '{"version":1}', ?7)`,
        )
        .bind(
          `aud_${candidate.id}_redeemed`,
          candidate.organization_id,
          candidate.event_id,
          candidate.contact_id,
          candidate.portal_grant_id,
          `auth_${candidate.id}`,
          nowIso,
        )
        .run();
    } catch {
      // The completed session remains usable when operational audit storage is unavailable.
    }
  }

  async #scopeRemainsEligible(candidate: MagicLinkCandidate): Promise<boolean> {
    if (candidate.purpose === "sign_in") {
      return true;
    }

    if (
      !candidate.organization_id ||
      !candidate.event_id ||
      !candidate.contact_id
    ) {
      return false;
    }

    const relationship = await this.#database
      .prepare(
        `SELECT 1 AS eligible
         FROM p_contacts contact
         JOIN tenant_registry tenant_scope
           ON tenant_scope.organization_id = contact.organization_id
          AND tenant_scope.status = 'active'
          AND tenant_scope.authority_ready_at IS NOT NULL
         JOIN p_event_contacts event_contact
           ON event_contact.organization_id = contact.organization_id
          AND event_contact.event_id = ?2
          AND event_contact.contact_id = contact.id
          AND event_contact.portal_state IN ('invited', 'active')
          AND event_contact.source_deleted_at IS NULL
         JOIN p_events event_scope
           ON event_scope.organization_id = event_contact.organization_id
          AND event_scope.id = event_contact.event_id
          AND event_scope.source_deleted_at IS NULL
         WHERE contact.organization_id = ?1
           AND contact.id = ?3
           AND (
             contact.email_normalized = ?4 COLLATE NOCASE
             OR EXISTS (
               SELECT 1 FROM event_contact_identity_bindings binding
               WHERE binding.organization_id = contact.organization_id
                 AND binding.event_id = event_contact.event_id
                 AND binding.contact_id = contact.id
                 AND binding.user_id = ?5
                 AND binding.relationship_role = 'speaker'
                 AND binding.revoked_at IS NULL
             )
           )
           AND contact.source_deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM json_each(event_contact.roles_json)
             WHERE json_each.value = 'speaker'
           )
         LIMIT 1`,
      )
      .bind(
        candidate.organization_id,
        candidate.event_id,
        candidate.contact_id,
        candidate.email_normalized,
        candidate.user_id,
      )
      .first<{ eligible: number }>();

    return relationship?.eligible === 1;
  }

  async #isRequestThrottled(
    email: string,
    metadata: AuthRequestMetadata,
    now: Date,
  ): Promise<boolean> {
    if (metadata.ipAddress) {
      const ipKey: ThrottleKey = {
        dimension: "ip",
        hash: await fingerprint(
          metadata.ipAddress,
          this.#hashPepper,
          "magic-link-ip",
        ),
        limit: ipRequestLimit,
      };
      if (
        (await this.#hasActiveRequestBlock(ipKey, now)) ||
        (await this.#recordRequest(ipKey, now))
      ) {
        return true;
      }
    }

    const emailKey: ThrottleKey = {
      dimension: "email",
      hash: await fingerprint(email, this.#hashPepper, "magic-link-email"),
      limit: emailRequestLimit,
    };
    return (
      (await this.#hasActiveRequestBlock(emailKey, now)) ||
      (await this.#recordRequest(emailKey, now))
    );
  }

  async #hasActiveRequestBlock(key: ThrottleKey, now: Date): Promise<boolean> {
    const nowIso = now.toISOString();
    const row = await this.#database
      .prepare(
        `SELECT 1 AS blocked
         FROM magic_link_request_limits
         WHERE dimension = ?1
           AND key_hash = ?2
           AND blocked_until > ?3
         LIMIT 1`,
      )
      .bind(key.dimension, key.hash, nowIso)
      .first<{ blocked: number }>();

    return row?.blocked === 1;
  }

  async #recordRequest(key: ThrottleKey, now: Date): Promise<boolean> {
    const nowIso = now.toISOString();
    const windowResetAt = isoAt(now, -throttleWindowMs);
    const blockUntil = isoAt(now, throttleBlockMs);
    const row = await this.#database
      .prepare(
        `INSERT INTO magic_link_request_limits
          (dimension, key_hash, window_started_at, request_count,
           blocked_until, updated_at)
         VALUES (?1, ?2, ?3, 1, NULL, ?3)
         ON CONFLICT (dimension, key_hash) DO UPDATE SET
           window_started_at = CASE
             WHEN magic_link_request_limits.blocked_until <= ?3
               OR magic_link_request_limits.window_started_at <= ?4
             THEN ?3
             ELSE magic_link_request_limits.window_started_at
           END,
           request_count = CASE
             WHEN magic_link_request_limits.blocked_until <= ?3
               OR magic_link_request_limits.window_started_at <= ?4
             THEN 1
             ELSE magic_link_request_limits.request_count + 1
           END,
           blocked_until = CASE
             WHEN magic_link_request_limits.blocked_until > ?3
             THEN magic_link_request_limits.blocked_until
             WHEN magic_link_request_limits.blocked_until IS NOT NULL
               AND magic_link_request_limits.blocked_until <= ?3
             THEN NULL
             WHEN magic_link_request_limits.window_started_at > ?4
               AND magic_link_request_limits.request_count + 1 > ?5
             THEN ?6
             ELSE NULL
           END,
           updated_at = ?3
         RETURNING blocked_until`,
      )
      .bind(
        key.dimension,
        key.hash,
        nowIso,
        windowResetAt,
        key.limit,
        blockUntil,
      )
      .first<ThrottleRow>();

    return row?.blocked_until ? row.blocked_until > nowIso : false;
  }
}
