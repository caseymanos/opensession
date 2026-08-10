import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sha256Hex } from "../src/auth/crypto";
import { compileDemoSeed } from "../src/demo/compiler";
import { demoSeedSource } from "../src/demo/fixture";

const pepper = "test-demo-route-pepper-with-at-least-32-characters";
const server = createTestHarness({
  workers: [
    {
      configPath: "workers/app/wrangler.jsonc",
      secrets: { AUTH_HASH_PEPPER: pepper },
    },
  ],
});
let origin = "";

beforeAll(async () => {
  const listening = await server.listen();
  origin = listening.url.origin;
  await server.getWorker<Env>().applyD1Migrations("DB");
});

afterAll(async () => {
  await server.close();
});

describe("demo operator and owner routes", () => {
  it("rejects an unknown operator token without creating authorization state", async () => {
    const response = await server.fetch("/api/internal/demo/bootstrap", {
      body: JSON.stringify({ owner_email: "owner@example.test" }),
      headers: {
        Authorization: `Bearer ${"x".repeat(48)}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    const environment = await server.getWorker<Env>().getEnv();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_bootstrap_authorization" },
    });
    await expect(
      environment.DB.prepare(
        "SELECT COUNT(*) AS count FROM demo_bootstrap_authorizations",
      ).first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("replays a completed bootstrap after the original client loses its response", async () => {
    const environment = await server.getWorker<Env>().getEnv();
    const plan = await compileDemoSeed(demoSeedSource);
    const token = "completed-response-lost-token-".padEnd(48, "r");
    const operationId = "demo_bootstrap_response_lost";
    const appliedResponse = {
      asset_count: 4,
      authority_ready: true,
      receipt: {
        audit_event_id: "audit_demo_bootstrap_response_lost",
        digest: plan.digest,
        operation_count: plan.operations.length,
        outcome: "applied",
        reset_run_id: operationId,
        snapshot_id: plan.snapshotId,
      },
      root_lineage_verified: true,
    };
    await environment.DB.prepare(
      `INSERT INTO demo_bootstrap_authorizations (
         operation_id, token_hash, environment, base_key, organization_id,
         event_id, organization_source_record_id, event_source_record_id,
         seed_version, snapshot_id, seed_digest, status, result_json,
         created_at, updated_at, expires_at, completed_at
       ) VALUES (?1, ?2, 'local', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                 'complete', ?11, ?12, ?12, ?13, ?12)`,
    )
      .bind(
        operationId,
        await sha256Hex(token),
        `local:${environment.AIRTABLE_BASE_ID}`,
        plan.organizationId,
        plan.eventId,
        `rec${"O".repeat(14)}`,
        `rec${"E".repeat(14)}`,
        plan.seedVersion,
        plan.snapshotId,
        plan.digest,
        JSON.stringify(appliedResponse),
        "2026-08-10T20:00:00.000Z",
        "2026-08-10T20:15:00.000Z",
      )
      .run();
    const before = await environment.DB.prepare(
      "SELECT * FROM demo_bootstrap_authorizations WHERE operation_id = ?1",
    )
      .bind(operationId)
      .first();

    const response = await server.fetch("/api/internal/demo/bootstrap", {
      body: JSON.stringify({ owner_email: "owner@example.test" }),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ...appliedResponse,
      receipt: { ...appliedResponse.receipt, outcome: "replayed" },
    });
    await expect(
      environment.DB.prepare(
        "SELECT * FROM demo_bootstrap_authorizations WHERE operation_id = ?1",
      )
        .bind(operationId)
        .first(),
    ).resolves.toEqual(before);
  });

  it("rejects reset before authority access unless origin, request, and session are valid", async () => {
    const path = "/api/events/ai-engineer-summit/demo/reset";
    const withoutOrigin = await server.fetch(path, {
      body: JSON.stringify({ confirmation: "RESET AI ENGINEER SUMMIT 2026" }),
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "demo_reset_guard",
      },
      method: "POST",
    });
    expect(withoutOrigin.status).toBe(403);
    await expect(withoutOrigin.json()).resolves.toMatchObject({
      error: { code: "invalid_origin" },
    });

    const invalidRequest = await server.fetch(path, {
      body: JSON.stringify({ confirmation: "" }),
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        "Sec-Fetch-Site": "same-origin",
      },
      method: "POST",
    });
    expect(invalidRequest.status).toBe(400);
    await expect(invalidRequest.json()).resolves.toMatchObject({
      error: { code: "invalid_request" },
    });

    const anonymous = await server.fetch(path, {
      body: JSON.stringify({ confirmation: "RESET AI ENGINEER SUMMIT 2026" }),
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "demo_reset_guard",
        Origin: origin,
        "Sec-Fetch-Site": "same-origin",
      },
      method: "POST",
    });
    expect(anonymous.status).toBe(401);
    await expect(anonymous.json()).resolves.toMatchObject({
      error: { code: "invalid_session" },
    });
  });

  it("requires an owner CSRF token and exact reset phrase before authority mutation", async () => {
    const environment = await server.getWorker<Env>().getEnv();
    const rawSession = "demo-owner-session-token".padEnd(48, "s");
    const csrf = "demo-owner-csrf-token".padEnd(48, "c");
    const now = "2026-08-10T20:00:00.000Z";
    const future = "2027-08-10T20:00:00.000Z";
    const contentHash = "d".repeat(64);
    await environment.DB.batch([
      environment.DB.prepare(
        `INSERT INTO tenant_registry (
           organization_id, base_key, source_record_id, status,
           authority_ready_at, created_at, updated_at
         ) VALUES ('org_ai_engineer_summit', 'local:appDemoRoutes', ?1,
                   'active', ?2, ?2, ?2)`,
      ).bind(`rec${"O".repeat(14)}`, now),
      environment.DB.prepare(
        `INSERT INTO users (
           id, email_normalized, display_name, status, created_at, updated_at
         ) VALUES ('usr_demo_owner_route', 'owner@example.test', 'Demo owner',
                   'active', ?1, ?1)`,
      ).bind(now),
      environment.DB.prepare(
        `INSERT INTO organization_memberships (
           id, organization_id, user_id, role, created_at, updated_at
         ) VALUES ('membership_demo_owner_route', 'org_ai_engineer_summit',
                   'usr_demo_owner_route', 'owner', ?1, ?1)`,
      ).bind(now),
      environment.DB.prepare(
        `INSERT INTO p_events (
           id, organization_id, name, slug, timezone, status, is_demo,
           source_record_id, source_version, source_content_hash, projected_at
         ) VALUES ('evt_ai_engineer_summit_2026', 'org_ai_engineer_summit',
                   'AI Engineer Summit 2026', 'ai-engineer-summit',
                   'America/Los_Angeles', 'published', 1, ?1, 1, ?2, ?3)`,
      ).bind(`rec${"E".repeat(14)}`, contentHash, now),
      environment.DB.prepare(
        `INSERT INTO auth_sessions (
           id, user_id, token_hash, created_at, expires_at, last_seen_at
         ) VALUES ('session_demo_owner_route', 'usr_demo_owner_route', ?1,
                   ?2, ?3, ?2)`,
      ).bind(await sha256Hex(rawSession), now, future),
      environment.DB.prepare(
        `INSERT INTO auth_session_secrets (
           session_id, csrf_token_hash, created_at
         ) VALUES ('session_demo_owner_route', ?1, ?2)`,
      ).bind(await sha256Hex(csrf), now),
    ]);
    const headers = {
      "Content-Type": "application/json",
      Cookie: `__Host-opensession-session=${rawSession}`,
      "Idempotency-Key": "demo_reset_owner_route",
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
    };

    const missingCsrf = await server.fetch(
      "/api/events/ai-engineer-summit/demo/reset",
      {
        body: JSON.stringify({ confirmation: "not the reset phrase" }),
        headers,
        method: "POST",
      },
    );
    expect(missingCsrf.status).toBe(403);
    await expect(missingCsrf.json()).resolves.toMatchObject({
      error: { code: "invalid_csrf" },
    });

    const wrongPhrase = await server.fetch(
      "/api/events/ai-engineer-summit/demo/reset",
      {
        body: JSON.stringify({ confirmation: "not the reset phrase" }),
        headers: { ...headers, "X-CSRF-Token": csrf },
        method: "POST",
      },
    );
    const wrongPhraseBody = await wrongPhrase.json();
    expect({ body: wrongPhraseBody, status: wrongPhrase.status }).toMatchObject(
      {
        body: { error: { code: "invalid_confirmation" } },
        status: 400,
      },
    );
  });
});
