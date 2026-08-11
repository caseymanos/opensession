import {
  hashAirtableContent,
  managedAirtableContent,
  type AirtableFields,
  type AirtableTableKey,
} from "@sessionbox-killer/data/airtable/internal";
import { createTestHarness } from "wrangler";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CfpSubmissionPlanInput } from "../src/cfp/submission-authority";
import { resumeOwnedCfpSubmission } from "../src/cfp/routes";
import type { FixtureBaseAuthority } from "./fixtures/airtable-authority-runtime";

const organizationId = "org_cfp_saga";
const eventId = "evt_cfp_saga";
const formId = "form_cfp_saga";
const trackId = "track_cfp_saga";
const contactId = "contact_cfp_saga";
const submissionId = "submission_cfp_saga";

const server = createTestHarness({
  workers: [
    {
      configPath:
        "workers/app/test/fixtures/airtable-authority-runtime.wrangler.jsonc",
    },
    {
      configPath:
        "workers/app/test/fixtures/airtable-authority-mock.wrangler.jsonc",
    },
  ],
});
const runtimeWorker = server.getWorker<{
  BASE_AUTHORITY: DurableObjectNamespace<FixtureBaseAuthority>;
}>("opensession-airtable-authority-runtime");

function readMigrationStatements(): string[] {
  const statements: string[] = [];
  for (const filename of [
    "0001_operational_foundation.sql",
    "0002_auth_security.sql",
    "0003_operational_observability.sql",
    "0003_private_uploads.sql",
    "0004_email_delivery.sql",
    "0005_auth_browser_binding.sql",
    "0006_authority_completion.sql",
    "0007_public_abuse_protection.sql",
    "0008_tenant_authority_readiness.sql",
    "0009_authority_cache_invalidation.sql",
    "0010_cache_invalidation_delivery.sql",
    "0011_cfp_authoritative_routing.sql",
    "0012_cfp_submission_reservations.sql",
    "0013_email_queue_handoff.sql",
    "0014_schedule_domain.sql",
    "0015_demo_bootstrap_authorization.sql",
    "0016_organizer_submissions.sql",
    "0017_campaign_delivery_product.sql",
    "0018_schedule_publication.sql",
    "0019_speaker_profiles.sql",
    "0020_versioned_cfp_forms.sql",
  ]) {
    const lines = readFileSync(
      resolve(process.cwd(), "migrations", filename),
      "utf8",
    ).split("\n");
    let current: string[] = [];
    let inTrigger = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("CREATE TRIGGER")) inTrigger = true;
      if (trimmed || current.length > 0) current.push(line);
      if (
        (!inTrigger && trimmed.endsWith(";")) ||
        (inTrigger && trimmed === "END;")
      ) {
        statements.push(current.join("\n").trim());
        current = [];
        inTrigger = false;
      }
    }
    if (current.some((line) => line.trim())) {
      throw new Error(`${filename} contains an unterminated statement.`);
    }
  }
  return statements;
}

async function post(path: string, body?: unknown) {
  return server.fetch(path, {
    method: "POST",
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        }),
  });
}

async function seedManagedRecord(
  table: AirtableTableKey,
  fields: AirtableFields,
): Promise<void> {
  const sourceVersion = 1;
  const sourceContentHash = await hashAirtableContent(
    managedAirtableContent(table, fields),
    sourceVersion,
  );
  const response = await post("/seed-provider", {
    fields: {
      ...fields,
      "Applied content hash": sourceContentHash,
      "Source version": sourceVersion,
    },
    table,
  });
  expect(response.status).toBe(204);
}

async function providerMutationCount(): Promise<number> {
  const response = await server.fetch("/provider-stats");
  return ((await response.json()) as { mutationCount: number }).mutationCount;
}

async function providerRecords(
  table: string,
): Promise<{ fields: AirtableFields; id: string }[]> {
  const response = await server.fetch(`/provider-records?table=${table}`);
  return (await response.json()) as { fields: AirtableFields; id: string }[];
}

async function evictAuthority(): Promise<void> {
  await runtimeWorker.evictDurableObject("BASE_AUTHORITY", {
    name: "local:appAuthorityFixture",
  });
}

