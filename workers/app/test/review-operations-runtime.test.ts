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
    "Review closes": "2026-08-28T00:00:00.000Z",
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
  await seedProvider("submission_participants", "participant_assigned", {
    Contact: [recordId("contacts", "contact_submitter")],
    "Is primary": true,
    Order: 1,
    Role: "speaker",
    Submission: [recordId("submissions", "submission_assigned")],
  });
  await seedProvider("submission_participants", "participant_unassigned", {
    Contact: [recordId("contacts", "contact_submitter")],
    "Is primary": true,
    Order: 1,
    Role: "speaker",
    Submission: [recordId("submissions", "submission_unassigned")],
  });
  await seedProvider("email_templates", "template_acceptance", {
    "Audience type": "speaker",
    "Body document JSON": JSON.stringify({
      blocks: [
        {
          text: "Your session {{session.title}} is accepted.",
          type: "paragraph",
        },
      ],
      previewText: "Your proposal has been accepted.",
    }),
    "Body HTML": "<p>Your session is accepted.</p>",
    "Body text": "Your session is accepted.",
    Event: [recordId("events", "event_alpha")],
    "Merge schema version": 1,
    Name: "Acceptance",
    "Reply to": "program@example.test",
    "Sender email": "notifications@example.test",
    "Sender name": "OpenSession",
    Status: "active",
    Subject: "Accepted: {{session.title}}",
    "Used merge fields JSON": JSON.stringify(["session.title"]),
    Version: 1,
  });
  await seedProvider("task_definitions", "task_acceptance_ack", {
    "Approval required": false,
    Description: "Acknowledge the speaker code of conduct.",
    Event: [recordId("events", "event_alpha")],
    "File policy JSON": "{}",
    "Form schema JSON": "{}",
    Name: "Code of conduct",
    "Required default": true,
    "Target rule JSON": JSON.stringify({ roles: ["speaker"] }),
    Type: "ack",
  });
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
      (
        (await own.json()) as {
          assignments: { assignment: { id: string } }[];
        }
      ).assignments,
    ).toEqual([
      expect.objectContaining({
        assignment: expect.objectContaining({ id: "assignment_existing" }),
      }),
    ]);

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
      (
        (await reviewer.json()) as {
          assignments: { assignment: { id: string } }[];
        }
      ).assignments,
    ).toEqual([
      expect.objectContaining({
        assignment: expect.objectContaining({ id: "assignment_new" }),
      }),
    ]);
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

  it("autosaves, submits exactly once, and reopens the preserved review draft", async () => {
    const initial = (await (
      await request(
        "/api/events/event_alpha/reviewer-assignments",
        reviewerOneAuth,
      )
    ).json()) as {
      assignments: {
        assignment: { id: string; sourceVersion: number; status: string };
      }[];
      event: { reviewDueAt: string | null };
    };
    const assignment = initial.assignments.find(
      ({ assignment: candidate }) => candidate.id === "assignment_existing",
    )?.assignment;
    expect(initial.event.reviewDueAt).toBe("2026-08-28T00:00:00.000Z");

    const saveCommand = {
      assignmentId: "assignment_existing",
      commandId: "command_review_draft",
      draft: {
        note: "Strong audience fit.",
        scores: [{ criterionId: "criterion_value", score: 4 }],
      },
      expectedVersion: assignment?.sourceVersion,
      type: "save_review_draft",
    };
    const saved = await request(
      "/api/events/event_alpha/reviewer-assignments/assignment_existing/commands",
      reviewerOneAuth,
      saveCommand,
    );
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      ok: true,
      result: { outcome: "applied", version: 2 },
    });
    const replay = await request(
      "/api/events/event_alpha/reviewer-assignments/assignment_existing/commands",
      reviewerOneAuth,
      saveCommand,
    );
    expect(await replay.json()).toMatchObject({
      ok: true,
      result: { outcome: "replayed", version: 2 },
    });

    const forbidden = await request(
      "/api/events/event_alpha/reviewer-assignments/assignment_existing/commands",
      reviewerTwoAuth,
      {
        ...saveCommand,
        commandId: "command_review_forbidden",
        expectedVersion: 2,
      },
    );
    expect(forbidden.status).toBe(404);

    const incomplete = await request(
      "/api/events/event_alpha/reviewer-assignments/assignment_existing/commands",
      reviewerOneAuth,
      {
        ...saveCommand,
        commandId: "command_review_incomplete",
        expectedVersion: 2,
        type: "submit_review",
      },
    );
    expect(incomplete.status).toBe(422);

    const submitCommand = {
      assignmentId: "assignment_existing",
      commandId: "command_review_submit",
      draft: {
        note: "Strong audience fit with concrete evidence.",
        scores: [
          { criterionId: "criterion_value", score: 4 },
          { criterionId: "criterion_evidence", score: 5 },
        ],
      },
      expectedVersion: 2,
      type: "submit_review",
    };
    const submitted = await request(
      "/api/events/event_alpha/reviewer-assignments/assignment_existing/commands",
      reviewerOneAuth,
      submitCommand,
    );
    expect(submitted.status).toBe(200);
    expect(await submitted.json()).toMatchObject({
      ok: true,
      result: { outcome: "applied", version: 3 },
    });
    const submittedReplay = await request(
      "/api/events/event_alpha/reviewer-assignments/assignment_existing/commands",
      reviewerOneAuth,
      submitCommand,
    );
    expect(await submittedReplay.json()).toMatchObject({
      ok: true,
      result: { outcome: "replayed", version: 3 },
    });
    const env = await runtime.getEnv();
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
         WHERE entity_id = 'assignment_existing'
           AND action = 'reviews.review.submit'`,
      ).first<{ count: number }>(),
    ).toEqual({ count: 1 });

    const reopenCommand = {
      assignmentId: "assignment_existing",
      commandId: "command_review_reopen",
      expectedVersion: 3,
      reason: "Clarify the evidence score before decisions.",
      type: "reopen_review",
    };
    const reopened = await request(
      "/api/events/event_alpha/review-operations/reviews/assignment_existing/commands",
      organizerAuth,
      reopenCommand,
    );
    expect(reopened.status).toBe(200);
    expect(await reopened.json()).toMatchObject({
      ok: true,
      result: { outcome: "applied", version: 4 },
    });
    const reopenReplay = await request(
      "/api/events/event_alpha/review-operations/reviews/assignment_existing/commands",
      organizerAuth,
      reopenCommand,
    );
    expect(await reopenReplay.json()).toMatchObject({
      ok: true,
      result: { outcome: "replayed", version: 4 },
    });

    const reopenedQueue = (await (
      await request(
        "/api/events/event_alpha/reviewer-assignments",
        reviewerOneAuth,
      )
    ).json()) as {
      assignments: {
        assignment: { id: string; status: string };
        draft: unknown;
        submittedAt: string | null;
      }[];
    };
    expect(reopenedQueue.assignments).toEqual([
      expect.objectContaining({
        assignment: expect.objectContaining({
          id: "assignment_existing",
          status: "in_progress",
        }),
        draft: submitCommand.draft,
        submittedAt: null,
      }),
    ]);
    const organizer = (await (
      await request("/api/events/event_alpha/review-operations", organizerAuth)
    ).json()) as {
      assignments: {
        audit: { action: string; reason?: string }[];
        id: string;
      }[];
    };
    expect(
      organizer.assignments.find(({ id }) => id === "assignment_existing")
        ?.audit,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "reviews.review.reopen",
          reason: reopenCommand.reason,
        }),
        expect.objectContaining({ action: "reviews.review.submit" }),
      ]),
    );
  });

  it("computes submitted-only evidence and records one auditable decision", async () => {
    const queue = (await (
      await request(
        "/api/events/event_alpha/reviewer-assignments",
        reviewerOneAuth,
      )
    ).json()) as {
      assignments: { assignment: { id: string; sourceVersion: number } }[];
    };
    const assignment = queue.assignments.find(
      ({ assignment }) => assignment.id === "assignment_existing",
    )?.assignment;
    const submit = await request(
      "/api/events/event_alpha/reviewer-assignments/assignment_existing/commands",
      reviewerOneAuth,
      {
        assignmentId: "assignment_existing",
        commandId: "command_decision_review_submit",
        draft: {
          note: "Strong evidence.",
          scores: [
            { criterionId: "criterion_value", score: 4 },
            { criterionId: "criterion_evidence", score: 5 },
          ],
        },
        expectedVersion: assignment?.sourceVersion,
        type: "submit_review",
      },
    );
    expect(submit.status, await submit.clone().text()).toBe(200);

    const privateRead = await request(
      "/api/events/event_alpha/decisions",
      reviewerOneAuth,
    );
    expect(privateRead.status).toBe(403);

    const before = await request(
      "/api/events/event_alpha/decisions",
      organizerAuth,
    );
    expect(before.status, await before.clone().text()).toBe(200);
    expect(await before.json()).toMatchObject({
      submissions: expect.arrayContaining([
        expect.objectContaining({
          aggregateScore: 4.4,
          decision: "undecided",
          id: "submission_assigned",
          reviews: [
            expect.objectContaining({
              note: "Strong evidence.",
              overallScore: 4.4,
              reviewer: "Riley Reviewer",
              status: "submitted",
            }),
          ],
        }),
      ]),
    });

    const command = {
      audience: "Primary speaker",
      commandId: "command_submission_accept",
      decision: "accepted",
      expectedVersion: 1,
      messageMode: "recorded_only",
      privateNote: "Anchor the reliability track.",
      reason: "Strong program fit",
      submissionId: "submission_assigned",
      template: null,
      type: "record_decision",
    };
    const applied = await request(
      "/api/events/event_alpha/decisions/submission_assigned/commands",
      organizerAuth,
      command,
    );
    expect(applied.status, await applied.clone().text()).toBe(200);
    expect(await applied.json()).toMatchObject({
      ok: true,
      result: {
        entityType: "submission",
        outcome: "applied",
        version: 2,
      },
    });
    const replay = await request(
      "/api/events/event_alpha/decisions/submission_assigned/commands",
      organizerAuth,
      command,
    );
    expect(await replay.json()).toMatchObject({
      ok: true,
      result: { outcome: "replayed", version: 2 },
    });
    const unauthorized = await request(
      "/api/events/event_alpha/decisions/submission_assigned/commands",
      reviewerTwoAuth,
      {
        ...command,
        commandId: "command_reviewer_forbidden",
        expectedVersion: 2,
      },
    );
    expect(unauthorized.status).toBe(403);

    const after = await request(
      "/api/events/event_alpha/decisions",
      organizerAuth,
    );
    expect(after.status, await after.clone().text()).toBe(200);
    const decided = (
      (await after.json()) as {
        submissions: {
          decision: string;
          history: unknown[];
          id: string;
        }[];
      }
    ).submissions.find(({ id }) => id === "submission_assigned");
    expect(decided).toMatchObject({ decision: "accepted" });
    expect(decided?.history).toEqual([
      expect.objectContaining({
        action: "accepted",
        actor: "Owen Organizer",
        commandId: command.commandId,
        messageMode: "recorded_only",
        privateNote: command.privateNote,
        reason: command.reason,
      }),
    ]);
  });

  it("resumes a post-commit acceptance failure without duplicating downstream effects", async () => {
    const command = {
      audience: "Primary speaker",
      commandId: "command_acceptance_injected_failure",
      decision: "accepted",
      expectedVersion: 1,
      messageMode: "send_queued",
      privateNote: "Exercise the durable workflow boundary.",
      reason: "Strong program fit",
      submissionId: "submission_unassigned",
      template: "Accepted · OpenSession Summit",
      type: "record_decision",
    } as const;
    let injected: unknown;
    try {
      await (
        await runtime.getExport()
      ).acceptWithInjectedFailure(command, "authority-commit:1");
    } catch (error) {
      injected = error;
    }
    expect(injected).toBeInstanceOf(Error);
    expect((injected as Error).message).toContain(
      "Injected acceptance failure",
    );
    const failedWorkspace = (await (
      await request("/api/events/event_alpha/decisions", organizerAuth)
    ).json()) as {
      submissions: {
        id: string;
        sideEffects: { errorCode: string; status: string } | null;
      }[];
    };
    expect(
      failedWorkspace.submissions.find(
        ({ id }) => id === "submission_unassigned",
      )?.sideEffects,
    ).toMatchObject({ errorCode: "Error", status: "failed" });

    const resumed = await (
      await runtime.getExport()
    ).acceptWithInjectedFailure(command);
    expect(resumed).toMatchObject({ outcome: "replayed", version: 2 });
    await (await runtime.getExport()).acceptWithInjectedFailure(command);
    const completedWorkspace = (await (
      await request("/api/events/event_alpha/decisions", organizerAuth)
    ).json()) as {
      submissions: {
        id: string;
        sideEffects: { errorCode: string | null; status: string } | null;
      }[];
    };
    expect(
      completedWorkspace.submissions.find(
        ({ id }) => id === "submission_unassigned",
      )?.sideEffects,
    ).toMatchObject({ errorCode: null, status: "complete" });

    const env = await runtime.getEnv();
    const session = await env.DB.prepare(
      `SELECT id FROM p_sessions
       WHERE organization_id = 'org_alpha' AND event_id = 'event_alpha'
         AND source_submission_id = 'submission_unassigned'
         AND source_deleted_at IS NULL`,
    ).all<{ id: string }>();
    expect(session.results).toHaveLength(1);
    const sessionId = session.results[0]?.id;
    const counts = await env.DB.batch<{ count: number }>([
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM p_session_participants
         WHERE session_id = ?1 AND source_deleted_at IS NULL`,
      ).bind(sessionId),
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM p_event_contacts
         WHERE organization_id = 'org_alpha' AND event_id = 'event_alpha'
           AND contact_id = 'contact_submitter' AND portal_state IN ('active', 'invited')
           AND source_deleted_at IS NULL`,
      ),
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM p_task_assignments
         WHERE organization_id = 'org_alpha' AND event_id = 'event_alpha'
           AND contact_id = 'contact_submitter' AND source_deleted_at IS NULL`,
      ),
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM provider_messages
         WHERE organization_id = 'org_alpha' AND event_id = 'event_alpha'
           AND contact_id = 'contact_submitter' AND kind = 'campaign'`,
      ),
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM outbox_events
         WHERE organization_id = 'org_alpha' AND event_id = 'event_alpha'
           AND aggregate_id = ?1 AND event_type = 'calendar.acceptance.requested'`,
      ).bind(sessionId),
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM workflow_runs
         WHERE organization_id = 'org_alpha' AND event_id = 'event_alpha'
           AND idempotency_key = 'decision-acceptance:v1:event_alpha:command_acceptance_injected_failure'
           AND status = 'complete'`,
      ),
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
         WHERE organization_id = 'org_alpha' AND event_id = 'event_alpha'
           AND command_id = 'command_acceptance_injected_failure'
           AND action = 'acceptance.email.queued'`,
      ),
    ]);
    expect(counts.map((result) => result.results[0]?.count)).toEqual([
      1, 1, 1, 2, 1, 1, 1,
    ]);
  });

  it("keeps waitlist and decline workflows free of onboarding side effects", async () => {
    await seedProvider("contacts", "contact_no_onboarding", {
      "Display name": "Nora Waitlist",
      "Email normalized": "nora@example.test",
      Organization: [recordId("organizations", "org_alpha")],
      "Social JSON": "{}",
    });
    await seedProvider("submissions", "submission_no_onboarding", {
      "Default reviewer group ID": "group_reliability",
      "Draft JSON": "{}",
      Event: [recordId("events", "event_alpha")],
      "Form version": 1,
      Form: [recordId("forms", "form_alpha")],
      "Friendly ID": "SUB-003",
      "Route key": "reliability",
      Status: "submitted",
      "Submitted at": timestamp,
      "Submitter contact": [recordId("contacts", "contact_no_onboarding")],
      Title: "A proposal without onboarding",
      Track: [recordId("tracks", "track_reliability")],
    });
    await seedProvider("submission_participants", "participant_no_onboarding", {
      Contact: [recordId("contacts", "contact_no_onboarding")],
      "Is primary": true,
      Order: 1,
      Role: "speaker",
      Submission: [recordId("submissions", "submission_no_onboarding")],
    });
    await (await runtime.getExport()).synchronize(["org_alpha"]);

    for (const [decision, expectedVersion] of [
      ["waitlisted", 1],
      ["declined", 2],
    ] as const) {
      const response = await request(
        "/api/events/event_alpha/decisions/submission_no_onboarding/commands",
        organizerAuth,
        {
          audience: "Primary speaker",
          commandId: `command_no_onboarding_${decision}`,
          decision,
          expectedVersion,
          messageMode: "recorded_only",
          privateNote: "No onboarding is permitted.",
          reason: "Limited program capacity",
          submissionId: "submission_no_onboarding",
          template: null,
          type: "record_decision",
        },
      );
      expect(response.status, await response.clone().text()).toBe(200);
    }

    const env = await runtime.getEnv();
    const counts = await env.DB.batch<{ count: number }>([
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM p_sessions
         WHERE source_submission_id = 'submission_no_onboarding'
           AND source_deleted_at IS NULL`,
      ),
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM p_event_contacts
         WHERE contact_id = 'contact_no_onboarding' AND source_deleted_at IS NULL`,
      ),
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM p_task_assignments
         WHERE contact_id = 'contact_no_onboarding' AND source_deleted_at IS NULL`,
      ),
    ]);
    expect(counts.map((result) => result.results[0]?.count)).toEqual([0, 0, 0]);
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
