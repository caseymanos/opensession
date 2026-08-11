import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sha256Hex } from "../src/auth/crypto";
import type { AuthenticatedSession } from "../src/auth/service";
import { D1SpeakerPortalService } from "../src/portal/service";

const hash = "a".repeat(64);
const timestamp = "2026-08-10T16:00:00.000Z";
const pepper = "speaker-portal-test-pepper-with-at-least-32-characters";
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

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function session(
  id: string,
  email: string,
  displayName: string,
): AuthenticatedSession {
  return {
    csrfTokenHash: hash,
    expiresAt: "2026-08-11T16:00:00.000Z",
    id: `auth_${id}`,
    tokenHash: hash,
    user: { displayName, email, id },
  };
}

const speakerOne = session(
  "usr_speaker_one",
  "speaker-one@example.test",
  "Sam Speaker",
);
const speakerTwo = session(
  "usr_speaker_two",
  "speaker-two@example.test",
  "Taylor Speaker",
);
const foreignSpeaker = session(
  "usr_foreign",
  "foreign@example.test",
  "Fern Foreign",
);
const owner = session("usr_owner", "owner@example.test", "Olivia Owner");

beforeAll(async () => {
  origin = (await server.listen()).url.origin;
  const worker = server.getWorker<Env>();
  await worker.applyD1Migrations("DB");
  const env = await worker.getEnv();
  const seedSql = `
    INSERT INTO tenant_registry
      (organization_id, base_key, source_record_id, created_at, updated_at,
       authority_ready_at)
    VALUES
      ('org_one', 'base_one', 'rec_org_one', ${sqlString(timestamp)},
       ${sqlString(timestamp)}, ${sqlString(timestamp)}),
      ('org_two', 'base_two', 'rec_org_two', ${sqlString(timestamp)},
       ${sqlString(timestamp)}, ${sqlString(timestamp)});

    INSERT INTO users
      (id, email_normalized, display_name, created_at, updated_at)
    VALUES
      ('usr_speaker_one', 'speaker-one@example.test', 'Sam Speaker',
       ${sqlString(timestamp)}, ${sqlString(timestamp)}),
      ('usr_speaker_two', 'speaker-two@example.test', 'Taylor Speaker',
       ${sqlString(timestamp)}, ${sqlString(timestamp)}),
      ('usr_foreign', 'foreign@example.test', 'Fern Foreign',
       ${sqlString(timestamp)}, ${sqlString(timestamp)}),
      ('usr_owner', 'owner@example.test', 'Olivia Owner',
       ${sqlString(timestamp)}, ${sqlString(timestamp)});

    INSERT INTO organization_memberships
      (id, organization_id, user_id, role, created_at, updated_at)
    VALUES
      ('membership_owner', 'org_one', 'usr_owner', 'owner',
       ${sqlString(timestamp)}, ${sqlString(timestamp)});

    INSERT INTO p_events
      (id, organization_id, name, slug, timezone, starts_at, ends_at, venue,
       status, brand_json, source_record_id, source_version,
       source_content_hash, projected_at)
    VALUES
      ('evt_one', 'org_one', 'Open Session Summit', 'open-session-summit',
       'America/Los_Angeles', '2026-08-18T16:00:00.000Z',
       '2026-08-20T23:00:00.000Z', 'Pier 27', 'published',
       '{"accent":"#ABCDEF","background":"#101010","ink":"#FEFEFE","private":"discard"}',
       'rec_evt_one', 1, ${sqlString(hash)}, ${sqlString(timestamp)}),
      ('evt_two', 'org_two', 'Foreign Conference', 'foreign-conference',
       'UTC', '2026-09-01T09:00:00.000Z', '2026-09-02T17:00:00.000Z',
       NULL, 'published', '{}', 'rec_evt_two', 1, ${sqlString(hash)},
       ${sqlString(timestamp)});

    INSERT INTO p_contacts
      (id, organization_id, email_normalized, display_name,
       headshot_object_key, source_record_id, source_version,
       source_content_hash, projected_at)
    VALUES
      ('contact_one', 'org_one', 'speaker-one@example.test', 'Sam Speaker',
       'private/headshot-one.jpg', 'rec_contact_one', 1, ${sqlString(hash)},
       ${sqlString(timestamp)}),
      ('contact_two', 'org_one', 'speaker-two@example.test', 'Taylor Speaker',
       'private/headshot-two.jpg', 'rec_contact_two', 1, ${sqlString(hash)},
       ${sqlString(timestamp)}),
      ('contact_unassigned', 'org_one', 'unassigned@example.test',
       'Una Assigned', NULL, 'rec_contact_unassigned', 1,
       ${sqlString(hash)}, ${sqlString(timestamp)}),
      ('contact_foreign', 'org_two', 'foreign@example.test', 'Fern Foreign',
       NULL, 'rec_contact_foreign', 1, ${sqlString(hash)},
       ${sqlString(timestamp)});

    INSERT INTO p_event_contacts
      (id, organization_id, event_id, contact_id, roles_json, portal_state,
       source_record_id, source_version, source_content_hash, projected_at)
    VALUES
      ('event_contact_one', 'org_one', 'evt_one', 'contact_one', '["speaker"]',
       'active', 'rec_event_contact_one', 1, ${sqlString(hash)},
       ${sqlString(timestamp)}),
      ('event_contact_two', 'org_one', 'evt_one', 'contact_two', '["speaker"]',
       'invited', 'rec_event_contact_two', 1, ${sqlString(hash)},
       ${sqlString(timestamp)}),
      ('event_contact_unassigned', 'org_one', 'evt_one', 'contact_unassigned',
       '["speaker"]', 'active', 'rec_event_contact_unassigned', 1,
       ${sqlString(hash)}, ${sqlString(timestamp)}),
      ('event_contact_foreign', 'org_two', 'evt_two', 'contact_foreign',
       '["speaker"]', 'active', 'rec_event_contact_foreign', 1,
       ${sqlString(hash)}, ${sqlString(timestamp)});

    INSERT INTO p_tracks
      (id, organization_id, event_id, name, sort_order, source_record_id,
       source_version, source_content_hash, projected_at)
    VALUES
      ('track_one', 'org_one', 'evt_one', 'Architecture', 1, 'rec_track_one',
       1, ${sqlString(hash)}, ${sqlString(timestamp)});

    INSERT INTO p_formats
      (id, organization_id, event_id, name, default_duration_minutes,
       sort_order, source_record_id, source_version, source_content_hash,
       projected_at)
    VALUES
      ('format_one', 'org_one', 'evt_one', 'Talk', 30, 1, 'rec_format_one',
       1, ${sqlString(hash)}, ${sqlString(timestamp)});

    INSERT INTO p_rooms
      (id, organization_id, event_id, name, capacity, sort_order,
       source_record_id, source_version, source_content_hash, projected_at)
    VALUES
      ('room_one', 'org_one', 'evt_one', 'Main Hall', 400, 1, 'rec_room_one',
       1, ${sqlString(hash)}, ${sqlString(timestamp)});

    INSERT INTO p_sessions
      (id, organization_id, event_id, friendly_id, title, status, track_id,
       format_id, duration_minutes, updated_at, source_record_id,
       source_version, source_content_hash, projected_at)
    VALUES
      ('session_shared', 'org_one', 'evt_one', 'OSS-101',
       'Authority Without Coupling', 'scheduled', 'track_one', 'format_one', 45,
       ${sqlString(timestamp)}, 'rec_session_shared', 1, ${sqlString(hash)},
       ${sqlString(timestamp)}),
      ('session_two', 'org_one', 'evt_one', 'OSS-202', 'Projection Design',
       'accepted', 'track_one', 'format_one', 30, ${sqlString(timestamp)},
       'rec_session_two', 1, ${sqlString(hash)}, ${sqlString(timestamp)});

    INSERT INTO p_session_participants
      (id, organization_id, event_id, session_id, contact_id, role, sort_order,
       confirmed_state, source_record_id, source_version, source_content_hash,
       projected_at)
    VALUES
      ('participant_one', 'org_one', 'evt_one', 'session_shared', 'contact_one',
       'speaker', 1, 'confirmed', 'rec_participant_one', 1, ${sqlString(hash)},
       ${sqlString(timestamp)}),
      ('participant_two_shared', 'org_one', 'evt_one', 'session_shared',
       'contact_two', 'speaker', 2, 'pending', 'rec_participant_two_shared', 1,
       ${sqlString(hash)}, ${sqlString(timestamp)}),
      ('participant_two', 'org_one', 'evt_one', 'session_two', 'contact_two',
       'speaker', 1, 'confirmed', 'rec_participant_two', 1, ${sqlString(hash)},
       ${sqlString(timestamp)});

    INSERT INTO p_schedule_slots
      (id, organization_id, event_id, session_id, room_id, starts_at, ends_at,
       version, source_record_id, source_version, source_content_hash,
       projected_at)
    VALUES
      ('slot_shared', 'org_one', 'evt_one', 'session_shared', 'room_one',
       '2026-08-18T18:00:00.000Z', '2026-08-18T18:45:00.000Z', 1,
       'rec_slot_shared', 1, ${sqlString(hash)}, ${sqlString(timestamp)});

    INSERT INTO p_task_definitions
      (id, organization_id, event_id, name, type, description,
       required_default, approval_required, source_record_id, source_version,
       source_content_hash, projected_at)
    VALUES
      ('task_definition_bio', 'org_one', 'evt_one', 'Review your biography',
       'ack', 'Confirm your public biography.', 1, 0, 'rec_task_definition_bio',
       1, ${sqlString(hash)}, ${sqlString(timestamp)}),
      ('task_definition_slides', 'org_one', 'evt_one', 'Upload slides', 'file',
       'Upload the final deck.', 1, 1, 'rec_task_definition_slides', 1,
       ${sqlString(hash)}, ${sqlString(timestamp)});

    INSERT INTO p_task_assignments
      (id, organization_id, event_id, definition_id, contact_id, session_id,
       due_at, required, status, completed_at, approved_at, response_json,
       file_object_ids_json, updated_at, source_record_id, source_version,
       source_content_hash, projected_at)
    VALUES
      ('task_one_overdue', 'org_one', 'evt_one', 'task_definition_bio',
       'contact_one', NULL, '2026-08-09T16:00:00.000Z', 1, 'not_started',
       NULL, NULL, '{}', '[]', ${sqlString(timestamp)},
       'rec_task_one_overdue', 1, ${sqlString(hash)}, ${sqlString(timestamp)}),
      ('task_one_complete', 'org_one', 'evt_one', 'task_definition_slides',
       'contact_one', 'session_shared', '2026-08-15T16:00:00.000Z', 1,
       'complete', '2026-08-08T16:00:00.000Z', '2026-08-09T16:00:00.000Z',
       '{"private":"discard"}', '["private-object-id"]',
       ${sqlString(timestamp)}, 'rec_task_one_complete', 1,
       ${sqlString(hash)}, ${sqlString(timestamp)}),
      ('task_two', 'org_one', 'evt_one', 'task_definition_bio', 'contact_two',
       NULL, '2026-08-16T16:00:00.000Z', 1, 'in_progress', NULL, NULL, '{}',
       '[]', ${sqlString(timestamp)}, 'rec_task_two', 1, ${sqlString(hash)},
       ${sqlString(timestamp)});
  `;
  const statements = seedSql
    .split(";")
    .map((statement) => statement.replaceAll(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((statement) => `${statement};`)
    .join("\n");
  await env.DB.exec(statements);
  for (const [label, userId] of [
    ["speaker_one", "usr_speaker_one"],
    ["owner", "usr_owner"],
    ["foreign", "usr_foreign"],
  ] as const) {
    const rawToken = `portal-session-${label}-${"s".repeat(36)}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO auth_sessions
          (id, user_id, token_hash, created_at, expires_at, last_seen_at)
         VALUES (?1, ?2, ?3, ?4, '2099-01-01T00:00:00.000Z', ?4)`,
      ).bind(`auth_${label}`, userId, await sha256Hex(rawToken), timestamp),
      env.DB.prepare(
        `INSERT INTO auth_session_secrets
          (session_id, csrf_token_hash, created_at)
         VALUES (?1, ?2, ?3)`,
      ).bind(`auth_${label}`, await sha256Hex(`csrf-${label}`), timestamp),
    ]);
  }
});

