import { Resend, type WebhookEventPayload } from "resend";

import { sha256Hex } from "../auth/crypto.js";
import { durableOperationalEventStatement } from "../observability.js";

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

export class EmailProviderEventNotReadyError extends Error {
  constructor(providerMessageId: string) {
    super(`Provider message ${providerMessageId} is not durable yet.`);
    this.name = "EmailProviderEventNotReadyError";
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

  constructor(options: {
    readonly database: D1Database;
    readonly now?: () => Date;
  }) {
    this.#database = options.database;
    this.#now = options.now ?? (() => new Date());
  }

  async apply(options: {
    readonly event: WebhookEventPayload;
    readonly eventId: string;
    readonly rawPayload: string;
  }): Promise<"applied" | "duplicate" | "ignored"> {
    const normalized = normalizedStatuses.get(options.event.type);
    if (!normalized || !("email_id" in options.event.data)) return "ignored";
    const duplicate = await this.#database
      .prepare(
        "SELECT provider_event_id FROM email_provider_events WHERE provider_event_id = ?1",
      )
      .bind(options.eventId)
      .first();
    if (duplicate) return "duplicate";
    const providerMessageId = options.event.data.email_id;
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
      throw new EmailProviderEventNotReadyError(providerMessageId);
    }
    const occurredAt = options.event.created_at;
    if (!occurredAt.endsWith("Z") || !Number.isFinite(Date.parse(occurredAt))) {
      throw new TypeError("Provider event timestamp is invalid.");
    }
    const receivedAt = this.#now().toISOString();
    const payloadHash = await sha256Hex(options.rawPayload);
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
}
