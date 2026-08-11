import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sha256Hex } from "../src/auth/crypto";
import { getBaseAuthority } from "../src/authority/binding";
import { D1PublicCfpPolicyReader } from "../src/cfp/policy";
import { parseCfpSubmissionPlanInput } from "../src/cfp/submission-authority";
import {
  cfpSubmissionCoordinates,
  cfpSubmissionUpdateCoordinates,
  D1CfpSubmissionCompiler,
  D1OwnedCfpDraftReader,
} from "../src/cfp/submission-compiler";
import type { AuthenticatedSession } from "../src/auth/service";

const hash = "c".repeat(64);
const pepper = "cfp-policy-test-pepper-with-at-least-32-characters";
const projectedAt = "2026-08-10T08:00:00.000Z";
const featureFlags = {
  ai: false,
  embeds: false,
  email: true,
  integrations: false,
  webhooks: false,
  writes: true,
};
const server = createTestHarness({
  workers: [
    {
      configPath: "workers/app/wrangler.jsonc",
      secrets: { AUTH_HASH_PEPPER: pepper },
      vars: {
        AIRTABLE_BASE_ID: "appCfpPolicyTest01",
        FEATURE_FLAGS: featureFlags,
      },
    },
  ],
});
let origin = "";

async function seedCfp(
  label: string,
  options: { closesAt?: string; routeKey?: string | null } = {},
): Promise<void> {
  const environment = await server.getWorker<Env>().getEnv();
  const organizationId = `org_${label}`;
  const eventId = `event_${label}`;
  const formId = `form_${label}`;
  const formatFieldId = `field_${label}_format`;
  const trackFieldId = `field_${label}_track`;
  const workshopFieldId = `field_${label}_workshop`;
  const closesAt = options.closesAt ?? "2099-01-01T00:00:00.000Z";
  const routeKey =
    options.routeKey === undefined ? "product-track-d" : options.routeKey;

  await environment.DB.batch([
    environment.DB.prepare(
      `INSERT INTO tenant_registry
        (organization_id, base_key, source_record_id, status, created_at,
         updated_at, authority_ready_at)
       VALUES (?1, ?2, ?3, 'active', ?4, ?4, ?4)`,
    ).bind(organizationId, `base_${label}`, `rec_tenant_${label}`, projectedAt),
    environment.DB.prepare(
      `INSERT INTO p_events
        (id, organization_id, name, slug, timezone, starts_at, ends_at, venue,
         cfp_opens_at, cfp_closes_at, status, source_record_id, source_version,
         source_content_hash, projected_at)
       VALUES (?1, ?2, ?3, ?4, 'America/Los_Angeles',
               '2099-10-13T16:00:00.000Z', '2099-10-15T00:00:00.000Z',
               'Fort Mason Center', '2000-01-01T00:00:00.000Z', ?5,
               'published', ?6, 1, ?7, ?8)`,
    ).bind(
      eventId,
      organizationId,
      `Event ${label}`,
      label,
      closesAt,
      `rec_event_${label}`,
      hash,
      projectedAt,
    ),
    environment.DB.prepare(
      `INSERT INTO p_forms
        (id, organization_id, event_id, name, status, version,
         welcome_content, submission_limit, edit_after_close, published_at,
         source_record_id, source_version, source_content_hash, projected_at)
       VALUES (?1, ?2, ?3, 'Call for proposals', 'published', 2,
               'Bring us a practical field report.', 3, 0, ?4, ?5, 1, ?6, ?4)`,
    ).bind(
      formId,
      organizationId,
      eventId,
      projectedAt,
      `rec_form_${label}`,
      hash,
    ),
    environment.DB.prepare(
      `INSERT INTO p_form_fields
        (id, organization_id, event_id, form_id, stable_key, sort_order,
         block_type, label, help_text, required, options_json, validation_json,
         source_record_id, source_version, source_content_hash, projected_at)
       VALUES (?1, ?2, ?3, ?4, 'format', 1, 'select', 'Format',
               'Choose the session length.', 1,
               '["30-minute talk","90-minute workshop"]', '{}', ?5, 1, ?6, ?7)`,
    ).bind(
      formatFieldId,
      organizationId,
      eventId,
      formId,
      `rec_field_${label}_format`,
      hash,
      projectedAt,
    ),
    environment.DB.prepare(
      `INSERT INTO p_form_fields
        (id, organization_id, event_id, form_id, stable_key, sort_order,
         block_type, label, help_text, required, options_json, validation_json,
         source_record_id, source_version, source_content_hash, projected_at)
       VALUES (?1, ?2, ?3, ?4, 'track', 2, 'select', 'Track',
               'Choose the review track.', 1, '["Product"]', '{}',
               ?5, 1, ?6, ?7)`,
    ).bind(
      trackFieldId,
      organizationId,
      eventId,
      formId,
      `rec_field_${label}_track`,
      hash,
      projectedAt,
    ),
    environment.DB.prepare(
      `INSERT INTO p_form_fields
        (id, organization_id, event_id, form_id, stable_key, sort_order,
         block_type, label, help_text, required, options_json, validation_json,
         source_record_id, source_version, source_content_hash, projected_at)
       VALUES (?1, ?2, ?3, ?4, 'workshop_prerequisites', 3, 'textarea',
               'Workshop prerequisites', '', 0, '[]', '{"maxLength":4000}',
               ?5, 1, ?6, ?7)`,
    ).bind(
      workshopFieldId,
      organizationId,
      eventId,
      formId,
      `rec_field_${label}_workshop`,
      hash,
      projectedAt,
    ),
    environment.DB.prepare(
      `INSERT INTO p_form_rules
        (id, organization_id, event_id, form_id, target_field_id,
         source_field_id, effect, operator, value_json, sort_order,
         source_record_id, source_version, source_content_hash, projected_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'show', 'equals',
               '"90-minute workshop"', 1, ?7, 1, ?8, ?9)`,
    ).bind(
      `rule_${label}_show_workshop`,
      organizationId,
      eventId,
      formId,
      workshopFieldId,
      formatFieldId,
      `rec_rule_${label}_show`,
      hash,
      projectedAt,
    ),
    environment.DB.prepare(
      `INSERT INTO p_form_rules
        (id, organization_id, event_id, form_id, target_field_id,
         source_field_id, effect, operator, value_json, sort_order,
         source_record_id, source_version, source_content_hash, projected_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'require', 'equals',
               '"90-minute workshop"', 2, ?7, 1, ?8, ?9)`,
    ).bind(
      `rule_${label}_require_workshop`,
      organizationId,
      eventId,
      formId,
      workshopFieldId,
      formatFieldId,
      `rec_rule_${label}_require`,
      hash,
      projectedAt,
    ),
    environment.DB.prepare(
      `INSERT INTO p_tracks
        (id, organization_id, event_id, name, description, sort_order,
         cfp_selection, cfp_aliases_json, route_key, submission_track,
         default_reviewer_group_id, source_record_id, source_version,
         source_content_hash, projected_at)
       VALUES (?1, ?2, ?3, 'Product', 'Human workflows.', 1, 'Product',
               '["Track D"]', ?4, 'Product · Track D', 'group-product',
               ?5, 1, ?6, ?7)`,
    ).bind(
      `track_${label}`,
      organizationId,
      eventId,
      routeKey,
      `rec_track_${label}`,
      hash,
      projectedAt,
    ),
    environment.DB.prepare(
      `INSERT INTO p_formats
        (id, organization_id, event_id, name, default_duration_minutes,
         sort_order, source_record_id, source_version, source_content_hash,
         projected_at)
       VALUES (?1, ?2, ?3, '30-minute talk', 30, 1, ?4, 1, ?5, ?6)`,
    ).bind(
      `format_${label}_talk`,
      organizationId,
      eventId,
      `rec_format_${label}_talk`,
      hash,
      projectedAt,
    ),
    environment.DB.prepare(
      `INSERT INTO p_formats
        (id, organization_id, event_id, name, default_duration_minutes,
         sort_order, source_record_id, source_version, source_content_hash,
         projected_at)
       VALUES (?1, ?2, ?3, '90-minute workshop', 90, 2, ?4, 1, ?5, ?6)`,
    ).bind(
      `format_${label}_workshop`,
      organizationId,
      eventId,
      `rec_format_${label}_workshop`,
      hash,
      projectedAt,
    ),
  ]);
}

