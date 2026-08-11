import { createTestHarness } from "wrangler";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ApiKeyMetadata } from "@sessionbox-killer/contracts/public-api";

import type * as PublicApiRuntime from "./fixtures/public-api-runtime";

import type { AppContext } from "../src/app-context";
import { sha256Hex } from "../src/auth/crypto";
import { createApiKeyMaterial } from "../src/public-api/crypto";
import {
  ApiKeyManagementService,
  ApiKeyPlaintextUnavailableError,
  type ApiKeyManagementAccess,
} from "../src/public-api/key-service";
import { PublicApiRateLimiter } from "../src/public-api/rate-limit";
import {
  registerApiKeyManagementRoutes,
  registerPublicApiDocumentationRoutes,
  registerPublicApiRoutes,
} from "../src/public-api/routes";

const origin = "https://api.opensession.test";
const pepper = "0".repeat(32);
const now = "2026-08-10T20:00:00.000Z";
const future = "2027-08-10T20:00:00.000Z";
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

let eventKey = "";
let organizationKey = "";
let limitedKey = "";
let revocableKey = "";
let betaOrganizationKey = "";
let submissionWriteKey = "";
let organizerSession!: { cookie: string; csrf: string };
let application!: Hono<AppContext>;
let applicationEnvironment!: Env;

function applicationFetch(path: string, init?: RequestInit) {
  return application.fetch(
    new Request(`${origin}${path}`, init),
    applicationEnvironment,
  );
}

function request(path: string, key?: string) {
  return applicationFetch(path, {
    ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}),
  });
}

function managementHeaders(
  options: { csrf?: string; idempotencyKey?: string } = {},
) {
  return {
    Cookie: organizerSession.cookie,
    "Content-Type": "application/json",
    ...(options.csrf === undefined
      ? { "X-CSRF-Token": organizerSession.csrf }
      : options.csrf
        ? { "X-CSRF-Token": options.csrf }
        : {}),
    ...(options.idempotencyKey
      ? { "Idempotency-Key": options.idempotencyKey }
      : {}),
    Origin: origin,
    "Sec-Fetch-Site": "same-origin",
  };
}

function access(
  organizationId: string,
  eventId: string,
  requestId: string,
): ApiKeyManagementAccess {
  return {
    actorId:
      organizationId === "organization_alpha" ? "user_alpha" : "user_beta",
    canManageOrganization: true,
    eventId,
    organizationId,
    requestId,
  };
}

async function createKey(options: {
  eventId: string;
  idempotencyKey: string;
  organizationId: string;
  scope: "event" | "organization";
  scopes: (
    | "events:read"
    | "integrations:read"
    | "schedule:read"
    | "sessions:read"
    | "speakers:read"
    | "submissions:read"
    | "submissions:write"
    | "tasks:read"
  )[];
}) {
  return new ApiKeyManagementService({
    database: (await runtime.getEnv()).DB,
    hashPepper: pepper,
    now: () => new Date(now),
  }).create(
    access(
      options.organizationId,
      options.eventId,
      `request_${options.idempotencyKey}`,
    ),
    {
      expires_at: null,
      name: options.idempotencyKey,
      scope: options.scope,
      scopes: options.scopes,
    },
    options.idempotencyKey,
  );
}

