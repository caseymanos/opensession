import { createCampaignMessageKey } from "@sessionbox-killer/email";
import type { WebhookEventPayload } from "resend";
import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sha256Hex } from "../src/auth/crypto";
import type { EmailDeliveryConfig } from "../src/email/config";
import {
  CampaignEmailCoordinator,
  EmailQueueDeliveryService,
  pruneExpiredEmailQueuePayloads,
} from "../src/email/delivery";
import type {
  CampaignEmailQueueMessage,
  EmailQueueMessage,
  MagicLinkEmailQueueMessage,
} from "../src/email/messages";
import { serializeMagicLinkDeliveryBinding } from "../src/email/messages";
import type {
  EmailDeliveryProvider,
  EmailProviderSendResult,
} from "../src/email/provider";
import {
  EmailProviderEventIdentityConflictError,
  EmailProviderEventNotReadyError,
  EmailProviderEventService,
  verifyResendWebhook,
} from "../src/email/webhook";
import { durableOperationalEventStatement } from "../src/observability";

const timestamp = "2026-08-09T22:00:00.000Z";
const hash = "a".repeat(64);
const signingBytes = new Uint8Array(32).fill(7);
const webhookSecret = `whsec_${Buffer.from(signingBytes).toString("base64")}`;
const server = createTestHarness({
  workers: [
    {
      configPath: "workers/app/wrangler.jsonc",
      secrets: {
        AUTH_HASH_PEPPER: "email-test-pepper-with-at-least-32-characters",
        RESEND_API_KEY: "re_test_email_delivery",
        RESEND_WEBHOOK_SECRET: webhookSecret,
      },
    },
  ],
});

const sinkConfig: EmailDeliveryConfig = {
  allowlist: [],
  authFrom: "OpenSession <auth@local.opensession.test>",
  authReplyTo: "hello@local.opensession.test",
  mode: "sink",
};
const allowlistConfig: EmailDeliveryConfig = {
  allowlist: ["speaker@example.test"],
  authFrom: "OpenSession <auth@updates.example.test>",
  authReplyTo: "hello@updates.example.test",
  mode: "allowlist",
};

interface ProviderMessageState {
  attempt_count: number;
  error_code: string | null;
  provider_message_id: string | null;
  status: string;
}

type DeliveredProviderEvent = Extract<
  WebhookEventPayload,
  { type: "email.delivered" }
>;

function createQueue(options: { fail?: boolean } = {}) {
  const sent: EmailQueueMessage[] = [];
  const queue = {
    async send(message: EmailQueueMessage) {
      if (options.fail) throw new Error("Queue unavailable");
      sent.push(structuredClone(message));
    },
  } as unknown as Queue<EmailQueueMessage>;
  return { queue, sent };
}

async function campaignMessage(
  label: string,
  recipient = "speaker@example.test",
): Promise<CampaignEmailQueueMessage> {
  const campaignId = `campaign_${label}`;
  const contactId = `contact_${label}`;
  const templateId = "template_submission_receipt";
  return {
    campaign_id: campaignId,
    contact_id: contactId,
    email: {
      from: "OpenSession <hello@updates.example.test>",
      html: `<p>Hello ${label}</p>`,
      replyTo: "program@example.test",
      subject: `Campaign ${label}`,
      text: `Hello ${label}`,
      to: [recipient],
    },
    event_id: "event_email",
    kind: "campaign.email.requested",
    message_id: await createCampaignMessageKey({
      campaignId,
      contactId,
      templateId,
      templateVersion: 1,
    }),
    organization_id: "org_email",
    queued_at: timestamp,
    request_id: `request_${label}`,
    template_id: templateId,
    template_version: 1,
    version: 1,
  };
}

function magicLinkMessage(
  label: string,
  recipient = "speaker@example.test",
): MagicLinkEmailQueueMessage {
  return {
    delivery_id: `magic_${label}`,
    expires_at: "2026-08-09T22:15:00.000Z",
    kind: "auth.magic_link.requested",
    link: `https://app.example.test/auth/magic#token=secret_${label}`,
    purpose: "sign_in",
    request_id: `request_magic_${label}`,
    to: recipient,
    version: 1,
  };
}

async function seedMagicLinkDelivery(
  database: D1Database,
  message: MagicLinkEmailQueueMessage,
  state: "pending" | "queued" = "queued",
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO magic_link_tokens (
         id, email_normalized, purpose, token_hash, redirect_path, created_at,
         expires_at, delivery_state, delivery_recipient_hash,
         delivery_payload_hash
       ) VALUES (?1, ?2, ?3, ?4, '/', ?5, ?6, ?7, ?8, ?9)`,
    )
    .bind(
      message.delivery_id,
      message.to,
      message.purpose,
      await sha256Hex(`token_${message.delivery_id}`),
      timestamp,
      message.expires_at,
      state,
      await sha256Hex(message.to.trim().toLowerCase()),
      await sha256Hex(serializeMagicLinkDeliveryBinding(message)),
    )
    .run();
}

async function messageState(
  database: D1Database,
  id: string,
): Promise<ProviderMessageState | null> {
  return database
    .prepare(
      `SELECT attempt_count, error_code, provider_message_id, status
       FROM provider_messages WHERE id = ?1`,
    )
    .bind(id)
    .first<ProviderMessageState>();
}

function provider(
  results: readonly EmailProviderSendResult[],
  calls: string[],
): EmailDeliveryProvider {
  let index = 0;
  return {
    async send(input) {
      calls.push(input.idempotencyKey);
      const result = results[index++];
      if (!result) throw new Error("Missing provider fixture result");
      return result;
    },
  };
}

async function signature(
  eventId: string,
  eventTimestamp: string,
  payload: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    signingBytes,
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${eventId}.${eventTimestamp}.${payload}`),
  );
  return `v1,${Buffer.from(digest).toString("base64")}`;
}

function deliveredProviderEvent(
  providerMessageId: string,
  createdAt = timestamp,
): DeliveredProviderEvent {
  return {
    created_at: createdAt,
    data: {
      created_at: createdAt,
      email_id: providerMessageId,
      from: "hello@updates.example.test",
      subject: "Delivery",
      to: ["speaker@example.test"],
    },
    type: "email.delivered",
  };
}

async function postSignedWebhook(eventId: string, event: unknown) {
  const eventTimestamp = String(Math.floor(Date.now() / 1_000));
  const payload = JSON.stringify(event);
  return server.fetch("/api/webhooks/resend", {
    body: payload,
    headers: {
      "Content-Type": "application/json",
      "svix-id": eventId,
      "svix-signature": await signature(eventId, eventTimestamp, payload),
      "svix-timestamp": eventTimestamp,
    },
    method: "POST",
  });
}

