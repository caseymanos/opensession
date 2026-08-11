import {
  createSeedEmailTemplates,
  type CampaignPreviewRequest,
  type EmailTemplate,
} from "@sessionbox-killer/email";
import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { BaseAuthority } from "../src/authority/base-authority";
import type { BaseAuthorityCommand } from "../src/authority/types";
import { AuthorityOutcomeUnknownError } from "../src/authority/types";
import {
  CampaignEmailCoordinator,
  EmailQueueDeliveryService,
} from "../src/email/delivery";
import type { EmailQueueMessage } from "../src/email/messages";
import type { EmailDeliveryProvider } from "../src/email/provider";
import type { EmailTemplateEventProjection } from "../src/email-templates/repository";
import { D1CampaignRepository } from "../src/campaigns/repository";
import { CampaignService } from "../src/campaigns/service";

const timestamp = "2026-08-10T20:00:00.000Z";
const scheduledAt = "2026-08-10T21:00:00.000Z";
const hash = "c".repeat(64);
const server = createTestHarness({
  workers: [{ configPath: "workers/app/wrangler.jsonc" }],
});

const event: EmailTemplateEventProjection = {
  id: "event_campaign_product",
  name: "Campaign Product Summit",
  organizationId: "org_campaign_product",
  slug: "campaign-product-summit",
  sourceRecordId: "rec_event_campaign_product",
  timezone: "UTC",
  venue: "Mission Bay",
};
const config = {
  allowlist: ["ada@example.test", "grace@example.test"],
  authFrom: "OpenSession <auth@example.test>",
  authReplyTo: "hello@example.test",
  mode: "allowlist" as const,
};

function queueFixture() {
  const sent: EmailQueueMessage[] = [];
  return {
    queue: {
      async send(message: EmailQueueMessage) {
        sent.push(structuredClone(message));
      },
    } as unknown as Queue<EmailQueueMessage>,
    sent,
  };
}

function authorityFixture(options: { repair?: boolean } = {}) {
  const calls: BaseAuthorityCommand[] = [];
  const authority = {
    async execute(command: BaseAuthorityCommand) {
      calls.push(structuredClone(command));
      return {
        authority: {
          entityId: command.entityId,
          fields: command.fields,
          recordId: `rec_${command.entityId}`,
          replayed:
            calls.filter(({ commandId }) => commandId === command.commandId)
              .length > 1,
          sourceVersion: 1,
        },
        commandId: command.commandId,
        projection: options.repair ? "repair_pending" : "durable",
        status: options.repair ? "committed_with_repair" : "committed",
      } as const;
    },
  } as unknown as Pick<BaseAuthority, "execute">;
  return { authority, calls };
}

function request(template: EmailTemplate): CampaignPreviewRequest {
  return {
    filter: {
      portalStates: ["active"],
      readiness: "ready",
      roles: ["speaker"],
    },
    schedule: { mode: "scheduled", scheduledAt },
    templateId: template.id,
  };
}

async function providerMessage(
  database: D1Database,
  campaignId: string,
  recipient: string,
) {
  return database
    .prepare(
      `SELECT id, status, queue_payload_json
       FROM provider_messages
       WHERE organization_id = ?1 AND campaign_id = ?2
         AND json_extract(queue_payload_json, '$.email.to[0]') = ?3
       LIMIT 1`,
    )
    .bind(event.organizationId, campaignId, recipient)
    .first<{ id: string; queue_payload_json: string | null; status: string }>();
}

let template: EmailTemplate;

