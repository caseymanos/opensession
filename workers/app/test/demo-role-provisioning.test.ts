import {
  demoRoleProvisioningPlanResponseSchema,
  demoRoleProvisioningResponseSchema,
  type DemoRoleProvisioningPlanResponse,
} from "@sessionbox-killer/contracts";
import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadEventAccess } from "../src/auth/authorization";
import { sha256Hex } from "../src/auth/crypto";
import { AuthService } from "../src/auth/service";
import { D1ReviewOperationsRepository } from "../src/reviews/repository";

const pepper = "demo-role-provisioning-test-pepper-at-least-32-characters";
const timestamp = "2026-08-11T20:00:00.000Z";
const future = "2027-08-11T20:00:00.000Z";
const sourceHash = "a".repeat(64);
const featureFlags = {
  ai: false,
  embeds: false,
  email: false,
  integrations: false,
  webhooks: false,
  writes: true,
};
const aliases = {
  organizer: "owner+organizer@example.test",
  reviewer: "owner+reviewer@example.test",
  speaker: "owner+speaker@example.test",
} as const;
const server = createTestHarness({
  workers: [
    {
      configPath: "workers/app/wrangler.jsonc",
      secrets: { AUTH_HASH_PEPPER: pepper },
      vars: { FEATURE_FLAGS: featureFlags },
    },
  ],
});
const lockedServer = createTestHarness({
  workers: [
    {
      configPath: "workers/app/wrangler.jsonc",
      secrets: { AUTH_HASH_PEPPER: pepper },
      vars: { FEATURE_FLAGS: { ...featureFlags, writes: false } },
    },
  ],
});
let origin = "";
let lockedOrigin = "";
const ownerSessionToken = `owner-session-${"s".repeat(40)}`;
const ownerCsrf = `owner-csrf-${"c".repeat(40)}`;
const organizerSessionToken = `organizer-session-${"o".repeat(40)}`;
const organizerCsrf = `organizer-csrf-${"r".repeat(40)}`;