beforeAll(async () => {
  await server.listen();
  const worker = server.getWorker<Env>();
  await worker.applyD1Migrations("DB");
  const env = await worker.getEnv();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tenant_registry (
         organization_id, base_key, source_record_id, status, created_at, updated_at
       ) VALUES ('org_email', 'base_email', 'rec_org_email', 'active', ?1, ?1)`,
    ).bind(timestamp),
    env.DB.prepare(
      `INSERT INTO p_events (
         id, organization_id, name, slug, timezone, status, source_record_id,
         source_version, source_content_hash, projected_at
       ) VALUES (
         'event_email', 'org_email', 'Email Event', 'email-event', 'UTC',
         'open', 'rec_event_email', 1, ?1, ?2
       )`,
    ).bind(hash, timestamp),
  ]);
});

afterAll(async () => {
  await server.close();
});

describe("campaign email delivery", () => {
  it("leases one queue handoff across concurrent exact replays", async () => {
    const env = await server.getWorker<Env>().getEnv();
    const message = await campaignMessage("concurrent_handoff");
    const sent: EmailQueueMessage[] = [];
    let releaseSend: (() => void) | undefined;
    let markSendStarted: (() => void) | undefined;
    const sendStarted = new Promise<void>((resolve) => {
      markSendStarted = resolve;
    });
    const sendReleased = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const queue = {
      async send(queuedMessage: EmailQueueMessage) {
        sent.push(structuredClone(queuedMessage));
        markSendStarted?.();
        await sendReleased;
      },
    } as unknown as Queue<EmailQueueMessage>;
    const coordinator = new CampaignEmailCoordinator({
      config: sinkConfig,
      database: env.DB,
      now: () => new Date(timestamp),
      queue,
    });

    const first = coordinator.enqueue(message);
    await sendStarted;
    await expect(coordinator.enqueue(message)).resolves.toEqual({
      outcome: "handoff_pending",
      status: "queued",
    });
    expect(sent).toHaveLength(1);

    releaseSend?.();
    await expect(first).resolves.toEqual({ outcome: "queued" });
    expect(sent).toEqual([message]);
  });

  it("accepts consumer proof that races producer handoff confirmation", async () => {
    const env = await server.getWorker<Env>().getEnv();
    const message = await campaignMessage("consumer_confirmation_race");
    const queue = {
      async send() {
        await env.DB.prepare(
          `UPDATE provider_messages
           SET queue_handed_off_at = ?1,
               queue_handoff_lease_expires_at = NULL,
               queue_payload_json = NULL
           WHERE organization_id = ?2 AND id = ?3`,
        )
          .bind(timestamp, message.organization_id, message.message_id)
          .run();
      },
    } as unknown as Queue<EmailQueueMessage>;
    await expect(
      new CampaignEmailCoordinator({
        config: sinkConfig,
        database: env.DB,
        now: () => new Date(timestamp),
        queue,
      }).enqueue(message),
    ).resolves.toEqual({ outcome: "queued" });
    const state = await env.DB.prepare(
      `SELECT queue_handed_off_at, queue_payload_json, status
       FROM provider_messages WHERE id = ?1`,
    )
      .bind(message.message_id)
      .first<{
        queue_handed_off_at: string | null;
        queue_payload_json: string | null;
        status: string;
      }>();
    expect(state).toEqual({
      queue_handed_off_at: timestamp,
      queue_payload_json: null,
      status: "queued",
    });
  });

  it("dedupes durable state and delivers exactly once across repeated queue handoffs", async () => {
    const env = await server.getWorker<Env>().getEnv();
    const message = await campaignMessage("sink");
    const { queue, sent } = createQueue();
    const coordinator = new CampaignEmailCoordinator({
      config: sinkConfig,
      database: env.DB,
      now: () => new Date(timestamp),
      queue,
    });

    await expect(coordinator.enqueue(message)).resolves.toEqual({
      outcome: "queued",
    });
    await expect(coordinator.enqueue(message)).resolves.toEqual({
      outcome: "already_queued",
      status: "queued",
    });
    expect(sent).toHaveLength(1);

    const service = new EmailQueueDeliveryService({
      config: sinkConfig,
      database: env.DB,
      now: () => new Date(timestamp),
    });
    await expect(service.process(sent[0])).resolves.toEqual({ action: "ack" });
    await expect(
      messageState(env.DB, message.message_id),
    ).resolves.toMatchObject({
      attempt_count: 1,
      error_code: null,
      status: "delivered",
    });
    const attempts = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM email_delivery_attempts WHERE message_id = ?1",
    )
      .bind(message.message_id)
      .first<{ count: number }>();
    expect(attempts?.count).toBe(1);
    const minimized = await env.DB.prepare(
      "SELECT queue_payload_json FROM provider_messages WHERE id = ?1",
    )
      .bind(message.message_id)
      .first<{ queue_payload_json: string | null }>();
    expect(minimized?.queue_payload_json).toBeNull();
    await expect(coordinator.replay(message)).resolves.toEqual({
      outcome: "not_replayable",
      status: "delivered",
    });
  });

  it("rejects queued or replayed content that does not match durable state", async () => {
    const env = await server.getWorker<Env>().getEnv();
    const message = await campaignMessage("tamper");
    const acceptedQueue = createQueue();
    const coordinator = new CampaignEmailCoordinator({
      config: sinkConfig,
      database: env.DB,
      now: () => new Date(timestamp),
      queue: acceptedQueue.queue,
    });
    await coordinator.enqueue(message);
    const tampered = {
      ...message,
      email: {
        ...message.email,
        html: "<p>Replaced content</p>",
        to: ["attacker@example.test"],
      },
    } satisfies CampaignEmailQueueMessage;
    const service = new EmailQueueDeliveryService({
      config: sinkConfig,
      database: env.DB,
      now: () => new Date(timestamp),
    });

    await expect(service.process(tampered)).rejects.toThrow(
      "Campaign queue message does not match durable state.",
    );
    await expect(
      messageState(env.DB, message.message_id),
    ).resolves.toMatchObject({ attempt_count: 0, status: "queued" });

    await env.DB.prepare(
      `UPDATE provider_messages SET status = 'failed', error_code = 'test_failure'
       WHERE id = ?1 AND status = 'queued'`,
    )
      .bind(message.message_id)
      .run();
    await expect(coordinator.replay(tampered)).rejects.toThrow(
      "Campaign message does not exist.",
    );
    expect(acceptedQueue.sent).toHaveLength(1);
    await expect(
      messageState(env.DB, message.message_id),
    ).resolves.toMatchObject({ error_code: "test_failure", status: "failed" });
  });

  it("fails closed across delivery-mode changes until an explicit replay", async () => {
    const env = await server.getWorker<Env>().getEnv();
    const message = await campaignMessage("mode_change");
    const deliveryQueue = createQueue();
    await new CampaignEmailCoordinator({
      config: allowlistConfig,
      database: env.DB,
      now: () => new Date(timestamp),
      queue: deliveryQueue.queue,
    }).enqueue(message);

    await expect(
      new EmailQueueDeliveryService({
        config: sinkConfig,
        database: env.DB,
        now: () => new Date(timestamp),
      }).process(deliveryQueue.sent[0]),
    ).resolves.toEqual({ action: "ack" });
    await expect(
      messageState(env.DB, message.message_id),
    ).resolves.toMatchObject({
      attempt_count: 0,
      error_code: "delivery_mode_changed",
      status: "failed",
    });

    const sinkCoordinator = new CampaignEmailCoordinator({
      config: sinkConfig,
      database: env.DB,
      now: () => new Date(timestamp),
      queue: deliveryQueue.queue,
    });
    await expect(sinkCoordinator.replay(message)).resolves.toEqual({
      outcome: "queued",
    });
    await expect(
      new EmailQueueDeliveryService({
        config: sinkConfig,
        database: env.DB,
        now: () => new Date(timestamp),
      }).process(deliveryQueue.sent[1]),
    ).resolves.toEqual({ action: "ack" });
    await expect(
      messageState(env.DB, message.message_id),
    ).resolves.toMatchObject({ attempt_count: 1, status: "delivered" });
  });

  it("retries transient provider failures with one stable provider key", async () => {
    const env = await server.getWorker<Env>().getEnv();
    const message = await campaignMessage("retry");
    const { queue, sent } = createQueue();
    await new CampaignEmailCoordinator({
      config: allowlistConfig,
      database: env.DB,
      now: () => new Date(timestamp),
      queue,
    }).enqueue(message);
    const calls: string[] = [];
    const service = new EmailQueueDeliveryService({
      config: allowlistConfig,
      database: env.DB,
      now: () => new Date(timestamp),
      provider: provider(
        [
          { errorCode: "rate_limit_exceeded", outcome: "retry" },
          { outcome: "sent", providerMessageId: "resend_retry" },
        ],
        calls,
      ),
    });

    await expect(service.process(sent[0])).resolves.toEqual({
      action: "retry",
      delaySeconds: 30,
    });
    await expect(service.process(sent[0])).resolves.toEqual({ action: "ack" });
    expect(calls).toEqual([message.message_id, message.message_id]);
    await expect(
      messageState(env.DB, message.message_id),
    ).resolves.toMatchObject({
      attempt_count: 2,
      provider_message_id: "resend_retry",
      status: "sent",
    });
  });

  it("holds a live claim lease when duplicate queue messages race", async () => {
    const env = await server.getWorker<Env>().getEnv();
    const message = await campaignMessage("lease");
    const { queue, sent } = createQueue();
    await new CampaignEmailCoordinator({
      config: allowlistConfig,
      database: env.DB,
      now: () => new Date(timestamp),
      queue,
    }).enqueue(message);
    let release: ((value: EmailProviderSendResult) => void) | undefined;
    let started: (() => void) | undefined;
    const providerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const providerResult = new Promise<EmailProviderSendResult>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const service = new EmailQueueDeliveryService({
      config: allowlistConfig,
      database: env.DB,
      now: () => new Date(timestamp),
      provider: {
        async send() {
          calls += 1;
          started?.();
          return providerResult;
        },
      },
    });

    const first = service.process(sent[0]);
    await providerStarted;
    await expect(service.process(sent[0])).resolves.toEqual({
      action: "retry",
      delaySeconds: 120,
    });
    expect(calls).toBe(1);
    release?.({ outcome: "sent", providerMessageId: "resend_lease" });
    await expect(first).resolves.toEqual({ action: "ack" });
    expect(calls).toBe(1);
  });

  it("fails closed on suppressions and allowlist misses, then recovers a lost queue handoff", async () => {
    const env = await server.getWorker<Env>().getEnv();
    const suppressed = await campaignMessage(
      "suppression",
      "blocked@example.test",
    );
    const recipientHash = await sha256Hex("blocked@example.test");
    await env.DB.prepare(
      `INSERT INTO email_suppressions (
         organization_id, recipient_hash, reason, created_at, updated_at
       ) VALUES ('org_email', ?1, 'manual', ?2, ?2)`,
    )
      .bind(recipientHash, timestamp)
      .run();
    const sinkQueue = createQueue();
    await expect(
      new CampaignEmailCoordinator({
        config: sinkConfig,
        database: env.DB,
        now: () => new Date(timestamp),
        queue: sinkQueue.queue,
      }).enqueue(suppressed),
    ).resolves.toEqual({ outcome: "suppressed", status: "suppressed" });
    expect(sinkQueue.sent).toHaveLength(0);

    const allowlistMiss = await campaignMessage(
      "allowlist",
      "other@example.test",
    );
    const allowedQueue = createQueue();
    await new CampaignEmailCoordinator({
      config: allowlistConfig,
      database: env.DB,
      now: () => new Date(timestamp),
      queue: allowedQueue.queue,
    }).enqueue(allowlistMiss);
    await expect(
      new EmailQueueDeliveryService({
        config: allowlistConfig,
        database: env.DB,
        now: () => new Date(timestamp),
      }).process(allowedQueue.sent[0]),
    ).resolves.toEqual({ action: "ack" });
    await expect(
      messageState(env.DB, allowlistMiss.message_id),
    ).resolves.toMatchObject({
      error_code: "preview_recipient_not_allowlisted",
      status: "suppressed",
    });

    const rejected = await campaignMessage("queue_failure");
    const rejectedCoordinator = new CampaignEmailCoordinator({
      config: sinkConfig,
      database: env.DB,
      now: () => new Date(timestamp),
      queue: createQueue({ fail: true }).queue,
    });
    await expect(rejectedCoordinator.enqueue(rejected)).rejects.toThrow(
      "Queue unavailable",
    );
    await expect(
      messageState(env.DB, rejected.message_id),
    ).resolves.toMatchObject({
      error_code: null,
      status: "queued",
    });
    const recoveredQueue = createQueue();
    await expect(
      new CampaignEmailCoordinator({
        config: sinkConfig,
        database: env.DB,
        now: () => new Date(timestamp),
        queue: recoveredQueue.queue,
      }).enqueue(rejected),
    ).resolves.toEqual({ outcome: "already_queued", status: "queued" });
    expect(recoveredQueue.sent).toEqual([rejected]);
    await expect(
      new EmailQueueDeliveryService({
        config: sinkConfig,
        database: env.DB,
        now: () => new Date(timestamp),
      }).process(recoveredQueue.sent[0]),
    ).resolves.toEqual({ action: "ack" });
    await expect(
      messageState(env.DB, rejected.message_id),
    ).resolves.toMatchObject({ attempt_count: 1, status: "delivered" });
  });

  it("keeps an accepted original envelope valid when a drifted recovery send rejects", async () => {
    const env = await server.getWorker<Env>().getEnv();
    const original = await campaignMessage("accepted_before_confirmation");
    const accepted: EmailQueueMessage[] = [];
    const confirmationLostQueue = {
      async send(message: EmailQueueMessage) {
        accepted.push(structuredClone(message));
        await env.DB.prepare(
          `UPDATE provider_messages
           SET queue_handoff_lease_expires_at = '2000-01-01T00:00:00.000Z'
           WHERE id = ?1`,
        )
          .bind(original.message_id)
          .run();
      },
    } as unknown as Queue<EmailQueueMessage>;
    await expect(
      new CampaignEmailCoordinator({
        config: sinkConfig,
        database: env.DB,
        now: () => new Date(timestamp),
        queue: confirmationLostQueue,
      }).enqueue(original),
    ).rejects.toThrow("Campaign queue handoff confirmation was lost.");
    expect(accepted).toEqual([original]);

    const drifted = {
      ...original,
      email: { ...original.email, subject: "A newly rendered subject" },
    } satisfies CampaignEmailQueueMessage;
    let replacementAttempt: EmailQueueMessage | null = null;
    const rejectedReplacementQueue = {
      async send(message: EmailQueueMessage) {
        replacementAttempt = structuredClone(message);
        throw new Error("Queue unavailable");
      },
    } as unknown as Queue<EmailQueueMessage>;
    await expect(
      new CampaignEmailCoordinator({
        config: sinkConfig,
        database: env.DB,
        now: () => new Date(timestamp),
        queue: rejectedReplacementQueue,
      }).enqueue(drifted),
    ).rejects.toThrow("Queue unavailable");
    expect(replacementAttempt).toEqual(original);

    await expect(
      new EmailQueueDeliveryService({
        config: sinkConfig,
        database: env.DB,
        now: () => new Date(timestamp),
      }).process(accepted[0]),
    ).resolves.toEqual({ action: "ack" });
    await expect(
      messageState(env.DB, original.message_id),
    ).resolves.toMatchObject({ attempt_count: 1, status: "delivered" });
  });

  it("enforces one CFP receipt identity and expires abandoned envelopes", async () => {
    const env = await server.getWorker<Env>().getEnv();
    const campaignId = "cfp_receipt_submission_database_unique";
    const scopedMessage = async (contactId: string) => {
      const base = await campaignMessage(`receipt_identity_${contactId}`);
      return {
        ...base,
        campaign_id: campaignId,
        contact_id: contactId,
        message_id: await createCampaignMessageKey({
          campaignId,
          contactId,
          templateId: base.template_id,
          templateVersion: base.template_version,
        }),
      } satisfies CampaignEmailQueueMessage;
    };
    const acceptedQueue = createQueue();
    await new CampaignEmailCoordinator({
      config: sinkConfig,
      database: env.DB,
      now: () => new Date(timestamp),
      queue: acceptedQueue.queue,
    }).enqueue(await scopedMessage("contact_receipt_identity_a"));
    await expect(
      new CampaignEmailCoordinator({
        config: sinkConfig,
        database: env.DB,
        now: () => new Date(timestamp),
        queue: acceptedQueue.queue,
      }).enqueue(await scopedMessage("contact_receipt_identity_b")),
    ).rejects.toThrow();
    const identityCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM provider_messages
       WHERE organization_id = 'org_email' AND campaign_id = ?1`,
    )
      .bind(campaignId)
      .first<{ count: number }>();
    expect(identityCount?.count).toBe(1);

    const abandoned = await campaignMessage("abandoned_envelope");
    await expect(
      new CampaignEmailCoordinator({
        config: sinkConfig,
        database: env.DB,
        now: () => new Date(timestamp),
        queue: createQueue({ fail: true }).queue,
      }).enqueue(abandoned),
    ).rejects.toThrow("Queue unavailable");
    await expect(
      new CampaignEmailCoordinator({
        config: sinkConfig,
        database: env.DB,
        now: () => new Date("2026-09-08T22:00:00.000Z"),
        queue: createQueue({ fail: true }).queue,
      }).drainPendingHandoffs(),
    ).rejects.toThrow("Queue unavailable");
    await expect(
      pruneExpiredEmailQueuePayloads(
        env.DB,
        new Date("2026-09-10T22:00:00.000Z"),
      ),
    ).resolves.toBe(1);
    const expired = await env.DB.prepare(
      `SELECT error_code, queue_payload_json, status
       FROM provider_messages WHERE id = ?1`,
    )
      .bind(abandoned.message_id)
      .first<{
        error_code: string | null;
        queue_payload_json: string | null;
        status: string;
      }>();
    expect(expired).toEqual({
      error_code: "queue_handoff_expired",
      queue_payload_json: null,
      status: "failed",
    });
  });

  it("isolates oversized poison envelopes while draining later rows", async () => {
    const env = await server.getWorker<Env>().getEnv();
    const oversizedBase = await campaignMessage("oversized_rejected");
    const oversized = {
      ...oversizedBase,
      email: {
        ...oversizedBase.email,
        html: "h".repeat(70 * 1_024),
        text: "t".repeat(70 * 1_024),
      },
    } satisfies CampaignEmailQueueMessage;
    await expect(
      new CampaignEmailCoordinator({
        config: sinkConfig,
        database: env.DB,
        now: () => new Date(timestamp),
        queue: createQueue().queue,
      }).enqueue(oversized),
    ).rejects.toThrow("Campaign queue payload exceeds 120 KiB.");
    const rejectedCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM provider_messages WHERE id = ?1",
    )
      .bind(oversized.message_id)
      .first<{ count: number }>();
    expect(rejectedCount?.count).toBe(0);

    const poison = await campaignMessage("oversized_poison");
    const following = await campaignMessage("after_oversized_poison");
    const unavailable = createQueue({ fail: true });
    const coordinator = new CampaignEmailCoordinator({
      config: sinkConfig,
      database: env.DB,
      now: () => new Date(timestamp),
      queue: unavailable.queue,
    });
    await expect(coordinator.enqueue(poison)).rejects.toThrow(
      "Queue unavailable",
    );
    await expect(coordinator.enqueue(following)).rejects.toThrow(
      "Queue unavailable",
    );
    await env.DB.prepare(
      "UPDATE provider_messages SET queue_payload_json = ?1 WHERE id = ?2",
    )
      .bind(
        JSON.stringify({ ...oversized, message_id: poison.message_id }),
        poison.message_id,
      )
      .run();
    const recovered = createQueue();
    await expect(
      new CampaignEmailCoordinator({
        config: sinkConfig,
        database: env.DB,
        now: () => new Date(timestamp),
        queue: recovered.queue,
      }).drainPendingHandoffs(),
    ).resolves.toBe(1);
    expect(recovered.sent).toEqual([following]);
    const poisonState = await env.DB.prepare(
      `SELECT error_code, queue_payload_json, status
       FROM provider_messages WHERE id = ?1`,
    )
      .bind(poison.message_id)
      .first<{
        error_code: string | null;
        queue_payload_json: string | null;
        status: string;
      }>();
    expect(poisonState).toEqual({
      error_code: "invalid_queue_payload",
      queue_payload_json: null,
      status: "failed",
    });
  });

  it("replays only failed, unsuppressed messages", async () => {
    const env = await server.getWorker<Env>().getEnv();
    const message = await campaignMessage("replay");
    const firstQueue = createQueue();
    const coordinator = new CampaignEmailCoordinator({
      config: allowlistConfig,
      database: env.DB,
      now: () => new Date(timestamp),
      queue: firstQueue.queue,
    });
    await coordinator.enqueue(message);
    await new EmailQueueDeliveryService({
      config: allowlistConfig,
      database: env.DB,
      now: () => new Date(timestamp),
      provider: provider(
        [{ errorCode: "invalid_from_address", outcome: "failed" }],
        [],
      ),
    }).process(firstQueue.sent[0]);

    await expect(coordinator.replay(message)).resolves.toEqual({
      outcome: "queued",
    });
    expect(firstQueue.sent).toHaveLength(2);
    await expect(
      messageState(env.DB, message.message_id),
    ).resolves.toMatchObject({
      error_code: null,
      status: "queued",
    });
  });
});

