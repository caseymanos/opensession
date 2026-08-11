import {
  createCampaignMessageKey,
  type EmailMessage,
} from "@sessionbox-killer/email";

import { sha256Hex } from "../auth/crypto.js";
import { durableOperationalEventStatement } from "../observability.js";
import { isAllowlisted, type EmailDeliveryConfig } from "./config.js";
import {
  parseEmailQueueMessage,
  serializeMagicLinkDeliveryBinding,
  type CampaignEmailQueueMessage,
  type EmailQueueMessage,
  type MagicLinkEmailQueueMessage,
} from "./messages.js";
import type { EmailDeliveryProvider } from "./provider.js";

export type EmailQueueAction =
  | { readonly action: "ack" }
  | { readonly action: "retry"; readonly delaySeconds: number };

export type CampaignEnqueueResult =
  | { readonly outcome: "queued" }
  | {
      readonly outcome:
        | "already_queued"
        | "already_terminal"
        | "handoff_pending"
        | "suppressed";
      readonly status: string;
    };

export type CampaignReplayResult =
  | { readonly outcome: "queued" }
  | { readonly outcome: "not_replayable"; readonly status: string }
  | { readonly outcome: "suppressed"; readonly status: "suppressed" };

interface ProviderMessageRow {
  attempt_count: number;
  campaign_id: string | null;
  contact_id: string | null;
  delivery_mode: EmailDeliveryConfig["mode"];
  event_id: string | null;
  idempotency_key: string;
  lease_expires_at: string | null;
  payload_hash: string | null;
  recipient_hash: string;
  status:
    | "bounced"
    | "complained"
    | "delivered"
    | "failed"
    | "queued"
    | "sending"
    | "sent"
    | "suppressed";
  template_id: string | null;
  template_version: number | null;
}

interface CampaignCoordinatorRow extends ProviderMessageRow {
  queue_payload_json: string | null;
  queue_handed_off_at: string | null;
  queue_handoff_lease_expires_at: string | null;
}

interface ClaimedMessageRow {
  attempt_count: number;
  recipient_hash: string;
}

interface MagicLinkDeliveryRow {
  delivery_attempt_count: number;
  delivery_completed_at: string | null;
  delivery_lease_expires_at: string | null;
  delivery_mode: EmailDeliveryConfig["mode"] | null;
  delivery_payload_hash: string | null;
  delivery_recipient_hash: string | null;
  delivery_state: "failed" | "pending" | "queued";
  event_id: string | null;
  organization_id: string | null;
  revoked_at: string | null;
}

const providerLeaseMilliseconds = 2 * 60 * 1_000;
const queueHandoffLeaseMilliseconds = 30 * 1_000;
const queuePayloadRetentionMilliseconds = 30 * 24 * 60 * 60 * 1_000;
const maximumQueuePayloadBytes = 120 * 1_024;
const maximumProviderAttempts = 5;
const retryDelays = [30, 120, 600, 1_800] as const;
const terminalStatuses = new Set([
  "bounced",
  "complained",
  "delivered",
  "failed",
  "sent",
  "suppressed",
]);

function retryDelay(attempt: number): number {
  return retryDelays[Math.min(attempt - 1, retryDelays.length - 1)] ?? 1_800;
}

