import {
  createSeedEmailTemplates,
  emailTemplateDraft,
  type EmailTemplate,
} from "@sessionbox-killer/email";
import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sha256Hex } from "../src/auth/crypto";

const hash = "e".repeat(64);
const pepper = "email-template-test-pepper-with-at-least-32-characters";
const timestamp = "2026-08-10T20:00:00.000Z";
const future = "2027-08-10T20:00:00.000Z";
const server = createTestHarness({
  workers: [
    {
      configPath: "workers/app/wrangler.jsonc",
      secrets: { AUTH_HASH_PEPPER: pepper },
      vars: {
        FEATURE_FLAGS: {
          ai: false,
          embeds: false,
          email: true,
          integrations: false,
          webhooks: false,
          writes: true,
        },
      },
    },
  ],
});

let origin = "";
let owner: { cookie: string; csrf: string };
let viewer: { cookie: string; csrf: string };
let accepted: EmailTemplate;

async function seedSession(userId: string, label: string) {
  const environment = await server.getWorker<Env>().getEnv();
  const token = `email-template-session-${label}-${"s".repeat(32)}`;
  const csrf = `email-template-csrf-${label}-${"c".repeat(32)}`;
  await environment.DB.batch([
    environment.DB.prepare(
      `INSERT INTO auth_sessions
        (id, user_id, token_hash, created_at, expires_at, last_seen_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?4)`,
    ).bind(
      `auth_email_template_${label}`,
      userId,
      await sha256Hex(token),
      timestamp,
      future,
    ),
    environment.DB.prepare(
      `INSERT INTO auth_session_secrets
        (session_id, csrf_token_hash, created_at)
       VALUES (?1, ?2, ?3)`,
    ).bind(`auth_email_template_${label}`, await sha256Hex(csrf), timestamp),
  ]);
  return {
    cookie: `__Host-opensession-session=${token}`,
    csrf,
  };
}

function headers(authentication?: { cookie: string; csrf?: string }) {
  return {
    "Content-Type": "application/json",
    ...(authentication ? { Cookie: authentication.cookie } : {}),
    ...(authentication?.csrf ? { "X-CSRF-Token": authentication.csrf } : {}),
  };
}

function previewBody(
  template = emailTemplateDraft(accepted),
  source: { kind: "recipient"; recipientId: string } | { kind: "seed" } = {
    kind: "recipient",
    recipientId: "contact_mina_okafor",
  },
) {
  return JSON.stringify({ baseTemplateId: accepted.id, source, template });
}

