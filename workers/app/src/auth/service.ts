import type { MagicLinkRequest } from "@sessionbox-killer/contracts";

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

const magicLinkLifetimeMs = 15 * 60 * 1000;
const sessionLifetimeMs = 12 * 60 * 60 * 1000;
const throttleWindowMs = 15 * 60 * 1000;
const throttleBlockMs = 30 * 60 * 1000;
const emailRequestLimit = 3;
const ipRequestLimit = 12;

export type AuthErrorCode =
  "invalid_magic_link" | "invalid_session" | "invalid_csrf";

export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
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
  redirect_path: string;
  user_id: string;
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

  async requestMagicLink(
    request: MagicLinkRequest,
    metadata: AuthRequestMetadata,
    browserBindingToken: string,
    origin: string,
    requestId: string,
    options: MagicLinkRequestOptions = {},
  ): Promise<MagicLinkRequestResult> {
    const email = request.email.toLowerCase();
    const now = this.#now();
    const nowIso = now.toISOString();

    if (!this.#emailEnabled) {
      return { deliveryId: null, outcome: "suppressed" };
    }

    const throttled = await this.#isRequestThrottled(email, metadata, now);

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
      sha256Hex(browserBindingToken),
      sha256Hex(token),
    ]);
    const tokenId = crypto.randomUUID();
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
      const finalized = await this.#database.batch([
        this.#database
          .prepare(
            `UPDATE magic_link_tokens
             SET delivery_state = 'queued'
             WHERE id = ?1
               AND delivery_state = 'pending'
               AND consumed_at IS NULL
               AND revoked_at IS NULL`,
          )
          .bind(tokenId),
        this.#supersessionStatement({
          createdAt: nowIso,
          email,
          eventId: request.event_id ?? null,
          organizationId: request.organization_id ?? null,
          purpose: request.purpose,
          revokeAll: false,
          revokeAt: nowIso,
          tokenId,
        }),
        durableOperationalEventStatement(
          this.#database,
          {
            attempt: 1,
            dedupe_key: `email:${tokenId}:queued`,
            delivery_id: tokenId,
            event: "email.magic_link.queued",
            outcome: "accepted",
            queue: "email_send",
            request_id: requestId,
            ...(request.organization_id
              ? { organization_id: request.organization_id }
              : {}),
            ...(request.event_id ? { event_id: request.event_id } : {}),
          },
          now,
        ),
      ]);
      return {
        deliveryId: tokenId,
        outcome:
          finalized[0]?.meta.changes === 1 ? "queued" : "finalization_failed",
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
          scope.contact_id
         FROM magic_link_tokens link
         JOIN users user ON user.id = link.user_id AND user.status = 'active'
         LEFT JOIN magic_link_scopes scope ON scope.token_id = link.id
         WHERE link.token_hash = ?1
           AND link.delivery_state IN ('pending', 'queued')
           AND link.expires_at > ?2
           AND link.consumed_at IS NULL
           AND link.revoked_at IS NULL
         LIMIT 1`,
      )
      .bind(tokenHash, nowIso)
      .first<MagicLinkCandidate>();

    if (
      !candidate?.browser_binding_hash ||
      !constantTimeEqual(candidate.browser_binding_hash, browserBindingHash) ||
      !(await this.#scopeRemainsEligible(candidate))
    ) {
      throw new AuthError(
        "invalid_magic_link",
        "This sign-in link is invalid or has expired.",
      );
    }

    const consumed = await this.#database.batch([
      this.#database
        .prepare(
          `UPDATE magic_link_tokens
           SET consumed_at = ?1, delivery_state = 'queued'
           WHERE id = ?2
             AND token_hash = ?3
             AND expires_at > ?1
             AND delivery_state IN ('pending', 'queued')
             AND consumed_at IS NULL
             AND revoked_at IS NULL`,
        )
        .bind(nowIso, candidate.id, tokenHash),
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
    ]);

    if (consumed[0]?.meta.changes !== 1) {
      throw new AuthError(
        "invalid_magic_link",
        "This sign-in link is invalid or has expired.",
      );
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
      await this.#database
        .prepare(
          `UPDATE magic_link_tokens
           SET consumed_at = NULL, delivery_state = ?4
           WHERE id = ?1 AND token_hash = ?2 AND consumed_at = ?3`,
        )
        .bind(candidate.id, tokenHash, nowIso, candidate.delivery_state)
        .run();
      throw error;
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

  async #eligibleIdentity(
    request: MagicLinkRequest,
    email: string,
    nowIso: string,
    registerUnprivilegedUser: boolean,
  ): Promise<{ contactId: string | null; userId: string } | null> {
    if (request.purpose === "portal") {
      const identity = await this.#database
        .prepare(
          `SELECT user.id AS user_id, contact.id AS contact_id
           FROM users user
           JOIN tenant_registry tenant_scope
             ON tenant_scope.organization_id = ?1
            AND tenant_scope.status = 'active'
            AND tenant_scope.authority_ready_at IS NOT NULL
           JOIN p_contacts contact
             ON contact.email_normalized = user.email_normalized COLLATE NOCASE
            AND contact.organization_id = ?1
            AND contact.source_deleted_at IS NULL
           JOIN p_event_contacts event_contact
             ON event_contact.organization_id = contact.organization_id
            AND event_contact.event_id = ?2
            AND event_contact.contact_id = contact.id
            AND event_contact.portal_state IN ('invited', 'active')
            AND event_contact.source_deleted_at IS NULL
           WHERE user.email_normalized = ?3 COLLATE NOCASE
             AND user.status = 'active'
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
           AND contact.email_normalized = ?4 COLLATE NOCASE
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
