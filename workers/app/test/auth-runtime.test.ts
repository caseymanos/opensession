import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scheduleSnapshotSchema } from "@sessionbox-killer/contracts";

import { sha256Hex } from "../src/auth/crypto";
import { AuthService } from "../src/auth/service";

const hash = "a".repeat(64);
const pepper = "test-auth-pepper-with-at-least-32-characters";
const timestamp = "2026-08-09T06:00:00.000Z";
const future = "2027-08-09T06:00:00.000Z";
const past = "2025-08-09T06:00:00.000Z";
const featureFlags = {
  ai: false,
  embeds: false,
  email: true,
  integrations: false,
  webhooks: false,
  writes: true,
};
const turnstileFields = {
  turnstile_action: "sign_in",
  turnstile_token: "XXXX.DUMMY.TOKEN.XXXX",
} as const;
const server = createTestHarness({
  workers: [
    {
      configPath: "workers/app/wrangler.jsonc",
      secrets: { AUTH_HASH_PEPPER: pepper },
      vars: {
        AIRTABLE_BASE_ID: "app12345678",
        APP_ENV: "local",
        FEATURE_FLAGS: featureFlags,
      },
    },
  ],
});
let origin = "";

type HarnessResponse = Awaited<ReturnType<typeof server.fetch>>;
interface ScopeResponse {
  scope: {
    can_read_session: boolean | null;
    event_role: string | null;
    organization_role: string | null;
    permissions: string[];
    speaker_contact_id: string | null;
  };
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function seedMagicLink(
  rawToken: string,
  userId: string,
  options: {
    browserBindingToken?: string;
    expiresAt?: string;
    id?: string;
    purpose?: "portal" | "sign_in";
    scope?: { contactId: string; eventId: string; organizationId: string };
  } = {},
): Promise<void> {
  const env = await server.getWorker<Env>().getEnv();
  const id = options.id ?? crypto.randomUUID();
  const browserBindingToken =
    options.browserBindingToken ?? `binding-${rawToken}`;
  const purpose = options.purpose ?? "sign_in";
  const user = await env.DB.prepare(
    "SELECT email_normalized FROM users WHERE id = ?1",
  )
    .bind(userId)
    .first<{ email_normalized: string }>();
  if (!user) {
    throw new Error(`Missing test user ${userId}`);
  }

  const statements = [
    env.DB.prepare(
      `INSERT INTO magic_link_tokens
        (id, email_normalized, user_id, purpose, token_hash, redirect_path,
         created_at, expires_at, browser_binding_hash)
       VALUES (?1, ?2, ?3, ?4, ?5, '/welcome', ?6, ?7, ?8)`,
    ).bind(
      id,
      user.email_normalized,
      userId,
      purpose,
      await sha256Hex(rawToken),
      timestamp,
      options.expiresAt ?? future,
      await sha256Hex(browserBindingToken),
    ),
  ];
  if (options.scope) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO magic_link_scopes
          (token_id, organization_id, event_id, contact_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      ).bind(
        id,
        options.scope.organizationId,
        options.scope.eventId,
        options.scope.contactId,
        timestamp,
      ),
    );
  }
  await env.DB.batch(statements);
}

async function seedSession(
  userId: string,
  label: string,
): Promise<{ cookie: string; csrf: string }> {
  const env = await server.getWorker<Env>().getEnv();
  const rawToken = `session-${label}-${"s".repeat(40)}`;
  const csrf = `csrf-${label}-${"c".repeat(40)}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO auth_sessions
        (id, user_id, token_hash, created_at, expires_at, last_seen_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?4)`,
    ).bind(
      `auth_${label}`,
      userId,
      await sha256Hex(rawToken),
      timestamp,
      future,
    ),
    env.DB.prepare(
      `INSERT INTO auth_session_secrets
        (session_id, csrf_token_hash, created_at)
       VALUES (?1, ?2, ?3)`,
    ).bind(`auth_${label}`, await sha256Hex(csrf), timestamp),
  ]);
  return {
    cookie: `__Host-opensession-session=${rawToken}`,
    csrf,
  };
}

function authHeaders(cookie?: string, csrf?: string): Record<string, string> {
  return {
    ...(cookie ? { Cookie: cookie } : {}),
    ...(csrf ? { "X-CSRF-Token": csrf } : {}),
    "Content-Type": "application/json",
    Origin: origin,
    "Sec-Fetch-Site": "same-origin",
    "User-Agent": "OpenSession security test",
  };
}

function responseCookies(response: HarnessResponse): string[] {
  return response.headers.getSetCookie();
}

function cookiePair(cookies: readonly string[], name: string): string {
  const cookie = cookies.find((candidate) => candidate.startsWith(`${name}=`));
  if (!cookie) {
    throw new Error(`Missing cookie ${name}`);
  }
  return cookie.split(";", 1)[0] ?? "";
}

function exchange(
  rawToken: string,
  cookie?: string,
  browserBindingToken: string | null = `binding-${rawToken}`,
) {
  const combinedCookie = [
    cookie,
    browserBindingToken
      ? `__Host-opensession-auth-init=${browserBindingToken}`
      : null,
  ]
    .filter(Boolean)
    .join("; ");
  return server.fetch("/api/auth/magic-links/exchange", {
    body: JSON.stringify({ token: rawToken }),
    headers: authHeaders(combinedCookie || undefined),
    method: "POST",
  });
}