async function seedHistoricalOpenCfpForm(): Promise<void> {
  const environment = await server.getWorker<Env>().getEnv();
  await environment.DB.batch([
    environment.DB.prepare(
      `INSERT INTO p_forms
        (id, organization_id, event_id, name, status, version,
         welcome_content, submission_limit, edit_after_close, published_at,
         source_record_id, source_version, source_content_hash, projected_at)
       VALUES ('form_open-cfp_v1', 'org_open-cfp', 'event_open-cfp',
               'Original call for proposals', 'closed', 1,
               'The original published form.', 3, 0, ?1,
               'rec_form_open-cfp_v1', 2, ?2, ?1)`,
    ).bind(projectedAt, hash),
    environment.DB.prepare(
      `INSERT INTO p_form_fields
        (id, organization_id, event_id, form_id, stable_key, sort_order,
         block_type, label, help_text, required, options_json, validation_json,
         source_record_id, source_version, source_content_hash, projected_at)
       VALUES ('field_open-cfp_v1_title', 'org_open-cfp', 'event_open-cfp',
               'form_open-cfp_v1', 'title', 1, 'text', 'Original title',
               '', 1, '[]', '{"maxLength":100}',
               'rec_field_open-cfp_v1_title', 1, ?1, ?2)`,
    ).bind(hash, projectedAt),
    environment.DB.prepare(
      `INSERT INTO p_form_fields
        (id, organization_id, event_id, form_id, stable_key, sort_order,
         block_type, label, help_text, required, options_json, validation_json,
         source_record_id, source_version, source_content_hash, projected_at)
       VALUES ('field_open-cfp_v1_abstract', 'org_open-cfp', 'event_open-cfp',
               'form_open-cfp_v1', 'abstract', 2, 'textarea', 'Original abstract',
               '', 1, '[]', '{"maxLength":1200}',
               'rec_field_open-cfp_v1_abstract', 1, ?1, ?2)`,
    ).bind(hash, projectedAt),
    environment.DB.prepare(
      `INSERT INTO p_form_fields
        (id, organization_id, event_id, form_id, stable_key, sort_order,
         block_type, label, help_text, required, options_json, validation_json,
         source_record_id, source_version, source_content_hash, projected_at)
       VALUES ('field_open-cfp_v1_outcomes', 'org_open-cfp', 'event_open-cfp',
               'form_open-cfp_v1', 'outcomes', 3, 'textarea', 'Original outcomes',
               '', 1, '[]', '{"maxLength":1200}',
               'rec_field_open-cfp_v1_outcomes', 1, ?1, ?2)`,
    ).bind(hash, projectedAt),
    environment.DB.prepare(
      `INSERT INTO p_form_fields
        (id, organization_id, event_id, form_id, stable_key, sort_order,
         block_type, label, help_text, required, options_json, validation_json,
         source_record_id, source_version, source_content_hash, projected_at)
       VALUES ('field_open-cfp_v1_format', 'org_open-cfp', 'event_open-cfp',
               'form_open-cfp_v1', 'format', 4, 'select', 'Original format',
               '', 1, '["30-minute talk","90-minute workshop"]', '{}',
               'rec_field_open-cfp_v1_format', 1, ?1, ?2)`,
    ).bind(hash, projectedAt),
    environment.DB.prepare(
      `INSERT INTO p_form_fields
        (id, organization_id, event_id, form_id, stable_key, sort_order,
         block_type, label, help_text, required, options_json, validation_json,
         source_record_id, source_version, source_content_hash, projected_at)
       VALUES ('field_open-cfp_v1_track', 'org_open-cfp', 'event_open-cfp',
               'form_open-cfp_v1', 'track', 5, 'select', 'Original track',
               '', 1, '["Product"]', '{}',
               'rec_field_open-cfp_v1_track', 1, ?1, ?2)`,
    ).bind(hash, projectedAt),
  ]);
}

