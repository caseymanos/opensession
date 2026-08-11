import {
  hashAirtableContent,
  managedAirtableContent,
  type AirtableFields,
} from "@sessionbox-killer/data/airtable/internal";
import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sha256Hex } from "../src/auth/crypto";

const timestamp = "2026-08-11T12:00:00.000Z";
const hash = "a".repeat(64);
const server = createTestHarness({
  workers: [
    {
      configPath:
        "workers/app/test/fixtures/speaker-profile-runtime.wrangler.jsonc",
    },
    {
      configPath:
        "workers/app/test/fixtures/airtable-authority-mock.wrangler.jsonc",
    },
  ],
});
const runtime = server.getWorker<Env>("opensession-speaker-profile-runtime");
const provider = server.getWorker("opensession-airtable-authority-mock");
let origin = "";
const rawSession = "profile-runtime-session";
const rawCsrf = "profile-runtime-csrf";

function recordId(table: string, id: string): string {
  return `rec_${table}_${id}`;
}

async function seedProvider(
  table: "contacts" | "organizations",
  id: string,
  fields: AirtableFields,
): Promise<void> {
  const withLifecycle: AirtableFields = {
    ...fields,
    ID: id,
    "Created at": timestamp,
    "Last command hash": "",
    "Last command ID": "",
    "Source version": 1,
    "Updated at": timestamp,
  };
  withLifecycle["Applied content hash"] = await hashAirtableContent(
    managedAirtableContent(table, withLifecycle),
    1,
  );
  const response = await provider.fetch("https://airtable.test/test/seed", {
    body: JSON.stringify({
      fields: withLifecycle,
      recordId: recordId(table, id),
      table,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  expect(response.status).toBe(204);
}

function headers(options: { csrf?: boolean; origin?: string } = {}) {
  return {
    "Content-Type": "application/json",
    ...(options.csrf === false ? {} : { "X-CSRF-Token": rawCsrf }),
    Cookie: `__Host-opensession-session=${rawSession}`,
    Origin: options.origin ?? origin,
    "Sec-Fetch-Site": "same-origin",
  };
}

function saveBody(
  commandId: string,
  fields = "A complete biography.",
  expectedVersion = 1,
  headshotFileId?: string,
  headshotAlt = "",
) {
  return {
    command_id: commandId,
    expected_version: expectedVersion,
    fields: {
      bio: fields,
      bluesky_url: "",
      company: "Open Session",
      display_name: "Sam Speaker",
      headshot_alt: headshotAlt,
      linkedin_url: "",
      pronouns: "",
      title: "Principal Engineer",
      website_url: "",
    },
    ...(headshotFileId === undefined
      ? {}
      : { headshot_file_id: headshotFileId }),
    reuse_organization: true,
  };
}

function publicationBody(
  commandId: string,
  expectedVersion: number,
  state: "approved" | "published",
) {
  return { command_id: commandId, expected_version: expectedVersion, state };
}

function squarePng(): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  new DataView(bytes.buffer).setUint32(16, 1_200);
  new DataView(bytes.buffer).setUint32(20, 1_200);
  return bytes;
}

beforeAll(async () => {
  origin = (await server.listen()).url.origin;
  await runtime.applyD1Migrations("DB");
  const env = await runtime.getEnv();
  await seedProvider("organizations", "org_one", {
    "Default timezone": "UTC",
    Name: "Open Session",
    Slug: "open-session",
  });
  await seedProvider("contacts", "contact_one", {
    Bio: "Initial biography",
    Company: "Initial Company",
    "Display name": "Sam Speaker",
    "Email normalized": "speaker@example.test",
    Organization: [recordId("organizations", "org_one")],
    "Social JSON": "{}",
    Title: "Initial Title",
  });
  await env.DB.prepare(
    `INSERT INTO tenant_registry
        (organization_id, base_key, source_record_id, status, created_at, updated_at,
         authority_roster_version, authority_ready_at)
       VALUES (?, ?, ?, 'active', ?, ?, 1, ?)`,
  )
    .bind(
      "org_one",
      "appAuthorityFixture",
      "rec_organizations_org_one",
      timestamp,
      timestamp,
      timestamp,
    )
    .run();
  const seedSql = `
    INSERT INTO users
      (id, email_normalized, display_name, created_at, updated_at)
    VALUES ('user_speaker', 'speaker@example.test', 'Sam Speaker',
      '${timestamp}', '${timestamp}');
    INSERT INTO p_organizations
      (id, name, slug, default_timezone, source_record_id, source_version,
       source_content_hash, projected_at)
    VALUES ('org_one', 'Open Session', 'open-session', 'UTC',
      'rec_organizations_org_one', 1, '${hash}', '${timestamp}');
    INSERT INTO authority_source_records
      (base_key, provider_table_key, provider_record_id, entity_id,
       organization_id, event_id, source_version, source_content_hash,
       projected_at, source_deleted_at)
    VALUES ('local:appAuthorityFixture', 'organizations', 'rec_organizations_org_one',
      'org_one', 'org_one', NULL, 1, '${hash}', '${timestamp}', NULL);
    INSERT INTO organization_memberships
      (id, organization_id, user_id, role, created_at, updated_at)
    VALUES ('membership_speaker', 'org_one', 'user_speaker', 'owner',
      '${timestamp}', '${timestamp}');
    INSERT INTO p_events
      (id, organization_id, name, slug, timezone, starts_at, ends_at, status,
       brand_json, source_record_id, source_version, source_content_hash, projected_at)
    VALUES ('evt_one', 'org_one', 'Open Session', 'open-session', 'UTC',
      '2026-09-01T09:00:00.000Z', '2026-09-02T17:00:00.000Z', 'published', '{}',
      'rec_events_evt_one', 1, '${hash}', '${timestamp}');
    INSERT INTO p_contacts
      (id, organization_id, email_normalized, display_name, title, company, bio,
       social_json, source_record_id, source_version, source_content_hash, projected_at)
    VALUES ('contact_one', 'org_one', 'speaker@example.test', 'Sam Speaker',
      'Initial Title', 'Initial Company', 'Initial biography', '{}',
      'rec_contacts_contact_one', 1, '${hash}', '${timestamp}');
    INSERT INTO p_event_contacts
      (id, organization_id, event_id, contact_id, roles_json, portal_state,
       source_record_id, source_version, source_content_hash, projected_at)
    VALUES ('event_contact_one', 'org_one', 'evt_one', 'contact_one', '["speaker"]',
      'active', 'rec_event_contacts_one', 1, '${hash}', '${timestamp}');
    INSERT INTO auth_sessions
      (id, user_id, token_hash, created_at, expires_at, last_seen_at)
    VALUES ('auth_speaker', 'user_speaker', '${await sha256Hex(rawSession)}',
      '${timestamp}', '2099-01-01T00:00:00.000Z', '${timestamp}');
    INSERT INTO auth_session_secrets
      (session_id, csrf_token_hash, created_at)
    VALUES ('auth_speaker', '${await sha256Hex(rawCsrf)}', '${timestamp}');
  `;
  await env.DB.batch(
    seedSql
      .split(";")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((statement) => env.DB.prepare(`${statement};`)),
  );
});

afterAll(async () => {
  await server.close();
});

describe.sequential("speaker profile runtime", () => {
  it("saves, replays after a lost response, and rejects changed or stale commands", async () => {
    const path = "/api/portal/open-session/profile/commands";
    const first = await runtime.fetch(origin + path, {
      body: JSON.stringify(saveBody("profile_save_one")),
      headers: headers(),
      method: "PUT",
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      outcome: string;
      projection: string;
    };
    expect(firstBody.outcome).toBe("applied");
    expect(firstBody.projection).toBe("durable");

    const changed = await runtime.fetch(origin + path, {
      body: JSON.stringify(saveBody("profile_save_one", "Changed content")),
      headers: headers(),
      method: "PUT",
    });
    expect(changed.status).toBe(409);
    expect(
      ((await changed.json()) as { error: { code: string } }).error.code,
    ).toBe("profile_idempotency_conflict");

    const replay = await runtime.fetch(origin + path, {
      body: JSON.stringify(saveBody("profile_save_one")),
      headers: headers(),
      method: "PUT",
    });
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as {
      outcome: string;
      profile: { fields: { bio: string } };
    };
    expect(replayBody.outcome).toBe("replayed");
    expect(replayBody.profile.fields.bio).toBe("A complete biography.");
    const providerStats = (await (
      await provider.fetch("https://airtable.test/test/stats")
    ).json()) as { mutationCount: number };
    expect(providerStats.mutationCount).toBe(1);

    const stale = await runtime.fetch(origin + path, {
      body: JSON.stringify(saveBody("profile_save_stale")),
      headers: headers(),
      method: "PUT",
    });
    expect(stale.status).toBe(412);
    expect(
      ((await stale.json()) as { error: { code: string } }).error.code,
    ).toBe("profile_version_conflict");

    const afterStaleRead = await runtime.fetch(
      origin + "/api/portal/open-session/profile",
      { headers: headers(), method: "GET" },
    );
    expect(afterStaleRead.status).toBe(200);
    const afterStaleBody = (await afterStaleRead.json()) as {
      audit: { action: string }[];
    };
    expect(afterStaleBody.audit).toHaveLength(1);
    expect(afterStaleBody.audit[0]?.action).toBe("saved");

    const env = await runtime.getEnv();
    const receipts = await env.DB.prepare(
      "SELECT operation, status FROM idempotency_keys WHERE command_id = 'profile_save_one' ORDER BY operation",
    ).all<{ operation: string; status: string }>();
    expect(receipts.results).toEqual([
      { operation: "speaker_profile.receipt.save", status: "committed" },
      { operation: "speaker_profile.save", status: "committed" },
    ]);
    const projected = await env.DB.prepare(
      "SELECT source_version, bio, title FROM p_contacts WHERE id = 'contact_one'",
    ).first<{ source_version: number; bio: string; title: string }>();
    expect(projected).toEqual({
      bio: "A complete biography.",
      source_version: 2,
      title: "Principal Engineer",
    });
    const audit = await env.DB.prepare(
      "SELECT id, action, command_id FROM audit_events WHERE entity_id = 'contact_one' ORDER BY created_at, id",
    ).all();
    expect(
      audit.results.filter((row) => row.command_id === "profile_save_one"),
    ).toHaveLength(1);

    const invalidOrigin = await runtime.fetch(origin + path, {
      body: JSON.stringify(saveBody("profile_save_origin", "Origin body", 2)),
      headers: headers({ origin: "https://attacker.example" }),
      method: "PUT",
    });
    expect(invalidOrigin.status).toBe(403);
    expect(
      ((await invalidOrigin.json()) as { error: { code: string } }).error.code,
    ).toBe("invalid_origin");

    const foreignHeadshot = await runtime.fetch(origin + path, {
      body: JSON.stringify(
        saveBody(
          "profile_save_foreign_file",
          "Foreign file",
          2,
          "foreign_file",
          "Foreign file portrait",
        ),
      ),
      headers: headers(),
      method: "PUT",
    });
    expect(foreignHeadshot.status).toBe(422);
    expect(
      ((await foreignHeadshot.json()) as { error: { code: string } }).error
        .code,
    ).toBe("profile_headshot_invalid");

    const fileBytes = squarePng();
    const objectKey = "org_one/events/evt_one/headshots/headshot_one.png";
    const object = await env.UPLOADS.put(objectKey, fileBytes, {
      httpMetadata: { contentType: "image/png" },
    });
    await env.DB.prepare(
      `INSERT INTO file_objects (
         id, organization_id, event_id, owner_contact_id, uploaded_by_user_id,
         object_key, display_filename, declared_mime_type, detected_mime_type,
         byte_size, checksum_sha256, status, created_at, finalized_at, purpose,
         lineage_id, version_number, r2_version, r2_etag, updated_at
       ) VALUES (?, 'org_one', 'evt_one', 'contact_one', 'user_speaker', ?,
         'headshot.png', 'image/png', 'image/png', ?, ?, 'ready', ?, ?,
         'headshot', ?, 1, ?, ?, ?)`,
    )
      .bind(
        "headshot_one",
        objectKey,
        fileBytes.byteLength,
        "b".repeat(64),
        timestamp,
        timestamp,
        "headshot_one",
        object.version,
        object.etag,
        timestamp,
      )
      .run();

    const withHeadshot = await runtime.fetch(origin + path, {
      body: JSON.stringify(
        saveBody(
          "profile_save_headshot",
          "Headshot biography",
          2,
          "headshot_one",
          "Portrait of Sam Speaker",
        ),
      ),
      headers: headers(),
      method: "PUT",
    });
    expect(withHeadshot.status).toBe(200);
    const headshotBody = (await withHeadshot.json()) as {
      profile: {
        headshot: { id: string; version: number } | null;
        upload_context: { replacement_file_id?: string };
        version: number;
      };
    };
    expect(headshotBody.profile.headshot).toMatchObject({
      id: "headshot_one",
      version: 1,
    });
    expect(headshotBody.profile.upload_context.replacement_file_id).toBe(
      "headshot_one",
    );
    expect(headshotBody.profile.version).toBe(3);

    const approved = await runtime.fetch(
      origin + "/api/events/evt_one/speaker-profiles/contact_one/publication",
      {
        body: JSON.stringify(
          publicationBody("profile_approve_one", 3, "approved"),
        ),
        headers: headers(),
        method: "PUT",
      },
    );
    expect(approved.status).toBe(200);
    expect(
      ((await approved.json()) as { profile: { publication_state: string } })
        .profile.publication_state,
    ).toBe("approved");

    const publishWithoutSchedule = await runtime.fetch(
      origin + "/api/events/evt_one/speaker-profiles/contact_one/publication",
      {
        body: JSON.stringify(
          publicationBody("profile_publish_without_schedule", 4, "published"),
        ),
        headers: headers(),
        method: "PUT",
      },
    );
    expect(publishWithoutSchedule.status).toBe(503);
    expect(
      ((await publishWithoutSchedule.json()) as { error: { code: string } })
        .error.code,
    ).toBe("profile_projection_invalid");
  });

  it("publishes only confirmed speaker profiles and keeps the public allowlist", async () => {
    const env = await runtime.getEnv();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO p_contacts (
           id, organization_id, email_normalized, display_name, title, company,
           bio, social_json, profile_publication_state, source_record_id,
           source_version, source_content_hash, projected_at
         ) VALUES ('contact_moderator', 'org_one', 'moderator@example.test',
           'Moderator Only', 'Chair', 'Open Session', 'Private moderator bio',
           '{}', 'published', 'rec_contacts_moderator', 1, ?, ?)`,
      ).bind(hash, timestamp),
      env.DB.prepare(
        `INSERT INTO p_rooms (
           id, organization_id, event_id, name, capacity, sort_order,
           source_record_id, source_version, source_content_hash, projected_at
         ) VALUES ('room_one', 'org_one', 'evt_one', 'Main room', 100, 1,
           'rec_room_one', 1, ?, ?)`,
      ).bind(hash, timestamp),
      env.DB.prepare(
        `INSERT INTO p_sessions (
           id, organization_id, event_id, friendly_id, title, abstract, status,
           is_public, external_mapping_json, updated_at, source_record_id,
           source_version, source_content_hash, projected_at
         ) VALUES ('session_one', 'org_one', 'evt_one', 'session-one',
           'Speaker profile session', 'Public abstract', 'published', 1, '{}',
           ?, 'rec_session_one', 1, ?, ?)`,
      ).bind(timestamp, hash, timestamp),
      env.DB.prepare(
        `INSERT INTO p_schedule_slots (
           id, organization_id, event_id, session_id, room_id, starts_at,
           ends_at, version, published_version, source_record_id, source_version,
           source_content_hash, projected_at
         ) VALUES ('slot_one', 'org_one', 'evt_one', 'session_one', 'room_one',
           '2026-09-01T10:00:00.000Z', '2026-09-01T11:00:00.000Z', 1, 1,
           'rec_slot_one', 1, ?, ?)`,
      ).bind(hash, timestamp),
      env.DB.prepare(
        `INSERT INTO p_session_participants (
           id, organization_id, event_id, session_id, contact_id, role,
           sort_order, confirmed_state, source_record_id, source_version,
           source_content_hash, projected_at
         ) VALUES ('participant_speaker', 'org_one', 'evt_one', 'session_one',
           'contact_one', 'speaker', 1, 'confirmed', 'rec_participant_speaker',
           1, ?, ?),
         ('participant_moderator', 'org_one', 'evt_one', 'session_one',
           'contact_moderator', 'moderator', 2, 'confirmed',
           'rec_participant_moderator', 1, ?, ?)`,
      ).bind(hash, timestamp, hash, timestamp),
      env.DB.prepare(
        "UPDATE p_events SET published_version = 1 WHERE id = 'evt_one'",
      ),
    ]);

    const published = await runtime.fetch(
      origin + "/api/events/evt_one/speaker-profiles/contact_one/publication",
      {
        body: JSON.stringify(
          publicationBody("profile_publish_one", 4, "published"),
        ),
        headers: headers(),
        method: "PUT",
      },
    );
    expect(published.status).toBe(200);
    const publicResponse = await runtime.fetch(
      origin + "/api/v1/public/events/open-session/speakers",
    );
    expect(publicResponse.status).toBe(200);
    const publicBody = (await publicResponse.json()) as {
      speakers: {
        email?: string;
        headshot?: { url: string };
        name: string;
        sessionIds: string[];
      }[];
      sessions: { speakers: { name: string }[] }[];
    };
    expect(publicBody.speakers).toHaveLength(1);
    expect(publicBody.speakers[0]).toMatchObject({
      name: "Sam Speaker",
      sessionIds: ["session-one"],
    });
    expect(publicBody.speakers[0]?.email).toBeUndefined();
    expect(
      publicBody.speakers.some((speaker) => speaker.name === "Moderator Only"),
    ).toBe(false);
    expect(publicBody.sessions[0]?.speakers).toEqual([
      {
        company: "Open Session",
        name: "Sam Speaker",
        role: "Principal Engineer",
      },
    ]);
    const headshotUrl = publicBody.speakers[0]?.headshot?.url;
    expect(headshotUrl).toContain("headshot_one-1");
    const publicHeadshot = await runtime.fetch(origin + (headshotUrl ?? ""));
    expect(publicHeadshot.status).toBe(200);
    expect(publicHeadshot.headers.get("Content-Type")).toBe("image/png");
  });
});
