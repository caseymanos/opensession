import type {
  CampaignEmailCoordinator,
  CampaignEnqueueResult,
} from "../email/delivery.js";
import {
  parseEmailQueueMessage,
  type CampaignEmailQueueMessage,
} from "../email/messages.js";
import { sha256Hex } from "../auth/crypto.js";

interface LifecycleEmailTrigger {
  readonly aggregateId: string;
  readonly aggregateType: string;
  readonly eventId: string;
  readonly eventType:
    | "lifecycle.decision.requested"
    | "lifecycle.receipt.requested"
    | "lifecycle.schedule_change.requested"
    | "lifecycle.task_assignment.requested";
  readonly idempotencyKey: string;
  readonly message: CampaignEmailQueueMessage;
  readonly organizationId: string;
}

interface OutboxRow {
  attempt_count: number;
  event_type: string;
  lease_expires_at: string | null;
  lease_owner: string | null;
  payload_json: string;
  status: "dead" | "failed" | "leased" | "pending" | "published";
}

function payload(message: CampaignEmailQueueMessage): string {
  return JSON.stringify({
    kind: "lifecycle.email.requested",
    message,
    version: 1,
  });
}

function message(value: string): CampaignEmailQueueMessage {
  const parsed = JSON.parse(value) as {
    kind?: unknown;
    message?: unknown;
    version?: unknown;
  };
  if (parsed.kind !== "lifecycle.email.requested" || parsed.version !== 1) {
    throw new TypeError("Lifecycle email outbox payload is invalid.");
  }
  const queueMessage = parseEmailQueueMessage(parsed.message);
  if (queueMessage.kind !== "campaign.email.requested") {
    throw new TypeError("Lifecycle email queue payload is invalid.");
  }
  return queueMessage;
}

export class LifecycleEmailOutbox {
  readonly #coordinator: CampaignEmailCoordinator;
  readonly #database: D1Database;
  readonly #now: () => Date;

  constructor(options: {
    coordinator: CampaignEmailCoordinator;
    database: D1Database;
    now?: () => Date;
  }) {
    this.#coordinator = options.coordinator;
    this.#database = options.database;
    this.#now = options.now ?? (() => new Date());
  }

  async enqueueAndDispatch(
    trigger: LifecycleEmailTrigger,
  ): Promise<CampaignEnqueueResult> {
    const payloadJson = payload(trigger.message);
    const outboxId = `out_${(
      await sha256Hex(
        `lifecycle-email\u0000${trigger.organizationId}\u0000${trigger.idempotencyKey}`,
      )
    ).slice(0, 26)}`;
    const now = this.#now().toISOString();
    await this.#database
      .prepare(
        `INSERT INTO outbox_events (
           id, organization_id, event_id, aggregate_type, aggregate_id,
           event_type, idempotency_key, payload_json, status, available_at,
           created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9, ?9, ?9)
         ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
      )
      .bind(
        outboxId,
        trigger.organizationId,
        trigger.eventId,
        trigger.aggregateType,
        trigger.aggregateId,
        trigger.eventType,
        trigger.idempotencyKey,
        payloadJson,
        now,
      )
      .run();
    const stored = await this.#row(outboxId);
    if (
      !stored ||
      stored.event_type !== trigger.eventType ||
      stored.payload_json !== payloadJson
    ) {
      throw new Error("Lifecycle email outbox idempotency state conflicts.");
    }
    return this.#dispatch(outboxId, stored);
  }

  async #dispatch(
    outboxId: string,
    initial: OutboxRow,
  ): Promise<CampaignEnqueueResult> {
    if (initial.status === "dead") {
      throw new Error("Lifecycle email outbox event is dead-lettered.");
    }
    const nowDate = this.#now();
    const now = nowDate.toISOString();
    const leaseOwner = crypto.randomUUID();
    if (initial.status !== "published") {
      const claimed = await this.#database
        .prepare(
          `UPDATE outbox_events
           SET status = 'leased', lease_owner = ?2, lease_expires_at = ?3,
               attempt_count = attempt_count + 1, updated_at = ?4
           WHERE id = ?1 AND (
             status IN ('pending', 'failed') OR
             (status = 'leased' AND lease_expires_at <= ?4)
           )`,
        )
        .bind(
          outboxId,
          leaseOwner,
          new Date(nowDate.getTime() + 30_000).toISOString(),
          now,
        )
        .run();
      if (claimed.meta.changes !== 1) {
        const winner = await this.#row(outboxId);
        if (winner?.status !== "published") {
          throw new Error("Lifecycle email outbox event is already leased.");
        }
      }
    }
    try {
      const result = await this.#coordinator.enqueue(
        message(initial.payload_json),
      );
      if (result.outcome === "handoff_pending") {
        throw new Error("Lifecycle email queue handoff is pending.");
      }
      await this.#database
        .prepare(
          `UPDATE outbox_events
           SET status = 'published', lease_owner = NULL,
               lease_expires_at = NULL, published_at = COALESCE(published_at, ?2),
               updated_at = ?2, last_error_code = NULL
           WHERE id = ?1 AND status IN ('leased', 'published')`,
        )
        .bind(outboxId, now)
        .run();
      return result;
    } catch (error) {
      await this.#database
        .prepare(
          `UPDATE outbox_events
           SET status = CASE WHEN attempt_count >= 8 THEN 'dead' ELSE 'failed' END,
               lease_owner = NULL, lease_expires_at = NULL,
               available_at = ?2, updated_at = ?3, last_error_code = ?4
           WHERE id = ?1 AND status = 'leased' AND lease_owner = ?5`,
        )
        .bind(
          outboxId,
          new Date(nowDate.getTime() + 30_000).toISOString(),
          now,
          error instanceof Error ? error.name.slice(0, 80) : "OutboxError",
          leaseOwner,
        )
        .run();
      throw error;
    }
  }

  async #row(outboxId: string): Promise<OutboxRow | null> {
    return this.#database
      .prepare(
        `SELECT status, attempt_count, event_type, payload_json,
                lease_owner, lease_expires_at
         FROM outbox_events WHERE id = ?1 LIMIT 1`,
      )
      .bind(outboxId)
      .first<OutboxRow>();
  }
}

export type { LifecycleEmailTrigger };