async function campaignPayloadHash(message: EmailMessage): Promise<string> {
  return sha256Hex(
    JSON.stringify([
      message.from,
      message.html,
      message.replyTo,
      message.subject,
      message.text,
      [...message.to],
    ]),
  );
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function magicLinkEmail(
  message: MagicLinkEmailQueueMessage,
  config: EmailDeliveryConfig,
): EmailMessage {
  const purpose = message.purpose === "portal" ? "speaker portal" : "account";
  const link = htmlEscape(message.link);
  return {
    from: config.authFrom,
    html: `<!doctype html><html lang="en"><body><main><h1>Sign in to OpenSession</h1><p>Use this private link to open your ${purpose}. It expires in 15 minutes.</p><p><a href="${link}">Sign in to OpenSession</a></p><p>If you did not request this link, you can ignore this email.</p></main></body></html>`,
    replyTo: config.authReplyTo,
    subject: "Your private OpenSession sign-in link",
    text: `Sign in to OpenSession\n\nUse this private link to open your ${purpose}. It expires in 15 minutes.\n\n${message.link}\n\nIf you did not request this link, you can ignore this email.`,
    to: [message.to],
  };
}

export class CampaignEmailCoordinator {
  readonly #config: EmailDeliveryConfig;
  readonly #database: D1Database;
  readonly #now: () => Date;
  readonly #queue: Queue<EmailQueueMessage>;

  constructor(options: {
    readonly config: EmailDeliveryConfig;
    readonly database: D1Database;
    readonly now?: () => Date;
    readonly queue: Queue<EmailQueueMessage>;
  }) {
    this.#config = options.config;
    this.#database = options.database;
    this.#now = options.now ?? (() => new Date());
    this.#queue = options.queue;
  }

  async enqueue(
    rawMessage: CampaignEmailQueueMessage,
  ): Promise<CampaignEnqueueResult> {
    const message = parseEmailQueueMessage(rawMessage);
    if (message.kind !== "campaign.email.requested") {
      throw new TypeError("Campaign queue message is required.");
    }
    const expectedKey = await createCampaignMessageKey({
      campaignId: message.campaign_id,
      contactId: message.contact_id,
      templateId: message.template_id,
      templateVersion: message.template_version,
    });
    if (message.message_id !== expectedKey) {
      throw new TypeError("Campaign message ID does not match its scope.");
    }
    const address = message.email.to[0] as string;
    const recipientHash = await sha256Hex(address.trim().toLowerCase());
    const payloadHash = await campaignPayloadHash(message.email);
    const queuePayloadJson = JSON.stringify(message);
    if (
      new TextEncoder().encode(queuePayloadJson).byteLength >
      maximumQueuePayloadBytes
    ) {
      throw new TypeError("Campaign queue payload exceeds 120 KiB.");
    }
    const suppression = await this.#database
      .prepare(
        `SELECT reason FROM email_suppressions
         WHERE organization_id = ?1 AND recipient_hash = ?2
           AND lifted_at IS NULL`,
      )
      .bind(message.organization_id, recipientHash)
      .first<{ reason: string }>();
    const now = this.#now().toISOString();
    const initialStatus = suppression ? "suppressed" : "queued";
    const errorCode = suppression ? "recipient_suppressed" : null;
    const inserted = await this.#database
      .prepare(
        `INSERT INTO provider_messages (
           id, organization_id, event_id, campaign_id, contact_id, kind,
           provider, idempotency_key, recipient_hash, template_id,
           template_version, payload_hash, delivery_mode, status, created_at,
           updated_at, error_code, queue_payload_json
         ) VALUES (
           ?1, ?2, ?3, ?4, ?5, 'campaign', 'resend', ?1, ?6, ?7, ?8, ?9,
           ?10, ?11, ?12, ?12, ?13, ?14
         ) ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
      )
      .bind(
        message.message_id,
        message.organization_id,
        message.event_id,
        message.campaign_id,
        message.contact_id,
        recipientHash,
        message.template_id,
        message.template_version,
        payloadHash,
        this.#config.mode,
        initialStatus,
        now,
        errorCode,
        suppression ? null : queuePayloadJson,
      )
      .run();
    let result: CampaignEnqueueResult = { outcome: "queued" };
    let existing: CampaignCoordinatorRow | null = null;
    if (inserted.meta.changes !== 1) {
      existing = await this.#message(message);
      if (!existing || !this.#matchesScope(existing, message, recipientHash)) {
        throw new Error("Campaign message idempotency state is inconsistent.");
      }
      if (terminalStatuses.has(existing.status)) {
        return { outcome: "already_terminal", status: existing.status };
      }
      if (existing.status === "sending" || existing.queue_handed_off_at) {
        return { outcome: "already_queued", status: existing.status };
      }
      result = { outcome: "already_queued", status: existing.status };
    }
    if (inserted.meta.changes === 1 && suppression) {
      return { outcome: "suppressed", status: "suppressed" };
    }
    if (existing && suppression) {
      const suppressed = await this.#database
        .prepare(
          `UPDATE provider_messages
           SET status = 'suppressed', error_code = 'recipient_suppressed',
               queue_payload_json = NULL, updated_at = ?1
           WHERE organization_id = ?2 AND id = ?3 AND status = 'queued'
             AND queue_handed_off_at IS NULL
             AND (queue_handoff_lease_expires_at IS NULL
               OR queue_handoff_lease_expires_at <= ?1)`,
        )
        .bind(now, message.organization_id, message.message_id)
        .run();
      if (suppressed.meta.changes === 1) {
        return { outcome: "suppressed", status: "suppressed" };
      }
    }
    const handoffMessage = existing
      ? await this.#durableMessage(existing, message, payloadHash)
      : message;
    return this.#handoff(handoffMessage, result);
  }

  async replay(
    rawMessage: CampaignEmailQueueMessage,
  ): Promise<CampaignReplayResult> {
    const message = parseEmailQueueMessage(rawMessage);
    if (message.kind !== "campaign.email.requested") {
      throw new TypeError("Campaign queue message is required.");
    }
    const existing = await this.#message(message);
    const recipientHash = await sha256Hex(
      (message.email.to[0] as string).trim().toLowerCase(),
    );
    const payloadHash = await campaignPayloadHash(message.email);
    if (!existing || !this.#matchesScope(existing, message, recipientHash)) {
      throw new Error("Campaign message does not exist.");
    }
    const handoffMessage = await this.#durableMessage(
      existing,
      message,
      payloadHash,
    );
    if (existing.status !== "failed") {
      return { outcome: "not_replayable", status: existing.status };
    }
    const suppression = await this.#database
      .prepare(
        `SELECT reason FROM email_suppressions
         WHERE organization_id = ?1 AND recipient_hash = ?2
           AND lifted_at IS NULL`,
      )
      .bind(message.organization_id, existing.recipient_hash)
      .first();
    if (suppression) {
      await this.#database
        .prepare(
          `UPDATE provider_messages
           SET status = 'suppressed', error_code = 'recipient_suppressed',
               queue_payload_json = NULL, updated_at = ?1
           WHERE organization_id = ?2 AND id = ?3 AND status = 'failed'`,
        )
        .bind(
          this.#now().toISOString(),
          message.organization_id,
          message.message_id,
        )
        .run();
      return { outcome: "suppressed", status: "suppressed" };
    }
    const reset = await this.#database
      .prepare(
        `UPDATE provider_messages
         SET status = 'queued', error_code = NULL, delivery_mode = ?1,
             queue_handed_off_at = NULL,
             queue_handoff_lease_expires_at = NULL, updated_at = ?2
         WHERE organization_id = ?3 AND id = ?4 AND status = 'failed'`,
      )
      .bind(
        this.#config.mode,
        this.#now().toISOString(),
        message.organization_id,
        message.message_id,
      )
      .run();
    if (reset.meta.changes !== 1) {
      const current = await this.#message(message);
      return {
        outcome: "not_replayable",
        status: current?.status ?? "missing",
      };
    }
    const handoff = await this.#handoff(handoffMessage, { outcome: "queued" });
    if (handoff.outcome === "queued") return handoff;
    return { outcome: "not_replayable", status: handoff.status };
  }

  async drainPendingHandoffs(limit = 25): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError(
        "Queue handoff drain limit must be between 1 and 100.",
      );
    }
    const rows = await this.#database
      .prepare(
        `SELECT id, organization_id, queue_payload_json
         FROM provider_messages
         WHERE status = 'queued' AND queue_handed_off_at IS NULL
           AND queue_payload_json IS NOT NULL
           AND (queue_handoff_lease_expires_at IS NULL
             OR queue_handoff_lease_expires_at <= ?1)
         ORDER BY created_at, id
         LIMIT ?2`,
      )
      .bind(this.#now().toISOString(), limit)
      .all<{
        id: string;
        organization_id: string;
        queue_payload_json: string;
      }>();
    let handedOff = 0;
    for (const row of rows.results) {
      let message: CampaignEmailQueueMessage;
      try {
        if (
          new TextEncoder().encode(row.queue_payload_json).byteLength >
          maximumQueuePayloadBytes
        ) {
          throw new TypeError("Campaign queue payload exceeds 120 KiB.");
        }
        const parsed = parseEmailQueueMessage(
          JSON.parse(row.queue_payload_json) as unknown,
        );
        if (parsed.kind !== "campaign.email.requested") {
          throw new TypeError("Campaign queue message is required.");
        }
        message = parsed;
      } catch (error) {
        if (!(error instanceof SyntaxError || error instanceof TypeError)) {
          throw error;
        }
        await this.#database
          .prepare(
            `UPDATE provider_messages
             SET status = 'failed', error_code = 'invalid_queue_payload',
                 queue_handoff_lease_expires_at = NULL,
                 queue_payload_json = NULL, updated_at = ?1
             WHERE organization_id = ?2 AND id = ?3 AND status = 'queued'
               AND queue_handed_off_at IS NULL`,
          )
          .bind(this.#now().toISOString(), row.organization_id, row.id)
          .run();
        continue;
      }
      const result = await this.enqueue(message);
      if (result.outcome !== "handoff_pending") handedOff += 1;
    }
    return handedOff;
  }

  async #handoff(
    message: CampaignEmailQueueMessage,
    result: CampaignEnqueueResult,
  ): Promise<CampaignEnqueueResult> {
    const now = this.#now();
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(
      now.getTime() + queueHandoffLeaseMilliseconds,
    ).toISOString();
    const claimed = await this.#database
      .prepare(
        `UPDATE provider_messages
         SET queue_handoff_lease_expires_at = ?1,
             queue_payload_json = COALESCE(queue_payload_json, ?2),
             delivery_mode = ?3, updated_at = ?4, error_code = NULL
         WHERE organization_id = ?5 AND id = ?6 AND status = 'queued'
           AND queue_handed_off_at IS NULL
           AND (queue_payload_json IS NOT NULL OR payload_hash = ?7)
           AND (queue_handoff_lease_expires_at IS NULL
             OR queue_handoff_lease_expires_at <= ?4)
         RETURNING id`,
      )
      .bind(
        leaseExpiresAt,
        JSON.stringify(message),
        this.#config.mode,
        nowIso,
        message.organization_id,
        message.message_id,
        await campaignPayloadHash(message.email),
      )
      .first<{ id: string }>();
    if (!claimed) {
      return { outcome: "handoff_pending", status: "queued" };
    }
    try {
      await this.#queue.send(message);
    } catch (error) {
      await this.#database
        .prepare(
          `UPDATE provider_messages
           SET queue_handoff_lease_expires_at = NULL, updated_at = ?1
           WHERE organization_id = ?2 AND id = ?3
             AND queue_handoff_lease_expires_at = ?4
             AND queue_handed_off_at IS NULL`,
        )
        .bind(
          this.#now().toISOString(),
          message.organization_id,
          message.message_id,
          leaseExpiresAt,
        )
        .run();
      throw error;
    }
    const confirmed = await this.#database
      .prepare(
        `UPDATE provider_messages
         SET queue_handed_off_at = ?1, queue_handoff_lease_expires_at = NULL,
             queue_payload_json = NULL, updated_at = ?1
         WHERE organization_id = ?2 AND id = ?3
           AND queue_handoff_lease_expires_at = ?4
           AND queue_handed_off_at IS NULL`,
      )
      .bind(
        this.#now().toISOString(),
        message.organization_id,
        message.message_id,
        leaseExpiresAt,
      )
      .run();
    if (confirmed.meta.changes !== 1) {
      const current = await this.#message(message);
      const recipientHash = await sha256Hex(
        (message.email.to[0] as string).trim().toLowerCase(),
      );
      const payloadHash = await campaignPayloadHash(message.email);
      if (
        current?.queue_handed_off_at &&
        this.#matchesMessage(current, message, recipientHash, payloadHash)
      ) {
        return result;
      }
      throw new Error("Campaign queue handoff confirmation was lost.");
    }
    return result;
  }

  async #message(
    message: CampaignEmailQueueMessage,
  ): Promise<CampaignCoordinatorRow | null> {
    return this.#database
      .prepare(
        `SELECT attempt_count, campaign_id, contact_id, delivery_mode, event_id,
                idempotency_key, lease_expires_at, payload_hash, recipient_hash,
                queue_handed_off_at, queue_handoff_lease_expires_at,
                queue_payload_json, status, template_id, template_version
         FROM provider_messages
         WHERE organization_id = ?1 AND id = ?2`,
      )
      .bind(message.organization_id, message.message_id)
      .first<CampaignCoordinatorRow>();
  }

  async #durableMessage(
    row: CampaignCoordinatorRow,
    current: CampaignEmailQueueMessage,
    currentPayloadHash: string,
  ): Promise<CampaignEmailQueueMessage> {
    if (!row.queue_payload_json) {
      if (row.payload_hash !== currentPayloadHash) {
        throw new Error("Campaign message idempotency state is inconsistent.");
      }
      return current;
    }
    let durable: CampaignEmailQueueMessage;
    try {
      const parsed = parseEmailQueueMessage(JSON.parse(row.queue_payload_json));
      if (parsed.kind !== "campaign.email.requested") {
        throw new TypeError("Campaign queue message is required.");
      }
      durable = parsed;
    } catch {
      throw new Error("Campaign queue payload state is inconsistent.");
    }
    const durableRecipientHash = await sha256Hex(
      (durable.email.to[0] as string).trim().toLowerCase(),
    );
    const durablePayloadHash = await campaignPayloadHash(durable.email);
    if (
      !this.#matchesMessage(
        row,
        durable,
        durableRecipientHash,
        durablePayloadHash,
      )
    ) {
      throw new Error("Campaign queue payload state is inconsistent.");
    }
    return durable;
  }

  #matchesScope(
    row: ProviderMessageRow,
    message: CampaignEmailQueueMessage,
    recipientHash: string,
  ): boolean {
    return (
      row.idempotency_key === message.message_id &&
      row.campaign_id === message.campaign_id &&
      row.contact_id === message.contact_id &&
      row.event_id === message.event_id &&
      row.template_id === message.template_id &&
      row.template_version === message.template_version &&
      row.recipient_hash === recipientHash
    );
  }

  #matchesMessage(
    row: ProviderMessageRow,
    message: CampaignEmailQueueMessage,
    recipientHash: string,
    payloadHash: string,
  ): boolean {
    return (
      this.#matchesScope(row, message, recipientHash) &&
      row.payload_hash === payloadHash
    );
  }
}

export async function pruneExpiredEmailQueuePayloads(
  database: D1Database,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(
    now.getTime() - queuePayloadRetentionMilliseconds,
  ).toISOString();
  const result = await database
    .prepare(
      `UPDATE provider_messages
       SET status = CASE
             WHEN status = 'queued' AND queue_handed_off_at IS NULL
               THEN 'failed'
             ELSE status
           END,
           error_code = CASE
             WHEN status = 'queued' AND queue_handed_off_at IS NULL
               THEN 'queue_handoff_expired'
             ELSE error_code
           END,
           queue_handoff_lease_expires_at = NULL,
           queue_payload_json = NULL,
           updated_at = ?1
       WHERE queue_payload_json IS NOT NULL AND created_at <= ?2
         AND status IN ('queued', 'failed')`,
    )
    .bind(now.toISOString(), cutoff)
    .run();
  return result.meta.changes;
}

export class EmailQueueDeliveryService {
  readonly #config: EmailDeliveryConfig;
  readonly #database: D1Database;
  readonly #now: () => Date;
  readonly #provider: EmailDeliveryProvider | null;

  constructor(options: {
    readonly config: EmailDeliveryConfig;
    readonly database: D1Database;
    readonly now?: () => Date;
    readonly provider?: EmailDeliveryProvider;
  }) {
    this.#config = options.config;
    this.#database = options.database;
    this.#now = options.now ?? (() => new Date());
    this.#provider = options.provider ?? null;
  }

  async process(
    rawMessage: unknown,
    queueAttempt = 1,
  ): Promise<EmailQueueAction> {
    if (!Number.isInteger(queueAttempt) || queueAttempt < 1) {
      throw new TypeError("Queue attempt must be positive.");
    }
    const message = parseEmailQueueMessage(rawMessage);
    return message.kind === "campaign.email.requested"
      ? this.#campaign(message)
      : this.#magicLink(message);
  }

  async #campaign(
    message: CampaignEmailQueueMessage,
  ): Promise<EmailQueueAction> {
    const existing = await this.#database
      .prepare(
        `SELECT attempt_count, campaign_id, contact_id, delivery_mode, event_id,
                idempotency_key, lease_expires_at, payload_hash, recipient_hash,
                status, template_id, template_version
         FROM provider_messages
         WHERE organization_id = ?1 AND id = ?2`,
      )
      .bind(message.organization_id, message.message_id)
      .first<ProviderMessageRow>();
    if (!existing || existing.idempotency_key !== message.message_id) {
      return { action: "ack" };
    }
    const expectedKey = await createCampaignMessageKey({
      campaignId: message.campaign_id,
      contactId: message.contact_id,
      templateId: message.template_id,
      templateVersion: message.template_version,
    });
    const recipientHash = await sha256Hex(
      (message.email.to[0] as string).trim().toLowerCase(),
    );
    const payloadHash = await campaignPayloadHash(message.email);
    if (
      expectedKey !== message.message_id ||
      existing.campaign_id !== message.campaign_id ||
      existing.contact_id !== message.contact_id ||
      existing.event_id !== message.event_id ||
      existing.template_id !== message.template_id ||
      existing.template_version !== message.template_version ||
      existing.recipient_hash !== recipientHash ||
      existing.payload_hash !== payloadHash
    ) {
      throw new TypeError(
        "Campaign queue message does not match durable state.",
      );
    }
    if (terminalStatuses.has(existing.status)) return { action: "ack" };
    const now = this.#now();
    const nowIso = now.toISOString();
    await this.#database
      .prepare(
        `UPDATE provider_messages
         SET queue_handed_off_at = COALESCE(queue_handed_off_at, ?1),
             queue_handoff_lease_expires_at = NULL,
             queue_payload_json = NULL, updated_at = ?1
         WHERE organization_id = ?2 AND id = ?3
           AND queue_handed_off_at IS NULL`,
      )
      .bind(nowIso, message.organization_id, message.message_id)
      .run();
    if (existing.delivery_mode !== this.#config.mode) {
      await this.#failCampaignBeforeAttempt(
        message,
        existing.attempt_count,
        "delivery_mode_changed",
      );
      return { action: "ack" };
    }
    const leaseExpiresAt = new Date(
      now.getTime() + providerLeaseMilliseconds,
    ).toISOString();
    const claimed = await this.#database
      .prepare(
        `UPDATE provider_messages
         SET status = 'sending', attempt_count = attempt_count + 1,
             lease_expires_at = ?1, updated_at = ?2, error_code = NULL,
             queue_handed_off_at = COALESCE(queue_handed_off_at, ?2),
             queue_handoff_lease_expires_at = NULL,
             queue_payload_json = NULL
         WHERE organization_id = ?3 AND id = ?4
           AND (status = 'queued' OR (status = 'sending' AND lease_expires_at <= ?2))
         RETURNING attempt_count, recipient_hash`,
      )
      .bind(leaseExpiresAt, nowIso, message.organization_id, message.message_id)
      .first<ClaimedMessageRow>();
    if (!claimed) {
      return { action: "retry", delaySeconds: 120 };
    }
    const suppression = await this.#database
      .prepare(
        `SELECT reason FROM email_suppressions
         WHERE organization_id = ?1 AND recipient_hash = ?2
           AND lifted_at IS NULL`,
      )
      .bind(message.organization_id, claimed.recipient_hash)
      .first<{ reason: string }>();
    if (suppression) {
      await this.#finishCampaignAttempt(message, claimed.attempt_count, {
        errorCode: "recipient_suppressed",
        outcome: "suppressed",
        status: "suppressed",
      });
      return { action: "ack" };
    }
    const recipient = message.email.to[0] as string;
    if (!isAllowlisted(this.#config, recipient)) {
      await this.#finishCampaignAttempt(message, claimed.attempt_count, {
        errorCode: "preview_recipient_not_allowlisted",
        outcome: "blocked",
        status: "suppressed",
      });
      return { action: "ack" };
    }
    if (this.#config.mode === "sink") {
      await this.#finishCampaignAttempt(message, claimed.attempt_count, {
        outcome: "sink",
        providerMessageId: `sink_${message.message_id.slice(6, 38)}`,
        status: "delivered",
      });
      return { action: "ack" };
    }
    if (!this.#provider) {
      return this.#retryCampaign(
        message,
        claimed.attempt_count,
        "provider_not_configured",
      );
    }
    const result = await this.#provider.send({
      idempotencyKey: message.message_id,
      message: message.email,
      tags: {
        campaign_id: message.campaign_id,
        event_id: message.event_id,
        message_id: message.message_id,
      },
    });
    if (result.outcome === "sent") {
      await this.#finishCampaignAttempt(message, claimed.attempt_count, {
        outcome: "sent",
        providerMessageId: result.providerMessageId,
        status: "sent",
      });
      return { action: "ack" };
    }
    if (result.outcome === "retry") {
      return this.#retryCampaign(
        message,
        claimed.attempt_count,
        result.errorCode,
      );
    }
    await this.#finishCampaignAttempt(message, claimed.attempt_count, {
      errorCode: result.errorCode,
      outcome: "failed",
      status: "failed",
    });
    return { action: "ack" };
  }

  async #retryCampaign(
    message: CampaignEmailQueueMessage,
    attempt: number,
    errorCode: string,
  ): Promise<EmailQueueAction> {
    if (attempt >= maximumProviderAttempts) {
      await this.#finishCampaignAttempt(message, attempt, {
        errorCode: "retry_exhausted",
        outcome: "failed",
        status: "failed",
      });
      return { action: "ack" };
    }
    await this.#finishCampaignAttempt(message, attempt, {
      errorCode,
      outcome: "retry",
      status: "queued",
    });
    return { action: "retry", delaySeconds: retryDelay(attempt) };
  }

  async #failCampaignBeforeAttempt(
    message: CampaignEmailQueueMessage,
    attempt: number,
    errorCode: string,
  ): Promise<void> {
    const now = this.#now();
    await this.#database.batch([
      this.#database
        .prepare(
          `UPDATE provider_messages
           SET status = 'failed', error_code = ?1, updated_at = ?2
           WHERE organization_id = ?3 AND id = ?4 AND status = 'queued'`,
        )
        .bind(
          errorCode,
          now.toISOString(),
          message.organization_id,
          message.message_id,
        ),
      durableOperationalEventStatement(
        this.#database,
        {
          attempt,
          dedupe_key: `email:${message.message_id}:${errorCode}`,
          delivery_id: message.message_id,
          error_type: errorCode,
          event: "email.delivery.failed",
          event_id: message.event_id,
          organization_id: message.organization_id,
          outcome: "failure",
          queue: "email_send",
          request_id: message.request_id,
        },
        now,
      ),
    ]);
  }

  async #finishCampaignAttempt(
    message: CampaignEmailQueueMessage,
    attempt: number,
    result: {
      readonly errorCode?: string;
      readonly outcome:
        "blocked" | "failed" | "retry" | "sent" | "sink" | "suppressed";
      readonly providerMessageId?: string;
      readonly status:
        "delivered" | "failed" | "queued" | "sent" | "suppressed";
    },
  ): Promise<void> {
    const now = this.#now();
    const nowIso = now.toISOString();
    await this.#database.batch([
      this.#database
        .prepare(
          `UPDATE provider_messages
           SET status = ?1, provider_message_id = COALESCE(?2, provider_message_id),
               error_code = ?3, lease_expires_at = NULL, updated_at = ?4,
               queue_payload_json = CASE
                 WHEN ?1 IN ('sent', 'delivered', 'suppressed') THEN NULL
                 ELSE queue_payload_json
               END,
               sent_at = CASE WHEN ?1 IN ('sent', 'delivered') THEN COALESCE(sent_at, ?4) ELSE sent_at END,
               delivered_at = CASE WHEN ?1 = 'delivered' THEN COALESCE(delivered_at, ?4) ELSE delivered_at END
           WHERE organization_id = ?5 AND id = ?6 AND status = 'sending'
             AND attempt_count = ?7`,
        )
        .bind(
          result.status,
          result.providerMessageId ?? null,
          result.errorCode ?? null,
          nowIso,
          message.organization_id,
          message.message_id,
          attempt,
        ),
      this.#database
        .prepare(
          `INSERT INTO email_delivery_attempts (
             message_id, organization_id, attempt_number, delivery_mode,
             outcome, provider_message_id, error_code, started_at, finished_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
        )
        .bind(
          message.message_id,
          message.organization_id,
          attempt,
          this.#config.mode,
          result.outcome,
          result.providerMessageId ?? null,
          result.errorCode ?? null,
          nowIso,
        ),
      durableOperationalEventStatement(
        this.#database,
        {
          attempt,
          dedupe_key: `email:${message.message_id}:${attempt}:${result.outcome}`,
          delivery_id: message.message_id,
          event: `email.delivery.${result.outcome}`,
          event_id: message.event_id,
          organization_id: message.organization_id,
          outcome:
            result.outcome === "sent" || result.outcome === "sink"
              ? "success"
              : result.outcome === "retry"
                ? "accepted"
                : "failure",
          queue: "email_send",
          queue_age_ms: Math.max(
            0,
            now.getTime() - Date.parse(message.queued_at),
          ),
          request_id: message.request_id,
          ...(result.errorCode ? { error_type: result.errorCode } : {}),
        },
        now,
      ),
    ]);
  }

  async #magicLink(
    message: MagicLinkEmailQueueMessage,
  ): Promise<EmailQueueAction> {
    const now = this.#now();
    const delivery = await this.#database
      .prepare(
        `SELECT link.delivery_attempt_count, link.delivery_completed_at,
                link.delivery_lease_expires_at, link.delivery_payload_hash,
                link.delivery_mode, link.delivery_recipient_hash,
                link.delivery_state,
                link.revoked_at, scope.organization_id, scope.event_id
         FROM magic_link_tokens link
         LEFT JOIN magic_link_scopes scope ON scope.token_id = link.id
         WHERE link.id = ?1`,
      )
      .bind(message.delivery_id)
      .first<MagicLinkDeliveryRow>();
    if (!delivery) return { action: "ack" };
    if (
      delivery.delivery_state === "failed" ||
      delivery.revoked_at ||
      delivery.delivery_completed_at
    ) {
      return { action: "ack" };
    }
    const recipientHash = await sha256Hex(message.to.trim().toLowerCase());
    const payloadHash = await sha256Hex(
      serializeMagicLinkDeliveryBinding(message),
    );
    if (
      delivery.delivery_recipient_hash !== recipientHash ||
      delivery.delivery_payload_hash !== payloadHash
    ) {
      throw new TypeError(
        "Magic-link queue message does not match durable state.",
      );
    }
    if (delivery.delivery_state === "pending") {
      const promoted = await this.#database
        .prepare(
          `UPDATE magic_link_tokens
           SET delivery_state = 'queued'
           WHERE id = ?1
             AND delivery_state = 'pending'
             AND revoked_at IS NULL
             AND consumed_at IS NULL`,
        )
        .bind(message.delivery_id)
        .run();
      if (promoted.meta.changes !== 1) {
        return { action: "retry", delaySeconds: 30 };
      }
      delivery.delivery_state = "queued";
    }
    if (
      delivery.delivery_mode !== null &&
      delivery.delivery_mode !== this.#config.mode
    ) {
      await this.#failMagicLink(
        message,
        delivery,
        "delivery_mode_changed",
        now,
      );
      return { action: "ack" };
    }
    if (Date.parse(message.expires_at) <= now.getTime()) {
      await this.#failMagicLink(message, delivery, "link_expired", now);
      return { action: "ack" };
    }
    if (!isAllowlisted(this.#config, message.to)) {
      await this.#failMagicLink(
        message,
        delivery,
        "preview_recipient_not_allowlisted",
        now,
      );
      return { action: "ack" };
    }
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(
      now.getTime() + providerLeaseMilliseconds,
    ).toISOString();
    const claimed = await this.#database
      .prepare(
        `UPDATE magic_link_tokens
         SET delivery_attempt_count = delivery_attempt_count + 1,
             delivery_lease_expires_at = ?1, delivery_mode = ?2,
             delivery_error_code = NULL
         WHERE id = ?3 AND delivery_state = 'queued' AND revoked_at IS NULL
           AND delivery_completed_at IS NULL
           AND (delivery_mode IS NULL OR delivery_mode = ?2)
           AND (delivery_lease_expires_at IS NULL OR delivery_lease_expires_at <= ?4)
         RETURNING delivery_attempt_count`,
      )
      .bind(leaseExpiresAt, this.#config.mode, message.delivery_id, nowIso)
      .first<{ delivery_attempt_count: number }>();
    if (!claimed) return { action: "retry", delaySeconds: 120 };
    const attempt = claimed.delivery_attempt_count;
    if (this.#config.mode === "sink") {
      await this.#recordMagicLink(message, delivery, attempt, "sink", now);
      return { action: "ack" };
    }
    if (!this.#provider) {
      return this.#retryMagicLink(
        message,
        delivery,
        attempt,
        "provider_not_configured",
        now,
      );
    }
    const providerResult = await this.#provider.send({
      idempotencyKey: `auth_${message.delivery_id}`,
      message: magicLinkEmail(message, this.#config),
      tags: { delivery_id: message.delivery_id, kind: "magic_link" },
    });
    if (providerResult.outcome === "sent") {
      await this.#recordMagicLink(
        message,
        delivery,
        attempt,
        "sent",
        now,
        providerResult.providerMessageId,
      );
      return { action: "ack" };
    }
    if (providerResult.outcome === "retry") {
      return this.#retryMagicLink(
        message,
        delivery,
        attempt,
        providerResult.errorCode,
        now,
      );
    }
    await this.#failClaimedMagicLink(
      message,
      delivery,
      attempt,
      providerResult.errorCode,
      now,
    );
    return { action: "ack" };
  }

  async #retryMagicLink(
    message: MagicLinkEmailQueueMessage,
    scope: MagicLinkDeliveryRow,
    attempt: number,
    errorCode: string,
    now: Date,
  ): Promise<EmailQueueAction> {
    if (attempt >= maximumProviderAttempts) {
      await this.#failClaimedMagicLink(
        message,
        scope,
        attempt,
        "retry_exhausted",
        now,
      );
      return { action: "ack" };
    }
    await this.#database.batch([
      this.#database
        .prepare(
          `UPDATE magic_link_tokens
           SET delivery_lease_expires_at = NULL, delivery_error_code = ?1
           WHERE id = ?2 AND delivery_state = 'queued' AND revoked_at IS NULL
             AND delivery_completed_at IS NULL AND delivery_attempt_count = ?3`,
        )
        .bind(errorCode, message.delivery_id, attempt),
      durableOperationalEventStatement(
        this.#database,
        {
          attempt,
          dedupe_key: `email:${message.delivery_id}:${attempt}:retry`,
          delivery_id: message.delivery_id,
          error_type: errorCode,
          event: "email.magic_link.retry",
          outcome: "accepted",
          queue: "email_send",
          request_id: message.request_id,
          ...(scope.organization_id
            ? { organization_id: scope.organization_id }
            : {}),
          ...(scope.event_id ? { event_id: scope.event_id } : {}),
        },
        now,
      ),
    ]);
    return { action: "retry", delaySeconds: retryDelay(attempt) };
  }

  async #failMagicLink(
    message: MagicLinkEmailQueueMessage,
    scope: MagicLinkDeliveryRow,
    errorCode: string,
    now: Date,
  ): Promise<void> {
    await this.#database.batch([
      this.#database
        .prepare(
          `UPDATE magic_link_tokens
           SET delivery_state = 'failed', revoked_at = ?1,
               delivery_lease_expires_at = NULL, delivery_mode = ?2,
               delivery_error_code = ?3
           WHERE id = ?4 AND delivery_state = 'queued' AND revoked_at IS NULL`,
        )
        .bind(
          now.toISOString(),
          this.#config.mode,
          errorCode,
          message.delivery_id,
        ),
      durableOperationalEventStatement(
        this.#database,
        {
          attempt: scope.delivery_attempt_count,
          dedupe_key: `email:${message.delivery_id}:delivery_failed`,
          delivery_id: message.delivery_id,
          error_type: errorCode,
          event: "email.magic_link.failed",
          outcome: "failure",
          queue: "email_send",
          request_id: message.request_id,
          ...(scope.organization_id
            ? { organization_id: scope.organization_id }
            : {}),
          ...(scope.event_id ? { event_id: scope.event_id } : {}),
        },
        now,
      ),
    ]);
  }

  async #failClaimedMagicLink(
    message: MagicLinkEmailQueueMessage,
    scope: MagicLinkDeliveryRow,
    attempt: number,
    errorCode: string,
    now: Date,
  ): Promise<void> {
    await this.#database.batch([
      this.#database
        .prepare(
          `UPDATE magic_link_tokens
           SET delivery_state = 'failed', revoked_at = ?1,
               delivery_lease_expires_at = NULL, delivery_error_code = ?2
           WHERE id = ?3 AND delivery_state = 'queued' AND revoked_at IS NULL
             AND delivery_completed_at IS NULL AND delivery_attempt_count = ?4`,
        )
        .bind(now.toISOString(), errorCode, message.delivery_id, attempt),
      durableOperationalEventStatement(
        this.#database,
        {
          attempt,
          dedupe_key: `email:${message.delivery_id}:delivery_failed`,
          delivery_id: message.delivery_id,
          error_type: errorCode,
          event: "email.magic_link.failed",
          outcome: "failure",
          queue: "email_send",
          request_id: message.request_id,
          ...(scope.organization_id
            ? { organization_id: scope.organization_id }
            : {}),
          ...(scope.event_id ? { event_id: scope.event_id } : {}),
        },
        now,
      ),
    ]);
  }

  async #recordMagicLink(
    message: MagicLinkEmailQueueMessage,
    scope: MagicLinkDeliveryRow,
    attempt: number,
    outcome: "sent" | "sink",
    now: Date,
    providerMessageId?: string,
  ): Promise<void> {
    await this.#database.batch([
      this.#database
        .prepare(
          `UPDATE magic_link_tokens
           SET delivery_completed_at = ?1, delivery_lease_expires_at = NULL,
               provider_message_id = ?2, delivery_error_code = NULL
           WHERE id = ?3 AND delivery_state = 'queued' AND revoked_at IS NULL
             AND delivery_completed_at IS NULL AND delivery_attempt_count = ?4`,
        )
        .bind(
          now.toISOString(),
          providerMessageId ?? null,
          message.delivery_id,
          attempt,
        ),
      durableOperationalEventStatement(
        this.#database,
        {
          attempt,
          dedupe_key: `email:${message.delivery_id}:${outcome}`,
          delivery_id: message.delivery_id,
          event: `email.magic_link.${outcome}`,
          outcome: "success",
          queue: "email_send",
          request_id: message.request_id,
          ...(scope.organization_id
            ? { organization_id: scope.organization_id }
            : {}),
          ...(scope.event_id ? { event_id: scope.event_id } : {}),
        },
        now,
      ),
    ]);
  }
}