beforeAll(async () => {
  const listening = await server.listen();
  origin = listening.url.origin;
  const worker = server.getWorker<Env>();
  await worker.applyD1Migrations("DB");
  const env = await worker.getEnv();

  const seedSql = `
    INSERT INTO tenant_registry
      (organization_id, base_key, source_record_id, created_at, updated_at)
    VALUES
      ('org_one', 'base_one', 'rec_org_one', ${sqlString(timestamp)}, ${sqlString(timestamp)}),
      ('org_two', 'base_two', 'rec_org_two', ${sqlString(timestamp)}, ${sqlString(timestamp)});

    INSERT INTO users
      (id, email_normalized, display_name, created_at, updated_at)
    VALUES
      ('usr_owner', 'owner@example.test', 'Olivia Owner', ${sqlString(timestamp)}, ${sqlString(timestamp)}),
      ('usr_reviewer', 'reviewer@example.test', 'Rae Reviewer', ${sqlString(timestamp)}, ${sqlString(timestamp)}),
      ('usr_viewer', 'viewer@example.test', 'Val Viewer', ${sqlString(timestamp)}, ${sqlString(timestamp)}),
      ('usr_speaker', 'speaker@example.test', 'Sam Speaker', ${sqlString(timestamp)}, ${sqlString(timestamp)}),
      ('usr_revoked', 'revoked@example.test', 'Remy Revoked', ${sqlString(timestamp)}, ${sqlString(timestamp)});

    INSERT INTO p_events
      (id, organization_id, name, slug, timezone, status, source_record_id,
       source_version, source_content_hash, projected_at)
    VALUES
      ('evt_one', 'org_one', 'Event One', 'event-one', 'UTC', 'draft',
       'rec_evt_one', 1, ${sqlString(hash)}, ${sqlString(timestamp)}),
      ('evt_two', 'org_two', 'Event Two', 'event-two', 'UTC', 'draft',
       'rec_evt_two', 1, ${sqlString(hash)}, ${sqlString(timestamp)});

    UPDATE p_events
    SET schedule_days_json = '[{"date":"2026-10-13","businessStart":"09:00","businessEnd":"17:00"}]',
        schedule_snap_minutes = 15,
        schedule_version = 0
    WHERE id = 'evt_one';

    INSERT INTO p_rooms
      (id, organization_id, event_id, name, capacity, sort_order,
       source_record_id, source_version, source_content_hash, projected_at)
    VALUES
      ('room_one', 'org_one', 'evt_one', 'Main room', 100, 1,
       'rec_room_one', 1, ${sqlString(hash)}, ${sqlString(timestamp)});

    INSERT INTO p_tracks
      (id, organization_id, event_id, name, sort_order, source_record_id,
       source_version, source_content_hash, projected_at)
    VALUES
      ('track_one', 'org_one', 'evt_one', 'General', 1, 'rec_track_one', 1,
       ${sqlString(hash)}, ${sqlString(timestamp)});

    INSERT INTO p_formats
      (id, organization_id, event_id, name, default_duration_minutes,
       sort_order, source_record_id, source_version, source_content_hash,
       projected_at)
    VALUES
      ('format_one', 'org_one', 'evt_one', 'Talk', 30, 1,
       'rec_format_one', 1, ${sqlString(hash)}, ${sqlString(timestamp)});

    INSERT INTO organization_memberships
      (id, organization_id, user_id, role, created_at, updated_at, revoked_at)
    VALUES
      ('membership_owner', 'org_one', 'usr_owner', 'owner', ${sqlString(timestamp)}, ${sqlString(timestamp)}, NULL),
      ('membership_viewer', 'org_one', 'usr_viewer', 'viewer', ${sqlString(timestamp)}, ${sqlString(timestamp)}, NULL),
      ('membership_revoked', 'org_one', 'usr_revoked', 'organizer', ${sqlString(timestamp)}, ${sqlString(timestamp)}, ${sqlString(timestamp)});

    INSERT INTO event_memberships
      (id, organization_id, event_id, user_id, role, created_at, updated_at)
    VALUES
      ('membership_reviewer', 'org_one', 'evt_one', 'usr_reviewer', 'reviewer',
       ${sqlString(timestamp)}, ${sqlString(timestamp)});

    INSERT INTO p_contacts
      (id, organization_id, email_normalized, display_name, source_record_id,
       source_version, source_content_hash, projected_at)
    VALUES
      ('contact_speaker', 'org_one', 'speaker@example.test', 'Sam Speaker',
       'rec_contact_speaker', 1, ${sqlString(hash)}, ${sqlString(timestamp)});

    INSERT INTO p_event_contacts
      (id, organization_id, event_id, contact_id, roles_json, portal_state,
       source_record_id, source_version, source_content_hash, projected_at)
    VALUES
      ('event_contact_speaker', 'org_one', 'evt_one', 'contact_speaker',
       '["speaker"]', 'active', 'rec_event_contact_speaker', 1,
       ${sqlString(hash)}, ${sqlString(timestamp)});

    INSERT INTO p_sessions
      (id, organization_id, event_id, friendly_id, title, status, track_id,
       format_id, duration_minutes, updated_at, source_record_id,
       source_version, source_content_hash, projected_at)
    VALUES
      ('session_own', 'org_one', 'evt_one', 'SES-OWN', 'Speaker session',
       'accepted', 'track_one', 'format_one', 30, ${sqlString(timestamp)},
       'rec_session_own', 1,
       ${sqlString(hash)}, ${sqlString(timestamp)}),
      ('session_other', 'org_one', 'evt_one', 'SES-OTHER', 'Other session',
       'accepted', 'track_one', 'format_one', 30, ${sqlString(timestamp)},
       'rec_session_other', 1,
       ${sqlString(hash)}, ${sqlString(timestamp)});

    INSERT INTO p_session_participants
      (id, organization_id, event_id, session_id, contact_id, role, sort_order,
       confirmed_state, source_record_id, source_version, source_content_hash,
       projected_at)
    VALUES
      ('participant_speaker', 'org_one', 'evt_one', 'session_own',
       'contact_speaker', 'speaker', 1, 'confirmed', 'rec_participant_speaker',
       1, ${sqlString(hash)}, ${sqlString(timestamp)});

    UPDATE tenant_registry
    SET authority_ready_at = ${sqlString(timestamp)}
    WHERE organization_id IN ('org_one', 'org_two');
  `;
  const statements = seedSql
    .split(";")
    .map((statement) => statement.replaceAll(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((statement) => `${statement};`)
    .join("\n");
  await env.DB.exec(statements);
});

afterAll(async () => {
  await server.close();
});

describe("passwordless authentication runtime", () => {
  it("consumes a link once, rotates a fixed session, and emits hardened cookies", async () => {
    const magicToken = `magic-valid-${"m".repeat(40)}`;
    const fixed = await seedSession("usr_owner", "fixed");
    await seedMagicLink(magicToken, "usr_owner");
    server.clearLogs();

    const response = await exchange(magicToken, fixed.cookie);
    const body = (await response.json()) as {
      csrf_token: string;
      redirect_path: string;
    };
    const cookies = responseCookies(response);
    const sessionSetCookie = cookies.find((cookie) =>
      cookie.startsWith("__Host-opensession-session="),
    );
    const csrfSetCookie = cookies.find((cookie) =>
      cookie.startsWith("__Host-opensession-csrf="),
    );

    expect(response.status).toBe(200);
    expect(body.redirect_path).toBe("/welcome");
    expect(sessionSetCookie).toContain("; HttpOnly");
    expect(sessionSetCookie).toContain("; Secure");
    expect(sessionSetCookie).toContain("; SameSite=Lax");
    expect(csrfSetCookie).toContain("; Secure");
    expect(csrfSetCookie).toContain("; SameSite=Lax");
    expect(csrfSetCookie).not.toContain("HttpOnly");
    expect(cookiePair(cookies, "__Host-opensession-session")).not.toBe(
      fixed.cookie,
    );

    const env = await server.getWorker<Env>().getEnv();
    const oldSession = await env.DB.prepare(
      "SELECT rotated_at, revoked_at FROM auth_sessions WHERE id = 'auth_fixed'",
    ).first<{ revoked_at: string | null; rotated_at: string | null }>();
    const stored = await env.DB.prepare(
      "SELECT token_hash FROM auth_sessions ORDER BY created_at DESC LIMIT 1",
    ).first<{ token_hash: string }>();
    expect(oldSession?.rotated_at).toBeTruthy();
    expect(oldSession?.revoked_at).toBeTruthy();
    expect(stored?.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored?.token_hash).not.toContain(magicToken);
    expect(JSON.stringify(server.getLogs())).not.toContain(magicToken);
    expect(JSON.stringify(server.getLogs())).not.toContain(body.csrf_token);
  });

  it("binds a magic link to the browser that requested it", async () => {
    const magicToken = `magic-browser-bound-${"b".repeat(40)}`;
    await seedMagicLink(magicToken, "usr_owner");

    const missingBinding = await exchange(magicToken, undefined, null);
    const wrongBinding = await exchange(
      magicToken,
      undefined,
      `attacker-binding-${"x".repeat(32)}`,
    );
    const intendedBrowser = await exchange(magicToken);

    expect(missingBinding.status).toBe(400);
    expect(wrongBinding.status).toBe(400);
    expect(intendedBrowser.status).toBe(200);
  });

  it("rejects replayed and expired links without creating another session", async () => {
    const replayToken = `magic-replay-${"r".repeat(40)}`;
    const expiredToken = `magic-expired-${"e".repeat(40)}`;
    await seedMagicLink(replayToken, "usr_reviewer");
    await seedMagicLink(expiredToken, "usr_reviewer", { expiresAt: past });

    const concurrent = await Promise.all([
      exchange(replayToken),
      exchange(replayToken),
    ]);
    const expired = await exchange(expiredToken);

    expect(concurrent.map(({ status }) => status).sort()).toEqual([200, 400]);
    expect(expired.status).toBe(400);
    const replay = concurrent.find(({ status }) => status === 400);
    expect(replay).toBeDefined();
    await expect(replay?.json()).resolves.toMatchObject({
      error: { code: "invalid_magic_link" },
    });
    await expect(expired.json()).resolves.toMatchObject({
      error: { code: "invalid_magic_link" },
    });
  });

  it("releases a consumed link when transactional session creation fails", async () => {
    const env = await server.getWorker<Env>().getEnv();
    const magicToken = `magic-recover-${"g".repeat(40)}`;
    const collidingSessionToken = `session-collision-${"x".repeat(40)}`;
    const magicTokenHash = await sha256Hex(magicToken);
    await seedMagicLink(magicToken, "usr_owner");
    await env.DB.prepare(
      `INSERT INTO auth_sessions
        (id, user_id, token_hash, created_at, expires_at, last_seen_at)
       VALUES ('auth_collision', 'usr_owner', ?1, ?2, ?3, ?2)`,
    )
      .bind(await sha256Hex(collidingSessionToken), timestamp, future)
      .run();

    const authService = new AuthService({
      database: env.DB,
      emailEnabled: true,
      emailQueue: env.EMAIL_QUEUE,
      hashPepper: pepper,
      tokenFactory: () => collidingSessionToken,
    });
    await expect(
      authService.exchangeMagicLink(
        magicToken,
        `binding-${magicToken}`,
        { ipAddress: null, userAgent: null },
        null,
      ),
    ).rejects.toThrow();

    const link = await env.DB.prepare(
      `SELECT consumed_at
       FROM magic_link_tokens
       WHERE token_hash = ?1`,
    )
      .bind(magicTokenHash)
      .first<{ consumed_at: string | null }>();
    expect(link?.consumed_at).toBeNull();
  });

  it("requires exact origin and CSRF before logout, then revokes the session", async () => {
    const session = await seedSession("usr_viewer", "logout");
    const missingOrigin = await server.fetch("/api/auth/logout", {
      headers: { "Content-Type": "application/json", Cookie: session.cookie },
      method: "POST",
    });
    const wrongOrigin = await server.fetch("/api/auth/logout", {
      headers: {
        ...authHeaders(session.cookie, session.csrf),
        Origin: "https://attacker.example",
      },
      method: "POST",
    });
    const missingCsrf = await server.fetch("/api/auth/logout", {
      headers: authHeaders(session.cookie),
      method: "POST",
    });
    const logout = await server.fetch("/api/auth/logout", {
      headers: authHeaders(session.cookie, session.csrf),
      method: "POST",
    });

    expect(missingOrigin.status).toBe(403);
    expect(wrongOrigin.status).toBe(403);
    expect(missingCsrf.status).toBe(403);
    expect(logout.status).toBe(204);
    expect(responseCookies(logout)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^__Host-opensession-session=;.*Max-Age=0/i),
        expect.stringMatching(/^__Host-opensession-csrf=;.*Max-Age=0/i),
      ]),
    );

    const afterLogout = await server.fetch("/api/auth/session", {
      headers: { Cookie: session.cookie },
    });
    expect(afterLogout.status).toBe(401);
  });

  it("rotates an authenticated session without accepting the old token", async () => {
    const session = await seedSession("usr_reviewer", "rotate");
    const response = await server.fetch("/api/auth/session/rotate", {
      body: "{}",
      headers: authHeaders(session.cookie, session.csrf),
      method: "POST",
    });
    const cookies = responseCookies(response);
    const rotatedCookie = cookiePair(cookies, "__Host-opensession-session");

    expect(response.status).toBe(200);
    expect(rotatedCookie).not.toBe(session.cookie);
    expect(
      (
        await server.fetch("/api/auth/session", {
          headers: { Cookie: session.cookie },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await server.fetch("/api/auth/session", {
          headers: { Cookie: rotatedCookie },
        })
      ).status,
    ).toBe(200);
  });

  it("resolves authenticated schedule reads by workspace slug or canonical ID", async () => {
    const owner = await seedSession("usr_owner", "schedule_owner");
    const speaker = await seedSession("usr_speaker", "schedule_speaker");
    const bySlug = await server.fetch("/api/events/event-one/schedule", {
      headers: { Cookie: owner.cookie },
    });
    expect(bySlug.status, await bySlug.clone().text()).toBe(200);
    const slugSnapshot = scheduleSnapshotSchema.parse(await bySlug.json());
    expect(slugSnapshot.event).toMatchObject({
      eventId: "evt_one",
      slug: "event-one",
    });
    expect(slugSnapshot.rooms.map(({ id }) => id)).toEqual(["room_one"]);

    const byId = await server.fetch("/api/events/evt_one/schedule", {
      headers: { Cookie: owner.cookie },
    });
    expect(byId.status).toBe(200);
    await expect(byId.json()).resolves.toEqual(slugSnapshot);
    expect(
      (
        await server.fetch("/api/events/event-one/schedule", {
          headers: { Cookie: speaker.cookie },
        })
      ).status,
    ).toBe(403);
    expect((await server.fetch("/api/events/event-one/schedule")).status).toBe(
      401,
    );

    const missingCsrf = await server.fetch(
      "/api/events/event-one/schedule/commands",
      {
        body: JSON.stringify({
          commandId: "cmd_schedule_route_test",
          durationMinutes: 30,
          eventId: "evt_one",
          expectedVersion: 0,
          roomId: "room_one",
          sessionId: "session_other",
          startAt: "2026-10-13T09:00:00.000Z",
          type: "place_session",
        }),
        headers: authHeaders(owner.cookie),
        method: "POST",
      },
    );
    expect(missingCsrf.status).toBe(403);
    await expect(missingCsrf.json()).resolves.toMatchObject({
      error: { code: "invalid_csrf" },
    });

    const mismatchedCanonicalId = await server.fetch(
      "/api/events/event-one/schedule/commands",
      {
        body: JSON.stringify({
          commandId: "cmd_schedule_route_mismatch",
          eventId: "evt_two",
          expectedVersion: 0,
          type: "publish_schedule",
        }),
        headers: authHeaders(owner.cookie, owner.csrf),
        method: "POST",
      },
    );
    expect(mismatchedCanonicalId.status).toBe(422);
    await expect(mismatchedCanonicalId.json()).resolves.toMatchObject({
      error: {
        code: "schedule_validation_error",
        field: "eventId",
        reason: "invalid_command",
      },
      ok: false,
    });
  });

  it("enforces hard conflicts on placement and publish at the server boundary", async () => {
    const owner = await seedSession("usr_owner", "schedule_conflicts");
    const env = await server.getWorker<Env>().getEnv();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE p_events SET schedule_version = 1 WHERE id = 'evt_one'`,
      ),
      env.DB.prepare(
        `UPDATE p_sessions SET status = 'scheduled'
         WHERE id = 'session_own'`,
      ),
      env.DB.prepare(
        `UPDATE p_sessions SET expected_attendance = 150
         WHERE id = 'session_other'`,
      ),
      env.DB.prepare(
        `INSERT INTO p_session_participants (
           id, organization_id, event_id, session_id, contact_id, role,
           sort_order, confirmed_state, source_record_id, source_version,
           source_content_hash, projected_at
         ) VALUES (?, ?, ?, ?, ?, 'moderator', 1, 'confirmed', ?, 1, ?, ?)`,
      ).bind(
        "participant_schedule_conflict",
        "org_one",
        "evt_one",
        "session_other",
        "contact_speaker",
        "rec_participant_schedule_conflict",
        hash,
        timestamp,
      ),
      env.DB.prepare(
        `INSERT INTO p_schedule_slots (
           id, organization_id, event_id, session_id, room_id, starts_at,
           ends_at, version, published_version, source_record_id,
           source_version, source_content_hash, projected_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, 1, ?, ?)`,
      ).bind(
        "slot_schedule_existing",
        "org_one",
        "evt_one",
        "session_own",
        "room_one",
        "2026-10-13T10:00:00.000Z",
        "2026-10-13T10:30:00.000Z",
        "rec_slot_schedule_existing",
        hash,
        timestamp,
      ),
    ]);

    const collisionCommand = {
      commandId: "cmd_server_room_collision",
      durationMinutes: 30,
      eventId: "evt_one",
      expectedVersion: 1,
      overrideReason: "Hard conflicts are never overrideable",
      roomId: "room_one",
      sessionId: "session_other",
      startAt: "2026-10-13T10:15:00.000Z",
      type: "place_session",
    };
    const beforeCollision = await server.fetch(
      "/api/events/event-one/schedule",
      { headers: { Cookie: owner.cookie } },
    );
    expect(beforeCollision.status, await beforeCollision.clone().text()).toBe(
      200,
    );
    const collision = await server.fetch(
      "/api/events/event-one/schedule/commands",
      {
        body: JSON.stringify(collisionCommand),
        headers: authHeaders(owner.cookie, owner.csrf),
        method: "POST",
      },
    );
    expect(collision.status, await collision.clone().text()).toBe(409);
    await expect(collision.json()).resolves.toMatchObject({
      error: {
        code: "schedule_hard_conflict",
        conflicts: expect.arrayContaining([
          expect.objectContaining({
            code: "room_overlap",
            entity: { id: "room_one", name: "Main room", type: "room" },
            overlap: {
              endAt: "2026-10-13T10:30:00.000Z",
              startAt: "2026-10-13T10:15:00.000Z",
            },
            overrideAllowed: false,
            sessionA: { id: "session_other", title: "Other session" },
            sessionB: { id: "session_own", title: "Speaker session" },
          }),
          expect.objectContaining({
            code: "participant_overlap",
            entity: expect.objectContaining({ id: "contact_speaker" }),
          }),
        ]),
      },
      ok: false,
    });

    const rejectedSession = await env.DB.prepare(
      "SELECT status FROM p_sessions WHERE id = 'session_other'",
    ).first<{ status: string }>();
    expect(rejectedSession?.status).toBe("accepted");

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE p_sessions SET status = 'scheduled'
         WHERE id = 'session_other'`,
      ),
      env.DB.prepare(
        `INSERT INTO p_schedule_slots (
           id, organization_id, event_id, session_id, room_id, starts_at,
           ends_at, version, published_version, source_record_id,
           source_version, source_content_hash, projected_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, 1, ?, ?)`,
      ).bind(
        "slot_schedule_conflicting",
        "org_one",
        "evt_one",
        "session_other",
        "room_one",
        "2026-10-13T10:15:00.000Z",
        "2026-10-13T10:45:00.000Z",
        "rec_slot_schedule_conflicting",
        hash,
        timestamp,
      ),
    ]);

    const report = await server.fetch(
      "/api/events/event-one/schedule/conflicts",
      { headers: { Cookie: owner.cookie } },
    );
    expect(report.status).toBe(200);
    await expect(report.json()).resolves.toMatchObject({
      eventId: "evt_one",
      hardConflicts: expect.arrayContaining([
        expect.objectContaining({ code: "room_overlap" }),
        expect.objectContaining({ code: "participant_overlap" }),
      ]),
      softWarnings: expect.arrayContaining([
        expect.objectContaining({ code: "capacity_exceeded" }),
        expect.objectContaining({ code: "missing_readiness" }),
      ]),
    });

    const publish = await server.fetch(
      "/api/events/event-one/schedule/commands",
      {
        body: JSON.stringify({
          commandId: "cmd_server_publish_conflict",
          eventId: "evt_one",
          expectedVersion: 1,
          type: "publish_schedule",
        }),
        headers: authHeaders(owner.cookie, owner.csrf),
        method: "POST",
      },
    );
    expect(publish.status).toBe(409);
    await expect(publish.json()).resolves.toMatchObject({
      error: { code: "schedule_hard_conflict" },
      ok: false,
    });

    await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM p_schedule_slots
         WHERE id IN ('slot_schedule_existing', 'slot_schedule_conflicting')`,
      ),
      env.DB.prepare(
        `DELETE FROM p_session_participants
         WHERE id = 'participant_schedule_conflict'`,
      ),
      env.DB.prepare(
        `UPDATE p_sessions SET status = 'accepted', expected_attendance = NULL
         WHERE id IN ('session_own', 'session_other')`,
      ),
      env.DB.prepare(
        `UPDATE p_events SET schedule_version = 0 WHERE id = 'evt_one'`,
      ),
    ]);
  });

  it("enforces role, tenant, revocation, and speaker relationship scope", async () => {
    const owner = await seedSession("usr_owner", "matrix_owner");
    const reviewer = await seedSession("usr_reviewer", "matrix_reviewer");
    const viewer = await seedSession("usr_viewer", "matrix_viewer");
    const speaker = await seedSession("usr_speaker", "matrix_speaker");
    const revoked = await seedSession("usr_revoked", "matrix_revoked");

    async function scope(
      cookie: string,
      organizationId: string,
      eventId: string,
      sessionId?: string,
    ) {
      const query = new URLSearchParams({
        event_id: eventId,
        organization_id: organizationId,
        ...(sessionId ? { session_id: sessionId } : {}),
      });
      const response = await server.fetch(`/api/auth/session?${query}`, {
        headers: { Cookie: cookie },
      });
      expect(response.status).toBe(200);
      return (await response.json()) as ScopeResponse;
    }

    const ownerAccess = await scope(owner.cookie, "org_one", "evt_one");
    const reviewerAccess = await scope(reviewer.cookie, "org_one", "evt_one");
    const viewerAccess = await scope(viewer.cookie, "org_one", "evt_one");
    const ownSession = await scope(
      speaker.cookie,
      "org_one",
      "evt_one",
      "session_own",
    );
    const otherSession = await scope(
      speaker.cookie,
      "org_one",
      "evt_one",
      "session_other",
    );
    const crossTenant = await scope(owner.cookie, "org_two", "evt_two");
    const revokedAccess = await scope(revoked.cookie, "org_one", "evt_one");

    const env = await server.getWorker<Env>().getEnv();
    await env.DB.prepare(
      `UPDATE event_memberships
       SET revoked_at = ?1
       WHERE id = 'membership_reviewer'`,
    )
      .bind(timestamp)
      .run();
    const revokedEventAccess = await scope(
      reviewer.cookie,
      "org_one",
      "evt_one",
    );
    await env.DB.prepare(
      `UPDATE tenant_registry SET status = 'suspended' WHERE organization_id = 'org_one'`,
    ).run();
    const suspendedOwnerAccess = await scope(
      owner.cookie,
      "org_one",
      "evt_one",
      "session_own",
    );
    const suspendedSpeakerAccess = await scope(
      speaker.cookie,
      "org_one",
      "evt_one",
      "session_own",
    );
    await env.DB.prepare(
      `UPDATE tenant_registry SET status = 'active' WHERE organization_id = 'org_one'`,
    ).run();
    await env.DB.prepare(
      `UPDATE tenant_registry SET authority_ready_at = ?1
       WHERE organization_id = 'org_one'`,
    )
      .bind(timestamp)
      .run();

    expect(ownerAccess.scope.organization_role).toBe("owner");
    expect(ownerAccess.scope.permissions).toContain("event:manage");
    expect(reviewerAccess.scope.event_role).toBe("reviewer");
    expect(reviewerAccess.scope.permissions).toContain("review:submit");
    expect(reviewerAccess.scope.permissions).not.toContain("event:manage");
    expect(viewerAccess.scope.permissions).toEqual(
      expect.arrayContaining(["event:read", "session:read:any"]),
    );
    expect(viewerAccess.scope.permissions).not.toContain("event:manage");
    expect(ownSession.scope.speaker_contact_id).toBe("contact_speaker");
    expect(ownSession.scope.can_read_session).toBe(true);
    expect(otherSession.scope.can_read_session).toBe(false);
    expect(crossTenant.scope.permissions).toEqual([]);
    expect(revokedAccess.scope.permissions).toEqual([]);
    expect(revokedEventAccess.scope.permissions).toEqual([]);
    expect(suspendedOwnerAccess.scope.permissions).toEqual([]);
    expect(suspendedOwnerAccess.scope.can_read_session).toBe(false);
    expect(suspendedSpeakerAccess.scope.permissions).toEqual([]);
    expect(suspendedSpeakerAccess.scope.can_read_session).toBe(false);
  });

  it("revalidates event-scoped speaker links at exchange time", async () => {
    const validPortalToken = `portal-valid-${"p".repeat(40)}`;
    const suspendedPortalToken = `portal-suspended-${"s".repeat(40)}`;
    const revokedPortalToken = `portal-revoked-${"q".repeat(40)}`;
    const scope = {
      contactId: "contact_speaker",
      eventId: "evt_one",
      organizationId: "org_one",
    };
    await seedMagicLink(validPortalToken, "usr_speaker", {
      purpose: "portal",
      scope,
    });
    expect((await exchange(validPortalToken)).status).toBe(200);

    const env = await server.getWorker<Env>().getEnv();
    await seedMagicLink(suspendedPortalToken, "usr_speaker", {
      purpose: "portal",
      scope,
    });
    await env.DB.prepare(
      `UPDATE tenant_registry SET status = 'suspended' WHERE organization_id = 'org_one'`,
    ).run();
    expect((await exchange(suspendedPortalToken)).status).toBe(400);
    await env.DB.prepare(
      `UPDATE tenant_registry SET status = 'active' WHERE organization_id = 'org_one'`,
    ).run();
    await env.DB.prepare(
      `UPDATE tenant_registry SET authority_ready_at = ?1
       WHERE organization_id = 'org_one'`,
    )
      .bind(timestamp)
      .run();

    await env.DB.prepare(
      `UPDATE p_event_contacts
       SET portal_state = 'revoked'
       WHERE id = 'event_contact_speaker'`,
    ).run();
    await seedMagicLink(revokedPortalToken, "usr_speaker", {
      purpose: "portal",
      scope,
    });
    expect((await exchange(revokedPortalToken)).status).toBe(400);
  });

  it("preserves the previously delivered link when a resend cannot queue", async () => {
    const env = await server.getWorker<Env>().getEnv();
    const priorToken = `magic-prior-${"o".repeat(40)}`;
    const replacementToken = `magic-undelivered-${"u".repeat(40)}`;
    await seedMagicLink(priorToken, "usr_viewer");
    const authService = new AuthService({
      database: env.DB,
      emailEnabled: true,
      emailQueue: {
        send: async () => {
          throw new Error("simulated queue outage");
        },
      } as unknown as Env["EMAIL_QUEUE"],
      hashPepper: pepper,
      tokenFactory: () => replacementToken,
    });

    const outcome = await authService.requestMagicLink(
      {
        email: "viewer@example.test",
        purpose: "sign_in",
        redirect_path: "/",
      },
      { ipAddress: "203.0.113.90", userAgent: null },
      `binding-${replacementToken}`,
      origin,
      "req_resend_queue_failure",
    );
    const prior = await env.DB.prepare(
      `SELECT delivery_state, revoked_at
       FROM magic_link_tokens
       WHERE token_hash = ?1`,
    )
      .bind(await sha256Hex(priorToken))
      .first<{ delivery_state: string; revoked_at: string | null }>();
    const replacement = await env.DB.prepare(
      `SELECT delivery_state, revoked_at
       FROM magic_link_tokens
       WHERE token_hash = ?1`,
    )
      .bind(await sha256Hex(replacementToken))
      .first<{ delivery_state: string; revoked_at: string | null }>();
    const event = await env.DB.prepare(
      `SELECT * FROM operational_events
       WHERE request_id = 'req_resend_queue_failure'`,
    ).first<Record<string, unknown>>();

    expect(outcome).toMatchObject({ outcome: "delivery_failed" });
    expect(event).toMatchObject({
      attempt_count: 1,
      delivery_id: outcome.deliveryId,
      error_code: "queue_rejected",
      event_type: "email.magic_link.enqueue_failed",
      outcome: "failure",
      queue_name: "email_send",
      request_id: "req_resend_queue_failure",
    });
    expect(JSON.stringify(event)).not.toContain("viewer@example.test");
    expect(JSON.stringify(event)).not.toContain(replacementToken);
    expect(prior).toEqual({ delivery_state: "queued", revoked_at: null });
    expect(replacement?.delivery_state).toBe("failed");
    expect(replacement?.revoked_at).toBeTruthy();
    expect((await exchange(priorToken)).status).toBe(200);
  });

  it("revokes the previous link only after its replacement is queued", async () => {
    const env = await server.getWorker<Env>().getEnv();
    const priorToken = `magic-replaced-${"d".repeat(40)}`;
    const replacementToken = `magic-delivered-${"n".repeat(40)}`;
    await seedMagicLink(priorToken, "usr_reviewer");
    const authService = new AuthService({
      database: env.DB,
      emailEnabled: true,
      emailQueue: {
        send: async () => undefined,
      } as unknown as Env["EMAIL_QUEUE"],
      hashPepper: pepper,
      tokenFactory: () => replacementToken,
    });

    const outcome = await authService.requestMagicLink(
      {
        email: "reviewer@example.test",
        purpose: "sign_in",
        redirect_path: "/",
      },
      { ipAddress: "203.0.113.91", userAgent: null },
      `binding-${replacementToken}`,
      origin,
      "req_resend_queued",
    );
    const event = await env.DB.prepare(
      `SELECT * FROM operational_events
       WHERE request_id = 'req_resend_queued'`,
    ).first<Record<string, unknown>>();

    expect(outcome).toMatchObject({ outcome: "queued" });
    expect(event).toMatchObject({
      attempt_count: 1,
      delivery_id: outcome.deliveryId,
      event_type: "email.magic_link.queued",
      outcome: "accepted",
      queue_name: "email_send",
      request_id: "req_resend_queued",
    });
    expect(JSON.stringify(event)).not.toContain("reviewer@example.test");
    expect(JSON.stringify(event)).not.toContain(replacementToken);
    expect((await exchange(priorToken)).status).toBe(400);
    expect((await exchange(replacementToken)).status).toBe(200);
  });

  it("lets the first presented link win after D1 finalization fails", async () => {
    const env = await server.getWorker<Env>().getEnv();
    const priorToken = `magic-finalize-prior-${"f".repeat(40)}`;
    const replacementToken = `magic-finalize-replacement-${"z".repeat(40)}`;
    await seedMagicLink(priorToken, "usr_revoked");
    let batchCalls = 0;
    const finalizationFailureDatabase = {
      batch: async (statements: D1PreparedStatement[]) => {
        batchCalls += 1;
        if (batchCalls === 2) {
          throw new Error("simulated post-enqueue D1 outage");
        }
        return env.DB.batch(statements);
      },
      prepare: env.DB.prepare.bind(env.DB),
    } as unknown as D1Database;
    const authService = new AuthService({
      database: finalizationFailureDatabase,
      emailEnabled: true,
      emailQueue: {
        send: async () => undefined,
      } as unknown as Env["EMAIL_QUEUE"],
      hashPepper: pepper,
      tokenFactory: () => replacementToken,
    });

    const outcome = await authService.requestMagicLink(
      {
        email: "revoked@example.test",
        purpose: "sign_in",
        redirect_path: "/",
      },
      { ipAddress: "203.0.113.92", userAgent: null },
      `binding-${replacementToken}`,
      origin,
      "req_finalize_prior_wins",
    );
    const pending = await env.DB.prepare(
      `SELECT delivery_state, revoked_at
       FROM magic_link_tokens
       WHERE token_hash = ?1`,
    )
      .bind(await sha256Hex(replacementToken))
      .first<{ delivery_state: string; revoked_at: string | null }>();

    expect(outcome).toMatchObject({ outcome: "finalization_failed" });
    expect(pending).toEqual({ delivery_state: "pending", revoked_at: null });
    expect((await exchange(priorToken)).status).toBe(200);
    expect((await exchange(replacementToken)).status).toBe(400);
  });

  it("lets the delivered pending replacement win finalization recovery", async () => {
    const env = await server.getWorker<Env>().getEnv();
    const priorToken = `magic-finalize-new-prior-${"p".repeat(40)}`;
    const replacementToken = `magic-finalize-new-winner-${"w".repeat(40)}`;
    await seedMagicLink(priorToken, "usr_viewer");
    let batchCalls = 0;
    const finalizationFailureDatabase = {
      batch: async (statements: D1PreparedStatement[]) => {
        batchCalls += 1;
        if (batchCalls === 2) {
          throw new Error("simulated post-enqueue D1 outage");
        }
        return env.DB.batch(statements);
      },
      prepare: env.DB.prepare.bind(env.DB),
    } as unknown as D1Database;
    const authService = new AuthService({
      database: finalizationFailureDatabase,
      emailEnabled: true,
      emailQueue: {
        send: async () => undefined,
      } as unknown as Env["EMAIL_QUEUE"],
      hashPepper: pepper,
      tokenFactory: () => replacementToken,
    });

    const outcome = await authService.requestMagicLink(
      {
        email: "viewer@example.test",
        purpose: "sign_in",
        redirect_path: "/",
      },
      { ipAddress: "203.0.113.93", userAgent: null },
      `binding-${replacementToken}`,
      origin,
      "req_finalize_replacement_wins",
    );

    expect(outcome).toMatchObject({ outcome: "finalization_failed" });
    expect((await exchange(replacementToken)).status).toBe(200);
    expect((await exchange(priorToken)).status).toBe(400);
  });

  it("preserves the delivered link when queue and cleanup both fail", async () => {
    const env = await server.getWorker<Env>().getEnv();
    const priorToken = `magic-cleanup-prior-${"c".repeat(40)}`;
    const replacementToken = `magic-cleanup-pending-${"g".repeat(40)}`;
    await seedMagicLink(priorToken, "usr_speaker");
    const cleanupFailureDatabase = {
      batch: env.DB.batch.bind(env.DB),
      prepare: (query: string) => {
        if (query.includes("SET delivery_state = 'failed'")) {
          return {
            bind: () => ({
              run: async () => {
                throw new Error("simulated cleanup D1 outage");
              },
            }),
          } as unknown as D1PreparedStatement;
        }
        return env.DB.prepare(query);
      },
    } as unknown as D1Database;
    const authService = new AuthService({
      database: cleanupFailureDatabase,
      emailEnabled: true,
      emailQueue: {
        send: async () => {
          throw new Error("simulated queue outage");
        },
      } as unknown as Env["EMAIL_QUEUE"],
      hashPepper: pepper,
      tokenFactory: () => replacementToken,
    });

    const outcome = await authService.requestMagicLink(
      {
        email: "speaker@example.test",
        purpose: "sign_in",
        redirect_path: "/",
      },
      { ipAddress: "203.0.113.94", userAgent: null },
      `binding-${replacementToken}`,
      origin,
      "req_queue_cleanup_failure",
    );
    const pending = await env.DB.prepare(
      `SELECT delivery_state, revoked_at
       FROM magic_link_tokens
       WHERE token_hash = ?1`,
    )
      .bind(await sha256Hex(replacementToken))
      .first<{ delivery_state: string; revoked_at: string | null }>();

    expect(outcome).toMatchObject({ outcome: "delivery_cleanup_failed" });
    expect(pending).toEqual({ delivery_state: "pending", revoked_at: null });
    expect((await exchange(priorToken)).status).toBe(200);
    expect((await exchange(replacementToken)).status).toBe(400);
  });

  it("chooses one winner for links issued in the same millisecond", async () => {
    const lowerToken = `magic-same-time-lower-${"l".repeat(40)}`;
    const higherToken = `magic-same-time-higher-${"h".repeat(40)}`;
    await seedMagicLink(lowerToken, "usr_owner", { id: "same-time-a" });
    await seedMagicLink(higherToken, "usr_owner", { id: "same-time-z" });

    expect((await exchange(lowerToken)).status).toBe(200);
    expect((await exchange(higherToken)).status).toBe(400);
  });

  it("throttles resend without revealing whether an identity exists", async () => {
    async function request(email: string) {
      return server.fetch("/api/auth/magic-links", {
        body: JSON.stringify({
          email,
          purpose: "sign_in",
          redirect_path: "/",
          ...turnstileFields,
        }),
        headers: {
          ...authHeaders(),
          "CF-Connecting-IP": "203.0.113.8",
        },
        method: "POST",
      });
    }

    const known = await request("owner@example.test");
    const unknown = await request("unknown@example.test");
    const knownBody = await known.json();
    const unknownBody = await unknown.json();
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(knownBody).toEqual(unknownBody);
    expect(responseCookies(known)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^__Host-opensession-auth-init=.*HttpOnly.*Secure.*SameSite=Lax/i,
        ),
      ]),
    );

    await request("owner@example.test");
    await request("owner@example.test");
    await request("owner@example.test");

    const env = await server.getWorker<Env>().getEnv();
    const limit = await env.DB.prepare(
      `SELECT request_count, blocked_until, key_hash
       FROM magic_link_request_limits
       WHERE dimension = 'email' AND request_count >= 4
       LIMIT 1`,
    ).first<{
      blocked_until: string | null;
      key_hash: string;
      request_count: number;
    }>();
    expect(limit?.request_count).toBe(4);
    expect(limit?.blocked_until).toBeTruthy();
    expect(limit?.key_hash).not.toContain("owner@example.test");
  });

  it("rejects a challenge action that does not match the account flow", async () => {
    const response = await server.fetch("/api/auth/magic-links", {
      body: JSON.stringify({
        email: "owner@example.test",
        event_slug: "ai-engineer-summit",
        purpose: "sign_in",
        redirect_path: "/e/ai-engineer-summit/cfp",
        ...turnstileFields,
      }),
      headers: authHeaders(),
      method: "POST",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_request" },
    });
  });

  it("rejects redirect canonicalization tricks and oversized auth bodies", async () => {
    for (const whitespace of ["\t", "\n", "\r"]) {
      const response = await server.fetch("/api/auth/magic-links", {
        body: JSON.stringify({
          email: "owner@example.test",
          purpose: "sign_in",
          redirect_path: `/${whitespace}/evil.example/path`,
          ...turnstileFields,
        }),
        headers: authHeaders(),
        method: "POST",
      });
      expect(response.status).toBe(400);
    }

    const oversized = await server.fetch("/api/auth/magic-links", {
      body: JSON.stringify({ padding: "x".repeat(9 * 1024) }),
      headers: authHeaders(),
      method: "POST",
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      error: { code: "request_too_large" },
    });
  });

  it("stops adding email limiter rows after the shared IP is blocked", async () => {
    const env = await server.getWorker<Env>().getEnv();
    const ipAddress = "203.0.113.240";
    const request = (index: number) =>
      server.fetch("/api/auth/magic-links", {
        body: JSON.stringify({
          email: `limiter-${index}@example.test`,
          purpose: "sign_in",
          redirect_path: "/",
          ...turnstileFields,
        }),
        headers: {
          ...authHeaders(),
          "CF-Connecting-IP": ipAddress,
        },
        method: "POST",
      });
    const emailRowCount = async () => {
      const row = await env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM magic_link_request_limits
         WHERE dimension = 'email'`,
      ).first<{ count: number }>();
      return row?.count ?? 0;
    };
    const before = await emailRowCount();

    for (let index = 0; index < 13; index += 1) {
      expect((await request(index)).status).toBe(202);
    }
    const atBlock = await emailRowCount();
    expect(atBlock - before).toBe(12);

    for (let index = 13; index < 18; index += 1) {
      expect((await request(index)).status).toBe(202);
    }
    expect(await emailRowCount()).toBe(atBlock);
  });
});