beforeAll(async () => {
  await server.listen();
  const worker = server.getWorker<Env>();
  await worker.applyD1Migrations("DB");
  const environment = await worker.getEnv();
  template = createSeedEmailTemplates({
    createdAt: timestamp,
    eventId: event.id,
    replyTo: "program@example.test",
    sender: { address: "updates@example.test", name: "OpenSession" },
  }).find(({ id }) => id === "template_submission_receipt") as EmailTemplate;
  await environment.DB.batch([
    environment.DB.prepare(
      `INSERT INTO tenant_registry (
         organization_id, base_key, source_record_id, status, created_at,
         updated_at, authority_ready_at
       ) VALUES (?1, 'base_campaign_product', 'rec_org_campaign_product',
                 'active', ?2, ?2, ?2)`,
    ).bind(event.organizationId, timestamp),
    environment.DB.prepare(
      `INSERT INTO p_events (
         id, organization_id, name, slug, timezone, venue, status,
         source_record_id, source_version, source_content_hash, projected_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'published', ?7, 1, ?8, ?9)`,
    ).bind(
      event.id,
      event.organizationId,
      event.name,
      event.slug,
      event.timezone,
      event.venue,
      event.sourceRecordId,
      hash,
      timestamp,
    ),
    environment.DB.prepare(
      `INSERT INTO p_events (
         id, organization_id, name, slug, timezone, status, source_record_id,
         source_version, source_content_hash, projected_at
       ) VALUES ('event_campaign_other', ?1, 'Other event', 'other-event',
                 'UTC', 'published', 'rec_event_campaign_other', 1, ?2, ?3)`,
    ).bind(event.organizationId, hash, timestamp),
    environment.DB.prepare(
      `INSERT INTO p_forms (
         id, organization_id, event_id, name, status, version,
         source_record_id, source_version, source_content_hash, projected_at
       ) VALUES ('form_campaign', ?1, ?2, 'CFP', 'published', 1,
                 'rec_form_campaign', 1, ?3, ?4)`,
    ).bind(event.organizationId, event.id, hash, timestamp),
    environment.DB.prepare(
      `INSERT INTO p_contacts (
         id, organization_id, email_normalized, display_name, first_name,
         source_record_id, source_version, source_content_hash, projected_at
       ) VALUES
         ('contact_campaign_ada', ?1, 'ada@example.test', 'Ada Lovelace', 'Ada',
          'rec_contact_campaign_ada', 1, ?2, ?3),
         ('contact_campaign_grace', ?1, 'grace@example.test', 'Grace Hopper', 'Grace',
          'rec_contact_campaign_grace', 1, ?2, ?3),
         ('contact_campaign_blocked', ?1, 'blocked@example.test', 'Blocked Speaker',
          'Blocked', 'rec_contact_campaign_blocked', 1, ?2, ?3),
         ('contact_campaign_reviewer', ?1, 'reviewer@example.test', 'Rae Reviewer',
          'Rae', 'rec_contact_campaign_reviewer', 1, ?2, ?3),
         ('contact_campaign_other', ?1, 'other@example.test', 'Other Event',
          'Other', 'rec_contact_campaign_other', 1, ?2, ?3)`,
    ).bind(event.organizationId, hash, timestamp),
    environment.DB.prepare(
      `INSERT INTO p_event_contacts (
         id, organization_id, event_id, contact_id, roles_json, portal_state,
         speaker_ready, source_record_id, source_version, source_content_hash,
         projected_at
       ) VALUES
         ('event_contact_campaign_ada', ?1, ?2, 'contact_campaign_ada',
          '["speaker"]', 'active', 1, 'rec_event_contact_campaign_ada', 1, ?3, ?4),
         ('event_contact_campaign_grace', ?1, ?2, 'contact_campaign_grace',
          '["speaker"]', 'active', 1, 'rec_event_contact_campaign_grace', 1, ?3, ?4),
         ('event_contact_campaign_blocked', ?1, ?2, 'contact_campaign_blocked',
          '["speaker"]', 'active', 1, 'rec_event_contact_campaign_blocked', 1, ?3, ?4),
         ('event_contact_campaign_reviewer', ?1, ?2, 'contact_campaign_reviewer',
          '["reviewer"]', 'active', 1, 'rec_event_contact_campaign_reviewer', 1, ?3, ?4),
         ('event_contact_campaign_other', ?1, 'event_campaign_other',
          'contact_campaign_other', '["speaker"]', 'active', 1,
          'rec_event_contact_campaign_other', 1, ?3, ?4)`,
    ).bind(event.organizationId, event.id, hash, timestamp),
    environment.DB.prepare(
      `INSERT INTO p_submissions (
         id, organization_id, event_id, form_id, form_version, friendly_id,
         submitter_contact_id, title, status, submitted_at, updated_at,
         source_record_id, source_version, source_content_hash, projected_at
       ) VALUES
         ('submission_campaign_ada', ?1, ?2, 'form_campaign', 1, 'SUB-ADA',
          'contact_campaign_ada', 'Analytical Engines', 'submitted', ?3, ?3,
          'rec_submission_campaign_ada', 1, ?4, ?3),
         ('submission_campaign_grace', ?1, ?2, 'form_campaign', 1, 'SUB-GRACE',
          'contact_campaign_grace', 'Compiler Design', 'submitted', ?3, ?3,
          'rec_submission_campaign_grace', 1, ?4, ?3),
         ('submission_campaign_blocked', ?1, ?2, 'form_campaign', 1, 'SUB-BLOCKED',
          'contact_campaign_blocked', 'Blocked Session', 'submitted', ?3, ?3,
          'rec_submission_campaign_blocked', 1, ?4, ?3),
         ('submission_campaign_reviewer', ?1, ?2, 'form_campaign', 1, 'SUB-REVIEW',
          'contact_campaign_reviewer', 'Review Session', 'submitted', ?3, ?3,
          'rec_submission_campaign_reviewer', 1, ?4, ?3)`,
    ).bind(event.organizationId, event.id, timestamp, hash),
    environment.DB.prepare(
      `INSERT INTO p_email_templates (
         id, organization_id, event_id, name, audience_type, sender_name,
         sender_email, subject, body_document_json, body_html, body_text,
         reply_to, used_merge_fields_json, merge_schema_version, status,
         version, source_record_id, source_version, source_content_hash,
         projected_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, '<p>projection</p>',
                 'projection', ?10, ?11, 1, 'active', 1,
                 'rec_template_campaign', 1, ?12, ?13)`,
    ).bind(
      template.id,
      event.organizationId,
      event.id,
      template.internalName,
      template.audience,
      template.sender.name,
      template.sender.address,
      template.subject,
      JSON.stringify(template.body),
      template.replyTo,
      JSON.stringify(template.allowedMergeFields),
      hash,
      timestamp,
    ),
  ]);
  const recipientHash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode("blocked@example.test"),
  );
  await environment.DB.prepare(
    `INSERT INTO email_suppressions (
       organization_id, recipient_hash, reason, created_at, updated_at
     ) VALUES (?1, ?2, 'manual', ?3, ?3)`,
  )
    .bind(
      event.organizationId,
      [...new Uint8Array(recipientHash)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
      timestamp,
    )
    .run();
});

