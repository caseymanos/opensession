import {
  hashAirtableContent,
  managedAirtableContent,
  type AirtableFields,
  type AirtableTableKey,
} from "@sessionbox-killer/data/airtable/internal";
import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type * as OrganizerSubmissionsRuntime from "./fixtures/organizer-submissions-runtime";

import { sha256Hex } from "../src/auth/crypto";

const origin = "https://organizer.opensession.test";
const timestamp = "2026-08-10T12:00:00.000Z";
const future = "2027-08-10T12:00:00.000Z";
const baseKey = "local:appAuthorityFixture";
const listProjectionTables = [
  "contacts",
  "event_contacts",
  "reviews",
  "review_scores",
  "submissions",
  "tracks",
] as const;

interface ProjectionWatermarkRow {
  base_key: string;
  committed_cursor: number | null;
  last_full_scan_at: string | null;
  last_full_scan_id: string | null;
  last_provider_time: string | null;
  last_transaction_number: number | null;
  organization_id: string;
  provider: string;
  table_key: string;
  updated_at: string;
}

const server = createTestHarness({
  workers: [
    {
      configPath:
        "workers/app/test/fixtures/organizer-submissions-runtime.wrangler.jsonc",
    },
    {
      configPath:
        "workers/app/test/fixtures/airtable-authority-mock.wrangler.jsonc",
    },
  ],
});
const runtime = server.getWorker<Env, typeof OrganizerSubmissionsRuntime>(
  "opensession-organizer-submissions-runtime",
);
const provider = server.getWorker("opensession-airtable-authority-mock");

function recordId(table: AirtableTableKey, id: string): string {
  return `rec_${table}_${id}`;
}