beforeAll(async () => {
  origin = (await server.listen()).url.origin;
  const worker = server.getWorker<Env>();
  await worker.applyD1Migrations("DB");
  const environment = await worker.getEnv();
  accepted = createSeedEmailTemplates({
    createdAt: timestamp,
    eventId: "event_ai_engineer_summit",
    replyTo: "program@example.test",
    sender: { address: "updates@example.test", name: "OpenSession" },
  }).find(({ id }) => id === "template_submission_accepted") as EmailTemplate;

  await environment.DB.batch([
    environment.DB.prepare(
      `INSERT INTO tenant_registry
        (organization_id, base_key, source_record_id, status, created_at,
         updated_at, authority_ready_at)
       VALUES ('org_opensession', 'base_opensession', 'rec_org_opensession',
               'active', ?1, ?1, ?1)`,
    ).bind(timestamp),
    environment.DB.prepare(
      `INSERT INTO users
        (id, email_normalized, display_name, created_at, updated_at)
       VALUES
        ('user_casey_manos', 'casey@example.test', 'Casey Manos', ?1, ?1),
        ('user_val_viewer', 'viewer@example.test', 'Val Viewer', ?1, ?1)`,
    ).bind(timestamp),
    environment.DB.prepare(
      `INSERT INTO p_events
        (id, organization_id, name, slug, timezone, venue, status,
         source_record_id, source_version, source_content_hash, projected_at)
       VALUES ('event_ai_engineer_summit', 'org_opensession',
               'AI Engineer Summit', 'ai-engineer-summit',
               'America/Los_Angeles', 'Pier 27', 'published',
               'rec_event_ai_engineer_summit', 1, ?1, ?2)`,
    ).bind(hash, timestamp),
    environment.DB.prepare(
      `INSERT INTO organization_memberships
        (id, organization_id, user_id, role, created_at, updated_at)
       VALUES
        ('membership_casey', 'org_opensession', 'user_casey_manos', 'owner', ?1, ?1),
        ('membership_viewer', 'org_opensession', 'user_val_viewer', 'viewer', ?1, ?1)`,
    ).bind(timestamp),
    environment.DB.prepare(
      `INSERT INTO p_forms
        (id, organization_id, event_id, name, status, version,
         source_record_id, source_version, source_content_hash, projected_at)
       VALUES ('form_cfp', 'org_opensession', 'event_ai_engineer_summit',
               'Call for proposals', 'published', 1, 'rec_form_cfp', 1, ?1, ?2)`,
    ).bind(hash, timestamp),
    environment.DB.prepare(
      `INSERT INTO p_contacts
        (id, organization_id, email_normalized, display_name, first_name,
         source_record_id, source_version, source_content_hash, projected_at)
       VALUES ('contact_mina_okafor', 'org_opensession',
               'mina@example.test', 'Mina Okafor', 'Mina',
               'rec_contact_mina_okafor', 1, ?1, ?2)`,
    ).bind(hash, timestamp),
    environment.DB.prepare(
      `INSERT INTO p_event_contacts
        (id, organization_id, event_id, contact_id, roles_json, portal_state,
         source_record_id, source_version, source_content_hash, projected_at)
       VALUES ('event_contact_mina', 'org_opensession',
               'event_ai_engineer_summit', 'contact_mina_okafor',
               '["speaker"]', 'active', 'rec_event_contact_mina', 1, ?1, ?2)`,
    ).bind(hash, timestamp),
    environment.DB.prepare(
      `INSERT INTO p_submissions
        (id, organization_id, event_id, form_id, form_version, friendly_id,
         submitter_contact_id, title, status, submitted_at, updated_at,
         source_record_id, source_version, source_content_hash, projected_at)
       VALUES ('submission_mina', 'org_opensession',
               'event_ai_engineer_summit', 'form_cfp', 1, 'SUB-0104',
               'contact_mina_okafor', 'Reliable Agents in Production',
               'accepted', ?1, ?1, 'rec_submission_mina', 1, ?2, ?1)`,
    ).bind(timestamp, hash),
    environment.DB.prepare(
      `INSERT INTO p_email_templates
        (id, organization_id, event_id, name, audience_type, sender_name,
         sender_email, subject, body_document_json, body_html, body_text,
         reply_to, used_merge_fields_json, merge_schema_version, status,
         version, source_record_id, source_version, source_content_hash,
         projected_at)
       VALUES (?1, 'org_opensession', 'event_ai_engineer_summit', ?2, ?3,
               ?4, ?5, ?6, ?7, '<p>projection</p>', 'projection', ?8, ?9,
               1, 'active', 1, 'rec_template_accepted', 7, ?10, ?11)`,
    ).bind(
      accepted.id,
      accepted.internalName,
      accepted.audience,
      accepted.sender.name,
      accepted.sender.address,
      accepted.subject,
      JSON.stringify(accepted.body),
      accepted.replyTo,
      JSON.stringify(accepted.allowedMergeFields),
      hash,
      timestamp,
    ),
  ]);
  owner = await seedSession("user_casey_manos", "owner");
  viewer = await seedSession("user_val_viewer", "viewer");
});

afterAll(async () => {
  await server.close();
});