function authHeaders(ipAddress: string): Record<string, string> {
  return {
    "CF-Connecting-IP": ipAddress,
    "Content-Type": "application/json",
    Origin: origin,
    "Sec-Fetch-Site": "same-origin",
    "User-Agent": "OpenSession CFP policy test",
  };
}

function requestAccount(
  email: string,
  eventSlug: string | undefined,
  ipAddress: string,
) {
  return server.fetch("/api/auth/magic-links", {
    body: JSON.stringify({
      email,
      ...(eventSlug ? { event_slug: eventSlug } : {}),
      purpose: "sign_in",
      redirect_path: eventSlug ? `/e/${eventSlug}/cfp` : "/",
      turnstile_action: eventSlug ? "cfp_account" : "sign_in",
      turnstile_token: "XXXX.DUMMY.TOKEN.XXXX",
    }),
    headers: authHeaders(ipAddress),
    method: "POST",
  });
}

async function seedAuthenticatedSession(userId: string, label: string) {
  const environment = await server.getWorker<Env>().getEnv();
  const token = `session-${label}-${"s".repeat(40)}`;
  const csrf = `csrf-${label}-${"c".repeat(40)}`;
  await environment.DB.batch([
    environment.DB.prepare(
      `INSERT INTO auth_sessions
        (id, user_id, token_hash, created_at, expires_at, last_seen_at)
       VALUES (?1, ?2, ?3, ?4, '2099-01-01T00:00:00.000Z', ?4)`,
    ).bind(`auth_${label}`, userId, await sha256Hex(token), projectedAt),
    environment.DB.prepare(
      `INSERT INTO auth_session_secrets
        (session_id, csrf_token_hash, created_at)
       VALUES (?1, ?2, ?3)`,
    ).bind(`auth_${label}`, await sha256Hex(csrf), projectedAt),
  ]);
  return { cookie: `__Host-opensession-session=${token}`, csrf };
}

beforeAll(async () => {
  const listening = await server.listen();
  origin = listening.url.origin;
  await server.getWorker<Env>().applyD1Migrations("DB");
  await seedCfp("open-cfp");
  await seedHistoricalOpenCfpForm();
  await seedCfp("limit-cfp");
  await seedCfp("closed-cfp", {
    closesAt: "2001-01-01T00:00:00.000Z",
  });
  await seedCfp("invalid-cfp", { routeKey: null });
  await seedCfp("bad-dates-cfp", {
    closesAt: "1999-01-01T00:00:00.000Z",
  });
});

afterAll(async () => {
  await server.close();
});