async function seedProvider(
  table: AirtableTableKey,
  id: string,
  content: AirtableFields,
): Promise<void> {
  const sourceVersion = 1;
  const fields: AirtableFields = {
    ...content,
    ID: id,
    "Created at": timestamp,
    "Last command hash": "a".repeat(64),
    "Last command ID": `seed_${id}`,
    "Source version": sourceVersion,
    "Updated at": timestamp,
  };
  fields["Applied content hash"] = await hashAirtableContent(
    managedAirtableContent(table, fields),
    sourceVersion,
  );
  const response = await provider.fetch("https://airtable.test/test/seed", {
    body: JSON.stringify({
      fields,
      recordId: recordId(table, id),
      table,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  expect(response.status).toBe(204);
}

async function seedAuthorityRecords(): Promise<void> {
  await seedProvider("organizations", "org_alpha", {
    "Default timezone": "UTC",
    Name: "Alpha Events",
    Slug: "alpha-events",
  });
  await seedProvider("organizations", "org_beta", {
    "Default timezone": "UTC",
    Name: "Beta Events",
    Slug: "beta-events",
  });
  await seedProvider("events", "evt_alpha", {
    "Brand JSON": "{}",
    "Is demo": true,
    Name: "OpenSession Summit",
    Organization: [recordId("organizations", "org_alpha")],
    "Published version": 0,
    "Schedule days JSON": "[]",
    "Schedule snap minutes": 15,
    "Schedule version": 0,
    Slug: "summit",
    Status: "open",
    Timezone: "UTC",
  });
  await seedProvider("events", "evt_beta", {
    "Brand JSON": "{}",
    "Is demo": false,
    Name: "Other Summit",
    Organization: [recordId("organizations", "org_beta")],
    "Published version": 0,
    "Schedule days JSON": "[]",
    "Schedule snap minutes": 15,
    "Schedule version": 0,
    Slug: "other-summit",
    Status: "open",
    Timezone: "UTC",
  });
  await seedProvider("forms", "form_alpha", {
    "Edit after close": true,
    Event: [recordId("events", "evt_alpha")],
    Name: "Call for proposals",
    Status: "published",
    Version: 2,
  });
  await seedProvider("forms", "form_beta", {
    "Edit after close": false,
    Event: [recordId("events", "evt_beta")],
    Name: "Other call for proposals",
    Status: "published",
    Version: 1,
  });
  await seedProvider("contacts", "contact_primary", {
    Company: "Reliable Systems",
    "Display name": "Priya Speaker",
    "Email normalized": "priya@example.test",
    Organization: [recordId("organizations", "org_alpha")],
    "Social JSON": "{}",
    Title: "Principal Engineer",
  });
  await seedProvider("contacts", "contact_reviewer", {
    "Display name": "Riley Reviewer",
    "Email normalized": "riley@example.test",
    Organization: [recordId("organizations", "org_alpha")],
    "Social JSON": "{}",
  });
  await seedProvider("contacts", "contact_beta", {
    "Display name": "Bailey Speaker",
    "Email normalized": "bailey@example.test",
    Organization: [recordId("organizations", "org_beta")],
    "Social JSON": "{}",
  });
  await seedProvider("event_contacts", "reviewer_membership", {
    Contact: [recordId("contacts", "contact_reviewer")],
    Event: [recordId("events", "evt_alpha")],
    "Portal state": "active",
    "Readiness projection JSON": "{}",
    Roles: ["reviewer"],
  });
  await seedProvider("tracks", "track_reliability", {
    "CFP aliases JSON": "[]",
    Event: [recordId("events", "evt_alpha")],
    Name: "Reliability",
    "Route key": "reliability",
    "Sort order": 1,
    "Submission track": "Reliability",
  });
  await seedProvider("tracks", "track_beta", {
    "CFP aliases JSON": "[]",
    Event: [recordId("events", "evt_beta")],
    Name: "Other",
    "Route key": "other",
    "Sort order": 1,
  });

  for (const [id, friendlyId, title, formVersion] of [
    ["submission_alpha", "SUB-002", "Durable agents in production", 2],
    ["submission_snapshot", "SUB-001", "Versioned answer snapshots", 1],
    ["submission_repair", "SUB-003", "Projection repair without loss", 2],
    ["submission_race", "SUB-004", "Concurrent organizer decisions", 2],
  ] as const) {
    await seedProvider("submissions", id, {
      "Default reviewer group ID": "reviewers_reliability",
      "Draft JSON": "{}",
      Event: [recordId("events", "evt_alpha")],
      "Form version": formVersion,
      Form: [recordId("forms", "form_alpha")],
      "Friendly ID": friendlyId,
      "Route key": "reliability",
      Status: "submitted",
      "Submitted at": timestamp,
      "Submitter contact": [recordId("contacts", "contact_primary")],
      Title: title,
      Track: [recordId("tracks", "track_reliability")],
    });
  }
  await seedProvider("submissions", "submission_beta", {
    "Draft JSON": "{}",
    Event: [recordId("events", "evt_beta")],
    "Form version": 1,
    Form: [recordId("forms", "form_beta")],
    "Friendly ID": "SUB-BETA",
    "Route key": "other",
    Status: "submitted",
    "Submitted at": timestamp,
    "Submitter contact": [recordId("contacts", "contact_beta")],
    Title: "Tenant-private proposal",
    Track: [recordId("tracks", "track_beta")],
  });
  await seedProvider("submission_answers", "answer_alpha_abstract", {
    "Field label snapshot": "What will organizers learn?",
    "Field stable key": "abstract",
    Order: 1,
    Submission: [recordId("submissions", "submission_alpha")],
    Type: "textarea",
    "Value JSON": JSON.stringify("A durable execution field guide."),
  });
  await seedProvider("submission_answers", "answer_alpha_file", {
    "Field label snapshot": "Private supporting file",
    "Field stable key": "private_file",
    Order: 2,
    Submission: [recordId("submissions", "submission_alpha")],
    Type: "file",
    "Value JSON": JSON.stringify({
      object_key: "org_alpha/secret.pdf",
      url: "https://private.example.test/secret.pdf",
    }),
  });
  await seedProvider("submission_answers", "answer_snapshot_v1", {
    "Field label snapshot": "Original v1 prompt",
    "Field stable key": "abstract",
    Order: 1,
    Submission: [recordId("submissions", "submission_snapshot")],
    Type: "textarea",
    "Value JSON": JSON.stringify("The immutable v1 answer."),
  });
  await seedProvider("submission_participants", "participant_alpha", {
    Contact: [recordId("contacts", "contact_primary")],
    "Is primary": true,
    Order: 1,
    Role: "Speaker",
    Submission: [recordId("submissions", "submission_alpha")],
  });
  await seedProvider("rubrics", "rubric_alpha", {
    Event: [recordId("events", "evt_alpha")],
    Name: "Program rubric",
    Status: "active",
  });
  await seedProvider("criteria", "criterion_alpha", {
    Guidance: "Assess practical depth.",
    Label: "Depth",
    Maximum: 5,
    Minimum: 1,
    Order: 1,
    Rubric: [recordId("rubrics", "rubric_alpha")],
    Weight: 1,
  });
  await seedProvider("reviews", "review_alpha", {
    Conflict: false,
    "Reviewer membership": [recordId("event_contacts", "reviewer_membership")],
    Status: "submitted",
    Submission: [recordId("submissions", "submission_alpha")],
    "Submitted at": timestamp,
  });
  await seedProvider("review_scores", "score_alpha", {
    Comment: "Strong operational detail.",
    Criterion: [recordId("criteria", "criterion_alpha")],
    "Numeric score": 4.5,
    Review: [recordId("reviews", "review_alpha")],
  });
}

async function seedSession(
  userId: string,
  label: string,
): Promise<{ cookie: string; csrf: string }> {
  const env = await runtime.getEnv();
  const token = `session-${label}-${"s".repeat(40)}`;
  const csrf = `csrf-${label}-${"c".repeat(40)}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO auth_sessions
        (id, user_id, token_hash, created_at, expires_at, last_seen_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?4)`,
    ).bind(`auth_${label}`, userId, await sha256Hex(token), timestamp, future),
    env.DB.prepare(
      `INSERT INTO auth_session_secrets
        (session_id, csrf_token_hash, created_at)
       VALUES (?1, ?2, ?3)`,
    ).bind(`auth_${label}`, await sha256Hex(csrf), timestamp),
  ]);
  return {
    cookie: `__Host-opensession-session=${token}`,
    csrf,
  };
}

function headers(
  authentication?: { cookie: string; csrf: string },
  options: { csrf?: boolean; origin?: string } = {},
) {
  return {
    ...(authentication ? { Cookie: authentication.cookie } : {}),
    ...(authentication && options.csrf !== false
      ? { "X-CSRF-Token": authentication.csrf }
      : {}),
    "Content-Type": "application/json",
    Origin: options.origin ?? origin,
    "Sec-Fetch-Site": "same-origin",
  };
}

function request(
  path: string,
  init: {
    body?: string;
    headers?: Record<string, string>;
    method?: string;
  } = {},
) {
  return runtime.fetch(`${origin}${path}`, init);
}

async function providerMutationCount(): Promise<number> {
  const response = await provider.fetch("https://airtable.test/test/stats");
  return ((await response.json()) as { mutationCount: number }).mutationCount;
}

let organizerAuth: { cookie: string; csrf: string };
let viewerAuth: { cookie: string; csrf: string };

beforeAll(async () => {
  await server.listen();
  await runtime.applyD1Migrations("DB");
  const env = await runtime.getEnv();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tenant_registry
        (organization_id, base_key, source_record_id, status,
         created_at, updated_at)
       VALUES
        ('org_alpha', ?1, ?2, 'active', ?3, ?3),
        ('org_beta', ?1, ?4, 'active', ?3, ?3)`,
    ).bind(
      baseKey,
      recordId("organizations", "org_alpha"),
      timestamp,
      recordId("organizations", "org_beta"),
    ),
  ]);
  await seedAuthorityRecords();
  const fixture = await runtime.getExport();
  await fixture.synchronize(["org_alpha", "org_beta"]);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE p_submissions SET updated_at = CASE id
         WHEN 'submission_alpha' THEN '2026-08-10T12:03:00.000Z'
         WHEN 'submission_repair' THEN '2026-08-10T12:02:00.000Z'
         WHEN 'submission_snapshot' THEN '2026-08-10T12:01:00.000Z'
         ELSE updated_at END
       WHERE organization_id = 'org_alpha'`,
    ),
    env.DB.prepare(
      `INSERT INTO users
        (id, email_normalized, display_name, created_at, updated_at)
       VALUES
        ('user_organizer', 'organizer@example.test', 'Owen Organizer', ?1, ?1),
        ('user_viewer', 'viewer@example.test', 'Vera Viewer', ?1, ?1)`,
    ).bind(timestamp),
    env.DB.prepare(
      `INSERT INTO organization_memberships
        (id, organization_id, user_id, role, created_at, updated_at)
       VALUES
        ('membership_organizer', 'org_alpha', 'user_organizer', 'organizer', ?1, ?1),
        ('membership_viewer', 'org_alpha', 'user_viewer', 'viewer', ?1, ?1)`,
    ).bind(timestamp),
  ]);
  organizerAuth = await seedSession("user_organizer", "organizer");
  viewerAuth = await seedSession("user_viewer", "viewer");
}, 120_000);