describe("magic-link email delivery", () => {
  it("records one durable completion and dedupes queue redelivery", async () => {
    const env = await server.getWorker<Env>().getEnv();
    const message = magicLinkMessage("sink");
    await seedMagicLinkDelivery(env.DB, message);
    const service = new EmailQueueDeliveryService({
      config: sinkConfig,
      database: env.DB,
      now: () => new Date(timestamp),
    });

    await expect(service.process(message)).resolves.toEqual({ action: "ack" });
    await expect(service.process(message)).resolves.toEqual({ action: "ack" });
    const delivery = await env.DB.prepare(
      `SELECT delivery_attempt_count, delivery_completed_at, delivery_mode,
              revoked_at
       FROM magic_link_tokens WHERE id = ?1`,
    )
      .bind(message.delivery_id)
      .first<Record<string, unknown>>();
    const eventCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM operational_events
       WHERE delivery_id = ?1 AND event_type = 'email.magic_link.sink'`,
    )
      .bind(message.delivery_id)
      .first<{ count: number }>();

    expect(delivery).toMatchObject({
      delivery_attempt_count: 1,
      delivery_mode: "sink",
      revoked_at: null,
    });
    expect(delivery?.delivery_completed_at).toBeTruthy();
    expect(eventCount?.count).toBe(1);
  });

  it("promotes a proven queue handoff and rejects altered link payloads", async () => {
    const env = await server.getWorker<Env>().getEnv();
    const pending = magicLinkMessage("pending");
    await seedMagicLinkDelivery(env.DB, pending, "pending");
    const service = new EmailQueueDeliveryService({
      config: sinkConfig,
      database: env.DB,
      now: () => new Date(timestamp),
    });

    const altered = {
      ...pending,
      link: "https://attacker.example.test/capture",
    } satisfies MagicLinkEmailQueueMessage;
    await expect(service.process(altered)).rejects.toThrow(
      "Magic-link queue message does not match durable state.",
    );
    await expect(
      env.DB.prepare(
        "SELECT delivery_state FROM magic_link_tokens WHERE id = ?1",
      )
        .bind(pending.delivery_id)
        .first(),
    ).resolves.toMatchObject({ delivery_state: "pending" });
    await expect(service.process(pending)).resolves.toEqual({ action: "ack" });
  });

  it("persists bounded provider retries with one stable idempotency key", async () => {
    const env = await server.getWorker<Env>().getEnv();
    const message = magicLinkMessage("retry");
    await seedMagicLinkDelivery(env.DB, message);
    const calls: string[] = [];
    const service = new EmailQueueDeliveryService({
      config: allowlistConfig,
      database: env.DB,
      now: () => new Date(timestamp),
      provider: provider(
        Array.from({ length: 5 }, () => ({
          errorCode: "rate_limit_exceeded",
          outcome: "retry" as const,
        })),
        calls,
      ),
    });

    await expect(service.process(message)).resolves.toEqual({
      action: "retry",
      delaySeconds: 30,
    });
    await expect(service.process(message)).resolves.toEqual({
      action: "retry",
      delaySeconds: 120,
    });
    await expect(service.process(message)).resolves.toEqual({
      action: "retry",
      delaySeconds: 600,
    });
    await expect(service.process(message)).resolves.toEqual({
      action: "retry",
      delaySeconds: 1_800,
    });
    await expect(service.process(message)).resolves.toEqual({ action: "ack" });
    expect(calls).toEqual(Array(5).fill(`auth_${message.delivery_id}`));
    const delivery = await env.DB.prepare(
      `SELECT delivery_attempt_count, delivery_error_code, delivery_state,
              revoked_at
       FROM magic_link_tokens WHERE id = ?1`,
    )
      .bind(message.delivery_id)
      .first<Record<string, unknown>>();
    expect(delivery).toMatchObject({
      delivery_attempt_count: 5,
      delivery_error_code: "retry_exhausted",
      delivery_state: "failed",
    });
    expect(delivery?.revoked_at).toBeTruthy();
  });

  it("revokes a link that cannot pass the environment allowlist", async () => {
    const env = await server.getWorker<Env>().getEnv();
    const message = magicLinkMessage("blocked", "blocked@example.test");
    await seedMagicLinkDelivery(env.DB, message);
    const calls: string[] = [];
    const service = new EmailQueueDeliveryService({
      config: allowlistConfig,
      database: env.DB,
      now: () => new Date(timestamp),
      provider: provider(
        [{ outcome: "sent", providerMessageId: "must_not_send" }],
        calls,
      ),
    });

    await expect(service.process(message)).resolves.toEqual({ action: "ack" });
    expect(calls).toHaveLength(0);
    const delivery = await env.DB.prepare(
      `SELECT delivery_error_code, delivery_state, revoked_at
       FROM magic_link_tokens WHERE id = ?1`,
    )
      .bind(message.delivery_id)
      .first<Record<string, unknown>>();
    expect(delivery).toMatchObject({
      delivery_error_code: "preview_recipient_not_allowlisted",
      delivery_state: "failed",
    });
    expect(delivery?.revoked_at).toBeTruthy();
  });
});

describe("Resend provider events", () => {
  it("verifies raw signatures and rejects modified payloads", async () => {
    const eventId = "webhook_signature_01";
    const eventTimestamp = String(Math.floor(Date.now() / 1_000));
    const payload = JSON.stringify({
      data: { email_id: "resend_none" },
      type: "email.sent",
    });
    const signed = await signature(eventId, eventTimestamp, payload);

    expect(
      verifyResendWebhook({
        apiKey: "re_test_webhook_verification",
        id: eventId,
        payload,
        secret: webhookSecret,
        signature: signed,
        timestamp: eventTimestamp,
      }).eventId,
    ).toBe(eventId);
    expect(() =>
      verifyResendWebhook({
        apiKey: "re_test_webhook_verification",
        id: eventId,
        payload: `${payload} `,
        secret: webhookSecret,
        signature: signed,
        timestamp: eventTimestamp,
      }),
    ).toThrow();
  });

  it("bounds foreign-event retries with an immutable digest-only quarantine", async () => {
    const env = await server.getWorker<Env>().getEnv();
    const eventId = "provider_event_foreign_01";
    const eventIdHash = await sha256Hex(eventId);
    const event = deliveredProviderEvent("resend_foreign_private_identifier");
    const payload = JSON.stringify(event);
    const payloadHash = await sha256Hex(payload);
    let currentTime = new Date(timestamp);
    const service = new EmailProviderEventService({
      database: env.DB,
      now: () => currentTime,
    });
    await durableOperationalEventStatement(
      env.DB,
      {
        dedupe_key: "email:provider-event:expired:retention-fixture",
        event: "email.provider_event.pending",
        job_id: "retention_fixture",
        outcome: "failure",
      },
      new Date(Date.parse(timestamp) - 31 * 24 * 60 * 60 * 1_000),
    ).run();

    await expect(
      service.apply({ event, eventId, rawPayload: payload }),
    ).rejects.toBeInstanceOf(EmailProviderEventNotReadyError);
    await expect(
      env.DB.prepare(
        `SELECT id FROM operational_events
         WHERE dedupe_key = 'email:provider-event:expired:retention-fixture'`,
      ).first(),
    ).resolves.toBeNull();
    const firstSeen = await env.DB.prepare(
      `SELECT command_id, dedupe_key, event_type, expires_at, occurred_at,
              outcome, response_status
       FROM operational_events WHERE job_id = ?1 ORDER BY id`,
    )
      .bind(eventIdHash)
      .all<Record<string, unknown>>();
    expect(firstSeen.results).toEqual([
      expect.objectContaining({
        command_id: payloadHash,
        event_type: "email.provider_event.pending",
        occurred_at: timestamp,
        outcome: "failure",
        response_status: 503,
      }),
    ]);
    expect(
      Date.parse(String(firstSeen.results[0]?.expires_at)) -
        Date.parse(timestamp),
    ).toBe(30 * 24 * 60 * 60 * 1_000);
    const serializedReceipt = JSON.stringify(firstSeen.results);
    expect(serializedReceipt).not.toContain("resend_foreign");
    expect(serializedReceipt).not.toContain("speaker@example.test");

    currentTime = new Date(Date.parse(timestamp) + 5 * 60 * 1_000);
    await expect(
      service.apply({ event, eventId, rawPayload: payload }),
    ).rejects.toBeInstanceOf(EmailProviderEventNotReadyError);
    const pendingCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count, MIN(occurred_at) AS first_seen
       FROM operational_events WHERE job_id = ?1`,
    )
      .bind(eventIdHash)
      .first<{ count: number; first_seen: string }>();
    expect(pendingCount).toEqual({ count: 1, first_seen: timestamp });

    const alteredPayload = JSON.stringify({ ...event, type: "email.sent" });
    await expect(
      service.apply({ event, eventId, rawPayload: alteredPayload }),
    ).rejects.toBeInstanceOf(EmailProviderEventIdentityConflictError);

    currentTime = new Date(Date.parse(timestamp) + 16 * 60 * 1_000);
    await expect(
      service.apply({ event, eventId, rawPayload: payload }),
    ).resolves.toBe("quarantined");
    currentTime = new Date(Date.parse(timestamp) + 17 * 60 * 1_000);
    await expect(
      service.apply({ event, eventId, rawPayload: payload }),
    ).resolves.toBe("quarantined");

    const quarantined = await env.DB.prepare(
      `SELECT command_id, event_type, expires_at, occurred_at, outcome,
              response_status
       FROM operational_events WHERE job_id = ?1 ORDER BY id`,
    )
      .bind(eventIdHash)
      .all<Record<string, unknown>>();
    expect(quarantined.results).toEqual([
      expect.objectContaining({
        command_id: payloadHash,
        event_type: "email.provider_event.pending",
        occurred_at: timestamp,
      }),
      expect.objectContaining({
        command_id: payloadHash,
        event_type: "email.provider_event.quarantined",
        occurred_at: "2026-08-09T22:16:00.000Z",
        outcome: "accepted",
        response_status: 200,
      }),
    ]);
    expect(
      Date.parse(String(quarantined.results[1]?.expires_at)) -
        Date.parse(String(quarantined.results[1]?.occurred_at)),
    ).toBe(30 * 24 * 60 * 60 * 1_000);
    const providerEventCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM email_provider_events
       WHERE provider_event_id = ?1`,
    )
      .bind(eventId)
      .first<{ count: number }>();
    expect(providerEventCount?.count).toBe(0);
  });

  it("applies a provider event when its message becomes durable during grace", async () => {
    const env = await server.getWorker<Env>().getEnv();
    const eventId = "provider_event_persistence_race_01";
    const event = deliveredProviderEvent("resend_persistence_race");
    const payload = JSON.stringify(event);
    let currentTime = new Date(timestamp);
    const service = new EmailProviderEventService({
      database: env.DB,
      now: () => currentTime,
    });

    await expect(
      service.apply({ event, eventId, rawPayload: payload }),
    ).rejects.toBeInstanceOf(EmailProviderEventNotReadyError);
    const message = await campaignMessage("provider_persistence_race");
    const queue = createQueue();
    await new CampaignEmailCoordinator({
      config: allowlistConfig,
      database: env.DB,
      now: () => new Date(timestamp),
      queue: queue.queue,
    }).enqueue(message);
    await new EmailQueueDeliveryService({
      config: allowlistConfig,
      database: env.DB,
      now: () => new Date(timestamp),
      provider: provider(
        [
          {
            outcome: "sent",
            providerMessageId: "resend_persistence_race",
          },
        ],
        [],
      ),
    }).process(queue.sent[0]);

    currentTime = new Date(Date.parse(timestamp) + 5 * 60 * 1_000);
    const drifted = {
      ...event,
      type: "email.complained",
    } satisfies WebhookEventPayload;
    const driftedResponse = await postSignedWebhook(eventId, drifted);
    expect(driftedResponse.status).toBe(503);
    await expect(
      messageState(env.DB, message.message_id),
    ).resolves.toMatchObject({ status: "sent" });
    const driftMutationCount = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM email_provider_events
          WHERE provider_event_id = ?1) AS event_count,
         (SELECT COUNT(*) FROM email_suppressions
          WHERE source_provider_event_id = ?1) AS suppression_count`,
    )
      .bind(eventId)
      .first<{ event_count: number; suppression_count: number }>();
    expect(driftMutationCount).toEqual({
      event_count: 0,
      suppression_count: 0,
    });
    await expect(
      service.apply({ event, eventId, rawPayload: payload }),
    ).resolves.toBe("applied");
    await expect(
      service.apply({ event, eventId, rawPayload: payload }),
    ).resolves.toBe("duplicate");
    await expect(
      service.apply({
        event,
        eventId,
        rawPayload: JSON.stringify({ ...event, type: "email.sent" }),
      }),
    ).rejects.toBeInstanceOf(EmailProviderEventIdentityConflictError);
    const quarantineCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM operational_events
       WHERE job_id = ?1 AND event_type = 'email.provider_event.quarantined'`,
    )
      .bind(await sha256Hex(eventId))
      .first<{ count: number }>();
    expect(quarantineCount?.count).toBe(0);
  });

  it("applies instead of quarantining when the provider message wins the final race", async () => {
    const env = await server.getWorker<Env>().getEnv();
    const message = await campaignMessage("provider_quarantine_race");
    const queue = createQueue();
    await new CampaignEmailCoordinator({
      config: allowlistConfig,
      database: env.DB,
      now: () => new Date(timestamp),
      queue: queue.queue,
    }).enqueue(message);
    await new EmailQueueDeliveryService({
      config: allowlistConfig,
      database: env.DB,
      now: () => new Date(timestamp),
      provider: provider(
        [
          {
            outcome: "sent",
            providerMessageId: "resend_quarantine_race",
          },
        ],
        [],
      ),
    }).process(queue.sent[0]);
    const eventId = "provider_event_quarantine_race_01";
    const event = deliveredProviderEvent("resend_quarantine_race");
    const payload = JSON.stringify(event);
    const eventIdHash = await sha256Hex(eventId);
    const payloadHash = await sha256Hex(payload);
    await durableOperationalEventStatement(
      env.DB,
      {
        command_id: payloadHash,
        dedupe_key: `email:provider-event:pending:${eventIdHash}`,
        error_type: "provider_event_not_ready",
        event: "email.provider_event.pending",
        job_id: eventIdHash,
        outcome: "failure",
      },
      new Date(timestamp),
    ).run();

    let hideFirstMessageRead = true;
    const database = {
      batch: env.DB.batch.bind(env.DB),
      prepare(query: string) {
        if (
          hideFirstMessageRead &&
          query.includes("SELECT id, organization_id") &&
          query.includes("FROM provider_messages")
        ) {
          hideFirstMessageRead = false;
          const statement = {
            bind: () => statement,
            first: async () => null,
          } as unknown as D1PreparedStatement;
          return statement;
        }
        return env.DB.prepare(query);
      },
    } as unknown as D1Database;
    const service = new EmailProviderEventService({
      database,
      now: () => new Date(Date.parse(timestamp) + 16 * 60 * 1_000),
    });

    await expect(
      service.apply({ event, eventId, rawPayload: payload }),
    ).resolves.toBe("applied");
    expect(hideFirstMessageRead).toBe(false);
    await expect(
      messageState(env.DB, message.message_id),
    ).resolves.toMatchObject({ status: "delivered" });
    const quarantineCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM operational_events
       WHERE job_id = ?1 AND event_type = 'email.provider_event.quarantined'`,
    )
      .bind(eventIdHash)
      .first<{ count: number }>();
    expect(quarantineCount?.count).toBe(0);
  });

  it("dedupes events, preserves terminal order, and suppresses complaints", async () => {
    const env = await server.getWorker<Env>().getEnv();
    const message = await campaignMessage("webhook");
    const queue = createQueue();
    await new CampaignEmailCoordinator({
      config: allowlistConfig,
      database: env.DB,
      now: () => new Date(timestamp),
      queue: queue.queue,
    }).enqueue(message);
    await new EmailQueueDeliveryService({
      config: allowlistConfig,
      database: env.DB,
      now: () => new Date(timestamp),
      provider: provider(
        [{ outcome: "sent", providerMessageId: "resend_webhook" }],
        [],
      ),
    }).process(queue.sent[0]);
    const service = new EmailProviderEventService({
      database: env.DB,
      now: () => new Date(timestamp),
    });
    const delivered = {
      created_at: timestamp,
      data: {
        created_at: timestamp,
        email_id: "resend_webhook",
        from: "hello@updates.example.test",
        subject: "Delivery",
        to: ["speaker@example.test"],
      },
      type: "email.delivered",
    } satisfies WebhookEventPayload;
    await expect(
      service.apply({
        event: delivered,
        eventId: "provider_event_01",
        rawPayload: JSON.stringify(delivered),
      }),
    ).resolves.toBe("applied");
    await expect(
      service.apply({
        event: delivered,
        eventId: "provider_event_01",
        rawPayload: JSON.stringify(delivered),
      }),
    ).resolves.toBe("duplicate");
    const complained = {
      ...delivered,
      type: "email.complained",
    } satisfies WebhookEventPayload;
    await expect(
      service.apply({
        event: complained,
        eventId: "provider_event_02",
        rawPayload: JSON.stringify(complained),
      }),
    ).resolves.toBe("applied");
    await expect(
      service.apply({
        event: delivered,
        eventId: "provider_event_03",
        rawPayload: JSON.stringify(delivered),
      }),
    ).resolves.toBe("applied");
    const olderBounce = {
      ...delivered,
      created_at: "2026-08-09T21:00:00.000Z",
      data: {
        ...delivered.data,
        bounce: {
          message: "Mailbox unavailable",
          subType: "General",
          type: "Permanent",
        },
      },
      type: "email.bounced",
    } satisfies WebhookEventPayload;
    await expect(
      service.apply({
        event: olderBounce,
        eventId: "provider_event_04",
        rawPayload: JSON.stringify(olderBounce),
      }),
    ).resolves.toBe("applied");
    await expect(
      messageState(env.DB, message.message_id),
    ).resolves.toMatchObject({
      status: "complained",
    });
    const suppression = await env.DB.prepare(
      `SELECT reason FROM email_suppressions
       WHERE organization_id = 'org_email' AND recipient_hash = ?1`,
    )
      .bind(await sha256Hex("speaker@example.test"))
      .first<{ reason: string }>();
    expect(suppression?.reason).toBe("complained");

    await env.DB.prepare(
      `UPDATE email_suppressions SET reason = 'manual', updated_at = ?1
       WHERE organization_id = 'org_email' AND recipient_hash = ?2`,
    )
      .bind(timestamp, await sha256Hex("speaker@example.test"))
      .run();
    const newerBounce = {
      ...delivered,
      created_at: "2026-08-09T23:00:00.000Z",
      data: {
        ...delivered.data,
        bounce: {
          message: "Mailbox unavailable",
          subType: "General",
          type: "Permanent",
        },
      },
      type: "email.bounced",
    } satisfies WebhookEventPayload;
    await expect(
      service.apply({
        event: newerBounce,
        eventId: "provider_event_05",
        rawPayload: JSON.stringify(newerBounce),
      }),
    ).resolves.toBe("applied");
    const manualSuppression = await env.DB.prepare(
      `SELECT reason FROM email_suppressions
       WHERE organization_id = 'org_email' AND recipient_hash = ?1`,
    )
      .bind(await sha256Hex("speaker@example.test"))
      .first<{ reason: string }>();
    expect(manualSuppression?.reason).toBe("manual");
    await expect(
      messageState(env.DB, message.message_id),
    ).resolves.toMatchObject({ status: "complained" });
  });

  it("accepts one signed route delivery and rejects its altered signature", async () => {
    const eventId = "provider_route_01";
    const eventTimestamp = String(Math.floor(Date.now() / 1_000));
    const event = {
      created_at: new Date().toISOString(),
      data: {
        created_at: timestamp,
        email_id: "resend_webhook",
        from: "hello@updates.example.test",
        subject: "Delivery",
        to: ["speaker@example.test"],
      },
      type: "email.sent",
    } satisfies WebhookEventPayload;
    const payload = JSON.stringify(event);
    const headers = {
      "Content-Type": "application/json",
      "svix-id": eventId,
      "svix-signature": await signature(eventId, eventTimestamp, payload),
      "svix-timestamp": eventTimestamp,
    };

    const accepted = await server.fetch("/api/webhooks/resend", {
      body: payload,
      headers,
      method: "POST",
    });
    expect(accepted.status).toBe(200);
    const rejected = await server.fetch("/api/webhooks/resend", {
      body: `${payload} `,
      headers,
      method: "POST",
    });
    expect(rejected.status).toBe(400);
  });

  it("requests a retry for a signed event without a durable message", async () => {
    const response = await postSignedWebhook(
      "provider_route_foreign_01",
      deliveredProviderEvent("resend_route_foreign", new Date().toISOString()),
    );

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toBe("Try again later.");
  });

  it("does not receipt malformed signed provider events", async () => {
    const env = await server.getWorker<Env>().getEnv();
    const malformedEvents = [
      {
        created_at: "not-a-timestamp",
        data: { email_id: "resend_malformed_timestamp" },
        type: "email.delivered",
      },
      {
        created_at: new Date().toISOString(),
        data: { email_id: 42 },
        type: "email.delivered",
      },
    ];

    for (const [index, event] of malformedEvents.entries()) {
      const eventId = `provider_route_malformed_0${index + 1}`;
      const response = await postSignedWebhook(eventId, event);
      expect(response.status).toBe(503);
      const receiptCount = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM operational_events WHERE job_id = ?1",
      )
        .bind(await sha256Hex(eventId))
        .first<{ count: number }>();
      expect(receiptCount?.count).toBe(0);
    }
  });

  it("acknowledges a signed foreign event after its durable grace expires", async () => {
    const env = await server.getWorker<Env>().getEnv();
    const eventId = "provider_route_quarantine_01";
    const event = deliveredProviderEvent(
      "resend_route_quarantine",
      new Date().toISOString(),
    );
    const payload = JSON.stringify(event);
    const eventIdHash = await sha256Hex(eventId);
    const payloadHash = await sha256Hex(payload);
    const firstSeen = new Date(Date.now() - 16 * 60 * 1_000);
    await durableOperationalEventStatement(
      env.DB,
      {
        command_id: payloadHash,
        dedupe_key: `email:provider-event:pending:${eventIdHash}`,
        error_type: "provider_event_not_ready",
        event: "email.provider_event.pending",
        job_id: eventIdHash,
        method: "POST",
        outcome: "failure",
        route: "/api/webhooks/resend",
        status: 503,
      },
      firstSeen,
    ).run();
    const accepted = await postSignedWebhook(eventId, event);
    expect(accepted.status).toBe(200);
    await expect(accepted.text()).resolves.toBe("OK");
    const replayed = await postSignedWebhook(eventId, event);
    expect(replayed.status).toBe(200);
    const quarantineCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM operational_events
       WHERE job_id = ?1 AND event_type = 'email.provider_event.quarantined'`,
    )
      .bind(eventIdHash)
      .first<{ count: number }>();
    expect(quarantineCount?.count).toBe(1);
  });
});
