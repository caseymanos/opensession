import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { D1PublicCfpPolicyReader } from "../src/cfp/policy";

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
      vars: { FEATURE_FLAGS: featureFlags },
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

beforeAll(async () => {
  const listening = await server.listen();
  origin = listening.url.origin;
  await server.getWorker<Env>().applyD1Migrations("DB");
  await seedCfp("open-cfp");
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