afterAll(async () => {
  await server.close();
});

async function service(): Promise<{
  database: D1Database;
  portal: D1SpeakerPortalService;
}> {
  const database = (await server.getWorker<Env>().getEnv()).DB;
  return {
    database,
    portal: new D1SpeakerPortalService({
      database,
      now: () => new Date(timestamp),
    }),
  };
}

describe("speaker portal authority", () => {
  it("returns only the authenticated speaker's event read model", async () => {
    const { portal } = await service();
    const result = await portal.bootstrap(
      speakerOne,
      "open-session-summit",
      "req_bootstrap_one",
    );

    expect(result.event).toMatchObject({
      brand: { accent: "#cde878", background: "#f5f2ea", ink: "#10201d" },
      days_remaining: 8,
      id: "evt_one",
      slug: "open-session-summit",
    });
    expect(result.speaker).toEqual({
      contact_id: "contact_one",
      display_name: "Sam Speaker",
      email: "speaker-one@example.test",
    });
    expect(result.readiness).toEqual({
      next_due_at: "2026-08-09T16:00:00.000Z",
      outstanding_task_count: 1,
      overdue_task_count: 1,
      policy: {
        configuration: "configured",
        explanation:
          "At least one required task is incomplete after its event-local due time.",
        next_due: {
          at: "2026-08-09T16:00:00.000Z",
          local_date: "2026-08-09",
          local_time: "09:00",
          timezone: "America/Los_Angeles",
        },
        outstanding_count: 1,
        overdue_count: 1,
        ratio: { complete: 1, percent: 50, total: 2 },
        status: "overdue",
      },
      required_complete: 1,
      required_total: 2,
      status: "overdue",
    });
    expect(result.tasks.map(({ id }) => id)).toEqual([
      "task_one_overdue",
      "task_one_complete",
    ]);
    expect(result.sessions).toEqual([
      expect.objectContaining({
        co_speakers: ["Taylor Speaker"],
        id: "session_shared",
        schedule: {
          ends_at: "2026-08-18T18:45:00.000Z",
          room: "Main Hall",
          starts_at: "2026-08-18T18:00:00.000Z",
        },
      }),
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("rec_");
    expect(serialized).not.toContain("private/");
    expect(serialized).not.toContain("private-object-id");
    expect(serialized).not.toContain('"private"');
  });

  it("isolates tasks and assignments between speakers in the same event", async () => {
    const { portal } = await service();
    const result = await portal.bootstrap(
      speakerTwo,
      "open-session-summit",
      "req_bootstrap_two",
    );

    expect(result.portal_status).toBe("invited");
    expect(result.tasks.map(({ id }) => id)).toEqual(["task_two"]);
    expect(result.sessions.map(({ id }) => id)).toEqual([
      "session_shared",
      "session_two",
    ]);
    expect(JSON.stringify(result)).not.toContain("task_one_");
  });

  it("denies a generic organizer session and a foreign-event speaker", async () => {
    const { database, portal } = await service();

    await expect(
      portal.bootstrap(owner, "open-session-summit", "req_owner_denied"),
    ).rejects.toMatchObject({
      code: "portal_access_denied",
    });
    await expect(
      portal.bootstrap(
        foreignSpeaker,
        "open-session-summit",
        "req_foreign_denied",
      ),
    ).rejects.toMatchObject({
      code: "portal_access_denied",
    });

    const denied = await database
      .prepare(
        "SELECT action, actor_id FROM audit_events WHERE request_id = ?1",
      )
      .bind("req_foreign_denied")
      .first<{ action: string; actor_id: string }>();
    expect(denied).toEqual({
      action: "portal.access.denied",
      actor_id: "usr_foreign",
    });
  });

  it("fails closed immediately after the speaker relationship is revoked", async () => {
    const { database, portal } = await service();
    const first = await portal.bootstrap(
      speakerOne,
      "open-session-summit",
      "req_before_revoke",
    );
    expect(first.speaker.contact_id).toBe("contact_one");

    await database
      .prepare(
        "UPDATE p_event_contacts SET portal_state = 'revoked' WHERE id = 'event_contact_one'",
      )
      .run();
    await expect(
      portal.bootstrap(speakerOne, "open-session-summit", "req_after_revoke"),
    ).rejects.toMatchObject({
      code: "portal_access_denied",
    });
    await database
      .prepare(
        "UPDATE p_event_contacts SET portal_state = 'active' WHERE id = 'event_contact_one'",
      )
      .run();
  });

  it("returns an explicit no-assignment state without leaking another speaker", async () => {
    const { database, portal } = await service();
    const unassigned = session(
      "usr_unassigned",
      "unassigned@example.test",
      "Una Assigned",
    );
    await database
      .prepare(
        `INSERT INTO users
          (id, email_normalized, display_name, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)`,
      )
      .bind(
        unassigned.user.id,
        unassigned.user.email,
        unassigned.user.displayName,
        timestamp,
      )
      .run();

    const result = await portal.bootstrap(
      unassigned,
      "open-session-summit",
      "req_unassigned",
    );
    expect(result.readiness.status).toBe("not_configured");
    expect(result.tasks).toEqual([]);
    expect(result.sessions).toEqual([]);
  });

  it("fails closed when an event slug is not globally canonical", async () => {
    const { database, portal } = await service();
    await database
      .prepare(
        `UPDATE p_events SET slug = 'open-session-summit'
         WHERE id = 'evt_two'`,
      )
      .run();
    await expect(
      portal.bootstrap(speakerOne, "open-session-summit", "req_ambiguous_slug"),
    ).rejects.toMatchObject({
      code: "portal_projection_invalid",
    });
    await database
      .prepare(
        "UPDATE p_events SET slug = 'foreign-conference' WHERE id = 'evt_two'",
      )
      .run();
  });
});

function routeHeaders(cookie?: string): Record<string, string> {
  return {
    Accept: "application/json",
    ...(cookie ? { Cookie: cookie } : {}),
    "Content-Type": "application/json",
    Origin: origin,
    "Sec-Fetch-Site": "same-origin",
    "User-Agent": "OpenSession portal route test",
  };
}

function sessionCookie(label: string): string {
  return `__Host-opensession-session=portal-session-${label}-${"s".repeat(36)}`;
}

describe("speaker portal routes", () => {
  it("reads an incomplete reusable profile and enforces scoped command boundaries", async () => {
    const response = await server.fetch(
      "/api/portal/open-session-summit/profile",
      { headers: routeHeaders(sessionCookie("speaker_one")) },
    );
    expect(response.status).toBe(200);
    const profile = (await response.json()) as {
      fields: { bio: string; title: string };
      headshot: unknown;
      upload_context: {
        event_id: string;
        organization_id: string;
        owner_contact_id: string;
        replacement_file_id?: string;
      };
    };
    expect(profile.fields).toMatchObject({ bio: "", title: "" });
    expect(profile.headshot).toBeNull();
    expect(profile.upload_context).toMatchObject({
      event_id: "evt_one",
      organization_id: "org_one",
      owner_contact_id: "contact_one",
    });
    expect(profile.upload_context.replacement_file_id).toBeUndefined();

    const foreign = await server.fetch(
      "/api/portal/open-session-summit/profile",
      { headers: routeHeaders(sessionCookie("foreign")) },
    );
    expect(foreign.status).toBe(403);

    const csrfFailure = await server.fetch(
      "/api/portal/open-session-summit/profile/commands",
      {
        body: JSON.stringify({
          command_id: "profile_command_csrf",
          expected_version: 1,
          fields: {
            bio: "A complete biography.",
            bluesky_url: "",
            company: "Open Session",
            display_name: "Sam Speaker",
            headshot_alt: "",
            linkedin_url: "",
            pronouns: "",
            title: "Principal Engineer",
            website_url: "",
          },
          reuse_organization: true,
        }),
        headers: routeHeaders(sessionCookie("speaker_one")),
        method: "PUT",
      },
    );
    expect(csrfFailure.status).toBe(403);
    await expect(csrfFailure.json()).resolves.toMatchObject({
      error: { code: "invalid_csrf" },
    });
  });

  it("bootstraps the event repeatedly from an authenticated speaker session", async () => {
    const first = await server.fetch(
      "/api/portal/open-session-summit/bootstrap",
      { headers: routeHeaders(sessionCookie("speaker_one")) },
    );
    const second = await server.fetch(
      "/api/portal/open-session-summit/bootstrap",
      { headers: routeHeaders(sessionCookie("speaker_one")) },
    );
    const body = (await second.json()) as { tasks: { id: string }[] };

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers.get("Cache-Control")).toContain("no-store");
    expect(body).toMatchObject({
      event: { id: "evt_one", slug: "open-session-summit" },
      speaker: { contact_id: "contact_one" },
    });
    expect(body.tasks.map(({ id }: { id: string }) => id)).toEqual([
      "task_one_overdue",
      "task_one_complete",
    ]);
  });

  it("denies an organizer-only session and a foreign speaker at the route boundary", async () => {
    const organizer = await server.fetch(
      "/api/portal/open-session-summit/bootstrap",
      { headers: routeHeaders(sessionCookie("owner")) },
    );
    const foreign = await server.fetch(
      "/api/portal/open-session-summit/bootstrap",
      { headers: routeHeaders(sessionCookie("foreign")) },
    );

    expect(organizer.status).toBe(403);
    expect(foreign.status).toBe(403);
    await expect(foreign.json()).resolves.toMatchObject({
      error: { code: "portal_access_denied" },
    });
  });

  it("keeps public recovery enumeration-safe and throttles repeated resends", async () => {
    const database = (await server.getWorker<Env>().getEnv()).DB;
    const request = (email: string) =>
      server.fetch("/api/portal/open-session-summit/invitations", {
        body: JSON.stringify({
          email,
          turnstile_action: "sign_in",
          turnstile_token: "XXXX.DUMMY.TOKEN.XXXX",
        }),
        headers: routeHeaders(),
        method: "POST",
      });

    const firstResponse = await request("speaker-one@example.test");
    const knownResponse = await firstResponse.json();
    const responses = [firstResponse];
    for (let attempt = 1; attempt < 5; attempt += 1) {
      responses.push(await request("speaker-one@example.test"));
    }
    const unknown = await request("unknown-speaker@example.test");

    expect(responses.map(({ status }) => status)).toEqual([
      202, 202, 202, 202, 202,
    ]);
    expect(unknown.status).toBe(202);
    expect(await unknown.json()).toEqual(knownResponse);
    const links = await database
      .prepare(
        `SELECT redirect_path, browser_binding_hash
         FROM magic_link_tokens
         WHERE purpose = 'portal' AND email_normalized = ?1
         ORDER BY created_at`,
      )
      .bind("speaker-one@example.test")
      .all<{ browser_binding_hash: string | null; redirect_path: string }>();
    const activeGrant = await database
      .prepare(
        `SELECT COUNT(*) AS count FROM portal_grants
         WHERE organization_id = 'org_one' AND event_id = 'evt_one'
           AND contact_id = 'contact_one'
           AND consumed_at IS NULL AND revoked_at IS NULL`,
      )
      .first<{ count: number }>();
    expect(links.results).toHaveLength(3);
    expect(links.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          redirect_path: "/portal/open-session-summit",
        }),
      ]),
    );
    expect(
      links.results.every(
        ({ browser_binding_hash: binding }) => binding?.length === 64,
      ),
    ).toBe(true);
    expect(activeGrant?.count).toBe(1);
  });
});