afterAll(async () => {
  await server.close();
});

describe("campaign product Workerd integration", () => {
  it("freezes an exact isolated audience and prepares stable authoritative messages", async () => {
    const environment = await server.getWorker<Env>().getEnv();
    const repository = new D1CampaignRepository(environment.DB);
    const queue = queueFixture();
    const authority = authorityFixture({ repair: true });
    const now = () => new Date(timestamp);
    const service = new CampaignService({
      actor: {
        email: "organizer@example.test",
        id: "user_campaign_owner",
        name: "Campaign Owner",
      },
      authority: authority.authority,
      config,
      database: environment.DB,
      now,
      queue: queue.queue,
      repository,
      requestUrl: "https://preview.opensession.test/api/campaigns",
    });

    const preview = await service.preview(event, request(template));
    expect(preview).toMatchObject({
      audience: {
        excludedByReason: [
          { count: 1, reason: "manual" },
          { count: 1, reason: "role_mismatch" },
        ],
        excludedCount: 2,
        includedCount: 2,
        totalCandidates: 4,
      },
      schedule: { mode: "scheduled", scheduledAt },
      sender: template.sender,
      template: { id: template.id, version: 1 },
    });
    expect(preview.audience.samples.map(({ email }) => email)).toEqual([
      "ada@example.test",
      "grace@example.test",
    ]);
    const result = await service.confirm(event, {
      ...request(template),
      commandId: "campaign_confirm_workerd",
      previewCreatedAt: preview.createdAt,
      previewId: preview.previewId,
    });
    expect(result).toMatchObject({
      messages: { total: 2 },
      projection: "repair_pending",
      replayed: false,
      scheduledAt,
    });
    expect(queue.sent).toHaveLength(0);
    expect(authority.calls.map(({ table }) => table)).toEqual([
      "campaigns",
      "messages",
      "messages",
    ]);
    expect(
      authority.calls.every(
        ({ audit }) =>
          !JSON.stringify(audit.safeDiff).includes("@example.test") &&
          !JSON.stringify(audit.safeDiff).includes("Analytical Engines"),
      ),
    ).toBe(true);
    const stored = await environment.DB.prepare(
      `SELECT COUNT(*) AS count, MIN(scheduled_at) AS scheduled_at
       FROM provider_messages WHERE campaign_id = ?1`,
    )
      .bind(result.campaignId)
      .first<{ count: number; scheduled_at: string }>();
    expect(stored).toEqual({ count: 2, scheduled_at: scheduledAt });
    const receipt = await environment.DB.prepare(
      `SELECT plan_json FROM campaign_command_receipts
       WHERE organization_id = ?1 AND event_id = ?2
         AND command_id = 'campaign_confirm_workerd'`,
    )
      .bind(event.organizationId, event.id)
      .first<{ plan_json: string }>();
    if (!receipt) throw new Error("Missing completed receipt fixture.");
    await environment.DB.prepare(
      `INSERT INTO p_campaigns (
         id, organization_id, event_id, template_id, template_version,
         template_snapshot_json, audience_filter_snapshot_json, trigger_name,
         scheduled_at, status, source_record_id, source_version,
         source_content_hash, projected_at
       ) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, 'organizer_campaign', ?7,
                 'scheduled', ?8, 1, ?9, ?10)`,
    )
      .bind(
        result.campaignId,
        event.organizationId,
        event.id,
        template.id,
        JSON.stringify(template),
        JSON.stringify(JSON.parse(receipt.plan_json).audience),
        scheduledAt,
        `rec_${result.campaignId}`,
        hash,
        timestamp,
      )
      .run();
    const childReceipts = await environment.DB.prepare(
      `SELECT COUNT(*) AS count FROM campaign_message_receipts
       WHERE organization_id = ?1 AND event_id = ?2
         AND command_id = 'campaign_confirm_workerd'`,
    )
      .bind(event.organizationId, event.id)
      .first<{ count: number }>();
    expect(childReceipts?.count).toBe(0);
    await expect(
      service.confirm(event, {
        ...request(template),
        commandId: "campaign_confirm_workerd",
        previewCreatedAt: preview.createdAt,
        previewId: preview.previewId,
      }),
    ).resolves.toMatchObject({
      campaignId: result.campaignId,
      replayed: true,
    });
    expect(authority.calls).toHaveLength(3);
  });

  it("hands off only when due, recovers one failure, and never duplicates a delivery", async () => {
    const environment = await server.getWorker<Env>().getEnv();
    const receipt = await environment.DB.prepare(
      `SELECT campaign_id FROM campaign_command_receipts
       WHERE command_id = 'campaign_confirm_workerd'`,
    ).first<{ campaign_id: string }>();
    if (!receipt) throw new Error("Missing campaign receipt fixture.");
    const queue = queueFixture();
    const coordinator = new CampaignEmailCoordinator({
      config,
      database: environment.DB,
      now: () => new Date(scheduledAt),
      queue: queue.queue,
    });
    await expect(coordinator.drainPendingHandoffs()).resolves.toBe(2);
    expect(queue.sent).toHaveLength(2);
    const calls = new Map<string, number>();
    const provider: EmailDeliveryProvider = {
      async send({ message }) {
        const recipient = message.to[0] as string;
        calls.set(recipient, (calls.get(recipient) ?? 0) + 1);
        if (recipient === "grace@example.test" && calls.get(recipient) === 1) {
          return { errorCode: "invalid_from_address", outcome: "failed" };
        }
        return {
          outcome: "sent",
          providerMessageId: `resend_${recipient.split("@")[0]}`,
        };
      },
    };
    const delivery = new EmailQueueDeliveryService({
      config,
      database: environment.DB,
      now: () => new Date(scheduledAt),
      provider,
    });
    for (const message of queue.sent) {
      await delivery.process(message);
    }
    const failed = await providerMessage(
      environment.DB,
      receipt.campaign_id,
      "grace@example.test",
    );
    expect(failed?.status).toBe("failed");
    expect(failed?.queue_payload_json).not.toBeNull();
    if (!failed) throw new Error("Missing failed message fixture.");
    const log = await new D1CampaignRepository(environment.DB).readDeliveryLog(
      event,
      receipt.campaign_id,
    );
    expect(
      log?.messages.find(({ messageId }) => messageId === failed.id),
    ).toMatchObject({
      errorCode: "invalid_from_address",
      replayable: true,
      status: "failed",
    });
    const serializedLog = JSON.stringify(log);
    expect(serializedLog).not.toContain("grace@example.test");
    expect(serializedLog).not.toContain("Compiler Design");
    expect(serializedLog).not.toContain("rec_contact_campaign_grace");
    await expect(
      new D1CampaignRepository(environment.DB).readDeliveryLog(
        {
          ...event,
          id: "event_campaign_other",
          slug: "other-event",
          sourceRecordId: "rec_event_campaign_other",
        },
        receipt.campaign_id,
      ),
    ).resolves.toBeNull();
    await expect(
      coordinator.replayById({
        campaignId: receipt.campaign_id,
        eventId: event.id,
        messageId: failed.id,
        organizationId: event.organizationId,
      }),
    ).resolves.toEqual({ outcome: "queued" });
    expect(queue.sent).toHaveLength(3);
    await delivery.process(queue.sent[2]);
    await delivery.process(queue.sent[2]);
    expect(calls.get("grace@example.test")).toBe(2);
    await expect(
      coordinator.replayById({
        campaignId: receipt.campaign_id,
        eventId: event.id,
        messageId: failed.id,
        organizationId: event.organizationId,
      }),
    ).resolves.toMatchObject({ outcome: "not_replayable", status: "sent" });
  });

  it("reconciles concurrent confirmations through one durable message set", async () => {
    const environment = await server.getWorker<Env>().getEnv();
    const queue = queueFixture();
    const authority = authorityFixture();
    const service = new CampaignService({
      actor: {
        email: "organizer@example.test",
        id: "user_campaign_owner",
        name: "Campaign Owner",
      },
      authority: authority.authority,
      config,
      database: environment.DB,
      now: () => new Date(timestamp),
      queue: queue.queue,
      repository: new D1CampaignRepository(environment.DB),
      requestUrl: "https://preview.opensession.test/api/campaigns",
    });
    const preview = await service.preview(event, request(template));
    const confirmation = {
      ...request(template),
      commandId: "campaign_concurrent_confirmation",
      previewCreatedAt: preview.createdAt,
      previewId: preview.previewId,
    } as const;
    const [first, duplicate] = await Promise.all([
      service.confirm(event, confirmation),
      service.confirm(event, confirmation),
    ]);
    expect(first.campaignId).toBe(duplicate.campaignId);
    expect(first.messages.total).toBe(2);
    expect(duplicate.messages.total).toBe(2);
    const providerRows = await environment.DB.prepare(
      `SELECT COUNT(*) AS count FROM provider_messages
       WHERE organization_id = ?1 AND campaign_id = ?2`,
    )
      .bind(event.organizationId, first.campaignId)
      .first<{ count: number }>();
    expect(providerRows?.count).toBe(2);
    const childReceipts = await environment.DB.prepare(
      `SELECT COUNT(*) AS count FROM campaign_message_receipts
       WHERE organization_id = ?1 AND event_id = ?2 AND command_id = ?3`,
    )
      .bind(event.organizationId, event.id, confirmation.commandId)
      .first<{ count: number }>();
    expect(childReceipts?.count).toBe(0);
    expect(queue.sent).toHaveLength(0);
  });

  it("resumes an outcome-unknown authority command from prepared exact messages", async () => {
    const environment = await server.getWorker<Env>().getEnv();
    const repository = new D1CampaignRepository(environment.DB);
    const queue = queueFixture();
    const stable = authorityFixture();
    let failed = false;
    const authority = {
      async execute(command: BaseAuthorityCommand) {
        if (command.table === "messages" && !failed) {
          failed = true;
          throw new AuthorityOutcomeUnknownError(command.commandId);
        }
        return stable.authority.execute(command);
      },
    } as unknown as Pick<BaseAuthority, "execute">;
    const service = new CampaignService({
      actor: {
        email: "organizer@example.test",
        id: "user_campaign_owner",
        name: "Campaign Owner",
      },
      authority,
      config,
      database: environment.DB,
      now: () => new Date(timestamp),
      queue: queue.queue,
      repository,
      requestUrl: "https://preview.opensession.test/api/campaigns",
    });
    const preview = await service.preview(event, request(template));
    const confirmation = {
      ...request(template),
      commandId: "campaign_outcome_unknown",
      previewCreatedAt: preview.createdAt,
      previewId: preview.previewId,
    } as const;
    await expect(service.confirm(event, confirmation)).rejects.toBeInstanceOf(
      AuthorityOutcomeUnknownError,
    );
    const pending = await environment.DB.prepare(
      `SELECT state FROM campaign_command_receipts
       WHERE organization_id = ?1 AND event_id = ?2 AND command_id = ?3`,
    )
      .bind(event.organizationId, event.id, confirmation.commandId)
      .first<{ state: string }>();
    expect(pending?.state).toBe("applying");
    await expect(service.confirm(event, confirmation)).resolves.toMatchObject({
      messages: { total: 2 },
      replayed: true,
    });
    const providerRows = await environment.DB.prepare(
      `SELECT COUNT(*) AS count FROM provider_messages
       WHERE organization_id = ?1 AND campaign_id = (
         SELECT campaign_id FROM campaign_command_receipts
         WHERE organization_id = ?1 AND event_id = ?2 AND command_id = ?3
       )`,
    )
      .bind(event.organizationId, event.id, confirmation.commandId)
      .first<{ count: number }>();
    expect(providerRows?.count).toBe(2);
  });
});
