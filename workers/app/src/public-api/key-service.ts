import {
  apiKeyCreateResponseSchema,
  apiKeyListResponseSchema,
  apiKeyMetadataSchema,
  apiKeyRevokeResponseSchema,
  publicApiScopeSchema,
  type ApiKeyCreateRequest,
  type ApiKeyCreateResponse,
  type ApiKeyMetadata,
  type ApiKeyScope,
} from "@sessionbox-killer/contracts/public-api";

import { createOpaqueToken, sha256Hex } from "../auth/crypto.js";
import {
  createApiKeyMaterial,
  parseApiKey,
  verifyApiKeyVerifier,
} from "./crypto.js";

const creationLeaseMilliseconds = 30_000;
const receiptLifetimeMilliseconds = 90 * 24 * 60 * 60 * 1_000;
const maximumLifetimeMilliseconds = 2 * 365 * 24 * 60 * 60 * 1_000;
const lastUsedWriteIntervalMilliseconds = 5 * 60 * 1_000;
const dummySalt = "0".repeat(32);
const dummyVerifier = "0".repeat(64);
const saltPattern = /^[0-9a-f]{32}$/;
const verifierPattern = /^[0-9a-f]{64}$/;

interface ApiKeyRow {
  created_at: string;
  event_id: string | null;
  expires_at: string | null;
  id: string;
  last_used_at: string | null;
  name: string;
  organization_id: string;
  revoked_at: string | null;
  scopes_json: string;
  token_prefix: string;
}

interface ApiKeyVerificationRow extends ApiKeyRow {
  token_hash: string;
  verifier_salt: string | null;
}

interface CreationReceiptRow {
  entity_id: string | null;
  lease_expires_at: string | null;
  original_response_json: string | null;
  request_hash: string;
  status:
    "committed" | "committed_with_repair" | "failed" | "pending" | "unknown";
}

interface AuditReceiptRow {
  created_at: string;
  id: string;
  request_id: string;
}

export interface ApiKeyManagementAccess {
  readonly actorId: string;
  readonly canManageOrganization: boolean;
  readonly eventId: string;
  readonly organizationId: string;
  readonly requestId: string;
}

export interface AuthenticatedApiKey {
  readonly eventId: string | null;
  readonly id: string;
  readonly name: string;
  readonly organizationId: string;
  readonly prefix: string;
  readonly scopes: readonly ApiKeyScope[];
}

export class ApiKeyIdempotencyConflictError extends Error {
  constructor() {
    super("This idempotency key was already used for different input.");
    this.name = "ApiKeyIdempotencyConflictError";
  }
}

export class ApiKeyPlaintextUnavailableError extends Error {
  constructor() {
    super(
      "The API key was already created and its plaintext cannot be recovered. Revoke it and create another key if the original value was not saved.",
    );
    this.name = "ApiKeyPlaintextUnavailableError";
  }
}

export class ApiKeyCreationPendingError extends Error {
  constructor() {
    super("API key creation is already in progress for this idempotency key.");
    this.name = "ApiKeyCreationPendingError";
  }
}

export class ApiKeyNotFoundError extends Error {
  constructor() {
    super("The requested API key does not exist.");
    this.name = "ApiKeyNotFoundError";
  }
}

export class ApiKeyValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "ApiKeyValidationError";
    this.field = field;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right, "en-US"))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Value is not serializable.");
  return encoded;
}

function safeScopes(value: string): ApiKeyScope[] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    const result = publicApiScopeSchema.array().safeParse(parsed);
    return result.success && new Set(result.data).size === result.data.length
      ? result.data
      : null;
  } catch {
    return null;
  }
}

function metadata(row: ApiKeyRow, now = new Date()): ApiKeyMetadata {
  const scopes = safeScopes(row.scopes_json);
  if (!scopes) throw new Error("API key scope storage is invalid.");
  const expired =
    row.expires_at !== null && Date.parse(row.expires_at) <= now.getTime();
  return apiKeyMetadataSchema.parse({
    created_at: row.created_at,
    expires_at: row.expires_at,
    id: row.id,
    last_used_at: row.last_used_at,
    name: row.name,
    prefix: row.token_prefix,
    revoked_at: row.revoked_at,
    scope: {
      event_id: row.event_id,
      kind: row.event_id ? "event" : "organization",
      organization_id: row.organization_id,
    },
    scopes,
    state: row.revoked_at ? "revoked" : expired ? "expired" : "active",
  });
}

