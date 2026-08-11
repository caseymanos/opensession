import { Resend, type WebhookEventPayload } from "resend";

import { sha256Hex } from "../auth/crypto.js";
import {
  durableOperationalEventStatement,
  expiredOperationalEventsStatement,
} from "../observability.js";

export type NormalizedEmailStatus =
  "bounced" | "complained" | "delivered" | "failed" | "sent" | "suppressed";

interface ProviderMessageEventRow {
  event_id: string | null;
  id: string;
  last_provider_event_at: string | null;
  organization_id: string;
  recipient_hash: string;
  status: string;
}

interface ProviderEventReceiptRow {
  command_id: string | null;
  occurred_at: string;
}

const normalizedStatuses = new Map<string, NormalizedEmailStatus>([
  ["email.bounced", "bounced"],
  ["email.complained", "complained"],
  ["email.delivered", "delivered"],
  ["email.failed", "failed"],
  ["email.sent", "sent"],
  ["email.suppressed", "suppressed"],
]);
const suppressionReasons = {
  bounced: "bounced",
  complained: "complained",
  suppressed: "provider_suppressed",
} as const;
const statusPriorities: Readonly<Record<string, number>> = {
  bounced: 3,
  complained: 5,
  delivered: 2,
  failed: 2,
  queued: 0,
  sending: 0,
  sent: 1,
  suppressed: 4,
};
const providerMessagePersistenceGraceMilliseconds = 15 * 60 * 1_000;
const operationalEventRetentionMilliseconds = 30 * 24 * 60 * 60 * 1_000;
const providerEventReceiptRoute = "/api/webhooks/resend";

export class EmailProviderEventNotReadyError extends Error {
  constructor() {
    super("Provider message is not durable yet.");
    this.name = "EmailProviderEventNotReadyError";
  }
}

export class EmailProviderEventIdentityConflictError extends Error {
  constructor() {
    super("Provider event identity does not match its durable receipt.");
    this.name = "EmailProviderEventIdentityConflictError";
  }
}

export function verifyResendWebhook(options: {
  readonly apiKey: string;
  readonly id: string | null;
  readonly payload: string;
  readonly secret: string;
  readonly signature: string | null;
  readonly timestamp: string | null;
}): { readonly event: WebhookEventPayload; readonly eventId: string } {
  if (
    !options.id ||
    !options.signature ||
    !options.timestamp ||
    !/^[A-Za-z0-9_-]{3,255}$/.test(options.id) ||
    options.payload.length > 256 * 1_024 ||
    !options.apiKey.startsWith("re_") ||
    !options.secret.startsWith("whsec_")
  ) {
    throw new TypeError("Resend webhook headers are invalid.");
  }
  const event = new Resend(options.apiKey).webhooks.verify({
    headers: {
      id: options.id,
      signature: options.signature,
      timestamp: options.timestamp,
    },
    payload: options.payload,
    webhookSecret: options.secret,
  });
  return { event, eventId: options.id };
}

function nextStatus(
  current: string,
  incoming: NormalizedEmailStatus,
): NormalizedEmailStatus | null {
  if (
    incoming === "bounced" ||
    incoming === "complained" ||
    incoming === "suppressed"
  ) {
    return (statusPriorities[incoming] ?? 0) >= (statusPriorities[current] ?? 0)
      ? incoming
      : null;
  }
  if (
    incoming === "delivered" &&
    current !== "bounced" &&
    current !== "complained" &&
    current !== "suppressed"
  ) {
    return incoming;
  }
  if (
    incoming === "failed" &&
    current !== "delivered" &&
    current !== "bounced" &&
    current !== "complained" &&
    current !== "suppressed"
  ) {
    return incoming;
  }
  if (
    incoming === "sent" &&
    (current === "queued" || current === "sending" || current === "sent")
  ) {
    return incoming;
  }
  return null;
}

export class EmailProviderEventService {
  readonly #database: D1Database;
  readonly #now: () => Date;
  readonly #providerMessagePersistenceGraceMilliseconds: number;