function submissionPlan(): CfpSubmissionPlanInput {
  return {
    actorId: "usr_cfp_saga",
    eventId,
    items: [
      {
        entityId: contactId,
        expectedVersion: 0,
        fields: {
          "Display name": "Ada Speaker",
          "Email normalized": "ada@example.test",
          Organization: {
            kind: "provider_record",
            recordId: `rec_organizations_${organizationId}`,
          },
          "Social JSON": "{}",
        },
        itemKey: "primary_contact",
        table: "contacts",
      },
      {
        entityId: submissionId,
        expectedVersion: 0,
        fields: {
          "Default reviewer group ID": "reviewers_platform",
          "Draft JSON": JSON.stringify({
            answers: { title: "The durable edge" },
            participants: [contactId],
          }),
          Event: {
            kind: "provider_record",
            recordId: `rec_events_${eventId}`,
          },
          Form: {
            kind: "provider_record",
            recordId: `rec_forms_${formId}`,
          },
          "Form version": 3,
          "Friendly ID": "CFP-0042",
          "Route key": "platform",
          Status: "submitted",
          "Submitted at": "2026-08-10T09:30:00.000Z",
          "Submitter contact": {
            itemKey: "primary_contact",
            kind: "plan_item_record",
          },
          Title: "The durable edge",
          Track: {
            kind: "provider_record",
            recordId: `rec_tracks_${trackId}`,
          },
        },
        itemKey: "submission",
        table: "submissions",
      },
      {
        entityId: "answer_cfp_saga_title",
        expectedVersion: 0,
        fields: {
          "Field label snapshot": "Title",
          "Field stable key": "title",
          "Form version snapshot": 3,
          Order: 1,
          Submission: {
            itemKey: "submission",
            kind: "plan_item_record",
          },
          Type: "short_text",
          "Value JSON": JSON.stringify("The durable edge"),
        },
        itemKey: "answer_title",
        table: "submission_answers",
      },
      {
        entityId: "participant_cfp_saga_primary",
        expectedVersion: 0,
        fields: {
          Contact: {
            itemKey: "primary_contact",
            kind: "plan_item_record",
          },
          "Is primary": true,
          Order: 1,
          Role: "Speaker",
          Submission: {
            itemKey: "submission",
            kind: "plan_item_record",
          },
        },
        itemKey: "primary_participant",
        table: "submission_participants",
      },
    ],
    mode: "submit",
    operation: "cfp.submission.persist",
    organizationId,
    planId: "plan_cfp_saga_submit",
    requestHash: "a".repeat(64),
    submissionId,
  };
}

beforeAll(async () => {
  await server.listen();
  const setup = await post("/setup", { statements: readMigrationStatements() });
  expect(setup.status).toBe(204);
  expect((await post("/allow-projection")).status).toBe(204);
  expect((await post("/setup-tenant", { organizationId })).status).toBe(204);
  await seedManagedRecord("organizations", {
    "Default timezone": "UTC",
    ID: organizationId,
    Name: "CFP Saga Org",
    Slug: "cfp-saga-org",
  });
  await seedManagedRecord("events", {
    "Brand JSON": "{}",
    ID: eventId,
    "Is demo": false,
    Name: "CFP Saga Event",
    Organization: [`rec_organizations_${organizationId}`],
    "Published version": 1,
    Slug: "cfp-saga-event",
    Status: "open",
    Timezone: "UTC",
  });
  await seedManagedRecord("forms", {
    "Edit after close": true,
    Event: [`rec_events_${eventId}`],
    ID: formId,
    Name: "Call for proposals",
    Status: "published",
    Version: 3,
    "Welcome content": "Share your strongest idea.",
  });
  await seedManagedRecord("tracks", {
    "CFP aliases JSON": "[]",
    "CFP selection": "Platform engineering",
    "Default reviewer group ID": "reviewers_platform",
    Event: [`rec_events_${eventId}`],
    ID: trackId,
    Name: "Platform",
    "Route key": "platform",
    "Sort order": 1,
    "Submission track": "Platform",
  });
  const reconciled = await post("/reconcile", { organizationId });
  expect(reconciled.status, await reconciled.clone().text()).toBe(200);
}, 60_000);

afterAll(async () => {
  await server.close();
});

