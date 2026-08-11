import { createTestHarness } from "wrangler";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type * as PublicApiRuntime from "./fixtures/public-api-runtime";

import type { AppContext } from "../src/app-context";
import { sha256Hex } from "../src/auth/crypto";
import { registerPrivacyRoutes } from "../src/privacy/routes";
import {
  PrivacyExportService,
  PrivacyExportTooLargeError,
} from "../src/privacy/service";

const origin = "https://privacy.opensession.test";
const now = "2026-08-11T18:00:00.000Z";
const future = "2027-08-11T18:00:00.000Z";
const sourceHash = "a".repeat(64);
const server = createTestHarness({
  workers: [
    {
      configPath: "workers/app/test/fixtures/public-api-runtime.wrangler.jsonc",
    },
  ],
});
const runtime = server.getWorker<Env, typeof PublicApiRuntime>(
  "opensession-public-api-runtime",
);

let application!: Hono<AppContext>;
let environment!: Env;
const sessions = new Map<string, { cookie: string; csrf: string }>();

function applicationFetch(path: string, init?: RequestInit) {
  return application.fetch(new Request(`${origin}${path}`, init), environment);
}

function privacyRequest(
  path: string,
  identity: string,
  options: { csrf?: string | null; email?: string; origin?: string } = {},
) {
  const session = sessions.get(identity);
  if (!session) throw new Error(`Missing test session: ${identity}`);
  return applicationFetch(path, {
    body: JSON.stringify({ email: options.email ?? "subject@example.test" }),
    headers: {
      Cookie: session.cookie,
      "Content-Type": "application/json",
      Origin: options.origin ?? origin,
      "Sec-Fetch-Site": "same-origin",
      ...(options.csrf === null
        ? {}
        : { "X-CSRF-Token": options.csrf ?? session.csrf }),
    },
    method: "POST",
  });
}

async function insertSession(identity: string, userId: string) {
  const token = `${identity}-${"s".repeat(48)}`;
  const csrf = `${identity}-${"c".repeat(48)}`;
  await environment.DB.batch([
    environment.DB.prepare(
      `INSERT INTO auth_sessions (
         id, user_id, token_hash, created_at, expires_at, last_seen_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?4)`,
    ).bind(`session_${identity}`, userId, await sha256Hex(token), now, future),
    environment.DB.prepare(
      `INSERT INTO auth_session_secrets (
         session_id, csrf_token_hash, created_at
       ) VALUES (?1, ?2, ?3)`,
    ).bind(`session_${identity}`, await sha256Hex(csrf), now),
  ]);
  sessions.set(identity, {
    cookie: `__Host-opensession-session=${token}`,
    csrf,
  });
}

