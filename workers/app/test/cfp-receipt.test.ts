import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CampaignEmailQueueMessage } from "../src/email/messages";
import {
  CampaignEmailCoordinator,
  EmailQueueDeliveryService,
} from "../src/email/delivery";
import {
  enqueueCfpSubmissionReceipt,
  hasConfirmedCfpSubmissionReceipt,
  requireCfpReceiptDelivery,
} from "../src/cfp/receipt";

const timestamp = "2026-08-10T15:00:00.000Z";
const sourceHash = "a".repeat(64);
const server = createTestHarness({
  workers: [{ configPath: "workers/app/wrangler.jsonc" }],
});

const deliveryConfig = {
  allowlist: [],
  authFrom: "OpenSession <auth@local.opensession.test>",
  authReplyTo: "hello@local.opensession.test",
  mode: "sink" as const,
};

function receiptOptions(
  database: D1Database,
  queue: Queue<CampaignEmailQueueMessage>,
  suffix: string,
) {
  return {
    coordinates: {
      friendlyId: `OS-RECEIPT-${suffix.toUpperCase()}`,
      planId: `cfp_plan_receipt_${suffix}`,
      requestHash: suffix.padEnd(64, "a"),
      submissionId: `submission_receipt_${suffix}`,
    },
    database,
    deliveryConfig,
    environment: "local" as const,
    event: {
      id: "event_cfp_receipt",
      name: "OpenSession Summit",
      slug: "opensession-summit",
    },
    now: () => new Date(timestamp),
    organizationId: "org_cfp_receipt",
    portalOrigin: "https://opensessionboard.com",
    queue,
    request: {
      answers: { title: `Trustworthy systems ${suffix}` },
      expected_source_version: 3,
      form_version: 2,
      mode: "submit" as const,
      participant_consent: true as const,
      participants: [
        {
          email: "primary@example.test",
          id: `participant_${suffix}`,
          name: "Casey Speaker",
          role: "Principal Engineer",
        },
      ],
      turnstile_action: "cfp_submit" as const,
      turnstile_token: "XXXX.DUMMY.TOKEN.XXXX",
    },
    requestId: `request_receipt_${suffix}`,
  };
}

function queue(options: { fail?: boolean } = {}) {
  const messages: CampaignEmailQueueMessage[] = [];
  return {
    binding: {
      async send(message: CampaignEmailQueueMessage) {
        if (options.fail) throw new Error("Queue unavailable");
        messages.push(structuredClone(message));
      },
    } as unknown as Queue<CampaignEmailQueueMessage>,
    messages,
  };
}

beforeAll(async () => {
  await server.listen();
  const worker = server.getWorker<Env>();
  await worker.applyD1Migrations("DB");
  const environment = await worker.getEnv();
  await environment.DB.batch([
    environment.DB.prepare(
      `INSERT INTO tenant_registry (
         organization_id, base_key, source_record_id, status, created_at, updated_at
       ) VALUES (
         'org_cfp_receipt', 'base_cfp_receipt', 'rec_org_cfp_receipt',
         'active', ?1, ?1
       )`,
    ).bind(timestamp),
    environment.DB.prepare(
      `INSERT INTO p_events (
         id, organization_id, name, slug, timezone, status, source_record_id,
         source_version, source_content_hash, projected_at
       ) VALUES (
         'event_cfp_receipt', 'org_cfp_receipt', 'OpenSession Summit',
         'opensession-summit', 'UTC', 'open', 'rec_event_cfp_receipt',
         1, ?1, ?2
       )`,
    ).bind(sourceHash, timestamp),
    environment.DB.prepare(
      `INSERT INTO p_contacts (
         id, organization_id, email_normalized, display_name, title,
         source_record_id, source_version, source_content_hash, projected_at
       ) VALUES (
         'contact_cfp_primary', 'org_cfp_receipt', 'primary@example.test',
         'Casey Speaker', 'Principal Engineer', 'rec_contact_cfp_primary',
         2, ?1, ?2
       )`,
    ).bind(sourceHash, timestamp),
  ]);
});

afterAll(async () => {
  await server.close();
});

