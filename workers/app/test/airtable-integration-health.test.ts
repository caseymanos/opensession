import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AirtableIntegrationService } from "../src/integrations/airtable-health.js";

const server = createTestHarness({
  workers: [
    {
      configPath: "workers/app/wrangler.jsonc",
      secrets: {
        AUTH_HASH_PEPPER: "0".repeat(32),
      },
      vars: { AIRTABLE_BASE_ID: "app12345678" },
    },
  ],
});

let ownerCookie = "";
let viewerCookie = "";

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
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
  const now = "2026-08-11T20:00:00.000Z";
  const future = "2026-08-12T20:00:00.000Z";
  const sourceHash = "a".repeat(64);
  const ownerToken = `ral72-owner-${"o".repeat(40)}`;
  const viewerToken = `ral72-viewer-${"v".repeat(40)}`;
  ownerCookie = `__Host-opensession-session=${ownerToken}`;
  viewerCookie = `__Host-opensession-session=${viewerToken}`;
  await environment.DB.batch([
    environment.DB.prepare(
      `INSERT INTO tenant_registry (
         organization_id, base_key, source_record_id, status, created_at, updated_at
       ) VALUES ('org_ral72', 'local:app12345678', 'rec_org_ral72',
                 'active', ?1, ?1)`,
    ).bind(now),
    environment.DB.prepare(
      `INSERT INTO p_events (
         id, organization_id, name, slug, timezone, status, brand_json,
         published_version, is_demo, source_record_id, source_version,
         source_content_hash, projected_at
       ) VALUES ('event_ral72', 'org_ral72', 'RAL-72 Event', 'ral-72-event',
                 'UTC', 'open', '{}', 0, 1, 'rec_event_ral72', 1, ?1, ?2)`,
    ).bind(sourceHash, now),
    environment.DB.prepare(
      `INSERT INTO users (
         id, email_normalized, display_name, status, created_at, updated_at
       ) VALUES ('user_ral72_owner', 'owner@ral72.invalid', 'Owner', 'active', ?1, ?1)`,
    ).bind(now),
    environment.DB.prepare(
      `INSERT INTO users (
         id, email_normalized, display_name, status, created_at, updated_at
       ) VALUES ('user_ral72_viewer', 'viewer@ral72.invalid', 'Viewer', 'active', ?1, ?1)`,
    ).bind(now),
    environment.DB.prepare(
      `INSERT INTO organization_memberships (
         id, organization_id, user_id, role, created_at, updated_at
       ) VALUES ('member_ral72_owner', 'org_ral72', 'user_ral72_owner', 'owner', ?1, ?1)`,
    ).bind(now),
    environment.DB.prepare(
      `INSERT INTO organization_memberships (
         id, organization_id, user_id, role, created_at, updated_at
       ) VALUES ('member_ral72_viewer', 'org_ral72', 'user_ral72_viewer', 'viewer', ?1, ?1)`,
    ).bind(now),
    environment.DB.prepare(
      `INSERT INTO auth_sessions (
         id, user_id, token_hash, created_at, expires_at, last_seen_at
       ) VALUES ('session_ral72_owner', 'user_ral72_owner', ?1, ?2, ?3, ?2)`,
    ).bind(await sha256(ownerToken), now, future),
    environment.DB.prepare(
      `INSERT INTO auth_sessions (
         id, user_id, token_hash, created_at, expires_at, last_seen_at
       ) VALUES ('session_ral72_viewer', 'user_ral72_viewer', ?1, ?2, ?3, ?2)`,
    ).bind(await sha256(viewerToken), now, future),
    environment.DB.prepare(
      `INSERT INTO auth_session_secrets (session_id, csrf_token_hash, created_at)
       VALUES ('session_ral72_owner', ?1, ?2)`,
    ).bind(await sha256("ral72-owner-csrf"), now),
    environment.DB.prepare(
      `INSERT INTO auth_session_secrets (session_id, csrf_token_hash, created_at)
       VALUES ('session_ral72_viewer', ?1, ?2)`,
    ).bind(await sha256("ral72-viewer-csrf"), now),
    environment.DB.prepare(
      `INSERT INTO projection_watermarks (
         organization_id, provider, base_key, table_key, last_full_scan_id,
         last_full_scan_at, updated_at
       ) VALUES ('org_ral72', 'airtable', 'local:app12345678', 'events',
                 'safe_fixture_scan', ?1, ?1)`,
    ).bind(now),
    environment.DB.prepare(
      `INSERT INTO projection_scan_runs (
         id, organization_id, provider, base_key, table_key, status,
         seen_count, created_at, completed_at
       ) VALUES ('scan_safe_events', 'org_ral72', 'airtable',
                 'local:app12345678', 'events', 'complete', 1, ?1, ?1)`,
    ).bind(now),
  ]);
});