beforeAll(async () => {
  await server.listen();
  await runtime.applyD1Migrations("DB");
  environment = await runtime.getEnv();
  application = new Hono<AppContext>();
  application.use("*", async (context, next) => {
    context.set("requestId", crypto.randomUUID());
    context.header("Cache-Control", "no-store");
    context.header("X-Content-Type-Options", "nosniff");
    await next();
  });
  registerPrivacyRoutes(application);

  await environment.DB.batch([
    environment.DB.prepare(
      `INSERT INTO tenant_registry (
         organization_id, base_key, source_record_id, status,
         created_at, updated_at, authority_ready_at
       ) VALUES
         ('organization_alpha', 'local:alpha', 'record_org_alpha', 'active', ?1, ?1, ?1),
         ('organization_beta', 'local:beta', 'record_org_beta', 'active', ?1, ?1, ?1)`,
    ).bind(now),
    environment.DB.prepare(
      `INSERT INTO users (
         id, email_normalized, display_name, status, created_at, updated_at
       ) VALUES
         ('user_owner', 'owner@example.test', 'Owner Fixture', 'active', ?1, ?1),
         ('user_organizer', 'organizer@example.test', 'Organizer Fixture', 'active', ?1, ?1),
         ('user_beta', 'beta@example.test', 'Beta Owner Fixture', 'active', ?1, ?1),
         ('user_revoked', 'revoked@example.test', 'Revoked Owner Fixture', 'active', ?1, ?1),
         ('user_subject', 'subject@example.test', 'Subject Fixture', 'active', ?1, ?1)`,
    ).bind(now),
    environment.DB.prepare(
      `INSERT INTO organization_memberships (
         id, organization_id, user_id, role, created_at, updated_at, revoked_at
       ) VALUES
         ('membership_owner', 'organization_alpha', 'user_owner', 'owner', ?1, ?1, NULL),
         ('membership_organizer', 'organization_alpha', 'user_organizer', 'organizer', ?1, ?1, NULL),
         ('membership_beta', 'organization_beta', 'user_beta', 'owner', ?1, ?1, NULL),
         ('membership_revoked', 'organization_alpha', 'user_revoked', 'owner', ?1, ?1, ?1),
         ('membership_subject', 'organization_alpha', 'user_subject', 'viewer', ?1, ?1, NULL)`,
    ).bind(now),
    environment.DB.prepare(
      `INSERT INTO p_events (
         id, organization_id, name, slug, timezone, status, brand_json,
         published_version, is_demo, source_record_id, source_version,
         source_content_hash, projected_at
       ) VALUES
         ('event_alpha', 'organization_alpha', 'Alpha Summit', 'alpha-summit',
          'UTC', 'published', '{}', 1, 0, 'record_event_alpha', 1, ?1, ?2),
         ('event_beta', 'organization_beta', 'Beta Summit', 'beta-summit',
          'UTC', 'published', '{}', 1, 0, 'record_event_beta', 1, ?1, ?2)`,
    ).bind(sourceHash, now),
    environment.DB.prepare(
      `INSERT INTO p_forms (
         id, organization_id, event_id, name, status, version,
         edit_after_close, source_record_id, source_version,
         source_content_hash, projected_at
       ) VALUES (
         'form_alpha', 'organization_alpha', 'event_alpha', 'Call for proposals',
         'published', 1, 0, 'record_form_alpha', 1, ?1, ?2
       )`,
    ).bind(sourceHash, now),
    environment.DB.prepare(
      `INSERT INTO p_contacts (
         id, organization_id, email_normalized, display_name, first_name,
         last_name, pronouns, title, company, bio, social_json,
         source_record_id, source_version, source_content_hash, projected_at,
         headshot_alt_text, profile_publication_state
       ) VALUES
         ('contact_subject', 'organization_alpha', 'subject@example.test',
          'Subject Fixture', 'Subject', 'Fixture', 'they/them', 'Speaker',
          'Example Test', 'Subject biography', '{"website":"https://example.test/subject"}',
          'record_contact_subject', 1, ?1, ?2, 'Subject portrait', 'published'),
         ('contact_third_party', 'organization_alpha', 'third-party@example.test',
          'Third Party Secret Name', 'Third', 'Party', NULL, NULL, NULL, NULL, '{}',
          'record_contact_third_party', 1, ?1, ?2, NULL, 'draft'),
         ('contact_beta', 'organization_beta', 'subject@example.test',
          'Other Tenant Secret Name', NULL, NULL, NULL, NULL, NULL, NULL, '{}',
          'record_contact_beta', 1, ?1, ?2, NULL, 'draft')`,
    ).bind(sourceHash, now),
    environment.DB.prepare(
      `INSERT INTO p_event_contacts (
         id, organization_id, event_id, contact_id, roles_json, portal_state,
         invitation_at, last_active_at, readiness_projection_json,
         source_record_id, source_version, source_content_hash, projected_at
       ) VALUES
         ('event_contact_subject', 'organization_alpha', 'event_alpha',
          'contact_subject', '["speaker","reviewer"]', 'active', ?2, ?2, '{}',
          'record_event_contact_subject', 1, ?1, ?2),
         ('event_contact_third', 'organization_alpha', 'event_alpha',
          'contact_third_party', '["speaker"]', 'active', ?2, ?2, '{}',
          'record_event_contact_third', 1, ?1, ?2)`,
    ).bind(sourceHash, now),
    environment.DB.prepare(
      `INSERT INTO event_memberships (
         id, organization_id, event_id, user_id, contact_id, role,
         created_at, updated_at
       ) VALUES (
         'event_membership_subject', 'organization_alpha', 'event_alpha',
         'user_subject', 'contact_subject', 'reviewer', ?1, ?1
       )`,
    ).bind(now),
    environment.DB.prepare(
      `INSERT INTO p_submissions (
         id, organization_id, event_id, form_id, form_version, friendly_id,
         submitter_contact_id, title, status, submitted_at, updated_at,
         source_record_id, source_version, source_content_hash, projected_at
       ) VALUES (
         'submission_subject', 'organization_alpha', 'event_alpha', 'form_alpha',
         1, 'SUB-001', 'contact_subject', 'Subject proposal', 'submitted',
         ?2, ?2, 'record_submission_subject', 1, ?1, ?2
       )`,
    ).bind(sourceHash, now),
    environment.DB.prepare(
      `INSERT INTO p_submission_answers (
         id, organization_id, event_id, submission_id, field_stable_key,
         field_label_snapshot, answer_type, value_json, sort_order,
         source_record_id, source_version, source_content_hash, projected_at
       ) VALUES (
         'answer_subject', 'organization_alpha', 'event_alpha',
         'submission_subject', 'abstract', 'Abstract', 'long_text',
         '"Subject answer fixture"', 1, 'record_answer_subject', 1, ?1, ?2
       )`,
    ).bind(sourceHash, now),
    environment.DB.prepare(
      `INSERT INTO p_submissions (
         id, organization_id, event_id, form_id, form_version, friendly_id,
         submitter_contact_id, title, status, submitted_at, updated_at,
         source_record_id, source_version, source_content_hash, projected_at
       ) VALUES (
         'submission_third', 'organization_alpha', 'event_alpha', 'form_alpha',
         1, 'SUB-002', 'contact_third_party', 'Shared participant proposal',
         'submitted', ?2, ?2, 'record_submission_third', 1, ?1, ?2
       )`,
    ).bind(sourceHash, now),
    environment.DB.prepare(
      `INSERT INTO p_submission_answers (
         id, organization_id, event_id, submission_id, field_stable_key,
         field_label_snapshot, answer_type, value_json, sort_order,
         source_record_id, source_version, source_content_hash, projected_at
       ) VALUES (
         'answer_third', 'organization_alpha', 'event_alpha',
         'submission_third', 'abstract', 'Abstract', 'long_text',
         '"Third-party confidential answer"', 1, 'record_answer_third', 1, ?1, ?2
       )`,
    ).bind(sourceHash, now),
    environment.DB.prepare(
      `INSERT INTO p_submission_participants (
         id, organization_id, event_id, submission_id, contact_id, role,
         sort_order, is_primary, source_record_id, source_version,
         source_content_hash, projected_at
       ) VALUES
         ('participant_subject', 'organization_alpha', 'event_alpha',
          'submission_subject', 'contact_subject', 'speaker', 1, 1,
          'record_participant_subject', 1, ?1, ?2),
         ('participant_third', 'organization_alpha', 'event_alpha',
          'submission_subject', 'contact_third_party', 'speaker', 2, 0,
          'record_participant_third', 1, ?1, ?2),
         ('participant_subject_shared', 'organization_alpha', 'event_alpha',
          'submission_third', 'contact_subject', 'speaker', 1, 0,
          'record_participant_subject_shared', 1, ?1, ?2)`,
    ).bind(sourceHash, now),
    environment.DB.prepare(
      `INSERT INTO p_rubrics (
         id, organization_id, event_id, name, status, source_record_id,
         source_version, source_content_hash, projected_at
       ) VALUES (
         'rubric_alpha', 'organization_alpha', 'event_alpha', 'Review rubric',
         'active', 'record_rubric_alpha', 1, ?1, ?2
       )`,
    ).bind(sourceHash, now),
    environment.DB.prepare(
      `INSERT INTO p_criteria (
         id, organization_id, event_id, rubric_id, label, minimum_score,
         maximum_score, weight, sort_order, source_record_id, source_version,
         source_content_hash, projected_at
       ) VALUES (
         'criterion_alpha', 'organization_alpha', 'event_alpha', 'rubric_alpha',
         'Clarity', 1, 5, 1, 1, 'record_criterion_alpha', 1, ?1, ?2
       )`,
    ).bind(sourceHash, now),
    environment.DB.prepare(
      `INSERT INTO p_reviews (
         id, organization_id, event_id, submission_id, reviewer_id, status,
         conflict, conflict_note, submitted_at, updated_at, source_record_id,
         source_version, source_content_hash, projected_at, reviewer_note
       ) VALUES (
         'review_subject', 'organization_alpha', 'event_alpha',
         'submission_subject', 'event_contact_subject', 'submitted', 0,
         NULL, ?2, ?2, 'record_review_subject', 1, ?1, ?2,
         'Subject reviewer note fixture'
       )`,
    ).bind(sourceHash, now),
    environment.DB.prepare(
      `INSERT INTO p_review_scores (
         id, organization_id, event_id, review_id, criterion_id,
         numeric_score, comment, source_record_id, source_version,
         source_content_hash, projected_at
       ) VALUES (
         'score_subject', 'organization_alpha', 'event_alpha',
         'review_subject', 'criterion_alpha', 4, 'Subject score comment fixture',
         'record_score_subject', 1, ?1, ?2
       )`,
    ).bind(sourceHash, now),
    environment.DB.prepare(
      `INSERT INTO p_sessions (
         id, organization_id, event_id, friendly_id, title, status,
         is_public, updated_at, source_record_id, source_version,
         source_content_hash, projected_at
       ) VALUES (
         'session_subject', 'organization_alpha', 'event_alpha', 'SES-001',
         'Subject session', 'published', 1, ?2, 'record_session_subject', 1, ?1, ?2
       )`,
    ).bind(sourceHash, now),
    environment.DB.prepare(
      `INSERT INTO p_session_participants (
         id, organization_id, event_id, session_id, contact_id, role,
         sort_order, confirmed_state, source_record_id, source_version,
         source_content_hash, projected_at
       ) VALUES (
         'session_participant_subject', 'organization_alpha', 'event_alpha',
         'session_subject', 'contact_subject', 'speaker', 1, 'confirmed',
         'record_session_participant_subject', 1, ?1, ?2
       )`,
    ).bind(sourceHash, now),
    environment.DB.prepare(
      `INSERT INTO p_task_definitions (
         id, organization_id, event_id, name, type, required_default,
         approval_required, target_rule_json, form_schema_json,
         file_policy_json, source_record_id, source_version,
         source_content_hash, projected_at
       ) VALUES (
         'task_definition_subject', 'organization_alpha', 'event_alpha',
         'Confirm phone', 'form', 1, 0, '{}', '{}', '{}',
         'record_task_definition_subject', 1, ?1, ?2
       )`,
    ).bind(sourceHash, now),
    environment.DB.prepare(
      `INSERT INTO p_task_assignments (
         id, organization_id, event_id, definition_id, contact_id, due_at,
         required, status, completed_at, response_json,
         file_object_ids_json, updated_at, source_record_id, source_version,
         source_content_hash, projected_at
       ) VALUES (
         'task_subject', 'organization_alpha', 'event_alpha',
         'task_definition_subject', 'contact_subject', ?2, 1, 'complete', ?2,
         '{"phone":"+1-555-0100"}', '["file_subject"]', ?2,
         'record_task_subject', 1, ?1, ?2
       )`,
    ).bind(sourceHash, now),
    environment.DB.prepare(
      `INSERT INTO file_objects (
         id, organization_id, event_id, owner_contact_id, object_key,
         display_filename, declared_mime_type, detected_mime_type, byte_size,
         checksum_sha256, status, created_at, finalized_at, purpose, updated_at
       ) VALUES (
         'file_subject', 'organization_alpha', 'event_alpha', 'contact_subject',
         'private/tenant-alpha/subject-secret-object-key', 'subject-slides.pdf',
         'application/pdf', 'application/pdf', 128, ?1, 'ready', ?2, ?2,
         'slides', ?2
       )`,
    ).bind("b".repeat(64), now),
    environment.DB.prepare(
      `INSERT INTO p_email_templates (
         id, organization_id, event_id, name, audience_type, sender_name,
         sender_email, subject, body_document_json, body_html, body_text,
         used_merge_fields_json, merge_schema_version, status, version,
         source_record_id, source_version, source_content_hash, projected_at
       ) VALUES (
         'template_alpha', 'organization_alpha', 'event_alpha', 'Reminder',
         'speakers', 'Program team', 'program@example.test', 'Private subject',
         '{}', '<p>Provider body secret</p>', 'Provider body secret', '[]', 1,
         'active', 1, 'record_template_alpha', 1, ?1, ?2
       )`,
    ).bind(sourceHash, now),
    environment.DB.prepare(
      `INSERT INTO p_campaigns (
         id, organization_id, event_id, template_id, template_version,
         template_snapshot_json, audience_filter_snapshot_json, trigger_name,
         status, source_record_id, source_version, source_content_hash, projected_at
       ) VALUES (
         'campaign_alpha', 'organization_alpha', 'event_alpha', 'template_alpha',
         1, '{}', '{}', 'manual', 'complete', 'record_campaign_alpha', 1, ?1, ?2
       )`,
    ).bind(sourceHash, now),
    environment.DB.prepare(
      `INSERT INTO p_messages (
         id, organization_id, event_id, campaign_id, contact_id,
         recipient_email, idempotency_key, provider_id, status, queued_at,
         sent_at, delivered_at, source_record_id, source_version,
         source_content_hash, projected_at
       ) VALUES (
         'message_subject', 'organization_alpha', 'event_alpha', 'campaign_alpha',
         'contact_subject', 'subject@example.test', 'private-idempotency-key',
         'private-provider-id', 'delivered', ?2, ?2, ?2,
         'record_message_subject', 1, ?1, ?2
       )`,
    ).bind(sourceHash, now),
  ]);

  await Promise.all([
    insertSession("owner", "user_owner"),
    insertSession("organizer", "user_organizer"),
    insertSession("beta", "user_beta"),
    insertSession("revoked", "user_revoked"),
  ]);
});