describe("authoritative public CFP policy", () => {
  it("publishes presentation-safe form data while retaining routing server-side", async () => {
    const response = await server.fetch("/api/v1/public/events/open-cfp/cfp");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      acceptingSubmissions: true,
      event: { slug: "open-cfp", timezone: "America/Los_Angeles" },
      form: {
        submissionLimit: 3,
        version: 2,
        fields: [
          { key: "format", type: "single_select", validation: {} },
          { key: "track", type: "single_select", validation: {} },
          {
            key: "workshop_prerequisites",
            rules: [
              { effect: "show", operator: "equals" },
              { effect: "require", operator: "equals" },
            ],
            type: "long_text",
            validation: { maxLength: 4_000 },
          },
        ],
      },
      formats: ["30-minute talk", "90-minute workshop"],
      tracks: [{ selection: "Product" }],
    });
    expect(JSON.stringify(body)).not.toContain("product-track-d");
    expect(JSON.stringify(body)).not.toContain("group-product");

    const environment = await server.getWorker<Env>().getEnv();
    const policy = await new D1PublicCfpPolicyReader(environment.DB).readBySlug(
      "open-cfp",
    );
    expect(policy?.routes).toEqual([
      {
        aliases: ["Track D"],
        defaultReviewerGroupId: "group-product",
        routeKey: "product-track-d",
        selection: "Product",
        submissionTrack: "Product · Track D",
      },
    ]);
  });

  it("derives open and closed phases at exact server timestamps", async () => {
    const environment = await server.getWorker<Env>().getEnv();
    const reader = new D1PublicCfpPolicyReader(environment.DB);

    expect(
      (await reader.readBySlug("open-cfp", new Date("1999-12-31T23:59:59Z")))
        ?.acceptingSubmissions,
    ).toBe(false);
    expect(
      (await reader.readBySlug("open-cfp", new Date("2050-01-01T00:00:00Z")))
        ?.acceptingSubmissions,
    ).toBe(true);
    expect(
      (await reader.readBySlug("open-cfp", new Date("2099-01-01T00:00:00Z")))
        ?.acceptingSubmissions,
    ).toBe(false);
  });

  it("keeps an existing v1 draft valid and submittable after v2 is published", async () => {
    const environment = await server.getWorker<Env>().getEnv();
    const reader = new D1PublicCfpPolicyReader(environment.DB);
    const current = await reader.readBySlug(
      "open-cfp",
      new Date("2026-08-10T12:00:00.000Z"),
    );
    const historical = await reader.readBySlug(
      "open-cfp",
      new Date("2026-08-10T12:00:00.000Z"),
      1,
    );
    if (!current || !historical) {
      throw new Error("The versioned CFP policy fixture is missing.");
    }
    expect(current.publicConfiguration.form).toMatchObject({
      status: "published",
      version: 2,
    });
    expect(historical.publicConfiguration.form).toMatchObject({
      status: "closed",
      version: 1,
    });
    expect(historical.acceptingSubmissions).toBe(true);

    const versionedResponse = await server.fetch(
      "/api/v1/public/events/open-cfp/cfp?version=1",
    );
    expect(versionedResponse.status).toBe(200);
    await expect(versionedResponse.json()).resolves.toMatchObject({
      acceptingSubmissions: true,
      form: { status: "closed", version: 1 },
    });

    const session: AuthenticatedSession = {
      csrfTokenHash: "1".repeat(64),
      expiresAt: "2099-01-01T00:00:00.000Z",
      id: "session_cfp_historical",
      tokenHash: "2".repeat(64),
      user: {
        displayName: "Historical Speaker",
        email: "historical@example.test",
        id: "user_cfp_historical",
      },
    };
    const request = {
      answers: {
        abstract: "The original version of this proposal abstract.",
        format: "30-minute talk",
        outcomes: "Understand why immutable snapshots matter.",
        title: "Historical snapshot safety",
        track: "Product",
      },
      expected_source_version: 3,
      form_version: 1,
      mode: "submit" as const,
      participant_consent: true as const,
      participants: [
        {
          email: session.user.email,
          id: "historical-speaker",
          name: "Historical Speaker",
          role: "Engineer",
        },
      ],
      turnstile_action: "cfp_submit" as const,
      turnstile_token: "XXXX.DUMMY.TOKEN.XXXX",
    };
    const draft = {
      content: {
        answers: request.answers,
        participants: request.participants,
      },
      form_version: 1,
      friendly_id: "OS-HISTORICAL",
      source_version: 3,
      submission_id: "submission_cfp_historical",
      updated_at: projectedAt,
    };
    const coordinates = await cfpSubmissionUpdateCoordinates(
      historical,
      session,
      "request-key-historical-0001",
      request,
      draft,
    );
    const plan = await new D1CfpSubmissionCompiler(
      environment.DB,
    ).compileUpdate(
      historical,
      session,
      request,
      coordinates,
      draft,
      new Date("2026-08-10T12:00:00.000Z"),
    );
    expect(
      plan.items.find((item) => item.table === "submissions")?.fields,
    ).toMatchObject({
      Form: { kind: "provider_record", recordId: "rec_form_open-cfp_v1" },
      "Form version": 1,
      Status: "submitted",
    });
    expect(
      plan.items
        .filter((item) => item.table === "submission_answers")
        .map((item) => item.fields),
    ).toEqual([
      expect.objectContaining({
        "Field label snapshot": "Original title",
        "Field stable key": "title",
        "Form version snapshot": 1,
        Order: 1,
        Type: "short_text",
      }),
      expect.objectContaining({
        "Field label snapshot": "Original abstract",
        "Field stable key": "abstract",
        "Form version snapshot": 1,
        Order: 2,
        Type: "long_text",
      }),
      expect.objectContaining({
        "Field label snapshot": "Original outcomes",
        "Field stable key": "outcomes",
        "Form version snapshot": 1,
        Order: 3,
        Type: "long_text",
      }),
      expect.objectContaining({
        "Field label snapshot": "Original format",
        "Field stable key": "format",
        "Form version snapshot": 1,
        Order: 4,
        Type: "single_select",
      }),
      expect.objectContaining({
        "Field label snapshot": "Original track",
        "Field stable key": "track",
        "Form version snapshot": 1,
        Order: 5,
        Type: "single_select",
      }),
    ]);
  });

  it("compiles an authenticated request into server-owned authority routing", async () => {
    const environment = await server.getWorker<Env>().getEnv();
    const policy = await new D1PublicCfpPolicyReader(environment.DB).readBySlug(
      "open-cfp",
    );
    if (!policy) throw new Error("The compiler fixture policy is missing.");
    const session: AuthenticatedSession = {
      csrfTokenHash: "b".repeat(64),
      expiresAt: "2099-01-01T00:00:00.000Z",
      id: "session_cfp_compiler",
      tokenHash: "c".repeat(64),
      user: {
        displayName: "Primary Speaker",
        email: "primary@example.test",
        id: "user_cfp_compiler",
      },
    };
    await environment.DB.prepare(
      `INSERT INTO users
        (id, email_normalized, display_name, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'active', ?4, ?4)`,
    )
      .bind(
        session.user.id,
        session.user.email,
        session.user.displayName,
        projectedAt,
      )
      .run();
    const request = {
      answers: {
        format: "30-minute talk",
        track: "Product",
        workshop_prerequisites: "This hidden value must be cleared.",
      },
      form_version: 2,
      mode: "submit" as const,
      participant_consent: true as const,
      participants: [
        {
          email: "primary@example.test",
          id: "primary-speaker",
          name: "Primary Speaker",
          role: "Principal Engineer",
        },
      ],
      turnstile_action: "cfp_submit" as const,
      turnstile_token: "XXXX.DUMMY.TOKEN.XXXX",
    };
    const coordinates = await cfpSubmissionCoordinates(
      policy,
      session,
      "request-key-compiler-0001",
      request,
    );
    const plan = await new D1CfpSubmissionCompiler(environment.DB).compile(
      policy,
      session,
      request,
      coordinates,
      new Date("2026-08-10T12:00:00.000Z"),
    );
    const submission = plan.items.find((item) => item.table === "submissions");

    expect(policy.authority).toMatchObject({
      eventRecordId: "rec_event_open-cfp",
      formRecordId: "rec_form_open-cfp",
      organizationRecordId: "rec_tenant_open-cfp",
      tracks: [
        {
          entityId: "track_open-cfp",
          providerRecordId: "rec_track_open-cfp",
        },
      ],
    });
    expect(plan).toMatchObject({
      actorId: session.user.id,
      mode: "submit",
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(submission?.fields).toMatchObject({
      "Default reviewer group ID": "group-product",
      "Route key": "product-track-d",
      Status: "submitted",
      Track: {
        kind: "provider_record",
        recordId: "rec_track_open-cfp",
      },
    });
    expect(String(submission?.fields["Draft JSON"])).not.toContain(
      "hidden value",
    );
    expect(
      plan.items.some(
        (item) =>
          item.table === "submission_answers" &&
          item.fields["Field stable key"] === "workshop_prerequisites",
      ),
    ).toBe(false);

    const refreshedChallenge = await cfpSubmissionCoordinates(
      policy,
      session,
      "request-key-compiler-0001",
      { ...request, turnstile_token: "A-FRESH-TOKEN" },
    );
    expect(refreshedChallenge.requestHash).toBe(coordinates.requestHash);

    const changedRequest = {
      ...request,
      answers: { ...request.answers, format: "90-minute workshop" },
      turnstile_token: "A-FRESH-TOKEN",
    };
    const changedCoordinates = await cfpSubmissionCoordinates(
      policy,
      session,
      "request-key-compiler-0001",
      changedRequest,
    );
    expect(changedCoordinates.planId).toBe(coordinates.planId);
    expect(changedCoordinates.requestHash).not.toBe(coordinates.requestHash);
    await expect(
      new D1CfpSubmissionCompiler(environment.DB).compile(
        policy,
        session,
        changedRequest,
        changedCoordinates,
      ),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("requires same-origin session and CSRF protection on submission writes", async () => {
    const body = JSON.stringify({
      answers: { format: "30-minute talk", track: "Product" },
      form_version: 2,
      mode: "draft",
      participants: [
        {
          email: "speaker@example.test",
          id: "primary-speaker",
          name: "Primary Speaker",
          role: "Engineer",
        },
      ],
    });
    const crossOrigin = await server.fetch(
      "/api/v1/public/events/open-cfp/submissions",
      {
        body,
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "request-key-route-0001",
          Origin: "https://attacker.example",
        },
        method: "POST",
      },
    );
    expect(crossOrigin.status).toBe(403);

    const unauthenticated = await server.fetch(
      "/api/v1/public/events/open-cfp/submissions",
      {
        body,
        headers: {
          ...authHeaders("203.0.113.107"),
          "Idempotency-Key": "request-key-route-0002",
          "X-CSRF-Token": "missing-session",
        },
        method: "POST",
      },
    );
    expect(unauthenticated.status).toBe(401);
    await expect(unauthenticated.json()).resolves.toMatchObject({
      error: { code: "invalid_session" },
    });
  });

  it("atomically reserves no more than the published per-account limit", async () => {
    const environment = await server.getWorker<Env>().getEnv();
    const policy = await new D1PublicCfpPolicyReader(environment.DB).readBySlug(
      "limit-cfp",
    );
    if (!policy) throw new Error("The limit fixture policy is missing.");
    const session: AuthenticatedSession = {
      csrfTokenHash: "d".repeat(64),
      expiresAt: "2099-01-01T00:00:00.000Z",
      id: "session_cfp_limit",
      tokenHash: "e".repeat(64),
      user: {
        displayName: "Limited Speaker",
        email: "limited@example.test",
        id: "user_cfp_limit",
      },
    };
    await environment.DB.prepare(
      `INSERT INTO users
        (id, email_normalized, display_name, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'active', ?4, ?4)`,
    )
      .bind(
        session.user.id,
        session.user.email,
        session.user.displayName,
        projectedAt,
      )
      .run();
    const request = {
      answers: { format: "30-minute talk", track: "Product" },
      form_version: 2,
      mode: "draft" as const,
      participants: [
        {
          email: session.user.email,
          id: "limited-speaker",
          name: "Limited Speaker",
          role: "Engineer",
        },
      ],
    };
    const attempts = await Promise.allSettled(
      Array.from({ length: 4 }, async (_, index) => {
        const coordinates = await cfpSubmissionCoordinates(
          policy,
          session,
          `request-key-limit-000${index}`,
          request,
        );
        return new D1CfpSubmissionCompiler(environment.DB).compile(
          policy,
          session,
          request,
          coordinates,
        );
      }),
    );

    expect(
      attempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(3);
    expect(
      attempts.filter((attempt) => attempt.status === "rejected"),
    ).toHaveLength(1);
    expect(
      await environment.DB.prepare(
        `SELECT COUNT(*) AS count FROM cfp_submission_reservations
         WHERE organization_id = ?1 AND event_id = ?2 AND user_id = ?3`,
      )
        .bind(policy.organizationId, policy.eventId, session.user.id)
        .first(),
    ).toEqual({ count: 3 });
  });

  it("lists only owned drafts and compiles versioned draft updates before one final materialization", async () => {
    const environment = await server.getWorker<Env>().getEnv();
    const policy = await new D1PublicCfpPolicyReader(environment.DB).readBySlug(
      "open-cfp",
    );
    if (!policy) throw new Error("The owned draft fixture policy is missing.");
    const session: AuthenticatedSession = {
      csrfTokenHash: "f".repeat(64),
      expiresAt: "2099-01-01T00:00:00.000Z",
      id: "session_owned_draft",
      tokenHash: "a".repeat(64),
      user: {
        displayName: "Owned Speaker",
        email: "owned@example.test",
        id: "user_owned_draft",
      },
    };
    const submissionId = "submission_owned_draft";
    const draftContent = {
      answers: { format: "30-minute talk" },
      participants: [
        {
          email: session.user.email,
          id: "owned-primary",
          name: "Owned Speaker",
          role: "Engineer",
        },
      ],
    };
    await environment.DB.batch([
      environment.DB.prepare(
        `INSERT INTO users
          (id, email_normalized, display_name, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'active', ?4, ?4)`,
      ).bind(
        session.user.id,
        session.user.email,
        session.user.displayName,
        projectedAt,
      ),
      environment.DB.prepare(
        `INSERT INTO p_contacts
          (id, organization_id, email_normalized, display_name, social_json,
           source_record_id, source_version, source_content_hash, projected_at)
         VALUES ('contact_owned_draft', ?1, ?2, ?3, '{}',
                 'rec_contact_owned_draft', 2, ?4, ?5)`,
      ).bind(
        policy.organizationId,
        session.user.email,
        session.user.displayName,
        hash,
        projectedAt,
      ),
      environment.DB.prepare(
        `INSERT INTO p_submissions
          (id, organization_id, event_id, form_id, form_version, friendly_id,
           submitter_contact_id, title, status, draft_json, updated_at,
           source_record_id, source_version, source_content_hash, projected_at)
         VALUES (?1, ?2, ?3, ?4, 2, 'OS-OWNEDDRAFT',
                 'contact_owned_draft', 'Saved draft', 'draft', ?5, ?6,
                 'rec_submission_owned_draft', 4, ?7, ?6)`,
      ).bind(
        submissionId,
        policy.organizationId,
        policy.eventId,
        policy.formId,
        JSON.stringify(draftContent),
        projectedAt,
        hash,
      ),
      environment.DB.prepare(
        `INSERT INTO cfp_submission_reservations
          (organization_id, event_id, submission_id, user_id, plan_id,
           request_hash, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'cfp_plan_owned_seed', ?5, ?6, ?6)`,
      ).bind(
        policy.organizationId,
        policy.eventId,
        submissionId,
        session.user.id,
        "d".repeat(64),
        projectedAt,
      ),
    ]);

    const reader = new D1OwnedCfpDraftReader(environment.DB);
    await expect(reader.list(policy, session)).resolves.toEqual([
      expect.objectContaining({
        content: draftContent,
        friendly_id: "OS-OWNEDDRAFT",
        source_version: 4,
        status: "draft",
        submission_id: submissionId,
      }),
    ]);
    await expect(
      reader.read(
        policy,
        {
          ...session,
          user: { ...session.user, id: "another_user" },
        },
        submissionId,
      ),
    ).resolves.toBeNull();
    const draft = await reader.read(policy, session, submissionId);
    if (!draft) throw new Error("The owned draft could not be read.");

    const draftRequest = {
      answers: { format: "30-minute talk" },
      expected_source_version: 4,
      form_version: 2,
      mode: "draft" as const,
      participants: draftContent.participants,
    };
    const draftCoordinates = await cfpSubmissionUpdateCoordinates(
      policy,
      session,
      "request-key-owned-update-0001",
      draftRequest,
      draft,
    );
    const draftPlan = await new D1CfpSubmissionCompiler(
      environment.DB,
    ).compileUpdate(policy, session, draftRequest, draftCoordinates, draft);
    expect(draftPlan.items).toHaveLength(2);
    expect(draftPlan.items[0]).toMatchObject({
      entityId: "contact_owned_draft",
      expectedVersion: 2,
      fields: { "Display name": "Owned Speaker", Title: "Engineer" },
      table: "contacts",
    });
    expect(draftPlan.items[1]).toMatchObject({
      entityId: submissionId,
      expectedVersion: 4,
      fields: {
        "Default reviewer group ID": null,
        "Route key": null,
        "Submitted at": null,
        Track: null,
      },
      table: "submissions",
    });
    expect(parseCfpSubmissionPlanInput(draftPlan)).toEqual(draftPlan);

    const finalRequest = {
      answers: { format: "30-minute talk", track: "Product" },
      expected_source_version: 4,
      form_version: 2,
      mode: "submit" as const,
      participant_consent: true as const,
      participants: [
        ...draftContent.participants,
        {
          email: "owned-co@example.test",
          id: "owned-co",
          name: "Owned Co-speaker",
          role: "Staff Engineer",
        },
      ],
      turnstile_action: "cfp_submit" as const,
      turnstile_token: "XXXX.DUMMY.TOKEN.XXXX",
    };
    const finalCoordinates = await cfpSubmissionUpdateCoordinates(
      policy,
      session,
      "request-key-owned-final-0001",
      finalRequest,
      draft,
    );
    const finalPlan = await new D1CfpSubmissionCompiler(
      environment.DB,
    ).compileUpdate(
      policy,
      session,
      finalRequest,
      finalCoordinates,
      draft,
      new Date("2026-08-10T12:30:00.000Z"),
    );
    expect(finalPlan.items.filter((item) => item.table === "contacts")).toEqual(
      [
        expect.objectContaining({
          entityId: "contact_owned_draft",
          expectedVersion: 2,
        }),
        expect.objectContaining({
          expectedVersion: 0,
          fields: expect.objectContaining({
            "Email normalized": "owned-co@example.test",
          }),
        }),
      ],
    );
    expect(
      finalPlan.items.filter((item) => item.table === "submission_answers"),
    ).toHaveLength(2);
    expect(
      finalPlan.items.filter(
        (item) => item.table === "submission_participants",
      ),
    ).toHaveLength(2);
    expect(
      finalPlan.items.find((item) => item.table === "submissions"),
    ).toMatchObject({ expectedVersion: 4, fields: { Status: "submitted" } });

    await environment.DB.prepare(
      `UPDATE p_contacts SET title = 'Engineer'
       WHERE organization_id = ?1 AND id = 'contact_owned_draft'`,
    )
      .bind(policy.organizationId)
      .run();
    const clearRoleRequest = {
      ...draftRequest,
      participants: draftContent.participants.map((participant) => ({
        ...participant,
        role: "",
      })),
    };
    const clearRoleCoordinates = await cfpSubmissionUpdateCoordinates(
      policy,
      session,
      "request-key-owned-clear-role-0001",
      clearRoleRequest,
      draft,
    );
    const clearRolePlan = await new D1CfpSubmissionCompiler(
      environment.DB,
    ).compileUpdate(
      policy,
      session,
      clearRoleRequest,
      clearRoleCoordinates,
      draft,
    );
    expect(
      clearRolePlan.items.find(
        (item) =>
          item.table === "contacts" && item.entityId === "contact_owned_draft",
      ),
    ).toMatchObject({ fields: { Title: null } });

    const newProposalRequest = {
      answers: { format: "30-minute talk" },
      form_version: 2,
      mode: "draft" as const,
      participants: draftContent.participants.map((participant) => ({
        ...participant,
        role: "",
      })),
    };
    const newProposalCoordinates = await cfpSubmissionCoordinates(
      policy,
      session,
      "request-key-new-blank-role-0001",
      newProposalRequest,
    );
    const newProposalPlan = await new D1CfpSubmissionCompiler(
      environment.DB,
    ).compile(policy, session, newProposalRequest, newProposalCoordinates);
    expect(
      newProposalPlan.items.find(
        (item) =>
          item.table === "contacts" && item.entityId === "contact_owned_draft",
      ),
    ).toBeUndefined();

    await expect(
      new D1CfpSubmissionCompiler(environment.DB).compileUpdate(
        policy,
        session,
        { ...draftRequest, expected_source_version: 3 },
        draftCoordinates,
        draft,
      ),
    ).rejects.toMatchObject({ code: "source_version_conflict" });

    const authentication = await seedAuthenticatedSession(
      session.user.id,
      "owned_draft",
    );
    const draftResponse = await server.fetch(
      "/api/v1/public/events/open-cfp/submissions",
      { headers: { Cookie: authentication.cookie } },
    );
    expect(draftResponse.status).toBe(200);
    await expect(draftResponse.json()).resolves.toMatchObject({
      submissions: [
        {
          content: draftContent,
          source_version: 4,
          status: "draft",
          submission_id: submissionId,
        },
      ],
    });
    const staleCoordinates = await cfpSubmissionUpdateCoordinates(
      policy,
      session,
      "request-key-route-update-0001",
      { ...draftRequest, expected_source_version: 3 },
      draft,
    );
    await expect(
      getBaseAuthority(environment).resumeCfpSubmissionPlan(
        policy.organizationId,
        staleCoordinates.planId,
        staleCoordinates.requestHash,
      ),
    ).resolves.toBeNull();
    const staleUpdate = await server.fetch(
      `/api/v1/public/events/open-cfp/submissions/${submissionId}`,
      {
        body: JSON.stringify({ ...draftRequest, expected_source_version: 3 }),
        headers: {
          ...authHeaders("203.0.113.108"),
          Cookie: authentication.cookie,
          "Idempotency-Key": "request-key-route-update-0001",
          "X-CSRF-Token": authentication.csrf,
        },
        method: "PUT",
      },
    );
    const staleBody = await staleUpdate.json();
    expect(
      staleUpdate.status,
      JSON.stringify({ body: staleBody, logs: server.getLogs() }),
    ).toBe(409);
    expect(staleBody).toMatchObject({
      error: { code: "source_version_conflict" },
    });

    const versionRace = await server.fetch(
      `/api/v1/public/events/open-cfp/submissions/${submissionId}`,
      {
        body: JSON.stringify({ ...draftRequest, form_version: 1 }),
        headers: {
          ...authHeaders("203.0.113.109"),
          Cookie: authentication.cookie,
          "Idempotency-Key": "request-key-route-version-race-0001",
          "X-CSRF-Token": authentication.csrf,
        },
        method: "PUT",
      },
    );
    expect(versionRace.status).toBe(409);
    await expect(versionRace.json()).resolves.toMatchObject({
      error: { code: "form_version_conflict" },
    });

    await environment.DB.prepare(
      `UPDATE p_submissions SET status = 'accepted' WHERE id = ?1`,
    )
      .bind(submissionId)
      .run();
    await expect(reader.list(policy, session)).resolves.toEqual([
      expect.objectContaining({
        status: "accepted",
        submission_id: submissionId,
      }),
    ]);
    await expect(
      reader.readForWrite(policy, session, submissionId),
    ).resolves.toMatchObject({
      draft: { submission_id: submissionId },
      status: "accepted",
    });
    const lockedUpdate = await server.fetch(
      `/api/v1/public/events/open-cfp/submissions/${submissionId}`,
      {
        body: JSON.stringify(draftRequest),
        headers: {
          ...authHeaders("203.0.113.108"),
          Cookie: authentication.cookie,
          "Idempotency-Key": "request-key-route-locked-0001",
          "X-CSRF-Token": authentication.csrf,
        },
        method: "PUT",
      },
    );
    expect(lockedUpdate.status).toBe(409);
    await expect(lockedUpdate.json()).resolves.toMatchObject({
      error: { code: "submission_locked" },
    });
  });

  it("registers an unprivileged identity only for an open valid CFP", async () => {
    const response = await requestAccount(
      "new-applicant@example.test",
      "open-cfp",
      "203.0.113.101",
    );
    expect(response.status).toBe(202);

    const environment = await server.getWorker<Env>().getEnv();
    const user = await environment.DB.prepare(
      `SELECT id, status FROM users
       WHERE email_normalized = 'new-applicant@example.test'`,
    ).first<{ id: string; status: string }>();
    const token = await environment.DB.prepare(
      `SELECT delivery_state FROM magic_link_tokens
       WHERE email_normalized = 'new-applicant@example.test'`,
    ).first<{ delivery_state: string }>();
    const membership = await environment.DB.prepare(
      `SELECT COUNT(*) AS count FROM organization_memberships
       WHERE user_id = ?1`,
    )
      .bind(user?.id ?? "missing")
      .first<{ count: number }>();

    expect(user).toMatchObject({ status: "active" });
    expect(user?.id).toMatch(/^usr_[a-f0-9]{32}$/);
    expect(token).toEqual({ delivery_state: "queued" });
    expect(membership?.count).toBe(0);
  });

  it("keeps unknown, closed, and generic account requests enumeration-safe", async () => {
    const closed = await requestAccount(
      "closed-applicant@example.test",
      "closed-cfp",
      "203.0.113.102",
    );
    const unknown = await requestAccount(
      "unknown-applicant@example.test",
      "missing-cfp",
      "203.0.113.103",
    );
    const generic = await requestAccount(
      "generic-applicant@example.test",
      undefined,
      "203.0.113.104",
    );

    expect(closed.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(generic.status).toBe(202);
    const [closedBody, unknownBody, genericBody] = await Promise.all([
      closed.json(),
      unknown.json(),
      generic.json(),
    ]);
    expect(closedBody).toEqual(unknownBody);
    expect(unknownBody).toEqual(genericBody);

    const environment = await server.getWorker<Env>().getEnv();
    const rows = await environment.DB.prepare(
      `SELECT email_normalized FROM users
       WHERE email_normalized IN (
         'closed-applicant@example.test',
         'unknown-applicant@example.test',
         'generic-applicant@example.test'
       )`,
    ).all<{ email_normalized: string }>();
    expect(rows.results).toEqual([]);
  });

  it("does not reactivate a disabled identity through CFP registration", async () => {
    const environment = await server.getWorker<Env>().getEnv();
    await environment.DB.prepare(
      `INSERT INTO users
        (id, email_normalized, status, created_at, updated_at, disabled_at)
       VALUES ('usr_disabled_cfp', 'disabled-cfp@example.test', 'disabled',
               ?1, ?1, ?1)`,
    )
      .bind(projectedAt)
      .run();

    const response = await requestAccount(
      "disabled-cfp@example.test",
      "open-cfp",
      "203.0.113.106",
    );
    expect(response.status).toBe(202);
    expect(
      await environment.DB.prepare(
        `SELECT status FROM users WHERE id = 'usr_disabled_cfp'`,
      ).first(),
    ).toEqual({ status: "disabled" });
    expect(
      await environment.DB.prepare(
        `SELECT id FROM magic_link_tokens
         WHERE email_normalized = 'disabled-cfp@example.test'`,
      ).first(),
    ).toBeNull();
  });

  it("fails an incomplete published route closed without leaking metadata", async () => {
    const response = await server.fetch(
      "/api/v1/public/events/invalid-cfp/cfp",
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "service_unavailable" },
    });

    const account = await requestAccount(
      "invalid-applicant@example.test",
      "invalid-cfp",
      "203.0.113.105",
    );
    expect(account.status).toBe(202);
    const environment = await server.getWorker<Env>().getEnv();
    expect(
      await environment.DB.prepare(
        `SELECT id FROM users
         WHERE email_normalized = 'invalid-applicant@example.test'`,
      ).first(),
    ).toBeNull();

    const badDates = await server.fetch(
      "/api/v1/public/events/bad-dates-cfp/cfp",
    );
    expect(badDates.status).toBe(503);
  });
});
