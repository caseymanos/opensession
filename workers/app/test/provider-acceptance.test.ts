import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { EmailQueueMessage } from "../src/email/messages";
import {
  assertProviderAcceptanceWindow,
  ProviderAcceptanceUnavailableError,
  runProviderAcceptance,
} from "../src/campaigns/provider-acceptance";
import type { EmailTemplateEventProjection } from "../src/email-templates/repository";

const server = createTestHarness({
  workers: [{ configPath: "workers/app/wrangler.jsonc" }],
});
const timestamp = "2026-08-11T20:00:00.000Z";
const hash = "a".repeat(64);
const event: EmailTemplateEventProjection = {
  id: "evt_ai_engineer_summit_2026",
  name: "AI Engineer Summit",
  organizationId: "org_ai_engineer_summit",
  slug: "ai-engineer-summit-2026",
  sourceRecordId: "rec_event_acceptance",
  timezone: "America/Los_Angeles",
  venue: "San Francisco",
};
const config = {
  allowlist: [
    "bounced@resend.dev",
    "complained@resend.dev",
    "delivered@resend.dev",
    "suppressed@resend.dev",
  ],
  authFrom: "OpenSession <auth@updates.opensessionboard.com>",
  authReplyTo: "hello@opensessionboard.com",
  mode: "allowlist" as const,
};
const acceptanceFlags = {
  ai: false,
  embeds: false,
  email: true,
  integrations: false,
  webhooks: false,
  writes: false,
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

async function recipientHash(recipient: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(recipient),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

beforeAll(async () => {
  await server.listen();
  const worker = server.getWorker<Env>();
  await worker.applyD1Migrations("DB");
  const environment = await worker.getEnv();
  await environment.DB.batch([
    environment.DB.prepare(
      `INSERT INTO tenant_registry (
         organization_id, base_key, source_record_id, status, created_at,
         updated_at, authority_ready_at
       ) VALUES (?1, 'base_acceptance', 'rec_org_acceptance', 'active', ?2, ?2, ?2)`,
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
      `INSERT INTO p_email_templates (
         id, organization_id, event_id, name, audience_type, sender_name,
         sender_email, subject, body_document_json, body_html, body_text,
         reply_to, used_merge_fields_json, merge_schema_version, status,
         version, source_record_id, source_version, source_content_hash,
         projected_at
       ) VALUES (
         'template_acceptance', ?1, ?2, 'Acceptance', 'speaker', 'Demo',
         'demo@opensession.invalid', 'Acceptance', '{"blocks":[{"type":"paragraph","text":"Demo"}]}',
         '<p>Demo</p>', 'Demo', 'demo@opensession.invalid', '[]', 1,
         'active', 1, 'rec_template_acceptance', 1, ?3, ?4
       )`,
    ).bind(event.organizationId, event.id, hash, timestamp),
    environment.DB.prepare(
      `INSERT INTO p_campaigns (
         id, organization_id, event_id, template_id, template_version,
         template_snapshot_json, audience_filter_snapshot_json, trigger_name,
         status, source_record_id, source_version, source_content_hash,
         projected_at
       ) VALUES (
         'campaign_acceptance_demo', ?1, ?2, 'template_acceptance', 1,
         '{}', '{}', 'demo_seed', 'complete', 'rec_campaign_acceptance', 1,
         ?3, ?4
       )`,
    ).bind(event.organizationId, event.id, hash, timestamp),
    environment.DB.prepare(
      `INSERT INTO p_contacts (
         id, organization_id, email_normalized, display_name, first_name,
         source_record_id, source_version, source_content_hash, projected_at
       ) VALUES
         ('contact_speaker_01', ?1, 'one@opensession.invalid', 'One', 'One', 'rec_contact_01', 1, ?2, ?3),
         ('contact_speaker_02', ?1, 'two@opensession.invalid', 'Two', 'Two', 'rec_contact_02', 1, ?2, ?3),
         ('contact_speaker_03', ?1, 'three@opensession.invalid', 'Three', 'Three', 'rec_contact_03', 1, ?2, ?3),
         ('contact_speaker_04', ?1, 'four@opensession.invalid', 'Four', 'Four', 'rec_contact_04', 1, ?2, ?3),
         ('contact_speaker_05', ?1, 'five@opensession.invalid', 'Five', 'Five', 'rec_contact_05', 1, ?2, ?3),
         ('contact_speaker_06', ?1, 'six@opensession.invalid', 'Six', 'Six', 'rec_contact_06', 1, ?2, ?3),
         ('contact_speaker_07', ?1, 'seven@opensession.invalid', 'Seven', 'Seven', 'rec_contact_07', 1, ?2, ?3)`,
    ).bind(event.organizationId, hash, timestamp),
    environment.DB.prepare(
      `INSERT INTO p_event_contacts (
         id, organization_id, event_id, contact_id, roles_json, portal_state,
         source_record_id, source_version, source_content_hash, projected_at
       ) VALUES
         ('event_contact_01', ?1, ?2, 'contact_speaker_01', '["speaker"]', 'active', 'rec_event_contact_01', 1, ?3, ?4),
         ('event_contact_02', ?1, ?2, 'contact_speaker_02', '["speaker"]', 'active', 'rec_event_contact_02', 1, ?3, ?4),
         ('event_contact_03', ?1, ?2, 'contact_speaker_03', '["speaker"]', 'active', 'rec_event_contact_03', 1, ?3, ?4),
         ('event_contact_04', ?1, ?2, 'contact_speaker_04', '["speaker"]', 'active', 'rec_event_contact_04', 1, ?3, ?4),
         ('event_contact_05', ?1, ?2, 'contact_speaker_05', '["speaker"]', 'active', 'rec_event_contact_05', 1, ?3, ?4),
         ('event_contact_06', ?1, ?2, 'contact_speaker_06', '["speaker"]', 'active', 'rec_event_contact_06', 1, ?3, ?4),
         ('event_contact_07', ?1, ?2, 'contact_speaker_07', '["speaker"]', 'active', 'rec_event_contact_07', 1, ?3, ?4)`,
    ).bind(event.organizationId, event.id, hash, timestamp),
  ]);
});

afterAll(async () => {
  await server.close();
});

describe("production provider acceptance", () => {
  it("fails closed outside the exact safe production window", () => {
    expect(() =>
      assertProviderAcceptanceWindow({
        config,
        environment: "production",
        featureFlags: { ...acceptanceFlags, writes: true },
      }),
    ).toThrow(ProviderAcceptanceUnavailableError);
    expect(() =>
      assertProviderAcceptanceWindow({
        config: {
          ...config,
          allowlist: [...config.allowlist, "extra@resend.dev"],
        },
        environment: "production",
        featureFlags: acceptanceFlags,
      }),
    ).toThrow(ProviderAcceptanceUnavailableError);
    expect(() =>
      assertProviderAcceptanceWindow({
        config,
        environment: "preview",
        featureFlags: acceptanceFlags,
      }),
    ).toThrow(ProviderAcceptanceUnavailableError);
  });

  it("returns stable no-op replays while queued and after provider outcomes", async () => {
    assertProviderAcceptanceWindow({
      config,
      environment: "production",
      featureFlags: acceptanceFlags,
    });
    const environment = await server.getWorker<Env>().getEnv();
    const queue = queueFixture();
    const first = await runProviderAcceptance({
      commandId: "ral59_provider_initial",
      config,
      database: environment.DB,
      event,
      now: () => new Date(timestamp),
      phase: "initial",
      queue: queue.queue,
    });
    expect(first.messages).toHaveLength(4);
    expect(first.messages.every(({ outcome }) => outcome === "queued")).toBe(
      true,
    );
    expect(queue.sent).toHaveLength(4);
    expect(JSON.stringify(first)).not.toContain("@resend.dev");

    const duplicate = await runProviderAcceptance({
      commandId: "ral59_provider_initial",
      config,
      database: environment.DB,
      event,
      now: () => new Date("2026-08-11T20:05:00.000Z"),
      phase: "initial",
      queue: queue.queue,
    });
    expect(
      duplicate.messages.every(({ outcome }) => outcome === "already_queued"),
    ).toBe(true);
    expect(duplicate.messages.map(({ messageId }) => messageId)).toEqual(
      first.messages.map(({ messageId }) => messageId),
    );
    expect(queue.sent).toHaveLength(4);

    await environment.DB.prepare(
      `UPDATE provider_messages
       SET status = CASE contact_id
             WHEN 'contact_speaker_01' THEN 'delivered'
             WHEN 'contact_speaker_02' THEN 'bounced'
             WHEN 'contact_speaker_03' THEN 'complained'
             WHEN 'contact_speaker_04' THEN 'suppressed'
           END,
           attempt_count = 1, queue_payload_json = NULL
       WHERE organization_id = ?1 AND campaign_id = 'campaign_acceptance_demo'
         AND contact_id IN (
           'contact_speaker_01', 'contact_speaker_02',
           'contact_speaker_03', 'contact_speaker_04'
         )`,
    )
      .bind(event.organizationId)
      .run();

    const terminal = await runProviderAcceptance({
      commandId: "ral59_provider_initial",
      config,
      database: environment.DB,
      event,
      now: () => new Date("2026-08-11T20:10:00.000Z"),
      phase: "initial",
      queue: queue.queue,
    });
    expect(terminal.messages).toEqual([
      {
        messageId: first.messages[0]?.messageId,
        outcome: "already_terminal",
        status: "delivered",
      },
      {
        messageId: first.messages[1]?.messageId,
        outcome: "already_terminal",
        status: "bounced",
      },
      {
        messageId: first.messages[2]?.messageId,
        outcome: "already_terminal",
        status: "complained",
      },
      {
        messageId: first.messages[3]?.messageId,
        outcome: "already_terminal",
        status: "suppressed",
      },
    ]);
    expect(queue.sent).toHaveLength(4);
    expect(JSON.stringify(terminal)).not.toContain("@resend.dev");

    const terminalDuplicate = await runProviderAcceptance({
      commandId: "ral59_provider_initial",
      config,
      database: environment.DB,
      event,
      now: () => new Date("2026-08-11T20:15:00.000Z"),
      phase: "initial",
      queue: queue.queue,
    });
    expect(terminalDuplicate).toEqual(terminal);
    expect(queue.sent).toHaveLength(4);

    const attempts = await environment.DB.prepare(
      `SELECT SUM(attempt_count) AS count
       FROM provider_messages
       WHERE organization_id = ?1 AND campaign_id = 'campaign_acceptance_demo'
         AND contact_id IN (
           'contact_speaker_01', 'contact_speaker_02',
           'contact_speaker_03', 'contact_speaker_04'
         )`,
    )
      .bind(event.organizationId)
      .first<{ count: number }>();
    expect(attempts?.count).toBe(4);
  });

  it("proves subsequent sends are stopped by application suppressions", async () => {
    const environment = await server.getWorker<Env>().getEnv();
    await environment.DB.batch(
      await Promise.all(
        [
          ["bounced@resend.dev", "bounced"],
          ["complained@resend.dev", "complained"],
          ["suppressed@resend.dev", "provider_suppressed"],
        ].map(async ([recipient, reason]) =>
          environment.DB.prepare(
            `INSERT INTO email_suppressions (
               organization_id, recipient_hash, reason, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?4)`,
          ).bind(
            event.organizationId,
            await recipientHash(recipient as string),
            reason,
            timestamp,
          ),
        ),
      ),
    );
    const queue = queueFixture();
    const result = await runProviderAcceptance({
      commandId: "ral59_provider_subsequent",
      config,
      database: environment.DB,
      event,
      now: () => new Date(timestamp),
      phase: "subsequent",
      queue: queue.queue,
    });
    expect(
      result.messages.every(
        ({ outcome, status }) =>
          outcome === "suppressed" && status === "suppressed",
      ),
    ).toBe(true);
    expect(queue.sent).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain("@resend.dev");
  });
});