afterAll(async () => {
  await server.close();
});

describe("privacy export and bounded deletion policy", () => {
  it("publishes a machine-readable no-partial-delete policy", async () => {
    const response = await applicationFetch("/api/v1/privacy/policy");
    const body = await response.json<{
      deletion: { completion_target_days: number; partial_delete_api: boolean };
      retention: unknown[];
    }>();
    expect(response.status).toBe(200);
    expect(body.deletion).toMatchObject({
      completion_target_days: 30,
      partial_delete_api: false,
    });
    expect(body.retention.length).toBeGreaterThanOrEqual(3);
  });

  it("exports a minimized, tenant-scoped subject package for an owner", async () => {
    const response = await privacyRequest(
      "/api/organizations/organization_alpha/privacy/exports",
      "owner",
    );
    const text = await response.text();
    const body = JSON.parse(text) as {
      contacts: { display_name: string }[];
      files: { display_filename: string }[];
      organization_id: string;
      reviews: { scores: unknown[] }[];
      subject_found: boolean;
      submissions: { answers: unknown[] }[];
      task_assignments: { response: unknown }[];
    };
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(body).toMatchObject({
      organization_id: "organization_alpha",
      subject_found: true,
    });
    expect(body.contacts).toEqual([
      expect.objectContaining({ display_name: "Subject Fixture" }),
    ]);
    expect(body.submissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          answers: [
            expect.objectContaining({ value: "Subject answer fixture" }),
          ],
          relationship: "submitter",
        }),
        expect.objectContaining({
          answers: [],
          relationship: "participant",
        }),
      ]),
    );
    expect(body.reviews[0]?.scores).toHaveLength(1);
    expect(body.task_assignments[0]?.response).toEqual({
      phone: "+1-555-0100",
    });
    expect(body.files).toEqual([
      expect.objectContaining({ display_filename: "subject-slides.pdf" }),
    ]);
    for (const forbidden of [
      "Third Party Secret Name",
      "Other Tenant Secret Name",
      "private/tenant-alpha/subject-secret-object-key",
      "private-idempotency-key",
      "private-provider-id",
      "Provider body secret",
      "Third-party confidential answer",
      "record_contact_subject",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("returns a complete empty package for an absent subject", async () => {
    const response = await privacyRequest(
      "/api/organizations/organization_alpha/privacy/exports",
      "owner",
      { email: "absent@example.test" },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      contacts: [],
      subject_found: false,
    });
  });

  it("fails closed for missing CSRF, foreign origin, non-owner, cross-tenant, and revoked owner", async () => {
    const [missingCsrf, foreignOrigin, organizer, crossTenant, revoked] =
      await Promise.all([
        privacyRequest(
          "/api/organizations/organization_alpha/privacy/exports",
          "owner",
          { csrf: null },
        ),
        privacyRequest(
          "/api/organizations/organization_alpha/privacy/exports",
          "owner",
          { origin: "https://attacker.invalid" },
        ),
        privacyRequest(
          "/api/organizations/organization_alpha/privacy/exports",
          "organizer",
        ),
        privacyRequest(
          "/api/organizations/organization_alpha/privacy/exports",
          "beta",
        ),
        privacyRequest(
          "/api/organizations/organization_alpha/privacy/exports",
          "revoked",
        ),
      ]);
    expect(missingCsrf.status).toBe(403);
    expect(foreignOrigin.status).toBe(403);
    expect(organizer.status).toBe(403);
    expect(crossTenant.status).toBe(404);
    expect(revoked.status).toBe(404);
    expect(await crossTenant.json()).toMatchObject({
      error: { code: "privacy_scope_unavailable" },
    });
    expect(await revoked.json()).toMatchObject({
      error: { code: "privacy_scope_unavailable" },
    });
  });

  it("refuses partial deletion without changing subject data", async () => {
    const before = await environment.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM p_contacts
       WHERE organization_id = 'organization_alpha'
         AND email_normalized = 'subject@example.test'`,
    ).first<{ count: number }>();
    const response = await privacyRequest(
      "/api/organizations/organization_alpha/privacy/deletions",
      "owner",
    );
    const after = await environment.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM p_contacts
       WHERE organization_id = 'organization_alpha'
         AND email_normalized = 'subject@example.test'`,
    ).first<{ count: number }>();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      accepted: false,
      code: "coordinated_deletion_required",
      message:
        "No partial deletion was performed. Follow the identity-verified operator runbook to remove authoritative, object-storage, provider, and projection copies together.",
      policy_url: "/api/v1/privacy/policy",
    });
    expect(after?.count).toBe(before?.count);
  });

  it("rejects an online export that exceeds a resource-family bound", async () => {
    await environment.DB.prepare(
      `WITH RECURSIVE counter(value) AS (
         SELECT 1
         UNION ALL
         SELECT value + 1 FROM counter WHERE value <= 1000
       )
       INSERT INTO p_contacts (
         id, organization_id, email_normalized, display_name, source_record_id,
         source_version, source_content_hash, projected_at, source_deleted_at
       )
       SELECT 'historical_' || value, 'organization_alpha',
              'overflow@example.test', 'Historical subject',
              'record_historical_' || value, 1, ?1, ?2, ?2
       FROM counter`,
    )
      .bind(sourceHash, now)
      .run();
    await expect(
      new PrivacyExportService({ database: environment.DB }).exportByEmail(
        "organization_alpha",
        "overflow@example.test",
      ),
    ).rejects.toBeInstanceOf(PrivacyExportTooLargeError);
  });
});