function auditId(): string {
  return `audit_key_${createOpaqueToken(18)}`;
}

export class ApiKeyManagementService {
  readonly #database: D1Database;
  readonly #hashPepper: string;
  readonly #now: () => Date;

  constructor(options: {
    database: D1Database;
    hashPepper: string;
    now?: () => Date;
  }) {
    if (options.hashPepper.length < 32) {
      throw new Error("AUTH_HASH_PEPPER must contain at least 32 characters.");
    }
    this.#database = options.database;
    this.#hashPepper = options.hashPepper;
    this.#now = options.now ?? (() => new Date());
  }

  async list(access: ApiKeyManagementAccess) {
    const result = await this.#database
      .prepare(
        `SELECT id, organization_id, event_id, name, token_prefix, scopes_json,
                created_at, expires_at, last_used_at, revoked_at
         FROM api_keys
         WHERE organization_id = ?1
           AND (?2 = 1 OR event_id = ?3)
         ORDER BY created_at DESC, id DESC
         LIMIT 501`,
      )
      .bind(
        access.organizationId,
        access.canManageOrganization ? 1 : 0,
        access.eventId,
      )
      .all<ApiKeyRow>();
    if (result.results.length > 500) {
      throw new Error("API key management result exceeds its safe bound.");
    }
    return apiKeyListResponseSchema.parse({
      data: result.results.map((row) => metadata(row, this.#now())),
    });
  }

  async create(
    access: ApiKeyManagementAccess,
    input: ApiKeyCreateRequest,
    idempotencyKey: string,
  ): Promise<ApiKeyCreateResponse> {
    if (input.scope === "organization" && !access.canManageOrganization) {
      throw new ApiKeyValidationError(
        "scope",
        "Organization-scoped keys require an organization owner or organizer.",
      );
    }
    const now = this.#now();
    if (input.expires_at) {
      const expiration = Date.parse(input.expires_at);
      if (
        !Number.isFinite(expiration) ||
        expiration <= now.getTime() + 5 * 60 * 1_000 ||
        expiration > now.getTime() + maximumLifetimeMilliseconds
      ) {
        throw new ApiKeyValidationError(
          "expires_at",
          "Expiration must be between five minutes and two years from now.",
        );
      }
    }
    const requestHash = await sha256Hex(
      canonicalJson({
        actor_id: access.actorId,
        event_id: access.eventId,
        input,
        organization_id: access.organizationId,
      }),
    );
    const existing = await this.#creationReceipt(
      access.organizationId,
      idempotencyKey,
    );
    if (existing) {
      await this.#handleExistingReceipt(existing, requestHash, now);
    }

    const material = await createApiKeyMaterial(this.#hashPepper);
    const eventId = input.scope === "event" ? access.eventId : null;
    const createdAt = now.toISOString();
    const leaseExpiresAt = new Date(
      now.getTime() + creationLeaseMilliseconds,
    ).toISOString();
    const receiptExpiresAt = new Date(
      now.getTime() + receiptLifetimeMilliseconds,
    ).toISOString();
    let reserved = await this.#database
      .prepare(
        `INSERT INTO idempotency_keys (
           tenant_key, operation, command_id, request_hash, status,
           entity_type, entity_id, lease_owner, lease_expires_at,
           created_at, updated_at, expires_at
         ) VALUES (?1, 'api_keys.create', ?2, ?3, 'pending', 'api_key', ?4,
                   ?5, ?6, ?7, ?7, ?8)
         ON CONFLICT (tenant_key, operation, command_id) DO NOTHING`,
      )
      .bind(
        access.organizationId,
        idempotencyKey,
        requestHash,
        material.id,
        access.requestId,
        leaseExpiresAt,
        createdAt,
        receiptExpiresAt,
      )
      .run();
    if (reserved.meta.changes !== 1) {
      const winner = await this.#creationReceipt(
        access.organizationId,
        idempotencyKey,
      );
      if (!winner) throw new Error("API key creation reservation was lost.");
      await this.#handleExistingReceipt(winner, requestHash, now);
      reserved = await this.#database
        .prepare(
          `UPDATE idempotency_keys
           SET status = 'pending', entity_id = ?4, lease_owner = ?5,
               lease_expires_at = ?6, error_code = NULL, updated_at = ?7
           WHERE tenant_key = ?1 AND operation = 'api_keys.create'
             AND command_id = ?2 AND request_hash = ?3
             AND (status = 'failed' OR lease_expires_at <= ?7)`,
        )
        .bind(
          access.organizationId,
          idempotencyKey,
          requestHash,
          material.id,
          access.requestId,
          leaseExpiresAt,
          createdAt,
        )
        .run();
      if (reserved.meta.changes !== 1) throw new ApiKeyCreationPendingError();
    }

    const row: ApiKeyRow = {
      created_at: createdAt,
      event_id: eventId,
      expires_at: input.expires_at,
      id: material.id,
      last_used_at: null,
      name: input.name,
      organization_id: access.organizationId,
      revoked_at: null,
      scopes_json: JSON.stringify(input.scopes),
      token_prefix: material.prefix,
    };
    const keyMetadata = metadata(row, now);
    const createdAuditId = auditId();
    const safeResponse = JSON.stringify({ data: keyMetadata });
    try {
      const results = await this.#database.batch([
        this.#database
          .prepare(
            `INSERT INTO api_keys (
               id, organization_id, event_id, created_by_user_id, name,
               token_prefix, token_hash, verifier_salt, scopes_json,
               created_at, expires_at, last_used_at, revoked_at
             )
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                    NULL, NULL
             WHERE EXISTS (
               SELECT 1 FROM idempotency_keys
               WHERE tenant_key = ?2 AND operation = 'api_keys.create'
                 AND command_id = ?12 AND request_hash = ?13
                 AND status = 'pending' AND entity_id = ?1
                 AND lease_owner = ?14
             )`,
          )
          .bind(
            material.id,
            access.organizationId,
            eventId,
            access.actorId,
            input.name,
            material.prefix,
            material.verifier,
            material.salt,
            row.scopes_json,
            createdAt,
            input.expires_at,
            idempotencyKey,
            requestHash,
            access.requestId,
          ),
        this.#database
          .prepare(
            `INSERT INTO audit_events (
               id, organization_id, event_id, actor_type, actor_id, action,
               entity_type, entity_id, request_id, command_id,
               redaction_version, safe_diff_json, metadata_json, created_at
             )
             SELECT ?1, ?2, ?3, 'user', ?4, 'api_key.created', 'api_key',
                    ?5, ?6, ?7, 1, ?8, '{}', ?9
             WHERE EXISTS (
               SELECT 1 FROM idempotency_keys
               WHERE tenant_key = ?2 AND operation = 'api_keys.create'
                 AND command_id = ?7 AND request_hash = ?10
                 AND status = 'pending' AND entity_id = ?5
                 AND lease_owner = ?6
             )`,
          )
          .bind(
            createdAuditId,
            access.organizationId,
            eventId,
            access.actorId,
            material.id,
            access.requestId,
            idempotencyKey,
            JSON.stringify({
              eventScoped: eventId !== null,
              prefix: material.prefix,
              scopes: input.scopes,
            }),
            createdAt,
            requestHash,
          ),
        this.#database
          .prepare(
            `UPDATE idempotency_keys
             SET status = 'committed', original_response_status = 201,
                 original_response_json = ?6, lease_owner = NULL,
                 lease_expires_at = NULL, updated_at = ?7
             WHERE tenant_key = ?1 AND operation = 'api_keys.create'
               AND command_id = ?2 AND request_hash = ?3
               AND status = 'pending' AND entity_id = ?4 AND lease_owner = ?5`,
          )
          .bind(
            access.organizationId,
            idempotencyKey,
            requestHash,
            material.id,
            access.requestId,
            safeResponse,
            createdAt,
          ),
      ]);
      if (results.some((result) => result.meta.changes !== 1)) {
        throw new Error("API key creation reservation was replaced.");
      }
    } catch (error) {
      await this.#database
        .prepare(
          `UPDATE idempotency_keys
           SET status = 'failed', error_code = 'api_key_create_failed',
               lease_owner = NULL, lease_expires_at = NULL, updated_at = ?6
           WHERE tenant_key = ?1 AND operation = 'api_keys.create'
             AND command_id = ?2 AND request_hash = ?3
             AND entity_id = ?4 AND lease_owner = ?5 AND status = 'pending'`,
        )
        .bind(
          access.organizationId,
          idempotencyKey,
          requestHash,
          material.id,
          access.requestId,
          this.#now().toISOString(),
        )
        .run()
        .catch(() => undefined);
      throw error;
    }
    return apiKeyCreateResponseSchema.parse({
      audit_receipt: {
        created_at: createdAt,
        id: createdAuditId,
        request_id: access.requestId,
      },
      data: { ...keyMetadata, plaintext: material.plaintext },
    });
  }

  async revoke(
    access: ApiKeyManagementAccess,
    keyId: string,
  ): Promise<ReturnType<typeof apiKeyRevokeResponseSchema.parse>> {
    const current = await this.#keyForManagement(access, keyId);
    if (!current) throw new ApiKeyNotFoundError();
    if (current.revoked_at) {
      const receipt = await this.#revokeAudit(access.organizationId, keyId);
      if (!receipt) throw new Error("Revoked API key has no audit receipt.");
      return apiKeyRevokeResponseSchema.parse({
        audit_receipt: receipt,
        data: metadata(current, this.#now()),
      });
    }
    const revokedAt = this.#now().toISOString();
    const revokedAuditId = auditId();
    const results = await this.#database.batch([
      this.#database
        .prepare(
          `UPDATE api_keys SET revoked_at = ?4
           WHERE id = ?1 AND organization_id = ?2
             AND (?3 = 1 OR event_id = ?5) AND revoked_at IS NULL`,
        )
        .bind(
          keyId,
          access.organizationId,
          access.canManageOrganization ? 1 : 0,
          revokedAt,
          access.eventId,
        ),
      this.#database
        .prepare(
          `INSERT INTO audit_events (
             id, organization_id, event_id, actor_type, actor_id, action,
             entity_type, entity_id, request_id, redaction_version,
             safe_diff_json, metadata_json, created_at
           )
           SELECT ?1, key.organization_id, key.event_id, 'user', ?2,
                  'api_key.revoked', 'api_key', key.id, ?3, 1,
                  json_object('prefix', key.token_prefix), '{}', ?4
           FROM api_keys AS key
           WHERE key.id = ?5 AND key.organization_id = ?6
             AND key.revoked_at = ?4
             AND NOT EXISTS (
               SELECT 1 FROM audit_events AS existing
               WHERE existing.organization_id = key.organization_id
                 AND existing.entity_type = 'api_key'
                 AND existing.entity_id = key.id
                 AND existing.action = 'api_key.revoked'
             )`,
        )
        .bind(
          revokedAuditId,
          access.actorId,
          access.requestId,
          revokedAt,
          keyId,
          access.organizationId,
        ),
    ]);
    if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
      const winner = await this.#keyForManagement(access, keyId);
      const receipt = await this.#revokeAudit(access.organizationId, keyId);
      if (!winner || !receipt) throw new ApiKeyNotFoundError();
      return apiKeyRevokeResponseSchema.parse({
        audit_receipt: receipt,
        data: metadata(winner, this.#now()),
      });
    }
    return apiKeyRevokeResponseSchema.parse({
      audit_receipt: {
        created_at: revokedAt,
        id: revokedAuditId,
        request_id: access.requestId,
      },
      data: metadata({ ...current, revoked_at: revokedAt }, this.#now()),
    });
  }

  async #creationReceipt(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<CreationReceiptRow | null> {
    return this.#database
      .prepare(
        `SELECT request_hash, status, entity_id, lease_expires_at,
                original_response_json
         FROM idempotency_keys
         WHERE tenant_key = ?1 AND operation = 'api_keys.create'
           AND command_id = ?2`,
      )
      .bind(organizationId, idempotencyKey)
      .first<CreationReceiptRow>();
  }

  async #handleExistingReceipt(
    receipt: CreationReceiptRow,
    requestHash: string,
    now: Date,
  ): Promise<void> {
    if (receipt.request_hash !== requestHash) {
      throw new ApiKeyIdempotencyConflictError();
    }
    if (
      receipt.status === "committed" ||
      receipt.status === "committed_with_repair"
    ) {
      throw new ApiKeyPlaintextUnavailableError();
    }
    if (
      receipt.status !== "failed" &&
      (!receipt.lease_expires_at ||
        Date.parse(receipt.lease_expires_at) > now.getTime())
    ) {
      throw new ApiKeyCreationPendingError();
    }
  }

  async #keyForManagement(
    access: ApiKeyManagementAccess,
    keyId: string,
  ): Promise<ApiKeyRow | null> {
    return this.#database
      .prepare(
        `SELECT id, organization_id, event_id, name, token_prefix, scopes_json,
                created_at, expires_at, last_used_at, revoked_at
         FROM api_keys
         WHERE id = ?1 AND organization_id = ?2
           AND (?3 = 1 OR event_id = ?4)
         LIMIT 1`,
      )
      .bind(
        keyId,
        access.organizationId,
        access.canManageOrganization ? 1 : 0,
        access.eventId,
      )
      .first<ApiKeyRow>();
  }

  async #revokeAudit(
    organizationId: string,
    keyId: string,
  ): Promise<AuditReceiptRow | null> {
    return this.#database
      .prepare(
        `SELECT id, request_id, created_at
         FROM audit_events
         WHERE organization_id = ?1 AND entity_type = 'api_key'
           AND entity_id = ?2 AND action = 'api_key.revoked'
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .bind(organizationId, keyId)
      .first<AuditReceiptRow>();
  }
}

export class ApiKeyAuthenticator {
  readonly #database: D1Database;
  readonly #hashPepper: string;
  readonly #now: () => Date;
  readonly #onLastUsedFailure: (() => void) | undefined;

  constructor(options: {
    database: D1Database;
    hashPepper: string;
    now?: () => Date;
    onLastUsedFailure?: () => void;
  }) {
    if (options.hashPepper.length < 32) {
      throw new Error("AUTH_HASH_PEPPER must contain at least 32 characters.");
    }
    this.#database = options.database;
    this.#hashPepper = options.hashPepper;
    this.#now = options.now ?? (() => new Date());
    this.#onLastUsedFailure = options.onLastUsedFailure;
  }

  async authenticate(value: string): Promise<AuthenticatedApiKey | null> {
    const parsed = parseApiKey(value);
    const row = await this.#database
      .prepare(
        `SELECT key.id, key.organization_id, key.event_id, key.name,
                key.token_prefix, key.token_hash, key.verifier_salt,
                key.scopes_json, key.created_at, key.expires_at,
                key.last_used_at, key.revoked_at
         FROM api_keys AS key
         JOIN tenant_registry AS tenant
           ON tenant.organization_id = key.organization_id
          AND tenant.status = 'active'
          AND tenant.authority_ready_at IS NOT NULL
         WHERE key.id = ?1
           AND (
             key.event_id IS NULL OR EXISTS (
               SELECT 1 FROM p_events AS event
               WHERE event.organization_id = key.organization_id
                 AND event.id = key.event_id
                 AND event.source_deleted_at IS NULL
             )
           )
         LIMIT 1`,
      )
      .bind(parsed?.id ?? "key_invalid")
      .first<ApiKeyVerificationRow>();
    const storedSalt =
      row?.verifier_salt && saltPattern.test(row.verifier_salt)
        ? row.verifier_salt
        : null;
    const storedVerifier =
      row?.token_hash && verifierPattern.test(row.token_hash)
        ? row.token_hash
        : null;
    const validVerifier = await verifyApiKeyVerifier(
      parsed?.plaintext ?? value,
      storedSalt ?? dummySalt,
      this.#hashPepper,
      storedVerifier ?? dummyVerifier,
    );
    const now = this.#now();
    const expiresAt =
      row?.expires_at === null || row?.expires_at === undefined
        ? null
        : Date.parse(row.expires_at);
    if (
      !parsed ||
      !row ||
      !storedSalt ||
      !storedVerifier ||
      !validVerifier ||
      parsed.prefix !== row.token_prefix ||
      row.revoked_at !== null ||
      (expiresAt !== null &&
        (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()))
    ) {
      return null;
    }
    const scopes = safeScopes(row.scopes_json);
    if (!scopes) return null;
    const cutoff = new Date(
      now.getTime() - lastUsedWriteIntervalMilliseconds,
    ).toISOString();
    try {
      await this.#database
        .prepare(
          `UPDATE api_keys SET last_used_at = ?1
           WHERE id = ?2 AND revoked_at IS NULL
             AND (expires_at IS NULL OR expires_at > ?1)
             AND (last_used_at IS NULL OR last_used_at < ?3)`,
        )
        .bind(now.toISOString(), row.id, cutoff)
        .run();
    } catch {
      this.#onLastUsedFailure?.();
    }
    return {
      eventId: row.event_id,
      id: row.id,
      name: row.name,
      organizationId: row.organization_id,
      prefix: row.token_prefix,
      scopes,
    };
  }
}