afterAll(async () => {
  await server.close();
});

describe.sequential("organizer submission runtime", () => {
  it("reauthorizes list reads and provides isolated indexed pagination and filters", async () => {
    expect((await request("/api/events/evt_alpha/submissions")).status).toBe(
      401,
    );
    expect(
      (
        await request("/api/events/evt_alpha/submissions", {
          headers: headers(viewerAuth),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/api/events/evt_beta/submissions", {
          headers: headers(organizerAuth),
        })
      ).status,
    ).toBe(403);

    const first = await request(
      "/api/events/summit/submissions?page_size=1&status=submitted&track=track_reliability",
      { headers: headers(organizerAuth) },
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      items: { id: string }[];
      nextCursor: string;
      projection: { state: string };
    };
    expect(firstBody.items).toHaveLength(1);
    expect(firstBody.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(firstBody.projection.state).toBe("current");
    const second = await request(
      `/api/events/evt_alpha/submissions?page_size=1&status=submitted&track=track_reliability&cursor=${firstBody.nextCursor}`,
      { headers: headers(organizerAuth) },
    );
    const secondBody = (await second.json()) as { items: { id: string }[] };
    expect(second.status).toBe(200);
    expect(secondBody.items[0]?.id).not.toBe(firstBody.items[0]?.id);

    const search = await request(
      "/api/events/evt_alpha/submissions?q=durable%20agents",
      { headers: headers(organizerAuth) },
    );
    expect(search.status).toBe(200);
    expect(
      ((await search.json()) as { items: { id: string }[] }).items,
    ).toEqual([expect.objectContaining({ id: "submission_alpha" })]);
    expect(
      (
        await request(
          "/api/events/evt_alpha/submissions?page_size=1&page_size=2",
          {
            headers: headers(organizerAuth),
          },
        )
      ).status,
    ).toBe(400);
  });

  it("fails projection freshness closed across missing, divergent, and retired-base watermarks", async () => {
    const env = await runtime.getEnv();
    const original = await env.DB.prepare(
      `SELECT * FROM projection_watermarks
       WHERE organization_id = 'org_alpha' AND provider = 'airtable'
         AND base_key = ?1
         AND table_key IN (${listProjectionTables.map((table) => `'${table}'`).join(", ")})
       ORDER BY table_key`,
    )
      .bind(baseKey)
      .all<ProjectionWatermarkRow>();
    expect(original.results).toHaveLength(listProjectionTables.length);

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE projection_watermarks SET updated_at = '2030-01-01T00:00:03.000Z'
         WHERE organization_id = 'org_alpha' AND provider = 'airtable'
           AND base_key = ?1
           AND table_key IN (${listProjectionTables.map((table) => `'${table}'`).join(", ")})`,
      ).bind(baseKey),
      env.DB.prepare(
        `UPDATE projection_watermarks SET updated_at = '2030-01-01T00:00:01.000Z'
         WHERE organization_id = 'org_alpha' AND provider = 'airtable'
           AND base_key = ?1 AND table_key = 'reviews'`,
      ).bind(baseKey),
      env.DB.prepare(
        `INSERT INTO projection_watermarks (
           organization_id, provider, base_key, table_key, last_full_scan_at,
           updated_at
         ) VALUES (
           'org_alpha', 'airtable', 'retired:appAuthorityFixture', 'reviews',
           '2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z'
         )`,
      ),
    ]);
    const divergent = (await (
      await request("/api/events/evt_alpha/submissions", {
        headers: headers(organizerAuth),
      })
    ).json()) as {
      projection: { asOf: string; reasons: string[]; state: string };
    };

    await env.DB.prepare(
      `DELETE FROM projection_watermarks
       WHERE organization_id = 'org_alpha' AND provider = 'airtable'
         AND base_key = ?1 AND table_key = 'reviews'`,
    )
      .bind(baseKey)
      .run();
    const missing = (await (
      await request("/api/events/evt_alpha/submissions", {
        headers: headers(organizerAuth),
      })
    ).json()) as {
      projection: { asOf: string; reasons: string[]; state: string };
    };

    await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM projection_watermarks
         WHERE organization_id = 'org_alpha' AND provider = 'airtable'
           AND base_key = 'retired:appAuthorityFixture'`,
      ),
      ...original.results.map((watermark) =>
        env.DB.prepare(
          `INSERT OR REPLACE INTO projection_watermarks (
             organization_id, provider, base_key, table_key, committed_cursor,
             last_transaction_number, last_provider_time, last_full_scan_id,
             last_full_scan_at, updated_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
        ).bind(
          watermark.organization_id,
          watermark.provider,
          watermark.base_key,
          watermark.table_key,
          watermark.committed_cursor,
          watermark.last_transaction_number,
          watermark.last_provider_time,
          watermark.last_full_scan_id,
          watermark.last_full_scan_at,
          watermark.updated_at,
        ),
      ),
    ]);

    expect(divergent.projection).toEqual(
      expect.objectContaining({
        asOf: "2030-01-01T00:00:01.000Z",
        reasons: [],
        state: "current",
      }),
    );
    expect(missing.projection).toEqual(
      expect.objectContaining({
        reasons: expect.arrayContaining(["upstream_rebuilding"]),
        state: "partial",
      }),
    );
  });

  it("returns immutable v1/v2 detail snapshots while redacting private file data", async () => {
    const current = await request(
      "/api/events/evt_alpha/submissions/submission_alpha",
      { headers: headers(organizerAuth) },
    );
    expect(current.status).toBe(200);
    const body = (await current.json()) as {
      answerSnapshot: {
        answers: {
          fieldKey: string;
          label: string;
          redacted: boolean;
          value: unknown;
        }[];
        formVersion: number;
      };
      participants: unknown[];
      reviews: { score: number; summary: string }[];
      submission: { reviews: { assigned: number; submitted: number } };
    };
    expect(body.answerSnapshot.formVersion).toBe(2);
    expect(body.answerSnapshot.answers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fieldKey: "abstract",
          label: "What will organizers learn?",
          redacted: false,
        }),
        expect.objectContaining({
          fieldKey: "private_file",
          redacted: true,
          value: null,
        }),
      ]),
    );
    expect(body.participants).toHaveLength(1);
    expect(body.submission.reviews).toEqual({
      assigned: 1,
      aggregateScore: 4.5,
      submitted: 1,
    });
    expect(body.reviews).toEqual([
      expect.objectContaining({
        score: 4.5,
        summary: "Strong operational detail.",
      }),
    ]);
    expect(JSON.stringify(body)).not.toContain("rec_");
    expect(JSON.stringify(body)).not.toContain("secret.pdf");

    const original = await request(
      "/api/events/evt_alpha/submissions/submission_snapshot",
      { headers: headers(organizerAuth) },
    );
    const originalBody = (await original.json()) as {
      answerSnapshot: {
        answers: { label: string; value: string }[];
        formVersion: number;
      };
    };
    expect(originalBody.answerSnapshot).toMatchObject({
      answers: [
        expect.objectContaining({
          label: "Original v1 prompt",
          value: "The immutable v1 answer.",
        }),
      ],
      formVersion: 1,
    });
    expect(
      (
        await request("/api/events/evt_alpha/submissions/submission_beta", {
          headers: headers(organizerAuth),
        })
      ).status,
    ).toBe(404);
  });

  it("enforces origin, JSON, CSRF, transitions, versions, and idempotency", async () => {
    const invalidOrigin = await request(
      "/api/events/evt_alpha/submissions/commands",
      {
        body: "{}",
        headers: headers(organizerAuth, { origin: "https://evil.test" }),
        method: "POST",
      },
    );
    expect(invalidOrigin.status).toBe(403);
    const invalidContentType = await request(
      "/api/events/evt_alpha/submissions/commands",
      {
        body: "{}",
        headers: {
          ...headers(organizerAuth),
          "Content-Type": "text/plain",
        },
        method: "POST",
      },
    );
    expect(invalidContentType.status).toBe(403);
    const oversized = await request(
      "/api/events/evt_alpha/submissions/commands",
      {
        body: JSON.stringify({ note: "x".repeat(17 * 1_024) }),
        headers: headers(organizerAuth),
        method: "POST",
      },
    );
    expect(oversized.status).toBe(413);
    const missingCsrf = await request(
      "/api/events/evt_alpha/submissions/commands",
      {
        body: JSON.stringify({
          commandId: "command_missing_csrf",
          expectedVersion: 1,
          reason: "Test",
          submissionId: "submission_alpha",
          type: "start_review",
        }),
        headers: headers(organizerAuth, { csrf: false }),
        method: "POST",
      },
    );
    expect(missingCsrf.status).toBe(403);
    const forbidden = await request(
      "/api/events/evt_alpha/submissions/commands",
      {
        body: JSON.stringify({
          commandId: "command_viewer_denied",
          expectedVersion: 1,
          reason: "Viewer must not mutate.",
          submissionId: "submission_repair",
          type: "start_review",
        }),
        headers: headers(viewerAuth),
        method: "POST",
      },
    );
    expect(forbidden.status).toBe(403);
    const crossTenant = await request(
      "/api/events/evt_alpha/submissions/commands",
      {
        body: JSON.stringify({
          commandId: "command_cross_tenant",
          expectedVersion: 1,
          reason: "Must stay within the event.",
          submissionId: "submission_beta",
          type: "start_review",
        }),
        headers: headers(organizerAuth),
        method: "POST",
      },
    );
    expect(crossTenant.status).toBe(404);

    const illegal = await request(
      "/api/events/evt_alpha/submissions/commands",
      {
        body: JSON.stringify({
          commandId: "command_illegal_reopen",
          expectedVersion: 1,
          reason: "No terminal state exists.",
          submissionId: "submission_snapshot",
          type: "reopen",
        }),
        headers: headers(organizerAuth),
        method: "POST",
      },
    );
    expect(illegal.status).toBe(422);

    const command = {
      commandId: "command_alpha_review",
      expectedVersion: 1,
      reason: "Initial eligibility check completed.",
      submissionId: "submission_alpha",
      type: "start_review",
    } as const;
    const before = await providerMutationCount();
    const applied = await request(
      "/api/events/evt_alpha/submissions/commands",
      {
        body: JSON.stringify(command),
        headers: headers(organizerAuth),
        method: "POST",
      },
    );
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({
      ok: true,
      result: {
        commandId: command.commandId,
        outcome: "applied",
        projection: "durable",
        status: "in_review",
        version: 2,
      },
    });
    const replay = await request("/api/events/evt_alpha/submissions/commands", {
      body: JSON.stringify(command),
      headers: headers(organizerAuth),
      method: "POST",
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      result: { outcome: "replayed", version: 2 },
    });
    expect(await providerMutationCount()).toBe(before + 1);

    const conflict = await request(
      "/api/events/evt_alpha/submissions/commands",
      {
        body: JSON.stringify({ ...command, reason: "Different request." }),
        headers: headers(organizerAuth),
        method: "POST",
      },
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: { code: "submission_idempotency_conflict" },
      ok: false,
    });
    const stale = await request("/api/events/evt_alpha/submissions/commands", {
      body: JSON.stringify({ ...command, commandId: "command_alpha_stale" }),
      headers: headers(organizerAuth),
      method: "POST",
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { actualVersion: 2, code: "submission_version_conflict" },
      ok: false,
    });

    const note = await request("/api/events/evt_alpha/submissions/commands", {
      body: JSON.stringify({
        body: "Keep this in the reliability review group.",
        commandId: "command_alpha_note",
        expectedVersion: 2,
        submissionId: "submission_alpha",
        type: "add_note",
      }),
      headers: headers(organizerAuth),
      method: "POST",
    });
    expect(note.status).toBe(200);
    expect(await note.json()).toMatchObject({
      result: {
        note: {
          actor: { displayName: "Owen Organizer", id: "user_organizer" },
          body: "Keep this in the reliability review group.",
          version: 1,
        },
        status: "in_review",
        version: 3,
      },
    });
    const detail = await request(
      "/api/events/evt_alpha/submissions/submission_alpha",
      { headers: headers(organizerAuth) },
    );
    expect(await detail.json()).toMatchObject({
      history: expect.arrayContaining([
        expect.objectContaining({
          action: "add_note",
          commandId: "command_alpha_note",
        }),
        expect.objectContaining({ action: "start_review" }),
      ]),
      notes: [
        expect.objectContaining({
          body: "Keep this in the reliability review group.",
        }),
      ],
    });
  });

  it("serializes concurrent lifecycle commands and reports the losing source version", async () => {
    const before = await providerMutationCount();
    const commands = ["first", "second"].map((suffix) => ({
      body: JSON.stringify({
        commandId: `command_race_${suffix}`,
        expectedVersion: 1,
        reason: `Concurrent organizer decision ${suffix}.`,
        submissionId: "submission_race",
        type: "start_review",
      }),
      headers: headers(organizerAuth),
      method: "POST",
    }));
    const responses = await Promise.all(
      commands.map((requestInit) =>
        request("/api/events/evt_alpha/submissions/commands", requestInit),
      ),
    );
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    const conflict = responses.find(({ status }) => status === 409);
    if (!conflict) throw new Error("Concurrent command conflict is missing.");
    expect(await conflict.json()).toMatchObject({
      error: {
        actualVersion: 2,
        code: "submission_version_conflict",
        expectedVersion: 1,
      },
      ok: false,
    });
    expect(await providerMutationCount()).toBe(before + 1);
  });

  it("resumes an outcome-unknown command after eviction without a second provider mutation", async () => {
    expect(
      (
        await provider.fetch(
          "https://airtable.test/test/ambiguous-invisible-next",
          { method: "POST" },
        )
      ).status,
    ).toBe(204);
    const command = {
      commandId: "command_snapshot_review",
      expectedVersion: 1,
      reason: "Ready for reviewer assignment.",
      submissionId: "submission_snapshot",
      type: "start_review",
    } as const;
    const before = await providerMutationCount();
    const unknown = await request(
      "/api/events/evt_alpha/submissions/commands",
      {
        body: JSON.stringify(command),
        headers: headers(organizerAuth),
        method: "POST",
      },
    );
    expect(unknown.status).toBe(503);
    await runtime.evictDurableObject("BASE_AUTHORITY", {
      name: "local:appAuthorityFixture",
    });
    expect(
      (
        await provider.fetch("https://airtable.test/test/reveal-records", {
          method: "POST",
        })
      ).status,
    ).toBe(204);
    const recovered = await request(
      "/api/events/evt_alpha/submissions/commands",
      {
        body: JSON.stringify(command),
        headers: headers(organizerAuth),
        method: "POST",
      },
    );
    const recoveredBody = await recovered.json();
    expect(recovered.status).toBe(200);
    expect(recoveredBody).toMatchObject({
      result: { outcome: "replayed", status: "in_review", version: 2 },
    });
    expect(await providerMutationCount()).toBe(before + 1);
  });

  it("reports partial projection state and repairs an authoritative command", async () => {
    const env = await runtime.getEnv();
    await env.DB.prepare(
      `CREATE TRIGGER fail_organizer_submission_projection
       BEFORE INSERT ON p_submissions
       WHEN NEW.id = 'submission_repair'
       BEGIN SELECT RAISE(ABORT, 'injected organizer projection failure'); END`,
    ).run();
    const applied = await request(
      "/api/events/evt_alpha/submissions/commands",
      {
        body: JSON.stringify({
          commandId: "command_projection_repair",
          expectedVersion: 1,
          reason: "Begin the repair-path review.",
          submissionId: "submission_repair",
          type: "start_review",
        }),
        headers: headers(organizerAuth),
        method: "POST",
      },
    );
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({
      result: { projection: "repair_pending", status: "in_review", version: 2 },
    });
    const partial = await request("/api/events/evt_alpha/submissions", {
      headers: headers(organizerAuth),
    });
    expect(await partial.json()).toMatchObject({
      projection: {
        pendingRepairs: 1,
        reasons: expect.arrayContaining(["repair_pending"]),
        state: "partial",
      },
    });
    await env.DB.prepare(
      "DROP TRIGGER fail_organizer_submission_projection",
    ).run();
    const fixture = await runtime.getExport();
    expect(await fixture.recoverPending()).toBeGreaterThanOrEqual(1);
    const projected = await env.DB.prepare(
      `SELECT status, source_version FROM p_submissions
       WHERE organization_id = 'org_alpha' AND event_id = 'evt_alpha'
         AND id = 'submission_repair'`,
    ).first();
    expect(projected).toEqual({ source_version: 2, status: "in_review" });
    const repaired = await request("/api/events/evt_alpha/submissions", {
      headers: headers(organizerAuth),
    });
    expect(await repaired.json()).toMatchObject({
      projection: { pendingRepairs: 0, state: "current" },
    });
  });
});