describe("CFP submission authority plan", () => {
  it("resumes after eviction without replaying a committed Airtable child", async () => {
    expect((await post("/arm-cfp-plan-checkpoint")).status).toBe(204);
    const first = await post("/execute-cfp-plan", submissionPlan());
    expect(first.status).toBe(409);
    await expect(first.json()).resolves.toMatchObject({
      error: "CfpSubmissionPlanInterruptionError",
    });
    expect(await providerMutationCount()).toBe(1);
    const interrupted = await server.fetch(
      `/inspect-cfp-plan?organizationId=${organizationId}&planId=plan_cfp_saga_submit`,
    );
    await expect(interrupted.json()).resolves.toMatchObject({
      completedItems: 0,
      itemCount: 4,
      state: "applying",
    });

    await evictAuthority();
    const resumed = await post("/execute-cfp-plan", submissionPlan());
    expect(resumed.status, await resumed.clone().text()).toBe(200);
    await expect(resumed.json()).resolves.toEqual({
      itemCount: 4,
      mode: "submit",
      outcome: "applied",
      planId: "plan_cfp_saga_submit",
      providerRecordId: `rec_submissions_${submissionId}`,
      sourceVersion: 1,
      submissionId,
    });
    expect(await providerMutationCount()).toBe(4);

    const replay = await post("/execute-cfp-plan", submissionPlan());
    await expect(replay.json()).resolves.toMatchObject({ outcome: "replayed" });
    expect(await providerMutationCount()).toBe(4);
    const resumedReplay = await post("/resume-cfp-plan", {
      organizationId,
      planId: "plan_cfp_saga_submit",
      requestHash: "a".repeat(64),
    });
    await expect(resumedReplay.json()).resolves.toMatchObject({
      outcome: "replayed",
    });
    const environment = await runtimeWorker.getEnv();
    const acceptedReplay = await resumeOwnedCfpSubmission(
      environment.BASE_AUTHORITY.getByName("local:appAuthorityFixture"),
      organizationId,
      {
        friendlyId: "CFP-0042",
        planId: "plan_cfp_saga_submit",
        requestHash: "a".repeat(64),
        submissionId,
      },
      "accepted",
    );
    expect(acceptedReplay).toMatchObject({
      kind: "replay",
      receipt: { outcome: "replayed", submissionId },
    });
    expect(await providerMutationCount()).toBe(4);
    const mismatchedReplay = await post("/resume-cfp-plan", {
      organizationId,
      planId: "plan_cfp_saga_submit",
      requestHash: "b".repeat(64),
    });
    expect(mismatchedReplay.status).toBe(409);
    await expect(mismatchedReplay.json()).resolves.toMatchObject({
      error: "CfpSubmissionPlanIdempotencyConflictError",
    });
    expect(await providerMutationCount()).toBe(4);
    const complete = await server.fetch(
      `/inspect-cfp-plan?organizationId=${organizationId}&planId=plan_cfp_saga_submit`,
    );
    await expect(complete.json()).resolves.toMatchObject({
      completedItems: 4,
      state: "complete",
    });

    const contact = (await providerRecords("contacts"))[0];
    const submission = (await providerRecords("submissions"))[0];
    const answer = (await providerRecords("submission_answers"))[0];
    const participant = (await providerRecords("submission_participants"))[0];
    expect(submission?.fields).toMatchObject({
      Event: [`rec_events_${eventId}`],
      Form: [`rec_forms_${formId}`],
      "Submitter contact": [contact?.id],
      Track: [`rec_tracks_${trackId}`],
    });
    expect(answer?.fields.Submission).toEqual([submission?.id]);
    expect(participant?.fields).toMatchObject({
      Contact: [contact?.id],
      Submission: [submission?.id],
    });

    const clearTitlePlan = {
      ...submissionPlan(),
      items: submissionPlan().items.map((item) => ({
        ...item,
        expectedVersion: 1,
        fields:
          item.table === "contacts"
            ? { ...item.fields, Title: null }
            : item.fields,
      })),
      planId: "plan_cfp_saga_clear_title",
      requestHash: "c".repeat(64),
    } satisfies CfpSubmissionPlanInput;
    const cleared = await post("/execute-cfp-plan", clearTitlePlan);
    expect(cleared.status, await cleared.clone().text()).toBe(200);
    expect(await providerMutationCount()).toBe(8);
    expect((await providerRecords("contacts"))[0]?.fields.Title).toBeNull();
  });

  it("fails closed on plan reuse, unsafe fields, and incomplete final routing", async () => {
    const changed = submissionPlan();
    const submission = changed.items.find(
      (item) => item.table === "submissions",
    );
    if (!submission) throw new Error("Fixture submission item is missing.");
    const conflict = await post("/execute-cfp-plan", {
      ...changed,
      items: changed.items.map((item) =>
        item === submission
          ? { ...item, fields: { ...item.fields, Title: "Changed title" } }
          : item,
      ),
    });
    await expect(conflict.json()).resolves.toMatchObject({
      error: "CfpSubmissionPlanIdempotencyConflictError",
    });

    const unsafe = await post("/execute-cfp-plan", {
      ...submissionPlan(),
      planId: "plan_cfp_saga_unsafe",
      items: submissionPlan().items.map((item) =>
        item.table === "submissions"
          ? { ...item, fields: { ...item.fields, "Decision note": "override" } }
          : item,
      ),
    });
    await expect(unsafe.json()).resolves.toMatchObject({ error: "TypeError" });

    const incomplete = submissionPlan();
    const withoutRoute = await post("/execute-cfp-plan", {
      ...incomplete,
      planId: "plan_cfp_saga_incomplete",
      items: incomplete.items.map((item) => {
        if (item.table !== "submissions") return item;
        const fields = { ...item.fields };
        Reflect.deleteProperty(fields, "Route key");
        return { ...item, fields };
      }),
    });
    await expect(withoutRoute.json()).resolves.toMatchObject({
      error: "TypeError",
    });

    const detached = submissionPlan();
    const detachedAnswer = await post("/execute-cfp-plan", {
      ...detached,
      planId: "plan_cfp_saga_detached",
      items: detached.items.map((item) =>
        item.table === "submission_answers"
          ? {
              ...item,
              fields: {
                ...item.fields,
                Submission: {
                  kind: "provider_record",
                  recordId: "rec_submissions_some_other_submission",
                },
              },
            }
          : item,
      ),
    });
    await expect(detachedAnswer.json()).resolves.toMatchObject({
      error: "TypeError",
    });
    expect(await providerMutationCount()).toBe(8);
  });
});
