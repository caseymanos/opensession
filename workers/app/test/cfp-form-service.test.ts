import {
  hashAirtableContent,
  managedAirtableContent,
  type AirtableFields,
  type AirtableTableKey,
} from "@sessionbox-killer/data/airtable/internal";
import {
  organizerCfpFormMutationResponseSchema,
  organizerCfpFormReadResponseSchema,
} from "@sessionbox-killer/contracts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";

const organizationId = "org_cfp_forms";
const eventId = "event_cfp_forms";
const publishedFormId = "form_cfp_forms_v1";

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
const runtimeWorker = server.getWorker<{ DB: D1Database }>(
  "opensession-airtable-authority-runtime",
);

function migrationStatements(): string[] {
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
    "0023_review_scoring.sql",
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

async function seed(
  table: AirtableTableKey,
  fields: AirtableFields,
): Promise<void> {
  const sourceVersion = 1;
  const contentHash = await hashAirtableContent(
    managedAirtableContent(table, fields),
    sourceVersion,
  );
  const response = await post("/seed-provider", {
    fields: {
      ...fields,
      "Applied content hash": contentHash,
      "Source version": sourceVersion,
    },
    table,
  });
  expect(response.status).toBe(204);
}

async function formService(
  action: "close" | "publish" | "read" | "save",
  request?: unknown,
  at?: string,
) {
  return post("/cfp-form-service", { action, at, eventId, request });
}

async function providerMutationCount(): Promise<number> {
  const response = await server.fetch("/provider-stats");
  return ((await response.json()) as { mutationCount: number }).mutationCount;
}

beforeAll(async () => {
  await server.listen();
  expect(
    (await post("/setup", { statements: migrationStatements() })).status,
  ).toBe(204);
  expect((await post("/allow-projection")).status).toBe(204);
  expect((await post("/setup-tenant", { organizationId })).status).toBe(204);

  await seed("organizations", {
    "Default timezone": "UTC",
    ID: organizationId,
    Name: "CFP Forms Organization",
    Slug: "cfp-forms-organization",
  });
  await seed("events", {
    "CFP closes": "2099-01-01T00:00:00.000Z",
    "CFP opens": "2000-01-01T00:00:00.000Z",
    "Brand JSON": "{}",
    ID: eventId,
    "Is demo": false,
    Name: "CFP Forms Event",
    Organization: [`rec_organizations_${organizationId}`],
    "Published version": 1,
    Slug: "cfp-forms-event",
    Status: "published",
    Timezone: "UTC",
  });
  await seed("forms", {
    "Edit after close": false,
    Event: [`rec_events_${eventId}`],
    ID: publishedFormId,
    Name: "Call for proposals",
    "Published at": "2026-08-01T00:00:00.000Z",
    Status: "published",
    "Submission limit": 3,
    Version: 1,
    "Welcome content": "Share a field-tested idea.",
  });
  for (const field of [
    {
      id: "field_cfp_forms_title",
      key: "title",
      label: "Session title",
      options: [],
      order: 1,
      required: true,
      type: "text",
      validation: { maxLength: 100, minLength: 8 },
    },
    {
      id: "field_cfp_forms_abstract",
      key: "abstract",
      label: "Abstract",
      options: [],
      order: 2,
      required: true,
      type: "textarea",
      validation: { maxLength: 1200, minLength: 20 },
    },
    {
      id: "field_cfp_forms_outcomes",
      key: "outcomes",
      label: "Attendee outcomes",
      options: [],
      order: 3,
      required: true,
      type: "textarea",
      validation: { maxLength: 1200, minLength: 10 },
    },
    {
      id: "field_cfp_forms_track",
      key: "track",
      label: "Track",
      options: ["Platform"],
      order: 4,
      required: true,
      type: "select",
      validation: {},
    },
    {
      id: "field_cfp_forms_format",
      key: "format",
      label: "Format",
      options: ["Talk"],
      order: 5,
      required: true,
      type: "select",
      validation: {},
    },
  ]) {
    await seed("form_fields", {
      "Block type": field.type,
      Form: [`rec_forms_${publishedFormId}`],
      ID: field.id,
      Label: field.label,
      "Options JSON": JSON.stringify(field.options),
      Order: field.order,
      Required: field.required,
      "Stable key": field.key,
      "Validation JSON": JSON.stringify(field.validation),
    });
  }
  await seed("tracks", {
    "CFP aliases JSON": "[]",
    "CFP selection": "Platform",
    "Default reviewer group ID": "reviewers_platform",
    Event: [`rec_events_${eventId}`],
    ID: "track_cfp_forms_platform",
    Name: "Platform",
    "Route key": "platform",
    "Sort order": 1,
    "Submission track": "Platform",
  });
  await seed("formats", {
    "Default duration minutes": 30,
    Event: [`rec_events_${eventId}`],
    ID: "format_cfp_forms_talk",
    Name: "Talk",
    "Sort order": 1,
  });
  const reconcile = await post("/reconcile", { organizationId });
  expect(reconcile.status, await reconcile.clone().text()).toBe(200);
}, 60_000);

afterAll(async () => {
  await server.close();
});

describe("authoritative CFP form service", () => {
  it("saves and publishes immutable, monotonic snapshots idempotently", async () => {
    const initialResponse = await formService("read");
    expect(initialResponse.status).toBe(200);
    const initial = organizerCfpFormReadResponseSchema.parse(
      await initialResponse.json(),
    );
    expect(initial.form).toMatchObject({
      id: publishedFormId,
      sourceVersion: 1,
      status: "published",
      version: 1,
    });

    const saveRequest = {
      commandId: "save_cfp_forms_v2",
      expectedFormId: initial.form.id,
      expectedSourceVersion: initial.form.sourceVersion,
      form: {
        editAfterClose: false,
        fields: initial.form.fields.map((field) =>
          field.key === "title"
            ? { ...field, label: "Session headline" }
            : field,
        ),
        name: initial.form.name,
        submissionLimit: initial.form.submissionLimit,
        welcomeContent: "Share the decisions behind the result.",
      },
    };
    const savedResponse = await formService("save", saveRequest);
    expect(savedResponse.status, await savedResponse.clone().text()).toBe(200);
    const saved = organizerCfpFormMutationResponseSchema.parse(
      await savedResponse.json(),
    );
    expect(saved).toMatchObject({
      outcome: "applied",
      result: { form: { status: "draft", version: 2 } },
    });
    expect(saved.result.form.id).not.toBe(publishedFormId);
    const mutationsAfterSave = await providerMutationCount();

    const replayResponse = await formService("save", saveRequest);
    expect(replayResponse.status).toBe(200);
    await expect(replayResponse.json()).resolves.toMatchObject({
      outcome: "replayed",
      result: { form: { id: saved.result.form.id, version: 2 } },
    });
    expect(await providerMutationCount()).toBe(mutationsAfterSave);

    const publishResponse = await formService(
      "publish",
      {
        commandId: "publish_cfp_forms_v2",
        expectedFormId: saved.result.form.id,
        expectedSourceVersion: saved.result.form.sourceVersion,
      },
      "2026-08-10T12:00:00.000Z",
    );
    expect(publishResponse.status, await publishResponse.clone().text()).toBe(
      200,
    );
    const published = organizerCfpFormMutationResponseSchema.parse(
      await publishResponse.json(),
    );
    expect(published).toMatchObject({
      outcome: "applied",
      result: {
        form: {
          id: saved.result.form.id,
          publishedAt: "2026-08-10T12:00:00.000Z",
          status: "published",
          version: 2,
        },
        publishedVersion: 2,
      },
    });
    const mutationsAfterPublish = await providerMutationCount();
    const publishReplay = await formService(
      "publish",
      {
        commandId: "publish_cfp_forms_v2",
        expectedFormId: saved.result.form.id,
        expectedSourceVersion: saved.result.form.sourceVersion,
      },
      "2026-08-10T12:00:00.000Z",
    );
    expect(publishReplay.status).toBe(200);
    await expect(publishReplay.json()).resolves.toMatchObject({
      outcome: "replayed",
      result: { form: { id: saved.result.form.id, status: "published" } },
    });
    expect(await providerMutationCount()).toBe(mutationsAfterPublish);

    const closeRequest = {
      commandId: "close_cfp_forms_v2",
      expectedFormId: published.result.form.id,
      expectedSourceVersion: published.result.form.sourceVersion,
    };
    const closeResponse = await formService("close", closeRequest);
    expect(closeResponse.status).toBe(200);
    await expect(closeResponse.json()).resolves.toMatchObject({
      outcome: "applied",
      result: { form: { id: saved.result.form.id, status: "closed" } },
    });
    const mutationsAfterClose = await providerMutationCount();
    const closeReplay = await formService("close", closeRequest);
    expect(closeReplay.status).toBe(200);
    await expect(closeReplay.json()).resolves.toMatchObject({
      outcome: "replayed",
      result: { form: { id: saved.result.form.id, status: "closed" } },
    });
    expect(await providerMutationCount()).toBe(mutationsAfterClose);

    const providerResponse = await server.fetch(
      "/provider-records?table=forms",
    );
    const forms = (await providerResponse.json()) as {
      fields: Record<string, unknown>;
      id: string;
    }[];
    expect(
      forms.find((form) => form.fields.ID === publishedFormId)?.fields,
    ).toMatchObject({
      Name: "Call for proposals",
      Status: "closed",
      Version: 1,
      "Welcome content": "Share a field-tested idea.",
    });
  });

  it("rejects a concurrent stale save before creating a second draft", async () => {
    const currentResponse = await formService("read");
    const current = organizerCfpFormReadResponseSchema.parse(
      await currentResponse.json(),
    );
    const request = (commandId: string, name: string) => ({
      commandId,
      expectedFormId: current.form.id,
      expectedSourceVersion: current.form.sourceVersion,
      form: {
        editAfterClose: current.form.editAfterClose,
        fields: current.form.fields,
        name,
        submissionLimit: current.form.submissionLimit,
        welcomeContent: current.form.welcomeContent,
      },
    });
    const responses = await Promise.all([
      formService("save", request("save_cfp_forms_v3_a", "CFP version A")),
      formService("save", request("save_cfp_forms_v3_b", "CFP version B")),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    const rejected = responses.find((response) => response.status === 409);
    await expect(rejected?.json()).resolves.toMatchObject({
      error: expect.stringMatching(
        /^CfpForm(?:PlanPrecondition|VersionConflict)Error$/,
      ),
    });
    const forcedStalePlan = {
      actorId: "usr_cfp_form_fixture",
      eventId,
      expectedFormId: current.form.id,
      expectedSourceVersion: current.form.sourceVersion,
      formId: "form_forced_stale_plan",
      items: [
        {
          entityId: "form_forced_stale_plan",
          expectedVersion: 0,
          fields: {
            "Edit after close": false,
            Event: {
              kind: "provider_record",
              recordId: `rec_events_${eventId}`,
            },
            Name: "Stale form",
            Status: "draft",
            Version: current.form.version + 1,
            "Welcome content": "This plan must never reach Airtable.",
          },
          itemKey: "form_snapshot",
          table: "forms",
        },
      ],
      mode: "save",
      operation: "cfp.form.persist",
      organizationId,
      planId: "cfp_form_plan_forced_stale",
      requestHash: "a".repeat(64),
    };
    const mutationsBeforeRejection = await providerMutationCount();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await post("/execute-cfp-form-plan", forcedStalePlan);
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: "CfpFormPlanPreconditionError",
      });
    }
    expect(await providerMutationCount()).toBe(mutationsBeforeRejection);
    await expect(
      (await server.fetch("/cfp-form-plan-states")).json(),
    ).resolves.toMatchObject({ complete: 4, rejected: 1 });
    const projected = organizerCfpFormReadResponseSchema.parse(
      await (await formService("read")).json(),
    );
    expect(projected.form).toMatchObject({ status: "draft", version: 3 });
    const providerResponse = await server.fetch(
      "/provider-records?table=forms",
    );
    const forms = (await providerResponse.json()) as {
      fields: Record<string, unknown>;
    }[];
    expect(forms.filter((form) => form.fields.Status === "draft")).toHaveLength(
      1,
    );
  });

  it("keeps public-runtime incompatibilities as precise draft diagnostics", async () => {
    const current = organizerCfpFormReadResponseSchema.parse(
      await (await formService("read")).json(),
    );
    const response = await formService("save", {
      commandId: "save_cfp_forms_file_diagnostic",
      expectedFormId: current.form.id,
      expectedSourceVersion: current.form.sourceVersion,
      form: {
        editAfterClose: current.form.editAfterClose,
        fields: [
          ...current.form.fields.map((field) =>
            field.key === "title" ? { ...field, required: false } : field,
          ),
          {
            helpText: "Optional supporting material.",
            id: "field_cfp_forms_supporting_file",
            key: "supporting_file",
            label: "Supporting file",
            options: [],
            order: current.form.fields.length + 1,
            required: false,
            rules: [],
            type: "file",
            validation: {},
          },
        ],
        name: current.form.name,
        submissionLimit: current.form.submissionLimit,
        welcomeContent: current.form.welcomeContent,
      },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const saved = organizerCfpFormMutationResponseSchema.parse(
      await response.json(),
    );
    expect(saved.result.publishable).toBe(false);
    expect(saved.result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "missing_title_field",
        fieldKey: "title",
      }),
    );
    expect(saved.result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "unsupported_public_field",
        fieldKey: "supporting_file",
        path: expect.stringMatching(/^fields\.field_[A-Za-z0-9_-]+\.type$/),
      }),
    );
  });

  it("reports malformed canonical routing metadata before publication", async () => {
    const environment = await runtimeWorker.getEnv();
    await environment.DB.prepare(
      `UPDATE p_tracks SET cfp_aliases_json = '[1]'
       WHERE organization_id = ?1 AND event_id = ?2`,
    )
      .bind(organizationId, eventId)
      .run();
    try {
      const response = await formService("read");
      expect(response.status).toBe(200);
      const current = organizerCfpFormReadResponseSchema.parse(
        await response.json(),
      );
      expect(current.publishable).toBe(false);
      expect(current.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "invalid_track_catalog",
          path: "event.tracks",
        }),
      );
    } finally {
      await environment.DB.prepare(
        `UPDATE p_tracks SET cfp_aliases_json = '[]'
         WHERE organization_id = ?1 AND event_id = ?2`,
      )
        .bind(organizationId, eventId)
        .run();
    }
  });
});