function sql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function executeSqlScript(
  database: D1Database,
  script: string,
): Promise<void> {
  const statements = script
    .split(";")
    .map((statement) => statement.replaceAll(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((statement) => `${statement};`)
    .join("\n");
  await database.exec(statements);
}

function ownerHeaders(options: { csrf?: boolean; origin?: string } = {}) {
  return {
    Cookie: `__Host-opensession-session=${ownerSessionToken}`,
    ...(options.csrf === false ? {} : { "X-CSRF-Token": ownerCsrf }),
    Origin: options.origin ?? origin,
    "Sec-Fetch-Site": "same-origin",
  };
}

function organizerHeaders() {
  return {
    Cookie: `__Host-opensession-session=${organizerSessionToken}`,
    "X-CSRF-Token": organizerCsrf,
    Origin: origin,
    "Sec-Fetch-Site": "same-origin",
  };
}

function requestBody(
  plan: DemoRoleProvisioningPlanResponse,
  overrides: {
    organizer?: string;
    reviewer?: string;
    speaker?: string;
  } = {},
) {
  return {
    confirmation: plan.confirmation,
    fixture_fingerprint: plan.fixture_fingerprint,
    identities: [
      {
        email: overrides.organizer ?? aliases.organizer,
        role: "organizer",
      },
      { email: overrides.reviewer ?? aliases.reviewer, role: "reviewer" },
      { email: overrides.speaker ?? aliases.speaker, role: "speaker" },
    ],
  } as const;
}

async function plan(): Promise<DemoRoleProvisioningPlanResponse> {
  const response = await server.fetch(
    "/api/events/ai-engineer-summit/demo/role-identities/plan",
    { headers: ownerHeaders({ csrf: false }) },
  );
  expect(response.status).toBe(200);
  return demoRoleProvisioningPlanResponseSchema.parse(await response.json());
}

async function provision(
  body: unknown,
  options: {
    commandId?: string;
    headers?: Record<string, string>;
    path?: string;
  } = {},
) {
  return server.fetch(
    options.path ??
      "/api/events/ai-engineer-summit/demo/role-identities/provision",
    {
      body: JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": options.commandId ?? "demo_role_provision_test_0001",
        ...ownerHeaders(),
        ...options.headers,
      },
      method: "POST",
    },
  );
}

beforeAll(async () => {
  const [listening, lockedListening] = await Promise.all([
    server.listen(),
    lockedServer.listen(),
  ]);
  origin = listening.url.origin;
  lockedOrigin = lockedListening.url.origin;
  const worker = server.getWorker<Env>();
  await worker.applyD1Migrations("DB");
  const env = await worker.getEnv();
  await executeSqlScript(
    env.DB,
    `
    INSERT INTO tenant_registry (
      organization_id, base_key, source_record_id, status, authority_ready_at,
      created_at, updated_at
    ) VALUES
      ('org_ai_engineer_summit', 'local:appDemoRoles', 'rec_demo_org', 'active',
       ${sql(timestamp)}, ${sql(timestamp)}, ${sql(timestamp)}),
      ('org_unrelated', 'local:appUnrelated', 'rec_unrelated_org', 'active',
       ${sql(timestamp)}, ${sql(timestamp)}, ${sql(timestamp)});

    INSERT INTO users (
      id, email_normalized, display_name, status, created_at, updated_at
    ) VALUES
      ('usr_demo_owner', 'owner@example.test', 'Demo Owner', 'active',
       ${sql(timestamp)}, ${sql(timestamp)}),
      ('usr_demo_organizer', 'existing-organizer@example.test',
       'Existing Organizer', 'active', ${sql(timestamp)}, ${sql(timestamp)}),
      ('usr_unrelated', 'unrelated@example.test', 'Unrelated User', 'active',
       ${sql(timestamp)}, ${sql(timestamp)});

    INSERT INTO organization_memberships (
      id, organization_id, user_id, role, created_at, updated_at
    ) VALUES (
      'om_demo_owner', 'org_ai_engineer_summit', 'usr_demo_owner', 'owner',
      ${sql(timestamp)}, ${sql(timestamp)}
    );

    INSERT INTO p_events (
      id, organization_id, name, slug, timezone, status, is_demo,
      source_record_id, source_version, source_content_hash, projected_at
    ) VALUES
      ('evt_ai_engineer_summit_2026', 'org_ai_engineer_summit',
       'AI Engineer Summit 2026', 'ai-engineer-summit',
       'America/Los_Angeles', 'published', 1, 'rec_demo_event', 1,
       ${sql(sourceHash)}, ${sql(timestamp)}),
      ('evt_unrelated', 'org_unrelated', 'Unrelated Event', 'unrelated-event',
       'UTC', 'draft', 0, 'rec_unrelated_event', 1,
       ${sql(sourceHash)}, ${sql(timestamp)});

    INSERT INTO event_memberships (
      id, organization_id, event_id, user_id, role, created_at, updated_at
    ) VALUES (
      'em_existing_organizer', 'org_ai_engineer_summit',
      'evt_ai_engineer_summit_2026', 'usr_demo_organizer', 'organizer',
      ${sql(timestamp)}, ${sql(timestamp)}
    );

    INSERT INTO p_contacts (
      id, organization_id, email_normalized, display_name, source_record_id,
      source_version, source_content_hash, projected_at
    ) VALUES
      ('contact_reviewer_01', 'org_ai_engineer_summit',
       'reviewer-01@demo.opensession.invalid', 'Riley Reviewer',
       'rec_demo_reviewer', 1, ${sql(sourceHash)}, ${sql(timestamp)}),
      ('contact_speaker_01', 'org_ai_engineer_summit',
       'speaker-01@demo.opensession.invalid', 'Ada Chen',
       'rec_demo_speaker', 1, ${sql(sourceHash)}, ${sql(timestamp)}),
      ('contact_unrelated', 'org_unrelated', 'contact@example.test',
       'Unrelated Contact', 'rec_unrelated_contact', 1, ${sql(sourceHash)},
       ${sql(timestamp)});

    INSERT INTO p_event_contacts (
      id, organization_id, event_id, contact_id, roles_json, portal_state,
      source_record_id, source_version, source_content_hash, projected_at
    ) VALUES
      ('event_contact_reviewer_01', 'org_ai_engineer_summit',
       'evt_ai_engineer_summit_2026', 'contact_reviewer_01', '["reviewer"]',
       'active', 'rec_demo_event_reviewer', 1, ${sql(sourceHash)},
       ${sql(timestamp)}),
      ('event_contact_speaker_01', 'org_ai_engineer_summit',
       'evt_ai_engineer_summit_2026', 'contact_speaker_01', '["speaker"]',
       'active', 'rec_demo_event_speaker', 1, ${sql(sourceHash)},
       ${sql(timestamp)}),
      ('event_contact_unrelated', 'org_unrelated', 'evt_unrelated',
       'contact_unrelated', '["speaker"]', 'active',
       'rec_unrelated_event_contact', 1, ${sql(sourceHash)}, ${sql(timestamp)});

    INSERT INTO auth_sessions (
      id, user_id, token_hash, created_at, expires_at, last_seen_at
    ) VALUES
      ('session_demo_owner', 'usr_demo_owner',
       ${sql(await sha256Hex(ownerSessionToken))}, ${sql(timestamp)},
       ${sql(future)}, ${sql(timestamp)}),
      ('session_demo_organizer', 'usr_demo_organizer',
       ${sql(await sha256Hex(organizerSessionToken))}, ${sql(timestamp)},
       ${sql(future)}, ${sql(timestamp)});

    INSERT INTO auth_session_secrets (session_id, csrf_token_hash, created_at)
    VALUES
      ('session_demo_owner', ${sql(await sha256Hex(ownerCsrf))},
       ${sql(timestamp)}),
      ('session_demo_organizer', ${sql(await sha256Hex(organizerCsrf))},
       ${sql(timestamp)});
  `,
  );
});

beforeEach(async () => {
  const env = await server.getWorker<Env>().getEnv();
  await executeSqlScript(
    env.DB,
    `
    DROP TRIGGER IF EXISTS fail_demo_reviewer_membership;
    DELETE FROM magic_link_tokens WHERE user_id LIKE 'usr_drp_%';
    DELETE FROM event_contact_identity_bindings;
    DELETE FROM event_memberships WHERE user_id LIKE 'usr_drp_%';
    DELETE FROM organization_memberships WHERE user_id LIKE 'usr_drp_%';
    DELETE FROM users
      WHERE id NOT IN ('usr_demo_owner', 'usr_demo_organizer', 'usr_unrelated');
    DELETE FROM idempotency_keys
      WHERE operation = 'demo.role-identities.provision';
    DELETE FROM abuse_rate_limits
      WHERE scope LIKE 'demo_identity_provisioning:%';
    UPDATE p_events SET source_version = 1, source_content_hash = '${sourceHash}',
      source_deleted_at = NULL
      WHERE id = 'evt_ai_engineer_summit_2026';
    UPDATE p_contacts SET source_version = 1, source_content_hash = '${sourceHash}',
      source_deleted_at = NULL
      WHERE id IN ('contact_reviewer_01', 'contact_speaker_01');
    UPDATE p_event_contacts SET source_version = 1,
      source_content_hash = '${sourceHash}', source_deleted_at = NULL,
      portal_state = 'active'
      WHERE id IN ('event_contact_reviewer_01', 'event_contact_speaker_01');
  `,
  );
});

afterAll(async () => {
  await Promise.all([server.close(), lockedServer.close()]);
});

describe("bounded demo role identity provisioning", () => {
  it("requires writes, same-origin owner authentication, CSRF, and exact scope", async () => {
    const locked = await lockedServer.fetch(
      "/api/events/ai-engineer-summit/demo/role-identities/provision",
      {
        body: "{}",
        headers: {
          "Content-Type": "application/json",
          Origin: lockedOrigin,
          "Sec-Fetch-Site": "same-origin",
        },
        method: "POST",
      },
    );
    expect(locked.status).toBe(503);
    await expect(locked.json()).resolves.toMatchObject({
      error: { code: "writes_disabled" },
    });

    const currentPlan = await plan();
    const body = requestBody(currentPlan);
    const wrongOrigin = await provision(body, {
      headers: { Origin: "https://attacker.example.test" },
    });
    expect(wrongOrigin.status).toBe(403);
    await expect(wrongOrigin.json()).resolves.toMatchObject({
      error: { code: "invalid_origin" },
    });

    const missingCsrf = await provision(body, {
      headers: { "X-CSRF-Token": "" },
    });
    expect(missingCsrf.status).toBe(403);
    await expect(missingCsrf.json()).resolves.toMatchObject({
      error: { code: "invalid_csrf" },
    });

    const nonOwner = await provision(body, { headers: organizerHeaders() });
    expect(nonOwner.status).toBe(403);
    await expect(nonOwner.json()).resolves.toMatchObject({
      error: { code: "not_privileged" },
    });

    const wrongEvent = await provision(body, {
      path: "/api/events/unrelated-event/demo/role-identities/provision",
    });
    expect(wrongEvent.status).toBe(404);
    await expect(wrongEvent.json()).resolves.toMatchObject({
      error: { code: "not_demo" },
    });
  });

  it("rejects malformed counts, unsupported roles, extra scope, and stale plans", async () => {
    const currentPlan = await plan();
    const exact = requestBody(currentPlan);
    for (const invalid of [
      { ...exact, identities: exact.identities.slice(0, 2) },
      {
        ...exact,
        identities: exact.identities.map((identity, index) =>
          index === 2 ? { ...identity, role: "viewer" } : identity,
        ),
      },
      { ...exact, organization_id: "org_ai_engineer_summit" },
    ]) {
      const response = await provision(invalid, {
        commandId: `demo_role_invalid_${crypto.randomUUID()}`,
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "invalid_request" },
      });
    }

    const env = await server.getWorker<Env>().getEnv();
    await env.DB.prepare(
      `UPDATE p_contacts SET source_version = source_version + 1
       WHERE id = 'contact_speaker_01'`,
    ).run();
    const stale = await provision(exact, {
      commandId: "demo_role_stale_fixture_0001",
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      error: { code: "stale_fixture_fingerprint" },
    });
  });

  it("rejects the wrong confirmation and missing named fixture identities", async () => {
    const currentPlan = await plan();
    const wrongConfirmation = await provision({
      ...requestBody(currentPlan),
      confirmation: "PROVISION A DIFFERENT DEMO",
    });
    expect(wrongConfirmation.status).toBe(400);
    await expect(wrongConfirmation.json()).resolves.toMatchObject({
      error: { code: "invalid_confirmation" },
    });

    const env = await server.getWorker<Env>().getEnv();
    await env.DB.prepare(
      `UPDATE p_event_contacts SET source_deleted_at = ?1
       WHERE id = 'event_contact_speaker_01'`,
    )
      .bind(timestamp)
      .run();
    const missingFixture = await provision(requestBody(currentPlan), {
      commandId: "demo_role_missing_fixture_0001",
    });
    expect(missingFixture.status).toBe(409);
    await expect(missingFixture.json()).resolves.toMatchObject({
      error: { code: "missing_fixture_identity" },
    });
    await expect(
      env.DB.prepare(
        "SELECT COUNT(*) AS count FROM users WHERE id LIKE 'usr_drp_%'",
      ).first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("preserves plus tags, binds exact roles atomically, and leaves unrelated state unchanged", async () => {
    const env = await server.getWorker<Env>().getEnv();
    const unrelatedBefore = await env.DB.prepare(
      `SELECT user.id AS user_id, event.id AS event_id, contact.id AS contact_id
       FROM users user, p_events event, p_contacts contact
       WHERE user.id = 'usr_unrelated' AND event.id = 'evt_unrelated'
         AND contact.id = 'contact_unrelated'`,
    ).first();
    const deliveryBefore = await env.DB.batch<{ count: number }>([
      env.DB.prepare("SELECT COUNT(*) AS count FROM magic_link_tokens"),
      env.DB.prepare("SELECT COUNT(*) AS count FROM outbox_events"),
      env.DB.prepare("SELECT COUNT(*) AS count FROM provider_messages"),
    ]);
    const response = await provision(requestBody(await plan()));
    expect(response.status).toBe(200);
    const result = demoRoleProvisioningResponseSchema.parse(
      await response.json(),
    );
    expect(result.receipt).toMatchObject({ outcome: "applied" });
    expect(result.receipt.identities.map(({ role }) => role)).toEqual([
      "organizer",
      "reviewer",
      "speaker",
    ]);

    const users = await env.DB.prepare(
      `SELECT email_normalized FROM users WHERE id LIKE 'usr_drp_%'
       ORDER BY email_normalized`,
    ).all<{ email_normalized: string }>();
    expect(
      users.results.map(({ email_normalized }) => email_normalized),
    ).toEqual(Object.values(aliases).sort());
    const memberships = await env.DB.prepare(
      `SELECT role, contact_id FROM event_memberships
       WHERE user_id LIKE 'usr_drp_%' ORDER BY role`,
    ).all<{ contact_id: string | null; role: string }>();
    expect(memberships.results).toEqual([
      { contact_id: null, role: "organizer" },
      { contact_id: "contact_reviewer_01", role: "reviewer" },
    ]);
    await expect(
      env.DB.prepare(
        `SELECT contact_id, relationship_role
         FROM event_contact_identity_bindings`,
      ).first(),
    ).resolves.toEqual({
      contact_id: "contact_speaker_01",
      relationship_role: "speaker",
    });
    await expect(
      env.DB.prepare(
        `SELECT user.id AS user_id, event.id AS event_id, contact.id AS contact_id
         FROM users user, p_events event, p_contacts contact
         WHERE user.id = 'usr_unrelated' AND event.id = 'evt_unrelated'
           AND contact.id = 'contact_unrelated'`,
      ).first(),
    ).resolves.toEqual(unrelatedBefore);
    const deliveryAfter = await env.DB.batch<{ count: number }>([
      env.DB.prepare("SELECT COUNT(*) AS count FROM magic_link_tokens"),
      env.DB.prepare("SELECT COUNT(*) AS count FROM outbox_events"),
      env.DB.prepare("SELECT COUNT(*) AS count FROM provider_messages"),
    ]);
    expect(deliveryAfter.map(({ results }) => results[0]?.count)).toEqual(
      deliveryBefore.map(({ results }) => results[0]?.count),
    );
  });

  it("rejects normalized alias collisions without changing role state", async () => {
    const currentPlan = await plan();
    const response = await provision({
      ...requestBody(currentPlan),
      identities: [
        { email: "Same+Tag@Example.Test", role: "organizer" },
        { email: "same+tag@example.test", role: "reviewer" },
        { email: aliases.speaker, role: "speaker" },
      ],
    });
    expect(response.status).toBe(400);
    const env = await server.getWorker<Env>().getEnv();
    await expect(
      env.DB.prepare(
        "SELECT COUNT(*) AS count FROM users WHERE id LIKE 'usr_drp_%'",
      ).first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("fails closed on an existing alias collision", async () => {
    const env = await server.getWorker<Env>().getEnv();
    await env.DB.prepare(
      `INSERT INTO users (
         id, email_normalized, display_name, status, created_at, updated_at
       ) VALUES ('usr_collision', ?1, 'Different Identity', 'active', ?2, ?2)`,
    )
      .bind(aliases.organizer, timestamp)
      .run();
    const response = await provision(requestBody(await plan()), {
      commandId: "demo_role_alias_collision_0001",
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "identity_collision" },
    });
    await expect(
      env.DB.prepare(
        "SELECT COUNT(*) AS count FROM event_memberships WHERE user_id LIKE 'usr_drp_%'",
      ).first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("rolls back every identity, membership, audit, and receipt on a partial write failure", async () => {
    const env = await server.getWorker<Env>().getEnv();
    const currentPlan = await plan();
    await env.DB.exec(
      "CREATE TRIGGER fail_demo_reviewer_membership BEFORE INSERT ON event_memberships WHEN NEW.role = 'reviewer' BEGIN SELECT RAISE(ABORT, 'simulated reviewer write failure'); END;",
    );
    const response = await provision(requestBody(currentPlan), {
      commandId: "demo_role_transaction_failure_0001",
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "transaction_failed" },
    });
    const state = await env.DB.batch<{ count: number }>([
      env.DB.prepare(
        "SELECT COUNT(*) AS count FROM users WHERE id LIKE 'usr_drp_%'",
      ),
      env.DB.prepare(
        "SELECT COUNT(*) AS count FROM event_memberships WHERE user_id LIKE 'usr_drp_%'",
      ),
      env.DB.prepare(
        "SELECT COUNT(*) AS count FROM event_contact_identity_bindings",
      ),
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
         WHERE action = 'demo.role-identities.provisioned'
           AND command_id = 'demo_role_transaction_failure_0001'`,
      ),
      env.DB.prepare(
        "SELECT COUNT(*) AS count FROM idempotency_keys WHERE operation = 'demo.role-identities.provision'",
      ),
    ]);
    expect(state.map(({ results }) => results[0]?.count)).toEqual([
      0, 0, 0, 0, 0,
    ]);
  });

  it("replays one durable receipt and rejects changed use of its idempotency key", async () => {
    const currentPlan = await plan();
    const commandId = "demo_role_idempotent_replay_0001";
    const first = await provision(requestBody(currentPlan), { commandId });
    const replay = await provision(requestBody(currentPlan), { commandId });
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    const firstBody = demoRoleProvisioningResponseSchema.parse(
      await first.json(),
    );
    const replayBody = demoRoleProvisioningResponseSchema.parse(
      await replay.json(),
    );
    expect(replayBody.receipt).toEqual({
      ...firstBody.receipt,
      outcome: "replayed",
    });

    const changed = await provision(
      {
        ...requestBody(currentPlan, {
          speaker: "owner+different-speaker@example.test",
        }),
        confirmation: "PROVISION A DIFFERENT DEMO",
      },
      { commandId },
    );
    expect(changed.status).toBe(409);
    await expect(changed.json()).resolves.toMatchObject({
      error: { code: "idempotency_conflict" },
    });
    const env = await server.getWorker<Env>().getEnv();
    await expect(
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
         WHERE action = 'demo.role-identities.provisioned'
           AND command_id = ?1`,
      )
        .bind(commandId)
        .first(),
    ).resolves.toEqual({ count: 1 });
  });

  it("redacts aliases from audit and idempotency receipts", async () => {
    server.clearLogs();
    const response = await provision(requestBody(await plan()), {
      commandId: "demo_role_redaction_0001",
    });
    expect(response.status).toBe(200);
    const env = await server.getWorker<Env>().getEnv();
    const [audit, receipt] = await Promise.all([
      env.DB.prepare(
        `SELECT actor_id, action, entity_id, request_id, command_id,
                safe_diff_json, metadata_json
         FROM audit_events WHERE action = 'demo.role-identities.provisioned'
           AND command_id = ?1`,
      )
        .bind("demo_role_redaction_0001")
        .first(),
      env.DB.prepare(
        `SELECT request_hash, original_response_json
         FROM idempotency_keys
         WHERE operation = 'demo.role-identities.provision'
           AND command_id = ?1`,
      )
        .bind("demo_role_redaction_0001")
        .first(),
    ]);
    const serialized = JSON.stringify({
      audit,
      logs: server.getLogs(),
      receipt,
    });
    for (const alias of Object.values(aliases)) {
      expect(serialized).not.toContain(alias);
    }
    expect(serialized).not.toContain("@example.test");
    expect(serialized).not.toContain("magic#token");
    expect(audit).toMatchObject({
      action: "demo.role-identities.provisioned",
      actor_id: "usr_demo_owner",
    });
  });

  it("makes all three aliases magic-link eligible without escalating speaker access", async () => {
    const response = await provision(requestBody(await plan()), {
      commandId: "demo_role_magic_eligibility_0001",
    });
    expect(response.status).toBe(200);
    const env = await server.getWorker<Env>().getEnv();
    const queued: unknown[] = [];
    let tokenIndex = 0;
    const authentication = new AuthService({
      database: env.DB,
      emailEnabled: true,
      emailQueue: {
        send: async (message: unknown) => {
          queued.push(message);
        },
      } as unknown as Env["EMAIL_QUEUE"],
      hashPepper: pepper,
      now: () => new Date(timestamp),
      tokenFactory: () =>
        `demo-role-magic-${String((tokenIndex += 1)).padStart(2, "0")}-${"t".repeat(40)}`,
    });
    for (const [role, email] of Object.entries(aliases)) {
      const result = await authentication.requestMagicLink(
        { email, purpose: "sign_in", redirect_path: `/${role}` },
        { ipAddress: null, userAgent: "demo role test" },
        `browser-binding-${role}`,
        origin,
        `request_demo_role_${role}`,
      );
      expect(result.outcome).toBe("queued");
    }
    const portalResult = await authentication.requestMagicLink(
      {
        email: aliases.speaker,
        event_id: "evt_ai_engineer_summit_2026",
        organization_id: "org_ai_engineer_summit",
        purpose: "portal",
        redirect_path: "/portal/ai-engineer-summit",
      },
      { ipAddress: null, userAgent: "demo role portal test" },
      "browser-binding-speaker-portal",
      origin,
      "request_demo_role_speaker_portal",
    );
    expect(portalResult.outcome).toBe("queued");
    expect(queued).toHaveLength(4);

    const users = await env.DB.prepare(
      `SELECT id, email_normalized FROM users WHERE id LIKE 'usr_drp_%'`,
    ).all<{ email_normalized: string; id: string }>();
    const byEmail = new Map(
      users.results.map((user) => [user.email_normalized, user]),
    );
    const organizerAccess = await loadEventAccess(
      env.DB,
      {
        email: aliases.organizer,
        id: byEmail.get(aliases.organizer)?.id ?? "missing",
      },
      "org_ai_engineer_summit",
      "evt_ai_engineer_summit_2026",
    );
    const reviewer = byEmail.get(aliases.reviewer);
    const reviewerAccess = await loadEventAccess(
      env.DB,
      { email: aliases.reviewer, id: reviewer?.id ?? "missing" },
      "org_ai_engineer_summit",
      "evt_ai_engineer_summit_2026",
    );
    const speakerAccess = await loadEventAccess(
      env.DB,
      {
        email: aliases.speaker,
        id: byEmail.get(aliases.speaker)?.id ?? "missing",
      },
      "org_ai_engineer_summit",
      "evt_ai_engineer_summit_2026",
    );
    expect(organizerAccess).toMatchObject({ eventRole: "organizer" });
    expect(reviewerAccess).toMatchObject({ eventRole: "reviewer" });
    expect(speakerAccess).toEqual({
      eventRole: null,
      organizationRole: null,
      permissions: [
        "session:read:self",
        "portal:read:self",
        "portal:write:self",
      ],
      speakerContactId: "contact_speaker_01",
    });
    await expect(
      new D1ReviewOperationsRepository(env.DB).reviewerIdForIdentity(
        {
          eventId: "evt_ai_engineer_summit_2026",
          organizationId: "org_ai_engineer_summit",
        },
        aliases.reviewer,
        reviewer?.id ?? "missing",
      ),
    ).resolves.toBe("event_contact_reviewer_01");
  });
});
