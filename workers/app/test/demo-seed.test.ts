import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { compileDemoSeed, resolveDemoSeedFields } from "../src/demo/compiler";
import { demoEventId, demoSeedSource } from "../src/demo/fixture";
import { requiredDemoTables } from "../src/demo/reset";
import type { DemoSeedEntity, DemoSeedSource } from "../src/demo/types";

function replaceEntity(
  source: DemoSeedSource,
  entityId: string,
  update: (entity: DemoSeedEntity) => DemoSeedEntity,
): DemoSeedSource {
  return {
    ...source,
    entities: source.entities.map((entity) =>
      entity.entityId === entityId ? update(entity) : entity,
    ),
  };
}

describe("deterministic demo seed compiler", () => {
  it("compiles the complete inspectable fixture to stable operations", async () => {
    const first = await compileDemoSeed(demoSeedSource);
    const second = await compileDemoSeed({
      ...demoSeedSource,
      assets: [...demoSeedSource.assets].reverse(),
      entities: [...demoSeedSource.entities].reverse(),
    });

    expect(second).toEqual(first);
    expect(first.digest).toBe(
      "00894df39f13e95e14822cda4c8ab3b67104087ff95027111c8e3e81b759e220",
    );
    expect(first.operations).toHaveLength(139);
    expect(first.snapshotId).toBe(`snapshot_${first.digest.slice(0, 24)}`);
    expect(first.operations.length).toBe(demoSeedSource.entities.length);
    const manifest = JSON.parse(
      readFileSync(
        resolve(process.cwd(), "workers/app/src/demo/seed-manifest.json"),
        "utf8",
      ),
    ) as {
      assetCount: number;
      digest: string;
      eventId: string;
      operationCount: number;
      organizationId: string;
      schemaVersion: number;
      seedVersion: number;
      snapshotId: string;
    };
    expect(manifest).toMatchObject({
      assetCount: first.assets.length,
      digest: first.digest,
      eventId: first.eventId,
      operationCount: first.operations.length,
      organizationId: first.organizationId,
      schemaVersion: 1,
      seedVersion: first.seedVersion,
      snapshotId: first.snapshotId,
    });
    expect(
      new Set(
        first.operations.map(({ templateOperationId }) => templateOperationId),
      ).size,
    ).toBe(first.operations.length);

    const operationIndex = new Map(
      first.operations.map(({ entityId }, index) => [entityId, index]),
    );
    for (const [index, operation] of first.operations.entries()) {
      expect(operation.templateOperationId).toBe(
        `demo_template_${first.digest.slice(0, 16)}_${String(index + 1).padStart(3, "0")}`,
      );
      expect("commandId" in operation).toBe(false);
      expect("expectedVersion" in operation).toBe(false);
      expect(operation.operation).toBe("demo.seed.upsert");
      for (const dependency of operation.dependencies) {
        expect(operationIndex.get(dependency)).toBeLessThan(index);
      }
    }
  });

  it("contains every promised demo state without live recipients", async () => {
    const plan = await compileDemoSeed(demoSeedSource);
    const counts = Object.groupBy(plan.operations, ({ table }) => table);
    const formFields = counts.form_fields ?? [];
    const formRules = counts.form_rules ?? [];
    const submissions = counts.submissions ?? [];
    const sessions = counts.sessions ?? [];
    const tracks = counts.tracks ?? [];
    const scheduledIds = new Set(
      (counts.schedule_slots ?? []).flatMap(({ dependencies }) =>
        dependencies.filter((id) => id.startsWith("session_")),
      ),
    );
    const emails = plan.operations.flatMap(({ fields }) =>
      Object.entries(fields)
        .filter(([name]) =>
          [
            "Email normalized",
            "Recipient email",
            "Reply to",
            "Sender email",
          ].includes(name),
        )
        .map(([, value]) => value),
    );

    expect(counts.rooms).toHaveLength(3);
    expect(counts.events?.[0]?.fields).toMatchObject({
      "CFP closes": "2026-08-22T00:00:00.000Z",
      End: "2026-10-15T00:00:00.000Z",
      Start: "2026-10-13T16:00:00.000Z",
      Venue: "Fort Mason Center · San Francisco",
    });
    expect(tracks).toHaveLength(4);
    expect(
      tracks.map(({ fields }) => ({
        aliases: JSON.parse(String(fields["CFP aliases JSON"])),
        defaultReviewerGroupId: fields["Default reviewer group ID"],
        routeKey: fields["Route key"],
        selection: fields["CFP selection"],
        submissionTrack: fields["Submission track"],
      })),
    ).toEqual([
      {
        aliases: [],
        defaultReviewerGroupId: "group-ai-engineering",
        routeKey: "ai-engineering",
        selection: "AI Engineering",
        submissionTrack: "AI Engineering",
      },
      {
        aliases: [],
        defaultReviewerGroupId: "group-evaluation",
        routeKey: "evaluation",
        selection: "Evaluation",
        submissionTrack: "Evaluation",
      },
      {
        aliases: [],
        defaultReviewerGroupId: "group-infrastructure",
        routeKey: "infrastructure",
        selection: "Infrastructure",
        submissionTrack: "Infrastructure",
      },
      {
        aliases: ["Track D", "Product · Track D"],
        defaultReviewerGroupId: "group-product",
        routeKey: "product-track-d",
        selection: "Product",
        submissionTrack: "Product · Track D",
      },
    ]);
    expect(counts.formats).toHaveLength(3);
    expect(new Set(counts.formats?.map(({ fields }) => fields.Name))).toEqual(
      new Set(["30-minute talk", "45-minute talk", "90-minute workshop"]),
    );
    expect(
      formFields
        .toSorted(
          (left, right) =>
            Number(left.fields.Order) - Number(right.fields.Order),
        )
        .map(({ fields }) => fields["Stable key"]),
    ).toEqual([
      "title",
      "abstract",
      "outcomes",
      "track",
      "format",
      "workshop_prerequisites",
    ]);
    expect(formRules).toHaveLength(2);
    expect(
      formRules
        .toSorted(
          (left, right) =>
            Number(left.fields.Order) - Number(right.fields.Order),
        )
        .map(({ fields }) => fields.Effect),
    ).toEqual(["show", "require"]);
    expect(
      formRules.every(
        ({ fields }) =>
          fields["Value JSON"] === JSON.stringify("90-minute workshop"),
      ),
    ).toBe(true);
    expect(submissions).toHaveLength(12);
    expect(
      submissions.every(
        ({ fields }) =>
          typeof fields["Route key"] === "string" &&
          typeof fields["Default reviewer group ID"] === "string" &&
          typeof fields["Draft JSON"] === "string",
      ),
    ).toBe(true);
    expect(new Set(submissions.map(({ fields }) => fields.Status))).toEqual(
      new Set([
        "accepted",
        "declined",
        "draft",
        "in_review",
        "submitted",
        "waitlisted",
        "withdrawn",
      ]),
    );
    expect(sessions).toHaveLength(6);
    expect(
      sessions.filter(({ entityId }) => !scheduledIds.has(entityId)),
    ).toHaveLength(2);
    expect(counts.email_templates).toHaveLength(6);
    expect(counts.sync_runs?.[0]?.fields.Status).toBe("failed");
    expect(plan.assets.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(["headshot", "slides"]),
    );
    expect(plan.assets).toHaveLength(4);
    expect(
      plan.assets.every(
        ({ contentDigest, sizeBytes }) =>
          /^[a-f0-9]{64}$/.test(contentDigest) && sizeBytes > 0,
      ),
    ).toBe(true);
    expect(plan.delivery).toEqual({ allowlist: [], mode: "sink" });
    expect(emails.length).toBeGreaterThan(0);
    expect(emails.every((address) => /\.invalid$/i.test(String(address)))).toBe(
      true,
    );
  });

  it("publishes exactly the reciprocal public-schedule speaker profiles", async () => {
    const plan = await compileDemoSeed(demoSeedSource);
    const counts = Object.groupBy(plan.operations, ({ table }) => table);
    const publishedSessionIds = new Set(
      (counts.sessions ?? [])
        .filter(
          ({ fields }) =>
            fields.Public === true && fields.Status === "published",
        )
        .map(({ entityId }) => entityId),
    );
    const scheduledSessionIds = new Set(
      (counts.schedule_slots ?? [])
        .filter(({ fields }) => fields["Published version"] === 3)
        .flatMap(({ dependencies }) =>
          dependencies.filter((id) => id.startsWith("session_")),
        ),
    );
    const reciprocalContactIds = new Set(
      (counts.session_participants ?? [])
        .filter(
          ({ dependencies, fields }) =>
            fields["Confirmed state"] === "confirmed" &&
            fields.Role === "speaker" &&
            dependencies.some(
              (id) =>
                publishedSessionIds.has(id) && scheduledSessionIds.has(id),
            ),
        )
        .flatMap(({ dependencies }) =>
          dependencies.filter((id) => id.startsWith("contact_")),
        ),
    );
    const publishedProfiles = (counts.contacts ?? []).filter(
      ({ fields }) => fields["Profile publication state"] === "published",
    );

    expect([...reciprocalContactIds].sort()).toEqual([
      "contact_speaker_01",
      "contact_speaker_02",
      "contact_speaker_03",
    ]);
    expect(publishedProfiles.map(({ entityId }) => entityId).sort()).toEqual(
      [...reciprocalContactIds].sort(),
    );
    expect(
      publishedProfiles.every(
        ({ fields }) =>
          typeof fields["Headshot alt text"] === "string" &&
          String(fields["Headshot alt text"]).length > 0 &&
          fields["Profile approved at"] === "2026-08-05T20:00:00.000Z" &&
          fields["Profile approved by"] === "system_demo_seed",
      ),
    ).toBe(true);
  });

  it("resolves stable entity links only after authority record IDs exist", async () => {
    const plan = await compileDemoSeed(demoSeedSource);
    const event = plan.operations.find(
      ({ entityId }) => entityId === demoEventId,
    );
    expect(event).toBeDefined();
    if (!event) return;

    expect(() => resolveDemoSeedFields(event.fields, new Map())).toThrow(
      "Missing Airtable record ID",
    );
    expect(
      resolveDemoSeedFields(
        event.fields,
        new Map([[demoSeedSource.organizationId, "recOrganization"]]),
      ),
    ).toMatchObject({ Organization: ["recOrganization"] });
  });

  it("fails closed on missing references and deliverable addresses", async () => {
    await expect(
      compileDemoSeed({
        ...demoSeedSource,
        entities: demoSeedSource.entities.filter(
          ({ entityId }) => entityId !== "contact_speaker_01",
        ),
      }),
    ).rejects.toThrow("references missing contact_speaker_01");

    const unsafe = replaceEntity(
      demoSeedSource,
      "contact_speaker_01",
      (contact) => ({
        ...contact,
        fields: {
          ...contact.fields,
          "Email normalized": "person@example.com",
        },
      }),
    );
    await expect(compileDemoSeed(unsafe)).rejects.toThrow(
      "must use a non-deliverable .invalid address",
    );

    await expect(
      compileDemoSeed({
        ...demoSeedSource,
        assets: [
          ...demoSeedSource.assets,
          {
            assetId: "asset_invalid_owner",
            contentBase64:
              "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAUElEQVR42u3PQQkAAAgEsItjGCPYP4cRfAuDFVhq+rUICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICFwWUZAAxFdbOLwAAAAASUVORK5CYII=",
            contentType: "image/png",
            kind: "headshot",
            license: "CC0-1.0",
            objectKey: `demo/${demoEventId}/headshots/invalid-owner.png`,
            ownerContactId: demoSeedSource.organizationId,
            synthetic: true,
          },
        ],
      }),
    ).rejects.toThrow("is not safely scoped");
  });

  it("rejects entities outside the single guarded demo root", async () => {
    const otherOrganizationId = "org_other_tenant";
    await expect(
      compileDemoSeed({
        ...demoSeedSource,
        entities: [
          ...demoSeedSource.entities,
          {
            entityId: otherOrganizationId,
            fields: { Name: "Other organization" },
            table: "organizations",
          },
          {
            entityId: "evt_non_demo",
            fields: {
              "Is demo": false,
              Name: "Non-demo event",
              Organization: [
                {
                  entityId: otherOrganizationId,
                  kind: "entity_reference",
                },
              ],
            },
            table: "events",
          },
        ],
      }),
    ).rejects.toThrow("exactly one target organization and event root");

    await expect(
      compileDemoSeed({
        ...demoSeedSource,
        entities: [
          ...demoSeedSource.entities,
          {
            entityId: "contact_unrelated",
            fields: {
              "Display name": "Unrelated contact",
              "Email normalized": "unrelated@demo.opensession.invalid",
              Organization: [
                {
                  entityId: demoSeedSource.organizationId,
                  kind: "entity_reference",
                },
              ],
            },
            table: "contacts",
          },
        ],
      }),
    ).rejects.toThrow("requires one exact target-event membership");
  });

  it("requires every persisted asset reference to resolve", async () => {
    const brokenHeadshot = replaceEntity(
      demoSeedSource,
      "contact_speaker_03",
      (contact) => ({
        ...contact,
        fields: {
          ...contact.fields,
          "Headshot object key": `demo/${demoEventId}/headshots/missing.png`,
        },
      }),
    );

    await expect(compileDemoSeed(brokenHeadshot)).rejects.toThrow(
      "references an invalid headshot asset",
    );

    const brokenSlides = replaceEntity(
      demoSeedSource,
      "assignment_speaker_01",
      (assignment) => ({
        ...assignment,
        fields: {
          ...assignment.fields,
          "File object IDs JSON": JSON.stringify(["asset_missing"]),
        },
      }),
    );
    await expect(compileDemoSeed(brokenSlides)).rejects.toThrow(
      "has invalid file asset references",
    );

    const wrongSlideOwner = replaceEntity(
      demoSeedSource,
      "assignment_speaker_01",
      (assignment) => ({
        ...assignment,
        fields: {
          ...assignment.fields,
          Contact: [
            {
              entityId: "contact_speaker_02",
              kind: "entity_reference",
            },
          ],
        },
      }),
    );
    await expect(compileDemoSeed(wrongSlideOwner)).rejects.toThrow(
      "has invalid file asset references",
    );

    await expect(
      compileDemoSeed({
        ...demoSeedSource,
        assets: demoSeedSource.assets.map((asset) =>
          asset.assetId === "asset_headshot_01"
            ? { ...asset, contentBase64: "bm90IGEgcG5n" }
            : asset,
        ),
      }),
    ).rejects.toThrow("content is not materializable");
  });

  it("makes the full RAL-34 capability gap explicit", async () => {
    const plan = await compileDemoSeed(demoSeedSource);

    expect(requiredDemoTables(plan)).toEqual(
      expect.arrayContaining([
        "events",
        "forms",
        "sessions",
        "schedule_slots",
        "task_assignments",
        "email_templates",
        "sync_runs",
      ]),
    );
  });
});