beforeAll(async () => {
  await server.listen();
  await runtime.applyD1Migrations("DB");
  const environment = await runtime.getEnv();
  applicationEnvironment = environment;
  application = new Hono<AppContext>();
  application.use("*", async (context, next) => {
    const requestId = crypto.randomUUID();
    context.set("requestId", requestId);
    context.header("Cache-Control", "no-store");
    context.header("X-Content-Type-Options", "nosniff");
    context.header("X-Request-Id", requestId);
    await next();
  });
  registerPublicApiDocumentationRoutes(application);
  registerApiKeyManagementRoutes(application);
  registerPublicApiRoutes(application);
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
         id, email_normalized, display_name, created_at, updated_at
       ) VALUES
         ('user_alpha', 'alpha@example.test', 'Alpha Organizer', ?1, ?1),
         ('user_beta', 'beta@example.test', 'Beta Organizer', ?1, ?1)`,
    ).bind(now),
    environment.DB.prepare(
      `INSERT INTO p_events (
         id, organization_id, name, slug, timezone, status, brand_json,
         published_version, is_demo, source_record_id, source_version,
         source_content_hash, projected_at
       ) VALUES
         ('event_alpha', 'organization_alpha', 'Alpha Summit', 'alpha-summit',
          'UTC', 'published', '{}', 1, 0, 'record_event_alpha', 3, ?1, ?2),
         ('event_alpha_other', 'organization_alpha', 'Alpha Workshop', 'alpha-workshop',
          'UTC', 'open', '{}', 0, 0, 'record_event_alpha_other', 2, ?1, ?2),
         ('event_beta', 'organization_beta', 'Beta Summit', 'beta-summit',
          'UTC', 'published', '{}', 1, 0, 'record_event_beta', 4, ?1, ?2)`,
    ).bind(sourceHash, now),
    environment.DB.prepare(
      `INSERT INTO organization_memberships (
         id, organization_id, user_id, role, created_at, updated_at
       ) VALUES (
         'membership_alpha', 'organization_alpha', 'user_alpha',
         'organizer', ?1, ?1
       )`,
    ).bind(now),
    environment.DB.prepare(
      `INSERT INTO p_forms (
         id, organization_id, event_id, name, status, version,
         edit_after_close, source_record_id, source_version,
         source_content_hash, projected_at
       ) VALUES (
         'form_alpha', 'organization_alpha', 'event_alpha',
         'Call for proposals', 'published', 1, 0, 'record_form_alpha',
         1, ?1, ?2
       )`,
    ).bind(sourceHash, now),
    environment.DB.prepare(
      `INSERT INTO p_contacts (
         id, organization_id, email_normalized, display_name, title, company,
         bio, source_record_id, source_version, source_content_hash, projected_at
       ) VALUES (
         'contact_speaker', 'organization_alpha', 'speaker@example.test',
         'Sam Speaker', 'Principal Engineer', 'Reliable Systems',
         'Builds durable systems.', 'record_contact_speaker', 2, ?1, ?2
       )`,
    ).bind(sourceHash, now),
    environment.DB.prepare(
      `INSERT INTO p_event_contacts (
         id, organization_id, event_id, contact_id, roles_json, portal_state,
         readiness_projection_json, required_total, required_complete,
         overdue_count, speaker_ready, source_record_id, source_version,
         source_content_hash, projected_at
       ) VALUES (
         'event_contact_speaker', 'organization_alpha', 'event_alpha',
         'contact_speaker', '["speaker"]', 'active', '{}', 2, 1, 1, 0,
         'record_event_contact_speaker', 2, ?1, ?2
       )`,
    ).bind(sourceHash, now),
    environment.DB.prepare(
      `INSERT INTO p_submissions (
         id, organization_id, event_id, form_id, form_version, friendly_id,
         submitter_contact_id, title, status, submitted_at, updated_at,
         source_record_id, source_version, source_content_hash, projected_at
       ) VALUES (
         'submission_alpha', 'organization_alpha', 'event_alpha', 'form_alpha',
         1, 'SUB-001', 'contact_speaker', 'Durable public APIs', 'submitted',
         ?2, ?2, 'record_submission_alpha', 5, ?1, ?2
       )`,
    ).bind(sourceHash, now),
    environment.DB.prepare(
      `INSERT INTO p_sessions (
         id, organization_id, event_id, friendly_id, title, abstract, status,
         duration_minutes, is_public, updated_at, source_record_id,
         source_version, source_content_hash, projected_at
       ) VALUES (
         'session_alpha', 'organization_alpha', 'event_alpha', 'SESSION-001',
         'Designing durable APIs', 'A provider-neutral architecture.',
         'published', 30, 1, ?2, 'record_session_alpha', 4, ?1, ?2
       )`,
    ).bind(sourceHash, now),
    environment.DB.prepare(
      `INSERT INTO p_task_definitions (
         id, organization_id, event_id, name, type, required_default,
         approval_required, target_rule_json, form_schema_json,
         file_policy_json, source_record_id, source_version,
         source_content_hash, projected_at
       ) VALUES (
         'definition_bio', 'organization_alpha', 'event_alpha',
         'Confirm biography', 'ack', 1, 0, '{}', '{}', '{}',
         'record_definition_bio', 1, ?1, ?2
       )`,
    ).bind(sourceHash, now),
    environment.DB.prepare(
      `INSERT INTO p_task_assignments (
         id, organization_id, event_id, definition_id, contact_id, required,
         status, response_json, file_object_ids_json, updated_at,
         source_record_id, source_version, source_content_hash, projected_at
       ) VALUES (
         'task_bio', 'organization_alpha', 'event_alpha', 'definition_bio',
         'contact_speaker', 1, 'complete', '{}', '[]', ?2,
         'record_task_bio', 3, ?1, ?2
       )`,
    ).bind(sourceHash, now),
    environment.DB.prepare(
      `INSERT INTO integration_runs (
         id, organization_id, event_id, integration_id, provider, mode,
         idempotency_key, status, counts_json, created_at, started_at,
         finished_at
       ) VALUES (
         'run_schedule_export', 'organization_alpha', 'event_alpha',
         'integration_schedule', 'generic_csv', 'dry_run',
         'fixture-export-run', 'complete', '{"sessions":1}', ?1, ?1, ?1
       )`,
    ).bind(now),
  ]);

  const sessionToken = `session-alpha-${"s".repeat(40)}`;
  const csrf = `csrf-alpha-${"c".repeat(40)}`;
  await environment.DB.batch([
    environment.DB.prepare(
      `INSERT INTO auth_sessions (
         id, user_id, token_hash, created_at, expires_at, last_seen_at
       ) VALUES ('auth_alpha', 'user_alpha', ?1, ?2, ?3, ?2)`,
    ).bind(await sha256Hex(sessionToken), now, future),
    environment.DB.prepare(
      `INSERT INTO auth_session_secrets (
         session_id, csrf_token_hash, created_at
       ) VALUES ('auth_alpha', ?1, ?2)`,
    ).bind(await sha256Hex(csrf), now),
  ]);
  organizerSession = {
    cookie: `__Host-opensession-session=${sessionToken}`,
    csrf,
  };

  const allReadScopes = [
    "events:read",
    "submissions:read",
    "sessions:read",
    "speakers:read",
    "tasks:read",
    "schedule:read",
    "integrations:read",
  ] as const;
  eventKey = (
    await createKey({
      eventId: "event_alpha",
      idempotencyKey: "event-alpha-reader",
      organizationId: "organization_alpha",
      scope: "event",
      scopes: [...allReadScopes],
    })
  ).data.plaintext;
  organizationKey = (
    await createKey({
      eventId: "event_alpha",
      idempotencyKey: "organization-alpha-reader",
      organizationId: "organization_alpha",
      scope: "organization",
      scopes: [...allReadScopes],
    })
  ).data.plaintext;
  limitedKey = (
    await createKey({
      eventId: "event_alpha",
      idempotencyKey: "schedule-only-reader",
      organizationId: "organization_alpha",
      scope: "event",
      scopes: ["schedule:read"],
    })
  ).data.plaintext;
  revocableKey = (
    await createKey({
      eventId: "event_alpha",
      idempotencyKey: "revocable-reader",
      organizationId: "organization_alpha",
      scope: "event",
      scopes: ["events:read"],
    })
  ).data.plaintext;
  betaOrganizationKey = (
    await createKey({
      eventId: "event_beta",
      idempotencyKey: "organization-beta-reader",
      organizationId: "organization_beta",
      scope: "organization",
      scopes: ["events:read"],
    })
  ).data.plaintext;
  submissionWriteKey = (
    await createKey({
      eventId: "event_alpha",
      idempotencyKey: "submission-workflow-writer",
      organizationId: "organization_alpha",
      scope: "event",
      scopes: ["submissions:write"],
    })
  ).data.plaintext;

  const saltless = await createApiKeyMaterial(pepper);
  await environment.DB.prepare(
    `INSERT INTO api_keys (
       id, organization_id, event_id, created_by_user_id, name, token_prefix,
       token_hash, verifier_salt, scopes_json, created_at
     ) VALUES (?1, 'organization_alpha', 'event_alpha', 'user_alpha',
               'Legacy saltless key', ?2, ?3, NULL, '["events:read"]', ?4)`,
  )
    .bind(saltless.id, saltless.prefix, saltless.verifier, now)
    .run();
  revocableKey += `\u0000${saltless.plaintext}`;
}, 60_000);

afterAll(async () => {
  await server.close();
});

describe.sequential("public API runtime", () => {
  it("serves the generated OpenAPI document and accessible human docs", async () => {
    const workerSchema = await runtime.fetch(`${origin}/openapi.json`);
    expect(workerSchema.status).toBe(200);
    const workerEvent = await runtime.fetch(
      `${origin}/api/v1/events/event_beta`,
      { headers: { Authorization: `Bearer ${betaOrganizationKey}` } },
    );
    expect(workerEvent.status).toBe(200);
    const schema = await request("/openapi.json");
    expect(schema.status).toBe(200);
    expect(schema.headers.get("cache-control")).toBe("public, max-age=300");
    await expect(schema.json()).resolves.toMatchObject({
      info: { title: "OpenSession Public API" },
      openapi: "3.1.0",
    });

    const docs = await request("/docs/api");
    expect(docs.status).toBe(200);
    expect(docs.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(await docs.text()).toContain("Plaintext is never recoverable");

    const missing = await request("/api/v1/does-not-exist");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    await expect(missing.json()).resolves.toMatchObject({
      code: "public_api_route_not_found",
      request_id: expect.any(String),
      status: 404,
    });
  });

  it("authenticates a scoped key, returns ETags and rate-limit metadata, and updates last used safely", async () => {
    const response = await request("/api/v1/events/event_alpha", eventKey);
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"opensession-event-v3"');
    expect(response.headers.get("ratelimit-limit")).toBe("120");
    expect(response.headers.get("ratelimit-remaining")).toBe("119");
    await expect(response.json()).resolves.toMatchObject({
      id: "event_alpha",
      name: "Alpha Summit",
      version: 3,
    });

    const environment = await runtime.getEnv();
    const parsedId = eventKey.split(".")[0]?.slice(4);
    const row = await environment.DB.prepare(
      "SELECT last_used_at FROM api_keys WHERE id = ?1",
    )
      .bind(parsedId)
      .first<{ last_used_at: string | null }>();
    expect(row?.last_used_at).not.toBeNull();
  });

  it("uses cursor pagination default 25/max 100 and rejects a cursor on another resource", async () => {
    const first = await request("/api/v1/events?limit=1", organizationKey);
    const firstBody = (await first.json()) as {
      page: { limit: number; next_cursor: string | null };
    };
    expect(firstBody.page).toMatchObject({ limit: 1 });
    expect(firstBody.page.next_cursor).toBeTruthy();
    const second = await request(
      `/api/v1/events?limit=1&cursor=${firstBody.page.next_cursor}`,
      organizationKey,
    );
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      data: [expect.objectContaining({ id: "event_alpha" })],
      page: { limit: 1, next_cursor: null },
    });

    const defaultPage = await request("/api/v1/events", organizationKey);
    await expect(defaultPage.json()).resolves.toMatchObject({
      page: { limit: 25 },
    });
    expect(
      (await request("/api/v1/events?limit=101", organizationKey)).status,
    ).toBe(400);
    const mismatched = await request(
      `/api/v1/events/event_alpha/submissions?cursor=${firstBody.page.next_cursor}`,
      organizationKey,
    );
    expect(mismatched.status).toBe(400);
    await expect(mismatched.json()).resolves.toMatchObject({
      code: "invalid_cursor",
      status: 400,
    });
    const cursor = firstBody.page.next_cursor ?? "";
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("0") ? "1" : "0"}`;
    const tamperedResponse = await request(
      `/api/v1/events?limit=1&cursor=${tampered}`,
      organizationKey,
    );
    expect(tamperedResponse.status).toBe(400);
    await expect(tamperedResponse.json()).resolves.toMatchObject({
      code: "invalid_cursor",
      status: 400,
    });
  });

  it("serves coherent provider-neutral submissions, sessions, speakers, tasks, schedule, and export status", async () => {
    const collections = [
      ["submissions", "submission_alpha"],
      ["sessions", "session_alpha"],
      ["speakers", "contact_speaker"],
      ["tasks", "task_bio"],
      ["export-runs", "run_schedule_export"],
    ] as const;
    for (const [resource, expectedId] of collections) {
      const response = await request(
        `/api/v1/events/event_alpha/${resource}`,
        eventKey,
      );
      expect(response.status, resource).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        data: [expect.objectContaining({ id: expectedId })],
        page: { limit: 25, next_cursor: null },
      });
    }

    const details = [
      ["submissions/submission_alpha", { reference: "SUB-001", version: 5 }],
      ["sessions/session_alpha", { reference: "SESSION-001", version: 4 }],
      ["speakers/contact_speaker", { display_name: "Sam Speaker" }],
      ["tasks/task_bio", { state: "complete", version: 3 }],
      [
        "export-runs/run_schedule_export",
        { counts: { sessions: 1 }, provider: "generic_csv" },
      ],
    ] as const;
    for (const [resource, expected] of details) {
      const response = await request(
        `/api/v1/events/event_alpha/${resource}`,
        eventKey,
      );
      expect(response.status, resource).toBe(200);
      await expect(response.json()).resolves.toMatchObject(expected);
    }

    const schedule = await request(
      "/api/v1/events/event_alpha/schedule",
      eventKey,
    );
    expect(schedule.status).toBe(200);
    expect(schedule.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/);
    await expect(schedule.json()).resolves.toMatchObject({
      data: {
        event: { name: "Alpha Summit", slug: "alpha-summit" },
        sessions: [],
        version: 1,
      },
    });
  });

  it("fails closed for missing scope, cross-event, and cross-organization access", async () => {
    const insufficient = await request("/api/v1/events", limitedKey);
    expect(insufficient.status).toBe(403);
    await expect(insufficient.json()).resolves.toMatchObject({
      code: "insufficient_scope",
    });
    expect(insufficient.headers.get("content-type")).toContain(
      "application/problem+json",
    );

    const crossEvent = await request(
      "/api/v1/events/event_alpha_other",
      eventKey,
    );
    expect(crossEvent.status).toBe(403);
    await expect(crossEvent.json()).resolves.toMatchObject({
      code: "event_scope_mismatch",
    });

    const crossOrganization = await request(
      "/api/v1/events/event_beta",
      organizationKey,
    );
    expect(crossOrganization.status).toBe(404);
    const reverseCrossOrganization = await request(
      "/api/v1/events/event_alpha",
      betaOrganizationKey,
    );
    expect(reverseCrossOrganization.status).toBe(404);
  });

  it("requires Idempotency-Key and a current strong If-Match before mutation", async () => {
    const url = "/api/v1/events/event_alpha/submissions/submission_alpha";
    const body = JSON.stringify({
      reason: "Ready for committee review.",
      status: "in_review",
    });
    const headers = {
      Authorization: `Bearer ${submissionWriteKey}`,
      "Content-Type": "application/json",
    };
    const missingIdempotency = await applicationFetch(url, {
      body,
      headers,
      method: "PATCH",
    });
    expect(missingIdempotency.status).toBe(400);
    await expect(missingIdempotency.json()).resolves.toMatchObject({
      code: "invalid_idempotency_key",
    });

    const missingPrecondition = await applicationFetch(url, {
      body,
      headers: {
        ...headers,
        "Idempotency-Key": "submission-update-0001",
      },
      method: "PATCH",
    });
    expect(missingPrecondition.status).toBe(428);
    await expect(missingPrecondition.json()).resolves.toMatchObject({
      code: "precondition_required",
    });

    const stalePrecondition = await applicationFetch(url, {
      body,
      headers: {
        ...headers,
        "Idempotency-Key": "submission-update-0002",
        "If-Match": '"opensession-submission-v4"',
      },
      method: "PATCH",
    });
    expect(stalePrecondition.status).toBe(412);
    await expect(stalePrecondition.json()).resolves.toMatchObject({
      code: "etag_mismatch",
    });
  });

  it("enforces the documented per-key read rate limit", async () => {
    const limiter = new PublicApiRateLimiter({
      database: (await runtime.getEnv()).DB,
      hashPepper: pepper,
      now: () => new Date("2026-08-10T20:10:30.000Z"),
    });
    for (let index = 0; index < 120; index += 1) {
      await expect(
        limiter.consume("key_rate_limit_fixture", "read"),
      ).resolves.toMatchObject({
        allowed: true,
        limit: 120,
      });
    }
    await expect(
      limiter.consume("key_rate_limit_fixture", "read"),
    ).resolves.toMatchObject({
      allowed: false,
      limit: 120,
      remaining: 0,
      retryAfterSeconds: 30,
    });
  });

  it("stores no plaintext, emits safe audit receipts, and refuses plaintext replay", async () => {
    const environment = await runtime.getEnv();
    const keyId = organizationKey.split(".")[0]?.slice(4);
    const row = await environment.DB.prepare(
      `SELECT token_hash, verifier_salt, scopes_json
       FROM api_keys WHERE id = ?1`,
    )
      .bind(keyId)
      .first<{
        scopes_json: string;
        token_hash: string;
        verifier_salt: string;
      }>();
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.verifier_salt).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(row)).not.toContain(organizationKey);

    const audit = await environment.DB.prepare(
      `SELECT safe_diff_json, metadata_json
       FROM audit_events WHERE entity_id = ?1 AND action = 'api_key.created'`,
    )
      .bind(keyId)
      .first<{ metadata_json: string; safe_diff_json: string }>();
    expect(JSON.stringify(audit)).not.toContain(organizationKey);
    expect(audit?.safe_diff_json).toContain("osk_key_");

    await expect(
      new ApiKeyManagementService({
        database: environment.DB,
        hashPepper: pepper,
        now: () => new Date(now),
      }).create(
        access(
          "organization_alpha",
          "event_alpha",
          "request_organization-alpha-reader",
        ),
        {
          expires_at: null,
          name: "organization-alpha-reader",
          scope: "organization",
          scopes: [
            "events:read",
            "submissions:read",
            "sessions:read",
            "speakers:read",
            "tasks:read",
            "schedule:read",
            "integrations:read",
          ],
        },
        "organization-alpha-reader",
      ),
    ).rejects.toBeInstanceOf(ApiKeyPlaintextUnavailableError);
  });

  it("serializes concurrent creation to one credential and one audit receipt", async () => {
    const environment = await runtime.getEnv();
    const service = () =>
      new ApiKeyManagementService({
        database: environment.DB,
        hashPepper: pepper,
        now: () => new Date(now),
      });
    const input = {
      expires_at: null,
      name: "Concurrent automation",
      scope: "event" as const,
      scopes: ["events:read" as const],
    };
    const attempts = await Promise.allSettled([
      service().create(
        access(
          "organization_alpha",
          "event_alpha",
          "request_concurrent_create_one",
        ),
        input,
        "concurrent-create-reader",
      ),
      service().create(
        access(
          "organization_alpha",
          "event_alpha",
          "request_concurrent_create_two",
        ),
        input,
        "concurrent-create-reader",
      ),
    ]);
    expect(
      attempts.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );

    const keys = await environment.DB.prepare(
      "SELECT id FROM api_keys WHERE organization_id = ?1 AND name = ?2",
    )
      .bind("organization_alpha", input.name)
      .all<{ id: string }>();
    expect(keys.results).toHaveLength(1);
    const auditCount = await environment.DB.prepare(
      `SELECT COUNT(*) AS count FROM audit_events
       WHERE organization_id = ?1 AND entity_type = 'api_key'
         AND entity_id = ?2 AND action = 'api_key.created'`,
    )
      .bind("organization_alpha", keys.results[0]?.id)
      .first<{ count: number }>();
    expect(auditCount?.count).toBe(1);
  });

  it("fails malformed verifier state, expiry, and scopes closed and revokes immediately", async () => {
    const [usable, saltless] = revocableKey.split("\u0000");
    expect(usable).toBeTruthy();
    expect(saltless).toBeTruthy();
    expect((await request("/api/v1/events", saltless)).status).toBe(401);
    expect((await request("/api/v1/events", usable)).status).toBe(200);

    const environment = await runtime.getEnv();
    const keyId = usable?.split(".")[0]?.slice(4) ?? "";
    const result = await new ApiKeyManagementService({
      database: environment.DB,
      hashPepper: pepper,
      now: () => new Date("2026-08-10T20:05:00.000Z"),
    }).revoke(
      access("organization_alpha", "event_alpha", "request_revoke_reader"),
      keyId,
    );
    expect(result.data.state).toBe("revoked");
    expect(result.audit_receipt.request_id).toBe("request_revoke_reader");
    expect((await request("/api/v1/events", usable)).status).toBe(401);

    const malformedExpiry = await createKey({
      eventId: "event_alpha",
      idempotencyKey: "malformed-expiry-reader",
      organizationId: "organization_alpha",
      scope: "event",
      scopes: ["events:read"],
    });
    const malformedKeyId = malformedExpiry.data.id;
    await environment.DB.prepare(
      "UPDATE api_keys SET expires_at = 'not-an-instant' WHERE id = ?1",
    )
      .bind(malformedKeyId)
      .run();
    expect(
      (await request("/api/v1/events", malformedExpiry.data.plaintext)).status,
    ).toBe(401);
    await environment.DB.prepare(
      "UPDATE api_keys SET expires_at = NULL WHERE id = ?1",
    )
      .bind(malformedKeyId)
      .run();
    await environment.DB.prepare(
      `UPDATE api_keys SET scopes_json = '["events:read","events:read"]'
       WHERE id = ?1`,
    )
      .bind(malformedKeyId)
      .run();
    expect(
      (await request("/api/v1/events", malformedExpiry.data.plaintext)).status,
    ).toBe(401);
    await environment.DB.prepare(
      `UPDATE api_keys SET scopes_json = '["events:read"]' WHERE id = ?1`,
    )
      .bind(malformedKeyId)
      .run();
  });

  it("creates a key through organizer auth, returns plaintext once, and requires CSRF for revoke", async () => {
    const body = {
      expires_at: null,
      name: "HTTP schedule reader",
      scope: "organization",
      scopes: ["events:read", "schedule:read"],
    };
    const unauthenticated = await applicationFetch(
      "/api/events/event_alpha/api-keys",
    );
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("content-type")).toContain(
      "application/problem+json",
    );

    const created = await applicationFetch("/api/events/event_alpha/api-keys", {
      body: JSON.stringify(body),
      headers: managementHeaders({
        idempotencyKey: "management-http-creation",
      }),
      method: "POST",
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      data: ApiKeyMetadata & { plaintext: string };
    };
    expect(createdBody.data.plaintext).toMatch(/^osk_key_/);

    const replay = await applicationFetch("/api/events/event_alpha/api-keys", {
      body: JSON.stringify(body),
      headers: managementHeaders({
        idempotencyKey: "management-http-creation",
      }),
      method: "POST",
    });
    expect(replay.status).toBe(409);
    expect(JSON.stringify(await replay.json())).not.toContain(
      createdBody.data.plaintext,
    );

    const list = await applicationFetch("/api/events/event_alpha/api-keys", {
      headers: managementHeaders(),
    });
    expect(list.status).toBe(200);
    const listText = await list.text();
    expect(listText).toContain(createdBody.data.prefix);
    expect(listText).not.toContain(createdBody.data.plaintext);

    const invalidCsrf = await applicationFetch(
      `/api/events/event_alpha/api-keys/${createdBody.data.id}`,
      {
        body: "{}",
        headers: managementHeaders({
          csrf: "wrong-csrf-token",
          idempotencyKey: "management-http-revoke",
        }),
        method: "DELETE",
      },
    );
    expect(invalidCsrf.status).toBe(403);
    await expect(invalidCsrf.json()).resolves.toMatchObject({
      code: "invalid_csrf",
      request_id: expect.any(String),
      status: 403,
    });
    expect(
      (await request("/api/v1/events", createdBody.data.plaintext)).status,
    ).toBe(200);

    const revoked = await applicationFetch(
      `/api/events/event_alpha/api-keys/${createdBody.data.id}`,
      {
        body: "{}",
        headers: managementHeaders({
          idempotencyKey: "management-http-revoke",
        }),
        method: "DELETE",
      },
    );
    expect(revoked.status).toBe(200);
    expect(
      (await request("/api/v1/events", createdBody.data.plaintext)).status,
    ).toBe(401);
  });
});
