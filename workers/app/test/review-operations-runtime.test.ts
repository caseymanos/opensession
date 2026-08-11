import {
  hashAirtableContent,
  managedAirtableContent,
  type AirtableFields,
  type AirtableTableKey,
} from "@sessionbox-killer/data/airtable/internal";
import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type * as ReviewOperationsRuntime from "./fixtures/review-operations-runtime";

import { sha256Hex } from "../src/auth/crypto";

const origin = "https://organizer.opensession.test";
const timestamp = "2026-08-11T12:00:00.000Z";
const future = "2027-08-11T12:00:00.000Z";
const baseKey = "local:appAuthorityFixture";
const criteria = [
  {
    guidance: "Assess audience value.",
    id: "criterion_value",
    label: "Audience value",
    weight: 60,
  },
  {
    guidance: "Assess concrete evidence.",
    id: "criterion_evidence",
    label: "Evidence",
    weight: 40,
  },
];
const rubricSnapshot = {
  criteria,
  id: "rubric_alpha",
  name: "Program quality",
  version: 2,
};

const server = createTestHarness({
  workers: [
    {
      configPath:
        "workers/app/test/fixtures/review-operations-runtime.wrangler.jsonc",
    },
    {
      configPath:
        "workers/app/test/fixtures/airtable-authority-mock.wrangler.jsonc",
    },
  ],
});
const runtime = server.getWorker<Env, typeof ReviewOperationsRuntime>(
  "opensession-review-operations-runtime",
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
  await seedProvider("events", "event_alpha", {
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
  await seedProvider("forms", "form_alpha", {
    "Edit after close": true,
    Event: [recordId("events", "event_alpha")],
    Name: "Call for proposals",
    Status: "published",
    Version: 1,
  });
  for (const [id, name, email] of [
    ["contact_submitter", "Priya Speaker", "priya@example.test"],
    ["contact_reviewer_one", "Riley Reviewer", "riley@example.test"],
    ["contact_reviewer_two", "Morgan Reviewer", "morgan@example.test"],
  ] as const) {
    await seedProvider("contacts", id, {
      "Display name": name,
      "Email normalized": email,
      Organization: [recordId("organizations", "org_alpha")],
      "Social JSON": "{}",
    });
  }
  for (const [id, contact] of [
    ["reviewer_one", "contact_reviewer_one"],
    ["reviewer_two", "contact_reviewer_two"],
  ] as const) {
    await seedProvider("event_contacts", id, {
      Contact: [recordId("contacts", contact)],
      Event: [recordId("events", "event_alpha")],
      "Portal state": "active",
      "Readiness projection JSON": "{}",
      Roles: ["reviewer"],
    });
  }
  await seedProvider("tracks", "track_reliability", {
    "CFP aliases JSON": "[]",
    "Default reviewer group ID": "group_reliability",
    Event: [recordId("events", "event_alpha")],
    Name: "Reliability",
    "Route key": "reliability",
    "Sort order": 1,
    "Submission track": "Reliability",
  });
  for (const [id, reference, title] of [
    ["submission_assigned", "SUB-001", "Reliable agents"],
    ["submission_unassigned", "SUB-002", "Durable workflows"],
  ] as const) {
    await seedProvider("submissions", id, {
      "Default reviewer group ID": "group_reliability",
      "Draft JSON": "{}",
      Event: [recordId("events", "event_alpha")],
      "Form version": 1,
      Form: [recordId("forms", "form_alpha")],
      "Friendly ID": reference,
      "Route key": "reliability",
      Status: "submitted",
      "Submitted at": timestamp,
      "Submitter contact": [recordId("contacts", "contact_submitter")],
      Title: title,
      Track: [recordId("tracks", "track_reliability")],
    });
  }
  await seedProvider("rubrics", "rubric_alpha", {
    "Criteria snapshot JSON": JSON.stringify(criteria),
    Event: [recordId("events", "event_alpha")],
    Name: "Program quality",
    Status: "active",
    Version: 2,
  });
  await seedProvider("reviewer_groups", "group_reliability", {
    Event: [recordId("events", "event_alpha")],
    "Member IDs JSON": JSON.stringify(["reviewer_one"]),
    Name: "Reliability reviewers",
    "Route key": "reliability",
    Status: "active",
  });
  await seedProvider("reviews", "assignment_existing", {
    "Assigned at": timestamp,
    Conflict: false,
    "Conflict note": "",
    "Reviewer group ID": "group_reliability",
    "Reviewer membership": [recordId("event_contacts", "reviewer_one")],
    "Rubric snapshot JSON": JSON.stringify(rubricSnapshot),
    "Rubric version": 2,
    "Scoring required": true,
    Status: "assigned",
    Submission: [recordId("submissions", "submission_assigned")],
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
  return { cookie: `__Host-opensession-session=${token}`, csrf };
}

function headers(authentication: { cookie: string; csrf: string }) {
  return {
    Cookie: authentication.cookie,
    "Content-Type": "application/json",
    Origin: origin,
    "Sec-Fetch-Site": "same-origin",
    "X-CSRF-Token": authentication.csrf,
  };
}

function request(
  path: string,
  authentication: { cookie: string; csrf: string },
  body?: unknown,
) {
  return runtime.fetch(`${origin}${path}`, {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: headers(authentication),
    method: body === undefined ? "GET" : "POST",
  });
}

let organizerAuth: { cookie: string; csrf: string };
let reviewerOneAuth: { cookie: string; csrf: string };
let reviewerTwoAuth: { cookie: string; csrf: string };

beforeAll(async () => {
  await server.listen();
  await runtime.applyD1Migrations("DB");
  const env = await runtime.getEnv();
  await env.DB.prepare(
    `INSERT INTO tenant_registry
      (organization_id, base_key, source_record_id, status, created_at, updated_at)
     VALUES ('org_alpha', ?1, ?2, 'active', ?3, ?3)`,
  )
    .bind(baseKey, recordId("organizations", "org_alpha"), timestamp)
    .run();
  await seedAuthorityRecords();
  await (await runtime.getExport()).synchronize(["org_alpha"]);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users
        (id, email_normalized, display_name, created_at, updated_at)
       VALUES
        ('user_organizer', 'organizer@example.test', 'Owen Organizer', ?1, ?1),
        ('user_reviewer_one', 'riley@example.test', 'Riley Reviewer', ?1, ?1),
        ('user_reviewer_two', 'morgan@example.test', 'Morgan Reviewer', ?1, ?1)`,
    ).bind(timestamp),
    env.DB.prepare(
      `INSERT INTO organization_memberships
        (id, organization_id, user_id, role, created_at, updated_at)
       VALUES ('membership_organizer', 'org_alpha', 'user_organizer', 'organizer', ?1, ?1)`,
    ).bind(timestamp),
    env.DB.prepare(
      `INSERT INTO event_memberships
        (id, organization_id, event_id, user_id, contact_id, role, created_at, updated_at)
       VALUES
        ('event_reviewer_one', 'org_alpha', 'event_alpha', 'user_reviewer_one', 'contact_reviewer_one', 'reviewer', ?1, ?1),
        ('event_reviewer_two', 'org_alpha', 'event_alpha', 'user_reviewer_two', 'contact_reviewer_two', 'reviewer', ?1, ?1)`,
    ).bind(timestamp),
  ]);
  organizerAuth = await seedSession("user_organizer", "organizer");
  reviewerOneAuth = await seedSession("user_reviewer_one", "reviewer-one");
  reviewerTwoAuth = await seedSession("user_reviewer_two", "reviewer-two");
}, 120_000);

afterAll(async () => server.close());

describe.sequential("review operations runtime", () => {
  it("returns unassigned routable proposals to organizers while scoping reviewer reads", async () => {
    const organizerResponse = await request(
      "/api/events/event_alpha/review-operations",
      organizerAuth,
    );
    expect(organizerResponse.status).toBe(200);
    const organizer = (await organizerResponse.json()) as {
      assignments: { id: string }[];
      proposals: { id: string }[];
    };
    expect(organizer.assignments.map(({ id }) => id)).toEqual([
      "assignment_existing",
    ]);
    expect(organizer.proposals.map(({ id }) => id)).toEqual([
      "submission_assigned",
      "submission_unassigned",
    ]);

    const own = await request(
      "/api/events/event_alpha/reviewer-assignments",
      reviewerOneAuth,
    );
    expect(own.status).toBe(200);
    expect(
      ((await own.json()) as { assignments: { id: string }[] }).assignments,
    ).toEqual([expect.objectContaining({ id: "assignment_existing" })]);

    const other = await request(
      "/api/events/event_alpha/reviewer-assignments",
      reviewerTwoAuth,
    );
    expect(other.status).toBe(200);
    expect(
      ((await other.json()) as { assignments: unknown[] }).assignments,
    ).toEqual([]);
  });

  it("enforces route membership and applies replay-safe group and assignment commands", async () => {
    const invalid = await request(
      "/api/events/event_alpha/review-operations/commands",
      organizerAuth,
      {
        assignmentId: "assignment_new",
        commandId: "command_invalid_membership",
        expectedVersion: 0,
        reviewerGroupId: "group_reliability",
        reviewerId: "reviewer_two",
        submissionId: "submission_unassigned",
        type: "assign_reviewer",
      },
    );
    expect(invalid.status).toBe(422);

    const groupCommand = {
      commandId: "command_add_group_member",
      expectedVersion: 1,
      groupId: "group_reliability",
      memberIds: ["reviewer_one", "reviewer_two"],
      name: "Reliability reviewers",
      routeKey: "reliability",
      status: "active",
      type: "upsert_group",
    };
    expect(
      (
        await request(
          "/api/events/event_alpha/review-operations/commands",
          organizerAuth,
          groupCommand,
        )
      ).status,
    ).toBe(200);

    const assignmentCommand = {
      assignmentId: "assignment_new",
      commandId: "command_assignment_new",
      expectedVersion: 0,
      reviewerGroupId: "group_reliability",
      reviewerId: "reviewer_two",
      submissionId: "submission_unassigned",
      type: "assign_reviewer",
    };
    const applied = await request(
      "/api/events/event_alpha/review-operations/commands",
      organizerAuth,
      assignmentCommand,
    );
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({
      ok: true,
      result: { outcome: "applied", version: 1 },
    });
    const replay = await request(
      "/api/events/event_alpha/review-operations/commands",
      organizerAuth,
      assignmentCommand,
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      ok: true,
      result: { outcome: "replayed", version: 1 },
    });
    const reviewer = await request(
      "/api/events/event_alpha/reviewer-assignments",
      reviewerTwoAuth,
    );
    expect(
      ((await reviewer.json()) as { assignments: { id: string }[] })
        .assignments,
    ).toEqual([expect.objectContaining({ id: "assignment_new" })]);
  });

  it("publishes a new rubric without reinterpreting existing assignment snapshots", async () => {
    const publish = await request(
      "/api/events/event_alpha/review-operations/commands",
      organizerAuth,
      {
        commandId: "command_publish_rubric",
        criteria: [
          { ...criteria[0], weight: 50 },
          { ...criteria[1], weight: 50 },
        ],
        expectedVersion: 1,
        name: "Program quality",
        rubricId: "rubric_alpha",
        type: "publish_rubric",
      },
    );
    expect(publish.status).toBe(200);
    const response = await request(
      "/api/events/event_alpha/review-operations",
      organizerAuth,
    );
    const body = (await response.json()) as {
      activeRubric: { version: number };
      assignments: {
        id: string;
        rubric: { criteria: unknown; version: number };
      }[];
    };
    expect(body.activeRubric.version).toBe(3);
    expect(body.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "assignment_existing",
          rubric: expect.objectContaining({ criteria, version: 2 }),
        }),
        expect.objectContaining({
          id: "assignment_new",
          rubric: expect.objectContaining({ criteria, version: 2 }),
        }),
      ]),
    );
  });

  it("records conflicts durably, removes scoring access, and exposes authoritative audit history", async () => {
    const operations = (await (
      await request("/api/events/event_alpha/review-operations", organizerAuth)
    ).json()) as { assignments: { id: string; sourceVersion: number }[] };
    const assignment = operations.assignments.find(
      ({ id }) => id === "assignment_new",
    );
    const hidden = await request(
      "/api/events/event_alpha/review-operations/commands",
      reviewerOneAuth,
      {
        assignmentId: "assignment_new",
        commandId: "command_conflict_hidden",
        expectedVersion: assignment?.sourceVersion,
        note: "Must not see another reviewer's assignment.",
        type: "disclose_conflict",
      },
    );
    expect(hidden.status).toBe(404);
    const conflict = await request(
      "/api/events/event_alpha/review-operations/commands",
      reviewerTwoAuth,
      {
        assignmentId: "assignment_new",
        commandId: "command_conflict_new",
        expectedVersion: assignment?.sourceVersion,
        note: "Prior collaborator",
        type: "disclose_conflict",
      },
    );
    expect(conflict.status).toBe(200);
    const organizer = (await (
      await request("/api/events/event_alpha/review-operations", organizerAuth)
    ).json()) as {
      assignments: {
        audit: { action: string }[];
        id: string;
        scoringRequired: boolean;
        status: string;
      }[];
    };
    expect(organizer.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          audit: expect.arrayContaining([
            expect.objectContaining({ action: "reviews.assignment.conflict" }),
            expect.objectContaining({ action: "reviews.assignment.create" }),
          ]),
          id: "assignment_new",
          scoringRequired: false,
          status: "conflict",
        }),
      ]),
    );
    const reviewer = await request(
      "/api/events/event_alpha/reviewer-assignments",
      reviewerTwoAuth,
    );
    expect(
      ((await reviewer.json()) as { assignments: unknown[] }).assignments,
    ).toEqual([]);
  });
});