describe("email-template workspace routes", () => {
  it("returns only event managers the template library and real speakers", async () => {
    const anonymous = await server.fetch(
      "/api/events/ai-engineer-summit/email-templates",
    );
    const forbidden = await server.fetch(
      "/api/events/ai-engineer-summit/email-templates",
      { headers: headers(viewer) },
    );
    const response = await server.fetch(
      "/api/events/ai-engineer-summit/email-templates",
      { headers: headers(owner) },
    );

    expect(anonymous.status).toBe(401);
    expect(forbidden.status).toBe(403);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      event: { id: "event_ai_engineer_summit" },
      recipients: [
        { id: "contact_mina_okafor", name: "Mina Okafor", roles: ["speaker"] },
      ],
      templates: [
        {
          sourceVersion: 7,
          template: { id: accepted.id, version: 1 },
        },
      ],
    });
  });

  it("renders the selected projected speaker in matching safe outputs", async () => {
    const response = await server.fetch(
      "/api/events/ai-engineer-summit/email-templates/preview",
      {
        body: previewBody(),
        headers: headers(owner),
        method: "POST",
      },
    );
    const body = (await response.json()) as {
      ok: boolean;
      preview: { html: string; subject: string; text: string };
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.preview.subject).toContain("Reliable Agents in Production");
    expect(body.preview.html).toContain("Mina");
    expect(body.preview.text).toContain("Mina");
    expect(body.preview.html).not.toContain("<script>");
  });

  it("reports an intentional invalid token at the exact subject offset", async () => {
    const draft = emailTemplateDraft(accepted);
    const response = await server.fetch(
      "/api/events/ai-engineer-summit/email-templates/preview",
      {
        body: previewBody({
          ...draft,
          subject: `${draft.subject} · {{recipient.nickname}}`,
        }),
        headers: headers(owner),
        method: "POST",
      },
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      issues: [
        {
          code: "unknown_field",
          location: "subject",
          offset: draft.subject.length + 3,
        },
      ],
      ok: false,
    });
  });

  it("requires same-origin and CSRF before an authoritative command", async () => {
    const command = JSON.stringify({
      baseTemplateId: accepted.id,
      commandId: "email_template_route_test",
      expectedSourceVersion: 7,
      template: emailTemplateDraft(accepted),
      type: "create_revision",
    });
    const crossOrigin = await server.fetch(
      "/api/events/ai-engineer-summit/email-templates/commands",
      {
        body: command,
        headers: {
          ...headers(owner),
          Origin: "https://attacker.example",
          "Sec-Fetch-Site": "cross-site",
        },
        method: "POST",
      },
    );
    const missingCsrf = await server.fetch(
      "/api/events/ai-engineer-summit/email-templates/commands",
      {
        body: command,
        headers: {
          ...headers({ cookie: owner.cookie }),
          Origin: origin,
          "Sec-Fetch-Site": "same-origin",
        },
        method: "POST",
      },
    );

    expect(crossOrigin.status).toBe(403);
    await expect(crossOrigin.json()).resolves.toMatchObject({
      error: { code: "invalid_origin" },
    });
    await expect(missingCsrf.json()).resolves.toMatchObject({
      error: { code: "invalid_csrf" },
    });
    expect(missingCsrf.status).toBe(403);
  });

  it("fails closed when an activation recipient is no longer eligible", async () => {
    const response = await server.fetch(
      "/api/events/ai-engineer-summit/email-templates/commands",
      {
        body: JSON.stringify({
          baseTemplateId: accepted.id,
          commandId: "email_template_missing_recipient",
          expectedSourceVersion: 7,
          source: {
            kind: "recipient",
            recipientId: "contact_missing_speaker",
          },
          template: emailTemplateDraft(accepted),
          type: "activate_version",
        }),
        headers: {
          ...headers(owner),
          Origin: origin,
          "Sec-Fetch-Site": "same-origin",
        },
        method: "POST",
      },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "email_preview_recipient_not_found" },
    });
  });
});