  constructor(options: {
    readonly database: D1Database;
    readonly now?: () => Date;
    readonly providerMessagePersistenceGraceMilliseconds?: number;
  }) {
    this.#database = options.database;
    this.#now = options.now ?? (() => new Date());
    this.#providerMessagePersistenceGraceMilliseconds =
      options.providerMessagePersistenceGraceMilliseconds ??
      providerMessagePersistenceGraceMilliseconds;
    if (
      !Number.isInteger(this.#providerMessagePersistenceGraceMilliseconds) ||
      this.#providerMessagePersistenceGraceMilliseconds < 1
    ) {
      throw new TypeError("Provider message persistence grace is invalid.");
    }
  }

  async apply(options: {
    readonly event: WebhookEventPayload;
    readonly eventId: string;
    readonly rawPayload: string;
  }): Promise<"applied" | "duplicate" | "ignored" | "quarantined"> {
    const normalized = normalizedStatuses.get(options.event.type);
    if (!normalized || !("email_id" in options.event.data)) return "ignored";
    const occurredAt = options.event.created_at;
    if (
      typeof occurredAt !== "string" ||
      !occurredAt.endsWith("Z") ||
      !Number.isFinite(Date.parse(occurredAt))
    ) {
      throw new TypeError("Provider event timestamp is invalid.");
    }
    const providerMessageId = options.event.data.email_id;
    if (
      typeof providerMessageId !== "string" ||
      !/^[A-Za-z0-9_-]{3,255}$/.test(providerMessageId)
    ) {
      throw new TypeError("Provider message identifier is invalid.");
    }
    const payloadHash = await sha256Hex(options.rawPayload);
    const eventIdHash = await sha256Hex(options.eventId);
    await this.#assertExistingReceiptPayload(eventIdHash, payloadHash);
    const duplicate = await this.#database
      .prepare(
        `SELECT payload_hash FROM email_provider_events
         WHERE provider_event_id = ?1`,
      )
      .bind(options.eventId)
      .first<{ payload_hash: string }>();
    if (duplicate) {
      if (duplicate.payload_hash !== payloadHash) {
        throw new EmailProviderEventIdentityConflictError();
      }
      return "duplicate";
    }
    const message = await this.#database
      .prepare(
        `SELECT id, organization_id, event_id, last_provider_event_at,
                recipient_hash, status
         FROM provider_messages
         WHERE provider = 'resend' AND provider_message_id = ?1`,
      )
      .bind(providerMessageId)
      .first<ProviderMessageEventRow>();
    if (!message) {
      const missingOutcome = await this.#handleMissingProviderMessage({
        eventIdHash,
        payloadHash,
        providerMessageId,
      });
      return missingOutcome === "message_ready"
        ? this.apply(options)
        : missingOutcome;
    }
    const receivedAt = this.#now().toISOString();
    const eventIsCurrent =
      !message.last_provider_event_at ||
      Date.parse(occurredAt) >= Date.parse(message.last_provider_event_at);
    const status = eventIsCurrent
      ? nextStatus(message.status, normalized)
      : null;
    const statements: D1PreparedStatement[] = [
      this.#database
        .prepare(
          `INSERT INTO email_provider_events (
             provider_event_id, organization_id, message_id,
             provider_message_id, event_type, normalized_status, payload_hash,
             occurred_at, received_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        )
        .bind(
          options.eventId,
          message.organization_id,
          message.id,
          providerMessageId,
          options.event.type,
          normalized,
          payloadHash,
          occurredAt,
          receivedAt,
        ),
    ];
    if (status) {
      statements.push(
        this.#database
          .prepare(
            `UPDATE provider_messages
             SET status = ?1, updated_at = ?2, last_provider_event_id = ?3,
                 last_provider_event_at = ?4,
                 queue_payload_json = CASE
                   WHEN ?1 IN ('sent', 'delivered', 'suppressed', 'bounced', 'complained')
                     THEN NULL
                   ELSE queue_payload_json
                 END,
                 sent_at = CASE WHEN ?1 IN ('sent', 'delivered') THEN COALESCE(sent_at, ?4) ELSE sent_at END,
                 delivered_at = CASE WHEN ?1 = 'delivered' THEN COALESCE(delivered_at, ?4) ELSE delivered_at END,
                 error_code = CASE WHEN ?1 IN ('failed', 'bounced', 'complained', 'suppressed') THEN ?1 ELSE NULL END
             WHERE organization_id = ?5 AND id = ?6`,
          )
          .bind(
            status,
            receivedAt,
            options.eventId,
            occurredAt,
            message.organization_id,
            message.id,
          ),
      );
    }
    const suppressionReason =
      normalized in suppressionReasons
        ? suppressionReasons[normalized as keyof typeof suppressionReasons]
        : null;
    if (suppressionReason) {
      statements.push(
        this.#database
          .prepare(
            `INSERT INTO email_suppressions (
               organization_id, recipient_hash, reason,
               source_provider_event_id, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT (organization_id, recipient_hash) DO UPDATE SET
               reason = excluded.reason,
               source_provider_event_id = excluded.source_provider_event_id,
               updated_at = excluded.updated_at,
               lifted_at = NULL
             WHERE email_suppressions.lifted_at IS NOT NULL
                OR (
                  email_suppressions.reason != 'manual'
                  AND CASE excluded.reason
                    WHEN 'complained' THEN 3
                    WHEN 'provider_suppressed' THEN 2
                    WHEN 'bounced' THEN 1
                    ELSE 0
                  END >= CASE email_suppressions.reason
                    WHEN 'complained' THEN 3
                    WHEN 'provider_suppressed' THEN 2
                    WHEN 'bounced' THEN 1
                    ELSE 4
                  END
                )`,
          )
          .bind(
            message.organization_id,
            message.recipient_hash,
            suppressionReason,
            options.eventId,
            receivedAt,
          ),
      );
    }
    statements.push(
      durableOperationalEventStatement(
        this.#database,
        {
          dedupe_key: `email:${message.id}:provider:${options.eventId}`,
          delivery_id: message.id,
          event: `email.provider.${normalized}`,
          organization_id: message.organization_id,
          outcome:
            normalized === "sent" || normalized === "delivered"
              ? "success"
              : "failure",
          ...(message.event_id ? { event_id: message.event_id } : {}),
        },
        new Date(receivedAt),
      ),
    );
    await this.#database.batch(statements);
    return "applied";
  }

  async #handleMissingProviderMessage(options: {
    readonly eventIdHash: string;
    readonly payloadHash: string;
    readonly providerMessageId: string;
  }): Promise<"message_ready" | "quarantined"> {
    const now = this.#now();
    await expiredOperationalEventsStatement(this.#database, now).run();
    const pendingKey = `email:provider-event:pending:${options.eventIdHash}`;
    const quarantineKey = `email:provider-event:quarantined:${options.eventIdHash}`;
    const quarantine = await this.#readReceipt(quarantineKey);
    if (quarantine) {
      this.#assertReceiptPayload(quarantine, options.payloadHash);
      return "quarantined";
    }

    await durableOperationalEventStatement(
      this.#database,
      {
        command_id: options.payloadHash,
        dedupe_key: pendingKey,
        error_type: "provider_event_not_ready",
        event: "email.provider_event.pending",
        job_id: options.eventIdHash,
        method: "POST",
        outcome: "failure",
        route: providerEventReceiptRoute,
        status: 503,
      },
      now,
    ).run();
    const pending = await this.#readReceipt(pendingKey);
    if (!pending) {
      throw new Error("Provider event receipt was not persisted.");
    }
    this.#assertReceiptPayload(pending, options.payloadHash);
    const firstSeenAt = Date.parse(pending.occurred_at);
    if (
      !Number.isFinite(firstSeenAt) ||
      now.getTime() - firstSeenAt <
        this.#providerMessagePersistenceGraceMilliseconds
    ) {
      throw new EmailProviderEventNotReadyError();
    }

    const quarantinedAt = now.toISOString();
    const expiresAt = new Date(
      now.getTime() + operationalEventRetentionMilliseconds,
    ).toISOString();
    await this.#database
      .prepare(
        `INSERT INTO operational_events (
           dedupe_key, event_type, level, outcome, job_id, command_id,
           route, method, response_status, error_code, occurred_at, expires_at
         )
         SELECT ?1, 'email.provider_event.quarantined', 'info', 'accepted',
                ?2, ?3, ?4, 'POST', 200, 'provider_event_not_ready', ?5, ?6
         WHERE NOT EXISTS (
           SELECT 1 FROM provider_messages
           WHERE provider = 'resend' AND provider_message_id = ?7
         )
         ON CONFLICT (dedupe_key) DO NOTHING`,
      )
      .bind(
        quarantineKey,
        options.eventIdHash,
        options.payloadHash,
        providerEventReceiptRoute,
        quarantinedAt,
        expiresAt,
        options.providerMessageId,
      )
      .run();
    const persistedQuarantine = await this.#readReceipt(quarantineKey);
    if (persistedQuarantine) {
      this.#assertReceiptPayload(persistedQuarantine, options.payloadHash);
      return "quarantined";
    }
    const messageBecameReady = await this.#database
      .prepare(
        `SELECT 1 FROM provider_messages
         WHERE provider = 'resend' AND provider_message_id = ?1`,
      )
      .bind(options.providerMessageId)
      .first();
    if (messageBecameReady) return "message_ready";
    throw new Error("Provider event quarantine was not persisted.");
  }

  async #assertExistingReceiptPayload(
    eventIdHash: string,
    payloadHash: string,
  ): Promise<void> {
    for (const state of ["pending", "quarantined"] as const) {
      const receipt = await this.#readReceipt(
        `email:provider-event:${state}:${eventIdHash}`,
      );
      if (receipt) this.#assertReceiptPayload(receipt, payloadHash);
    }
  }

  async #readReceipt(
    dedupeKey: string,
  ): Promise<ProviderEventReceiptRow | null> {
    return this.#database
      .prepare(
        `SELECT command_id, occurred_at FROM operational_events
         WHERE dedupe_key = ?1`,
      )
      .bind(dedupeKey)
      .first<ProviderEventReceiptRow>();
  }

  #assertReceiptPayload(
    receipt: ProviderEventReceiptRow,
    payloadHash: string,
  ): void {
    if (receipt.command_id !== payloadHash) {
      throw new EmailProviderEventIdentityConflictError();
    }
  }
}