afterAll(async () => {
  await server.close();
});

describe("Airtable integration health", () => {
  it("returns owner-only aggregate health without base IDs or record data", async () => {
    const unauthorized = await server.fetch(
      "/api/events/ral-72-event/integrations/airtable/health",
      { headers: { Cookie: viewerCookie } },
    );
    expect(unauthorized.status, await unauthorized.clone().text()).toBe(403);
    expect(await unauthorized.text()).not.toContain("app12345678");

    const response = await server.fetch(
      "/api/events/ral-72-event/integrations/airtable/health",
      { headers: { Cookie: ownerCookie } },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(text).not.toContain("app12345678");
    expect(text).not.toContain("rec_event_ral72");
    expect(JSON.parse(text)).toMatchObject({
      authority: { base_suffix: "…345678", schema_version: 10 },
      judge_trace: [
        { kind: "proposal", projected_count: 0 },
        { kind: "session", projected_count: 0 },
        { kind: "task_assignment", projected_count: 0 },
      ],
      projection: {
        last_reconcile: { status: "succeeded", table_count: 1 },
        repair_backlog: { dead: 0, failed: 0, pending: 0 },
      },
    });
  });

  it("binds apply to an unchanged dry run and writes only aggregate audit data", async () => {
    const environment = await server.getWorker<Env>().getEnv();
    let fingerprint = "b".repeat(64);
    const authority = {
      planReconcile: async () => ({
        counts: { create: 1, missing: 1, unchanged: 2, update: 1 },
        fingerprint,
        tables: [
          {
            create: 1,
            key: "organizations" as const,
            missing: 1,
            name: "Organizations",
            unchanged: 2,
            update: 1,
          },
        ],
      }),
      reconcilePlanned: async () => ({
        cursor: null,
        deleted: 1,
        projected: 4,
        scanId: "internal_scan_not_returned",
        tables: ["organizations" as const],
      }),
    };
    const integration = new AirtableIntegrationService({
      authority,
      baseId: "app12345678",
      database: environment.DB,
      environment: "local",
      now: () => new Date("2026-08-11T20:10:00.000Z"),
    });
    const dryRun = await integration.dryRun("org_ral72", "ral-72-event");
    expect(dryRun.plan).toMatchObject({
      confirmation: "RECONCILE ORGANIZATION FOR ral-72-event",
      counts: { create: 1, missing: 1, unchanged: 2, update: 1 },
      scope: "organization",
    });
    const applied = await integration.apply({
      actorId: "user_ral72_owner",
      confirmation: dryRun.plan.confirmation,
      eventId: "event_ral72",
      eventSlug: "ral-72-event",
      idempotencyKey: "fixture-key-one",
      organizationId: "org_ral72",
      planId: dryRun.plan.plan_id,
      requestId: "request_ral72_apply",
    });
    expect(applied).toMatchObject({
      mode: "apply",
      result: { deleted: 1, projected: 4, table_count: 1 },
    });
    const audit = await environment.DB.prepare(
      `SELECT action, safe_diff_json, metadata_json FROM audit_events
       WHERE organization_id = 'org_ral72'
         AND action = 'airtable.reconciliation.completed'`,
    ).first<{
      action: string;
      metadata_json: string;
      safe_diff_json: string;
    }>();
    expect(audit?.action).toBe("airtable.reconciliation.completed");
    expect(`${audit?.safe_diff_json}${audit?.metadata_json}`).not.toContain(
      "internal_scan_not_returned",
    );
    expect(`${audit?.safe_diff_json}${audit?.metadata_json}`).not.toContain(
      "app12345678",
    );

    const nextDryRun = await integration.dryRun("org_ral72", "ral-72-event");
    fingerprint = "c".repeat(64);
    await expect(
      integration.apply({
        actorId: "user_ral72_owner",
        confirmation: nextDryRun.plan.confirmation,
        eventId: "event_ral72",
        eventSlug: "ral-72-event",
        idempotencyKey: "fixture-key-two",
        organizationId: "org_ral72",
        planId: nextDryRun.plan.plan_id,
        requestId: "request_ral72_stale",
      }),
    ).rejects.toMatchObject({ code: "reconcile_plan_changed", status: 409 });
  });
});