describe("CFP submission receipts", () => {
  it("fails final delivery readiness closed outside a preview allowlist", () => {
    expect(() =>
      requireCfpReceiptDelivery(
        {
          ...deliveryConfig,
          allowlist: [],
          mode: "allowlist",
        },
        "preview",
        "primary@example.test",
      ),
    ).toThrow("Receipt delivery is not enabled for this address.");
    expect(() =>
      requireCfpReceiptDelivery(
        {
          ...deliveryConfig,
          allowlist: ["primary@example.test"],
          mode: "allowlist",
        },
        "preview",
        "PRIMARY@example.test",
      ),
    ).not.toThrow();
  });

  it("renders and durably deduplicates one receipt through provider completion", async () => {
    const environment = await server.getWorker<Env>().getEnv();
    const emailQueue = queue();
    const options = receiptOptions(
      environment.DB,
      emailQueue.binding,
      "dedupe",
    );

    await expect(enqueueCfpSubmissionReceipt(options)).resolves.toEqual({
      outcome: "queued",
    });
    await expect(enqueueCfpSubmissionReceipt(options)).resolves.toEqual({
      outcome: "already_queued",
      status: "queued",
    });
    expect(emailQueue.messages).toHaveLength(1);
    expect(emailQueue.messages[0]).toMatchObject({
      email: {
        subject: "We received OS-RECEIPT-DEDUPE for OpenSession Summit",
        to: ["primary@example.test"],
      },
      event_id: "event_cfp_receipt",
      organization_id: "org_cfp_receipt",
      contact_id: "contact_cfp_primary",
      template_id: "template_submission_receipt",
    });
    expect(emailQueue.messages[0]?.email.html).toContain(
      "Trustworthy systems dedupe",
    );
    expect(emailQueue.messages[0]?.email.html).toContain(
      "https://opensessionboard.com/e/opensession-summit/cfp",
    );

    const service = new EmailQueueDeliveryService({
      config: deliveryConfig,
      database: environment.DB,
      now: () => new Date(timestamp),
    });
    await expect(service.process(emailQueue.messages[0])).resolves.toEqual({
      action: "ack",
    });
    await expect(enqueueCfpSubmissionReceipt(options)).resolves.toEqual({
      outcome: "already_terminal",
      status: "delivered",
    });
    expect(emailQueue.messages).toHaveLength(1);

    const state = await environment.DB.prepare(
      `SELECT COUNT(*) AS count, COUNT(contact.id) AS contact_count,
              MAX(message.attempt_count) AS attempts, MAX(message.status) AS status
       FROM provider_messages AS message
       LEFT JOIN p_contacts AS contact
         ON contact.organization_id = message.organization_id
        AND contact.id = message.contact_id
       WHERE message.organization_id = 'org_cfp_receipt'
         AND message.campaign_id = 'cfp_receipt_submission_receipt_dedupe'`,
    ).first<{
      attempts: number;
      contact_count: number;
      count: number;
      status: string;
    }>();
    expect(state).toEqual({
      attempts: 1,
      contact_count: 1,
      count: 1,
      status: "delivered",
    });
  });

  it("uses the authority's canonical fallback for a valid title-less form", async () => {
    const environment = await server.getWorker<Env>().getEnv();
    const emailQueue = queue();
    const base = receiptOptions(
      environment.DB,
      emailQueue.binding,
      "titleless",
    );

    await expect(
      enqueueCfpSubmissionReceipt({
        ...base,
        request: { ...base.request, answers: {} },
      }),
    ).resolves.toEqual({ outcome: "queued" });
    expect(emailQueue.messages[0]?.email.subject).toBe(
      "We received OS-RECEIPT-TITLELESS for OpenSession Summit",
    );
    expect(emailQueue.messages[0]?.email.text).toContain("Untitled proposal");
  });

  it("autonomously recovers a rejected handoff after the client disappears", async () => {
    const environment = await server.getWorker<Env>().getEnv();
    const rejectedQueue = queue({ fail: true });
    await expect(
      enqueueCfpSubmissionReceipt(
        receiptOptions(environment.DB, rejectedQueue.binding, "recovery"),
      ),
    ).rejects.toThrow("Queue unavailable");

    const recoveredQueue = queue();
    await expect(
      new CampaignEmailCoordinator({
        config: deliveryConfig,
        database: environment.DB,
        now: () => new Date(timestamp),
        queue: recoveredQueue.binding,
      }).drainPendingHandoffs(),
    ).resolves.toBe(1);
    expect(recoveredQueue.messages).toHaveLength(1);
    await expect(
      new EmailQueueDeliveryService({
        config: deliveryConfig,
        database: environment.DB,
        now: () => new Date(timestamp),
      }).process(recoveredQueue.messages[0]),
    ).resolves.toEqual({ action: "ack" });
    const state = await environment.DB.prepare(
      `SELECT COUNT(*) AS count, MAX(status) AS status
       FROM provider_messages
       WHERE organization_id = 'org_cfp_receipt'
         AND campaign_id = 'cfp_receipt_submission_receipt_recovery'`,
    ).first<{ count: number; status: string }>();
    expect(state).toEqual({ count: 1, status: "delivered" });
  });

  it("freezes the original envelope until its queue handoff is confirmed", async () => {
    const environment = await server.getWorker<Env>().getEnv();
    const rejectedQueue = queue({ fail: true });
    const original = receiptOptions(
      environment.DB,
      rejectedQueue.binding,
      "drift",
    );
    await expect(enqueueCfpSubmissionReceipt(original)).rejects.toThrow(
      "Queue unavailable",
    );

    const recoveredQueue = queue();
    const changed = receiptOptions(
      environment.DB,
      recoveredQueue.binding,
      "drift",
    );
    await expect(
      enqueueCfpSubmissionReceipt({
        ...changed,
        event: { ...changed.event, name: "Renamed OpenSession Summit" },
      }),
    ).resolves.toEqual({ outcome: "already_queued", status: "queued" });
    expect(recoveredQueue.messages).toHaveLength(1);
    expect(recoveredQueue.messages[0]?.email.subject).toContain(
      "OpenSession Summit",
    );
    expect(recoveredQueue.messages[0]?.email.subject).not.toContain("Renamed");
    await expect(
      new EmailQueueDeliveryService({
        config: deliveryConfig,
        database: environment.DB,
        now: () => new Date(timestamp),
      }).process(recoveredQueue.messages[0]),
    ).resolves.toEqual({ action: "ack" });
    const state = await environment.DB.prepare(
      `SELECT COUNT(*) AS count, MAX(attempt_count) AS attempts,
              MAX(status) AS status
       FROM provider_messages
       WHERE organization_id = 'org_cfp_receipt'
         AND campaign_id = 'cfp_receipt_submission_receipt_drift'`,
    ).first<{ attempts: number; count: number; status: string }>();
    expect(state).toEqual({ attempts: 1, count: 1, status: "delivered" });
  });

  it("reuses confirmed receipt identity across config and contact-lineage changes", async () => {
    const environment = await server.getWorker<Env>().getEnv();
    const emailQueue = queue();
    const options = receiptOptions(
      environment.DB,
      emailQueue.binding,
      "stable-lineage",
    );
    await enqueueCfpSubmissionReceipt(options);
    await expect(hasConfirmedCfpSubmissionReceipt(options)).resolves.toBe(true);

    await environment.DB.prepare(
      `UPDATE p_contacts SET id = 'contact_cfp_primary_replaced'
       WHERE organization_id = 'org_cfp_receipt'
         AND id = 'contact_cfp_primary'`,
    ).run();
    try {
      await expect(
        enqueueCfpSubmissionReceipt({
          ...options,
          deliveryConfig: { mode: "invalid" },
        }),
      ).resolves.toEqual({ outcome: "already_queued", status: "queued" });
      const count = await environment.DB.prepare(
        `SELECT COUNT(*) AS count FROM provider_messages
         WHERE organization_id = 'org_cfp_receipt'
           AND campaign_id = 'cfp_receipt_submission_receipt_stable-lineage'`,
      ).first<{ count: number }>();
      expect(count?.count).toBe(1);
      expect(emailQueue.messages).toHaveLength(1);
    } finally {
      await environment.DB.prepare(
        `UPDATE p_contacts SET id = 'contact_cfp_primary'
         WHERE organization_id = 'org_cfp_receipt'
           AND id = 'contact_cfp_primary_replaced'`,
      ).run();
    }
  });

  it("treats consumer receipt as handoff proof after producer confirmation loss", async () => {
    const environment = await server.getWorker<Env>().getEnv();
    const accepted: CampaignEmailQueueMessage[] = [];
    const liveConfig = {
      ...deliveryConfig,
      allowlist: ["primary@example.test"],
      mode: "allowlist" as const,
    };
    const lostConfirmationQueue = {
      async send(message: CampaignEmailQueueMessage) {
        accepted.push(structuredClone(message));
        await environment.DB.prepare(
          `UPDATE provider_messages
           SET queue_handoff_lease_expires_at = '2000-01-01T00:00:00.000Z'
           WHERE id = ?1`,
        )
          .bind(message.message_id)
          .run();
      },
    } as unknown as Queue<CampaignEmailQueueMessage>;
    const options = {
      ...receiptOptions(
        environment.DB,
        lostConfirmationQueue,
        "consumer-proof",
      ),
      deliveryConfig: liveConfig,
      environment: "preview" as const,
    };
    await expect(enqueueCfpSubmissionReceipt(options)).rejects.toThrow(
      "Campaign queue handoff confirmation was lost.",
    );
    expect(accepted).toHaveLength(1);
    await expect(
      new EmailQueueDeliveryService({
        config: liveConfig,
        database: environment.DB,
        now: () => new Date(timestamp),
        provider: {
          async send() {
            return { errorCode: "recipient_rejected", outcome: "failed" };
          },
        },
      }).process(accepted[0]),
    ).resolves.toEqual({ action: "ack" });
    await expect(hasConfirmedCfpSubmissionReceipt(options)).resolves.toBe(true);
    await expect(
      enqueueCfpSubmissionReceipt({
        ...options,
        deliveryConfig: { mode: "invalid" },
      }),
    ).resolves.toEqual({ outcome: "already_queued", status: "failed" });
    const state = await environment.DB.prepare(
      `SELECT attempt_count, queue_handed_off_at, queue_payload_json, status
       FROM provider_messages
       WHERE organization_id = 'org_cfp_receipt'
         AND campaign_id = 'cfp_receipt_submission_receipt_consumer-proof'`,
    ).first<{
      attempt_count: number;
      queue_handed_off_at: string | null;
      queue_payload_json: string | null;
      status: string;
    }>();
    expect(state).toMatchObject({
      attempt_count: 1,
      queue_payload_json: null,
      status: "failed",
    });
    expect(state?.queue_handed_off_at).toBeTruthy();

    const modeAccepted: CampaignEmailQueueMessage[] = [];
    const modeConfirmationLostQueue = {
      async send(message: CampaignEmailQueueMessage) {
        modeAccepted.push(structuredClone(message));
        await environment.DB.prepare(
          `UPDATE provider_messages
           SET queue_handoff_lease_expires_at = '2000-01-01T00:00:00.000Z'
           WHERE id = ?1`,
        )
          .bind(message.message_id)
          .run();
      },
    } as unknown as Queue<CampaignEmailQueueMessage>;
    const modeOptions = {
      ...receiptOptions(
        environment.DB,
        modeConfirmationLostQueue,
        "consumer-mode-proof",
      ),
      deliveryConfig: liveConfig,
      environment: "preview" as const,
    };
    await expect(enqueueCfpSubmissionReceipt(modeOptions)).rejects.toThrow(
      "Campaign queue handoff confirmation was lost.",
    );
    await expect(
      new EmailQueueDeliveryService({
        config: deliveryConfig,
        database: environment.DB,
        now: () => new Date(timestamp),
      }).process(modeAccepted[0]),
    ).resolves.toEqual({ action: "ack" });
    await expect(hasConfirmedCfpSubmissionReceipt(modeOptions)).resolves.toBe(
      true,
    );
    const modeState = await environment.DB.prepare(
      `SELECT error_code, queue_handed_off_at, queue_payload_json, status
       FROM provider_messages
       WHERE organization_id = 'org_cfp_receipt'
         AND campaign_id = 'cfp_receipt_submission_receipt_consumer-mode-proof'`,
    ).first<{
      error_code: string | null;
      queue_handed_off_at: string | null;
      queue_payload_json: string | null;
      status: string;
    }>();
    expect(modeState).toMatchObject({
      error_code: "delivery_mode_changed",
      queue_payload_json: null,
      status: "failed",
    });
    expect(modeState?.queue_handed_off_at).toBeTruthy();
  });

  it("does not amplify Queue writes across an exact replay burst", async () => {
    const environment = await server.getWorker<Env>().getEnv();
    const emailQueue = queue();
    const options = receiptOptions(environment.DB, emailQueue.binding, "burst");
    await enqueueCfpSubmissionReceipt(options);

    await expect(
      Promise.all(
        Array.from({ length: 20 }, () => enqueueCfpSubmissionReceipt(options)),
      ),
    ).resolves.toEqual(
      Array.from({ length: 20 }, () => ({
        outcome: "already_queued",
        status: "queued",
      })),
    );
    expect(emailQueue.messages).toHaveLength(1);
  });
});
