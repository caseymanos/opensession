import {
  hashAirtableContent,
  hashAirtableValue,
  managedAirtableContent,
  type AirtableFields,
  type AirtableTableKey,
} from "@sessionbox-killer/data/airtable/internal";
import { createTestHarness } from "wrangler";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compileDemoSeed, resolveDemoSeedFields } from "../src/demo/compiler";
import {
  demoEventId,
  demoOrganizationId,
  demoSeedSource,
} from "../src/demo/fixture";
import type { CompiledDemoSeed } from "../src/demo/types";
import type FixtureAuthorityRuntime from "./fixtures/airtable-authority-runtime";
import type { FixtureBaseAuthority } from "./fixtures/airtable-authority-runtime";
import type { FixtureAirtableState } from "./fixtures/airtable-authority-mock";

const server = createTestHarness({
  workers: [
    {
      configPath:
        "workers/app/test/fixtures/airtable-authority-completion-runtime.wrangler.jsonc",
    },
    {
      configPath:
        "workers/app/test/fixtures/airtable-authority-completion-mock.wrangler.jsonc",
    },
  ],
});
const runtimeWorker = server.getWorker<
  {
    BASE_AUTHORITY: DurableObjectNamespace<FixtureBaseAuthority>;
  },
  { default: typeof FixtureAuthorityRuntime }
>("opensession-airtable-authority-completion-runtime");
const mockWorker = server.getWorker<{
  STATE: DurableObjectNamespace<FixtureAirtableState>;
}>("opensession-airtable-authority-completion-mock");
let runtimeFixture: Awaited<ReturnType<typeof runtimeWorker.getExport>>;

async function fixtureFetch(
  path: string,
  init: {
    body?: string;
    headers?: Record<string, string>;
    method?: string;
  } = {},
): Promise<Response> {
  const response = await runtimeFixture.fetch(
    new URL(path, "http://fixture.invalid").toString(),
    init,
  );
  const body = await response.arrayBuffer();
  return new Response(body.byteLength === 0 ? null : body, {
    headers: response.headers,
    status: response.status,
  });
}

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
    if (current.some((line) => line.trim()))
      throw new Error(`${filename} is incomplete.`);
  }
  return statements;
}

async function post(path: string, body?: unknown) {
  if (path === "/mutate-provider") {
    const environment = await mockWorker.getEnv();
    const mutated =
      await environment.STATE.getByName("singleton").mutateForTest(body);
    return new Response(null, { status: mutated ? 204 : 404 });
  }
  return fixtureFetch(path, {
    method: "POST",
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        }),
  });
}

async function providerRecords(
  table: string,
): Promise<{ fields: AirtableFields; id: string; table: string }[]> {
  const response = await fixtureFetch(`/provider-records?table=${table}`);
  return (await response.json()) as {
    fields: AirtableFields;
    id: string;
    table: string;
  }[];
}

async function providerMutationCount(): Promise<number> {
  const response = await fixtureFetch("/provider-stats");
  return ((await response.json()) as { mutationCount: number }).mutationCount;
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMilliseconds = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for authority fixture state.");
}

async function sha256Bytes(value: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function encodeBase64(value: Uint8Array<ArrayBuffer>): string {
  return btoa([...value].map((byte) => String.fromCharCode(byte)).join(""));
}

async function assetState(key: string): Promise<{
  checksum: string;
  checksums: { sha256?: string };
  contentType: string | null;
  customMetadata: Record<string, string>;
  etag: string;
  size: number;
  version: string;
}> {
  const response = await fixtureFetch(
    `/asset-state?key=${encodeURIComponent(key)}`,
  );
  return (await response.json()) as Awaited<ReturnType<typeof assetState>>;
}

async function fileIdentity(id: string): Promise<{
  checksum_sha256: string;
  event_id: string;
  id: string;
  intent_status: string;
  organization_id: string;
  purpose: string;
  r2_etag: string;
  r2_version: string;
  status: string;
}> {
  const response = await fixtureFetch(
    `/file-identity?id=${encodeURIComponent(id)}`,
  );
  return (await response.json()) as Awaited<ReturnType<typeof fileIdentity>>;
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

let plan: CompiledDemoSeed;

beforeAll(async () => {
  plan = await compileDemoSeed(demoSeedSource);
  await server.listen();
  runtimeFixture = await runtimeWorker.getExport();
  const setup = await post("/setup", { statements: readMigrationStatements() });
  expect(setup.status).toBe(204);
  expect((await post("/allow-projection")).status).toBe(204);
  expect(
    (await post("/setup-tenant", { organizationId: demoOrganizationId }))
      .status,
  ).toBe(204);

  const recordIds = new Map(
    plan.operations.map((operation) => [
      operation.entityId,
      `rec_${operation.table}_${operation.entityId}`,
    ]),
  );
  for (const operation of plan.operations) {
    const managedFields: AirtableFields = {
      ...resolveDemoSeedFields(operation.fields, recordIds),
      ID: operation.entityId,
    };
    const sourceVersion = 1;
    const sourceContentHash = await hashAirtableContent(
      managedAirtableContent(operation.table, managedFields),
      sourceVersion,
    );
    const seeded = await post("/seed-provider", {
      fields: {
        ...managedFields,
        "Applied content hash": sourceContentHash,
        "Source version": sourceVersion,
      },
      recordId: recordIds.get(operation.entityId),
      table: operation.table,
    });
    expect(seeded.status).toBe(204);
  }
}, 60_000);

afterAll(async () => {
  await server.close();
});

describe("RAL-34 completed authority data plane", () => {
  it("reconciles every table, fails closed on lifecycle tampering, ingests webhook cursors, and replaces one exact demo snapshot", async () => {
    const scan = await post("/reconcile", {
      organizationId: demoOrganizationId,
    });
    expect(scan.status, await scan.clone().text()).toBe(200);
    await expect(scan.json()).resolves.toMatchObject({
      deleted: 0,
      projected: plan.operations.length,
    });

    const sourceResponse = await fixtureFetch(
      `/source-state?organizationId=${demoOrganizationId}`,
    );
    const sourceState = (await sourceResponse.json()) as {
      projections: Record<string, number>;
      sources: {
        deleted_count: number;
        record_count: number;
        table_key: string;
      }[];
    };
    expect(sourceState.sources).toHaveLength(29);
    expect(
      sourceState.sources.reduce((sum, row) => sum + row.record_count, 0),
    ).toBe(plan.operations.length);
    expect(sourceState.projections).toMatchObject({
      contacts: plan.operations.filter(({ table }) => table === "contacts")
        .length,
      events: 1,
      formats: 3,
      rooms: 3,
      schedule_slots: plan.operations.filter(
        ({ table }) => table === "schedule_slots",
      ).length,
      session_participants: plan.operations.filter(
        ({ table }) => table === "session_participants",
      ).length,
      sessions: plan.operations.filter(({ table }) => table === "sessions")
        .length,
      tracks: 4,
    });

    const roomOperation = plan.operations.find(
      ({ table }) => table === "rooms",
    );
    if (!roomOperation) throw new Error("Demo fixture is missing a room.");
    expect(
      (
        await post("/mutate-provider", {
          fields: { Name: "Organizer-edited room" },
          id: roomOperation.entityId,
          table: "rooms",
        })
      ).status,
    ).toBe(204);
    const edited = await post("/reconcile", {
      organizationId: demoOrganizationId,
      tables: ["rooms"],
    });
    expect(edited.status).toBe(200);
    const editedRoom = (await providerRecords("rooms")).find(
      ({ fields }) => fields.ID === roomOperation.entityId,
    );
    expect(editedRoom?.fields.Name).toBe("Organizer-edited room");
    const acceptedHash = editedRoom?.fields["Applied content hash"];
    const acceptedVersion = editedRoom?.fields["Source version"];
    expect(acceptedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(acceptedVersion).toBe(2);
    const mutationsAfterAdoption = await providerMutationCount();
    const staleCommand = await post("/execute", {
      audit: {
        action: "rooms.update",
        actorId: "usr_stale_writer",
        actorType: "user",
        eventId: demoEventId,
        requestId: "req_stale_room_update",
        safeDiff: { name: "Stale overwrite" },
      },
      commandId: "cmd_stale_room_update",
      entityId: roomOperation.entityId,
      expectedVersion: 1,
      fields: { Name: "Stale overwrite" },
      operation: "rooms.update",
      organizationId: demoOrganizationId,
      table: "rooms",
    });
    expect(staleCommand.status).toBe(409);
    expect(await providerMutationCount()).toBe(mutationsAfterAdoption);
    expect(
      (await providerRecords("rooms")).find(
        ({ fields }) => fields.ID === roomOperation.entityId,
      )?.fields.Name,
    ).toBe("Organizer-edited room");

    await post("/mutate-provider", {
      fields: { "Source version": 9 },
      id: roomOperation.entityId,
      table: "rooms",
    });
    const tampered = await post("/reconcile", {
      organizationId: demoOrganizationId,
      tables: ["rooms"],
    });
    expect(tampered.status).toBe(500);
    await post("/mutate-provider", {
      fields: {
        "Applied content hash": acceptedHash,
        "Source version": acceptedVersion,
      },
      id: roomOperation.entityId,
      table: "rooms",
    });

    const staleId = "room_stale_demo";
    const staleFields: AirtableFields = {
      Capacity: 5,
      Event: [`rec_events_${demoEventId}`],
      ID: staleId,
      Name: "Stale room",
      "Sort order": 99,
    };
    const staleHash = await hashAirtableContent(
      managedAirtableContent("rooms", staleFields),
      1,
    );
    await post("/seed-provider", {
      fields: {
        ...staleFields,
        "Applied content hash": staleHash,
        "Source version": 1,
      },
      table: "rooms",
    });
    expect(
      (
        await post("/reconcile", {
          organizationId: demoOrganizationId,
          tables: ["rooms"],
        })
      ).status,
    ).toBe(200);
    await post("/remove-provider", { id: staleId, table: "rooms" });
    const deleted = await post("/reconcile", {
      organizationId: demoOrganizationId,
      tables: ["rooms"],
    });
    await expect(deleted.json()).resolves.toMatchObject({ deleted: 1 });

    const secondOrganizationId = "org_webhook_second";
    const secondEventId = "evt_webhook_second";
    const secondRoomId = "room_webhook_second";
    expect(
      (
        await post("/setup-tenant", {
          organizationId: secondOrganizationId,
        })
      ).status,
    ).toBe(204);
    await seedManagedRecord("organizations", {
      "Default timezone": "UTC",
      ID: secondOrganizationId,
      Name: "Second webhook organization",
      Slug: "webhook-second",
    });
    await seedManagedRecord("events", {
      "Brand JSON": "{}",
      ID: secondEventId,
      "Is demo": false,
      Name: "Second webhook event",
      Organization: [`rec_organizations_${secondOrganizationId}`],
      "Published version": 0,
      Slug: "webhook-second-event",
      Status: "open",
      Timezone: "UTC",
    });
    await seedManagedRecord("rooms", {
      Capacity: 25,
      Event: [`rec_events_${secondEventId}`],
      ID: secondRoomId,
      Name: "Second tenant room",
      "Sort order": 1,
    });
    const webhookOrganizations =
      "organizationId=org_fixture" +
      `&organizationId=${demoOrganizationId}` +
      `&organizationId=${secondOrganizationId}`;
    await post("/configure-webhook", {
      cursor: 1,
      webhookId: "ach_demo_webhook",
    });
    expect((await post(`/ingest-webhook?${webhookOrganizations}`)).status).toBe(
      200,
    );
    expect(
      (
        await post("/mutate-provider", {
          fields: { Name: "Webhook-edited room" },
          id: roomOperation.entityId,
          table: "rooms",
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await post("/mutate-provider", {
          fields: { Name: "Second tenant webhook edit" },
          id: secondRoomId,
          table: "rooms",
        })
      ).status,
    ).toBe(204);
    expect(
      (await providerRecords("rooms")).find(
        ({ fields }) => fields.ID === roomOperation.entityId,
      )?.fields.Name,
    ).toBe("Webhook-edited room");
    await post("/webhook-page", {
      cursor: 1,
      page: {
        cursor: 2,
        mightHaveMore: false,
        payloads: [
          {
            baseTransactionNumber: 42,
            changedTablesById: { tbl_rooms: { changedRecordsById: {} } },
          },
        ],
      },
    });
    expect(
      (await post(`/ingest-webhook?organizationId=${demoOrganizationId}`))
        .status,
    ).toBe(500);
    const webhook = await post(`/ingest-webhook?${webhookOrganizations}`);
    await expect(webhook.json()).resolves.toMatchObject({
      cursor: 2,
      projected: 4,
      tables: ["rooms"],
    });
    const secondRoom = await fixtureFetch(
      `/room-state?organizationId=${secondOrganizationId}&id=${secondRoomId}`,
    );
    await expect(secondRoom.json()).resolves.toMatchObject({
      id: secondRoomId,
      name: "Second tenant webhook edit",
    });

    const lateOrganizationId = "org_webhook_late";
    const lateEventId = "evt_webhook_late";
    const lateRoomId = "room_webhook_late";
    expect(
      (
        await post("/setup-tenant", {
          organizationId: lateOrganizationId,
        })
      ).status,
    ).toBe(204);
    await seedManagedRecord("organizations", {
      "Default timezone": "UTC",
      ID: lateOrganizationId,
      Name: "Late webhook organization",
      Slug: "webhook-late",
    });
    await seedManagedRecord("events", {
      "Brand JSON": "{}",
      ID: lateEventId,
      "Is demo": false,
      Name: "Late webhook event",
      Organization: [`rec_organizations_${lateOrganizationId}`],
      "Published version": 0,
      Slug: "webhook-late-event",
      Status: "open",
      Timezone: "UTC",
    });
    await seedManagedRecord("rooms", {
      Capacity: 15,
      Event: [`rec_events_${lateEventId}`],
      ID: lateRoomId,
      Name: "Late tenant room",
      "Sort order": 1,
    });
    const expandedWebhookOrganizations = `${webhookOrganizations}&organizationId=${lateOrganizationId}`;
    const speakerAccessPath =
      `/access-state?organizationId=${demoOrganizationId}` +
      `&eventId=${demoEventId}&userId=usr_speaker_fixture` +
      "&email=speaker-01%40demo.opensession.invalid";
    expect((await post("/arm-webhook-roster-checkpoint")).status).toBe(204);
    const invalidatedRoster = post(
      `/ingest-webhook?${expandedWebhookOrganizations}`,
    );
    await waitFor(async () => {
      const checkpoint = (await (
        await fixtureFetch("/webhook-roster-checkpoint")
      ).json()) as { reached?: number };
      return checkpoint.reached === 1;
    });
    const accessBeforeReactivation = (await (
      await fixtureFetch(speakerAccessPath)
    ).json()) as { permissions: string[] };
    expect(accessBeforeReactivation.permissions).toContain("portal:write:self");
    expect(
      (
        await post("/reactivate-tenant", {
          organizationId: demoOrganizationId,
        })
      ).status,
    ).toBe(204);
    const accessDuringReactivation = (await (
      await fixtureFetch(speakerAccessPath)
    ).json()) as { permissions: string[] };
    expect(accessDuringReactivation.permissions).not.toContain(
      "portal:write:self",
    );
    expect((await post("/release-webhook-roster-checkpoint")).status).toBe(204);
    expect((await invalidatedRoster).status).toBe(500);
    await expect(
      (await fixtureFetch("/authority-state")).json(),
    ).resolves.toMatchObject({ committedCursor: 2 });
    expect(
      (await post(`/ingest-webhook?${expandedWebhookOrganizations}`)).status,
    ).toBe(200);
    await expect(
      (
        await fixtureFetch(
          `/room-state?organizationId=${lateOrganizationId}&id=${lateRoomId}`,
        )
      ).json(),
    ).resolves.toMatchObject({ id: lateRoomId, name: "Late tenant room" });
    const accessAfterRosterRepair = (await (
      await fixtureFetch(speakerAccessPath)
    ).json()) as { permissions: string[] };
    expect(accessAfterRosterRepair.permissions).toContain("portal:write:self");

    const actorId = "usr_demo_owner";
    const preSnapshotRoom = (await providerRecords("rooms")).find(
      ({ fields }) => fields.ID === roomOperation.entityId,
    );
    if (!preSnapshotRoom) throw new Error("Edited room disappeared.");
    expect(preSnapshotRoom.fields.Name).toBe("Webhook-edited room");
    expect(preSnapshotRoom.fields["Applied content hash"]).toBe(
      await hashAirtableContent(
        managedAirtableContent("rooms", preSnapshotRoom.fields),
        Number(preSnapshotRoom.fields["Source version"]),
      ),
    );
    expect(
      (
        await post("/setup-owner", {
          actorId,
          organizationId: demoOrganizationId,
        })
      ).status,
    ).toBe(204);
    const resetRunId = "req_demo_snapshot_workerd";
    const snapshotInput = {
      actorId,
      expectedSourceVersion: 1,
      operation: "demo.snapshot.replace" as const,
      plan,
      requireActiveOwner: true as const,
      requireAuthoritativeDemo: true as const,
      resetRunId,
    };
    const preSnapshotMutations = await providerMutationCount();
    expect((await post("/fail-room-projection")).status).toBe(204);
    const pendingSnapshot = await post("/snapshot", snapshotInput);
    expect(pendingSnapshot.status).toBe(409);
    expect((await post("/allow-room-projection")).status).toBe(204);
    const snapshot = await post("/snapshot", snapshotInput);
    expect(snapshot.status, await snapshot.clone().text()).toBe(200);
    await expect(snapshot.json()).resolves.toMatchObject({
      digest: plan.digest,
      operationCount: plan.operations.length,
      outcome: "applied",
      resetRunId,
      snapshotId: plan.snapshotId,
    });
    expect(await providerMutationCount()).toBe(
      preSnapshotMutations + plan.operations.length,
    );
    const mutationCount = await providerMutationCount();
    const replay = await post("/snapshot", snapshotInput);
    await expect(replay.json()).resolves.toMatchObject({ outcome: "replayed" });
    expect(await providerMutationCount()).toBe(mutationCount);
    const changedPlan: CompiledDemoSeed = {
      ...plan,
      operations: plan.operations.map((operation, index) =>
        index === 0
          ? {
              ...operation,
              fields: { ...operation.fields, Name: "Changed replay content" },
            }
          : operation,
      ),
    };
    const conflictingReplay = await post("/snapshot", {
      ...snapshotInput,
      plan: changedPlan,
    });
    expect(conflictingReplay.status).toBe(409);
    expect(await providerMutationCount()).toBe(mutationCount);

    const assets = await fixtureFetch(`/assets?prefix=demo/${demoEventId}/`);
    await expect(assets.json()).resolves.toHaveLength(plan.assets.length);
    for (const asset of plan.assets) {
      const download = await fixtureFetch(
        `/download-asset?id=${asset.assetId}&actorId=${actorId}`,
      );
      expect(download.status).toBe(200);
      expect(await sha256Bytes(await download.arrayBuffer())).toBe(
        asset.contentDigest,
      );
      await expect(fileIdentity(asset.assetId)).resolves.toMatchObject({
        checksum_sha256: asset.contentDigest,
        intent_status: "finalized",
        purpose: asset.kind,
        status: "ready",
      });
    }

    const evictionAsset = plan.assets[0];
    if (!evictionAsset) throw new Error("Demo fixture has no eviction asset.");
    const evictionBaseline = await assetState(evictionAsset.objectKey);
    const evictionIdentityBaseline = await fileIdentity(evictionAsset.assetId);
    const interruptedBytes = new TextEncoder().encode(
      "replacement committed before eviction",
    );
    const interruptedDigest = await sha256Bytes(interruptedBytes.buffer);
    const interruptedAsset = {
      ...evictionAsset,
      contentBase64: encodeBase64(interruptedBytes),
      contentDigest: interruptedDigest,
      sizeBytes: interruptedBytes.byteLength,
    };
    const evictionPlan: CompiledDemoSeed = {
      ...plan,
      assets: plan.assets.map((asset) =>
        asset.assetId === interruptedAsset.assetId ? interruptedAsset : asset,
      ),
      digest: await hashAirtableValue({
        assetDigest: interruptedDigest,
        baselineDigest: plan.digest,
      }),
      snapshotId: `snapshot_${interruptedDigest.slice(0, 24)}`,
    };
    const evictionEventState = (await (
      await fixtureFetch(
        `/event-state?organizationId=${demoOrganizationId}&id=${demoEventId}`,
      )
    ).json()) as { source_version: number };
    const evictionRunId = "req_demo_snapshot_eviction_recovery";
    const evictionSnapshotInput = {
      ...snapshotInput,
      expectedSourceVersion: evictionEventState.source_version,
      plan: evictionPlan,
      resetRunId: evictionRunId,
    };
    const evictionStaleAssetId = "asset_stale_eviction_recovery";
    const evictionStaleAssetKey = `demo/${demoEventId}/stale/eviction-proof.txt`;
    expect(
      (
        await post("/seed-stale-asset", {
          actorId,
          eventId: demoEventId,
          id: evictionStaleAssetId,
          key: evictionStaleAssetKey,
          organizationId: demoOrganizationId,
        })
      ).status,
    ).toBe(204);
    expect((await post("/arm-snapshot-asset-checkpoint")).status).toBe(204);
    const interruptedSnapshot = await post("/snapshot", evictionSnapshotInput);
    expect(interruptedSnapshot.status).toBe(409);
    await runtimeWorker.evictDurableObject("BASE_AUTHORITY", {
      name: "local:appAuthorityFixture",
    });
    await expect(
      (await fixtureFetch("/snapshot-asset-checkpoint")).json(),
    ).resolves.toMatchObject({ armed: 0, reached: 1 });
    expect((await assetState(evictionAsset.objectKey)).checksum).toBe(
      interruptedDigest,
    );
    await expect(fileIdentity(evictionAsset.assetId)).resolves.toMatchObject({
      checksum_sha256: interruptedDigest,
      intent_status: "finalized",
      status: "ready",
    });
    expect(
      (
        await post("/fail-stale-asset-deletion", {
          id: evictionStaleAssetId,
        })
      ).status,
    ).toBe(204);
    expect((await post("/snapshot", evictionSnapshotInput)).status).toBe(409);
    expect((await post("/allow-asset-projection")).status).toBe(204);
    const evictionRestored = await assetState(evictionAsset.objectKey);
    expect(evictionRestored).toMatchObject({
      checksum: evictionBaseline.checksum,
      contentType: evictionBaseline.contentType,
      customMetadata: evictionBaseline.customMetadata,
      etag: evictionBaseline.etag,
    });
    expect(evictionRestored.version).not.toBe(evictionBaseline.version);
    await expect(fileIdentity(evictionAsset.assetId)).resolves.toMatchObject({
      checksum_sha256: evictionIdentityBaseline.checksum_sha256,
      intent_status: evictionIdentityBaseline.intent_status,
      purpose: evictionIdentityBaseline.purpose,
      r2_etag: evictionRestored.etag,
      r2_version: evictionRestored.version,
      status: evictionIdentityBaseline.status,
    });
    await expect(fileIdentity(evictionStaleAssetId)).resolves.toMatchObject({
      intent_status: "finalized",
      status: "ready",
    });
    expect((await post("/snapshot", evictionSnapshotInput)).status).toBe(200);

    const staleAssetKey = `demo/${demoEventId}/stale/rollback-proof.txt`;
    const staleAssetId = "asset_stale_same_request_rollback";
    expect(
      (
        await post("/seed-stale-asset", {
          actorId,
          eventId: demoEventId,
          id: staleAssetId,
          key: staleAssetKey,
          organizationId: demoOrganizationId,
        })
      ).status,
    ).toBe(204);
    const beforeFailure = (await (
      await fixtureFetch(`/assets?prefix=demo/${demoEventId}/`)
    ).json()) as { key: string }[];
    const rollbackAsset = plan.assets[0];
    if (!rollbackAsset) throw new Error("Demo fixture has no rollback asset.");
    const rollbackObjectBefore = await assetState(rollbackAsset.objectKey);
    const rollbackIdentityBefore = await fileIdentity(rollbackAsset.assetId);
    expect(
      (await post("/fail-stale-asset-deletion", { id: staleAssetId })).status,
    ).toBe(204);
    const rollbackRunId = "req_demo_snapshot_rollback";
    const eventState = (await (
      await fixtureFetch(
        `/event-state?organizationId=${demoOrganizationId}&id=${demoEventId}`,
      )
    ).json()) as { source_version: number };
    const failedSnapshot = await post("/snapshot", {
      ...snapshotInput,
      expectedSourceVersion: eventState.source_version,
      resetRunId: rollbackRunId,
    });
    expect(failedSnapshot.status).toBe(409);
    const afterFailure = (await (
      await fixtureFetch(`/assets?prefix=demo/${demoEventId}/`)
    ).json()) as { key: string }[];
    expect(afterFailure.map(({ key }) => key).sort()).toEqual(
      beforeFailure.map(({ key }) => key).sort(),
    );
    const rollbackObjectAfter = await assetState(rollbackAsset.objectKey);
    const rollbackIdentityAfter = await fileIdentity(rollbackAsset.assetId);
    expect(rollbackObjectAfter).toMatchObject({
      checksum: rollbackObjectBefore.checksum,
      contentType: rollbackObjectBefore.contentType,
      customMetadata: rollbackObjectBefore.customMetadata,
      etag: rollbackObjectBefore.etag,
    });
    expect(rollbackObjectAfter.version).not.toBe(rollbackObjectBefore.version);
    expect(rollbackIdentityAfter).toMatchObject({
      checksum_sha256: rollbackIdentityBefore.checksum_sha256,
      intent_status: "finalized",
      purpose: rollbackIdentityBefore.purpose,
      r2_etag: rollbackObjectAfter.etag,
      r2_version: rollbackObjectAfter.version,
      status: "ready",
    });
    expect(
      (
        await fixtureFetch(
          `/download-asset?id=${rollbackAsset.assetId}&actorId=${actorId}`,
        )
      ).status,
    ).toBe(200);
    expect((await post("/allow-asset-projection")).status).toBe(204);
    const recoveredSnapshot = await post("/snapshot", {
      ...snapshotInput,
      expectedSourceVersion: eventState.source_version,
      resetRunId: rollbackRunId,
    });
    await expect(recoveredSnapshot.json()).resolves.toMatchObject({
      outcome: "applied",
      resetRunId: rollbackRunId,
    });
    const recoveredAssets = (await (
      await fixtureFetch(`/assets?prefix=demo/${demoEventId}/`)
    ).json()) as { key: string }[];
    expect(recoveredAssets.map(({ key }) => key)).not.toContain(staleAssetKey);

    const inScopeStaleRoomId = "room_stale_in_scope_snapshot";
    await seedManagedRecord("rooms", {
      Capacity: 12,
      Event: [`rec_events_${demoEventId}`],
      ID: inScopeStaleRoomId,
      Name: "In-scope stale room",
      "Sort order": 98,
    });
    expect(
      (
        await post("/reconcile", {
          organizationId: demoOrganizationId,
          tables: ["rooms"],
        })
      ).status,
    ).toBe(200);
    const deleteControlEventState = (await (
      await fixtureFetch(
        `/event-state?organizationId=${demoOrganizationId}&id=${demoEventId}`,
      )
    ).json()) as { source_version: number };
    expect(
      (
        await post("/snapshot", {
          ...snapshotInput,
          expectedSourceVersion: deleteControlEventState.source_version,
          resetRunId: "req_demo_snapshot_delete_control",
        })
      ).status,
    ).toBe(200);
    expect(
      (await providerRecords("rooms")).some(
        ({ fields }) => fields.ID === inScopeStaleRoomId,
      ),
    ).toBe(false);
    await expect(
      (
        await fixtureFetch(
          `/room-state?organizationId=${demoOrganizationId}&id=${inScopeStaleRoomId}`,
        )
      ).json(),
    ).resolves.toMatchObject({ source_deleted_at: expect.any(String) });

    const collisionAsset = plan.assets[0];
    if (!collisionAsset)
      throw new Error("Demo fixture has no collision asset.");
    const collisionObjectBefore = await assetState(collisionAsset.objectKey);
    const collisionIdentityBefore = await fileIdentity(collisionAsset.assetId);
    expect(
      (
        await post("/move-file-identity", {
          eventId: secondEventId,
          id: collisionAsset.assetId,
          organizationId: secondOrganizationId,
          ownerContactId: null,
        })
      ).status,
    ).toBe(204);
    const collisionEventState = (await (
      await fixtureFetch(
        `/event-state?organizationId=${demoOrganizationId}&id=${demoEventId}`,
      )
    ).json()) as { source_version: number };
    expect(
      (
        await post("/snapshot", {
          ...snapshotInput,
          expectedSourceVersion: collisionEventState.source_version,
          resetRunId: "req_demo_snapshot_asset_scope_guard",
        })
      ).status,
    ).toBe(409);
    await expect(fileIdentity(collisionAsset.assetId)).resolves.toMatchObject({
      event_id: secondEventId,
      organization_id: secondOrganizationId,
      r2_etag: collisionIdentityBefore.r2_etag,
      r2_version: collisionIdentityBefore.r2_version,
    });
    expect(await assetState(collisionAsset.objectKey)).toEqual(
      collisionObjectBefore,
    );
    expect(
      (
        await post("/move-file-identity", {
          eventId: demoEventId,
          id: collisionAsset.assetId,
          organizationId: demoOrganizationId,
          ownerContactId: collisionAsset.ownerContactId,
        })
      ).status,
    ).toBe(204);

    const movedRoomId = "room_scope_moved_before_snapshot";
    await seedManagedRecord("rooms", {
      Capacity: 40,
      Event: [`rec_events_${demoEventId}`],
      ID: movedRoomId,
      Name: "Moved room must survive the original event reset",
      "Sort order": 99,
    });
    expect(
      (
        await post("/reconcile", {
          organizationId: demoOrganizationId,
          tables: ["rooms"],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post("/mutate-provider", {
          fields: { Event: [`rec_events_${secondEventId}`] },
          id: movedRoomId,
          table: "rooms",
        })
      ).status,
    ).toBe(204);
    const scopedDeleteEventState = (await (
      await fixtureFetch(
        `/event-state?organizationId=${demoOrganizationId}&id=${demoEventId}`,
      )
    ).json()) as { source_version: number };
    const rejectedScopedDelete = await post("/snapshot", {
      ...snapshotInput,
      expectedSourceVersion: scopedDeleteEventState.source_version,
      resetRunId: "req_demo_snapshot_scope_guard",
    });
    expect(rejectedScopedDelete.status).toBe(409);
    expect(
      (await providerRecords("rooms")).find(
        ({ fields }) => fields.ID === movedRoomId,
      )?.fields.Event,
    ).toEqual([`rec_events_${secondEventId}`]);
    expect(
      (
        await post("/mutate-provider", {
          fields: { Event: [`rec_events_${demoEventId}`] },
          id: movedRoomId,
          table: "rooms",
        })
      ).status,
    ).toBe(204);

    const readinessRoom = (await providerRecords("rooms")).find(
      ({ fields }) => fields.ID === roomOperation.entityId,
    );
    if (!readinessRoom) throw new Error("Readiness test room disappeared.");
    const readinessRoomVersion = Number(readinessRoom.fields["Source version"]);
    expect(Number.isInteger(readinessRoomVersion)).toBe(true);
    expect(
      (
        await post("/webhook-page", {
          cursor: 2,
          page: {
            cursor: 3,
            mightHaveMore: false,
            payloads: [
              {
                baseTransactionNumber: 43,
                changedTablesById: {
                  tbl_event_contacts: { changedRecordsById: {} },
                  tbl_rooms: { changedRecordsById: {} },
                },
              },
            ],
          },
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await post("/mutate-provider", {
          fields: { "Source version": readinessRoomVersion + 1000 },
          id: roomOperation.entityId,
          table: "rooms",
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await post("/mutate-provider", {
          fields: { "Portal state": "revoked" },
          id: "event_contact_speaker_01",
          table: "event_contacts",
        })
      ).status,
    ).toBe(204);
    expect(
      (await post(`/ingest-webhook?${expandedWebhookOrganizations}`)).status,
    ).toBe(500);
    await expect(
      (
        await fixtureFetch(
          `/tenant-readiness?organizationId=${demoOrganizationId}`,
        )
      ).json(),
    ).resolves.toMatchObject({ authority_ready_at: null });
    await expect(
      (
        await fixtureFetch(
          `/tenant-readiness?organizationId=${secondOrganizationId}`,
        )
      ).json(),
    ).resolves.toMatchObject({ authority_ready_at: null });
    await expect(
      (
        await fixtureFetch(
          `/tenant-readiness?organizationId=${lateOrganizationId}`,
        )
      ).json(),
    ).resolves.toMatchObject({ authority_ready_at: null });
    const accessWhilePartialScanFailed = (await (
      await fixtureFetch(speakerAccessPath)
    ).json()) as { permissions: string[] };
    expect(accessWhilePartialScanFailed.permissions).not.toContain(
      "portal:write:self",
    );
    expect(
      (
        await post("/mutate-provider", {
          fields: { "Source version": readinessRoomVersion },
          id: roomOperation.entityId,
          table: "rooms",
        })
      ).status,
    ).toBe(204);
    const repairedFullScan = await post(
      `/ingest-webhook?${expandedWebhookOrganizations}`,
    );
    expect(repairedFullScan.status, await repairedFullScan.clone().text()).toBe(
      200,
    );
    expect(
      (await post(`/ingest-webhook?${expandedWebhookOrganizations}`)).status,
    ).toBe(200);
    await expect(
      (
        await fixtureFetch(
          `/tenant-readiness?organizationId=${demoOrganizationId}`,
        )
      ).json(),
    ).resolves.toMatchObject({
      authority_ready_at: expect.any(String),
    });
    const revokedAccess = (await (
      await fixtureFetch(speakerAccessPath)
    ).json()) as { permissions: string[] };
    expect(revokedAccess.permissions).not.toContain("portal:write:self");
    expect(
      (
        await post("/webhook-page", {
          cursor: 3,
          page: {
            cursor: 4,
            mightHaveMore: false,
            payloads: [
              {
                baseTransactionNumber: 44,
                changedTablesById: {
                  tbl_unknown_authority: { changedRecordsById: {} },
                },
              },
            ],
          },
        })
      ).status,
    ).toBe(204);
    expect(
      (await post(`/ingest-webhook?${expandedWebhookOrganizations}`)).status,
    ).toBe(500);
    for (const organizationId of [
      demoOrganizationId,
      secondOrganizationId,
      lateOrganizationId,
    ]) {
      await expect(
        (
          await fixtureFetch(
            `/tenant-readiness?organizationId=${organizationId}`,
          )
        ).json(),
      ).resolves.toMatchObject({ authority_ready_at: null });
    }
    expect(
      (
        await post("/webhook-page", {
          cursor: 3,
          page: {
            cursor: 4,
            mightHaveMore: false,
            payloads: [],
          },
        })
      ).status,
    ).toBe(204);
    const recoveredUnknownTableFailure = await post(
      `/ingest-webhook?${expandedWebhookOrganizations}`,
    );
    expect(
      recoveredUnknownTableFailure.status,
      await recoveredUnknownTableFailure.clone().text(),
    ).toBe(200);
    expect(
      (await post(`/ingest-webhook?${expandedWebhookOrganizations}`)).status,
    ).toBe(200);
    await expect(
      (
        await fixtureFetch(
          `/tenant-readiness?organizationId=${demoOrganizationId}`,
        )
      ).json(),
    ).resolves.toMatchObject({
      authority_ready_at: expect.any(String),
    });
    const revokedAccessAfterUnknownTableRecovery = (await (
      await fixtureFetch(speakerAccessPath)
    ).json()) as { permissions: string[] };
    expect(revokedAccessAfterUnknownTableRecovery.permissions).not.toContain(
      "portal:write:self",
    );
    expect(
      (
        await post("/webhook-page", {
          cursor: 4,
          page: {
            cursor: 5,
            mightHaveMore: true,
            payloads: [
              {
                baseTransactionNumber: 45,
                changedTablesById: {
                  tbl_rooms: { changedRecordsById: {} },
                },
              },
            ],
          },
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await post("/webhook-page", {
          cursor: 5,
          page: {
            cursor: 6,
            mightHaveMore: false,
            payloads: [
              {
                baseTransactionNumber: 46,
                changedTablesById: {
                  tbl_event_contacts: { changedRecordsById: {} },
                },
              },
            ],
          },
        })
      ).status,
    ).toBe(204);
    expect((await post("/arm-webhook-roster-checkpoint")).status).toBe(204);
    const multiPageRevocation = post(
      `/ingest-webhook?${expandedWebhookOrganizations}`,
    );
    await waitFor(async () => {
      const checkpoint = (await (
        await fixtureFetch("/webhook-roster-checkpoint")
      ).json()) as { reached?: number };
      return checkpoint.reached === 1;
    });
    for (const organizationId of [
      demoOrganizationId,
      secondOrganizationId,
      lateOrganizationId,
    ]) {
      await expect(
        (
          await fixtureFetch(
            `/tenant-readiness?organizationId=${organizationId}`,
          )
        ).json(),
      ).resolves.toMatchObject({ authority_ready_at: null });
    }
    const accessBetweenWebhookPages = (await (
      await fixtureFetch(speakerAccessPath)
    ).json()) as { permissions: string[] };
    expect(accessBetweenWebhookPages.permissions).not.toContain(
      "portal:write:self",
    );
    expect((await post("/release-webhook-roster-checkpoint")).status).toBe(204);
    const multiPageRevocationResponse = await multiPageRevocation;
    expect(
      multiPageRevocationResponse.status,
      await multiPageRevocationResponse.clone().text(),
    ).toBe(200);
    await expect(
      (
        await fixtureFetch(
          `/tenant-readiness?organizationId=${demoOrganizationId}`,
        )
      ).json(),
    ).resolves.toMatchObject({
      authority_ready_at: expect.any(String),
    });
    const revokedAccessAfterMultiPageRecovery = (await (
      await fixtureFetch(speakerAccessPath)
    ).json()) as { permissions: string[] };
    expect(revokedAccessAfterMultiPageRecovery.permissions).not.toContain(
      "portal:write:self",
    );
    expect(
      (
        await post("/mutate-provider", {
          fields: { "Portal state": "active" },
          id: "event_contact_speaker_01",
          table: "event_contacts",
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await post("/reconcile", {
          organizationId: demoOrganizationId,
          tables: ["event_contacts"],
        })
      ).status,
    ).toBe(200);

    const queueFailureRoom = (await providerRecords("rooms")).find(
      ({ fields }) => fields.ID === roomOperation.entityId,
    );
    if (!queueFailureRoom) throw new Error("Queue failure room disappeared.");
    expect(
      (
        await post("/set-queue-failure", {
          enabled: true,
          eventId: demoEventId,
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await post("/mutate-provider", {
          fields: { ID: `${roomOperation.entityId}_tampered` },
          id: roomOperation.entityId,
          table: "rooms",
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await post("/reconcile", {
          organizationId: demoOrganizationId,
          tables: ["rooms"],
        })
      ).status,
    ).toBe(500);
    await expect(
      (
        await fixtureFetch(
          `/room-state?organizationId=${demoOrganizationId}&id=${roomOperation.entityId}`,
        )
      ).json(),
    ).resolves.toMatchObject({
      source_deleted_at: expect.any(String),
    });
    const invalidationPath =
      `/cache-invalidation-state?organizationId=${demoOrganizationId}` +
      `&eventId=${demoEventId}`;
    await expect(
      (await fixtureFetch(invalidationPath)).json(),
    ).resolves.toMatchObject({
      attempt_count: 1,
      last_error_code: "Error",
      status: "pending",
    });
    expect(
      (
        await post("/set-queue-failure", {
          enabled: false,
        })
      ).status,
    ).toBe(204);
    await runtimeWorker.evictDurableObject("BASE_AUTHORITY", {
      name: "local:appAuthorityFixture",
    });
    await waitFor(async () => {
      const state = (await (await fixtureFetch(invalidationPath)).json()) as {
        attempt_count: number;
        status: string;
      };
      return state.status === "enqueued" && state.attempt_count >= 2;
    });
    const enqueuedInvalidation = (await (
      await fixtureFetch(invalidationPath)
    ).json()) as {
      attempt_count: number;
      invalidation_version: number;
      status: string;
    };
    expect(enqueuedInvalidation).toMatchObject({ status: "enqueued" });
    await waitFor(async () => {
      const state = (await (await fixtureFetch(invalidationPath)).json()) as {
        attempt_count: number;
        status: string;
      };
      return (
        state.status === "enqueued" &&
        state.attempt_count > enqueuedInvalidation.attempt_count
      );
    });
    expect(
      (
        await post("/process-cache-invalidation", {
          event_id: demoEventId,
          invalidation_version: enqueuedInvalidation.invalidation_version,
          kind: "public_schedule.cache.invalidate",
          organization_id: demoOrganizationId,
          version: 2,
        })
      ).status,
    ).toBe(204);
    await expect(
      (await fixtureFetch(invalidationPath)).json(),
    ).resolves.toMatchObject({ status: "processed" });
    expect(
      (
        await post("/process-cache-invalidation", {
          event_id: demoEventId,
          kind: "public_schedule.cache.invalidate",
          version: 1,
        })
      ).status,
    ).toBe(204);
    await expect(
      (await fixtureFetch(invalidationPath)).json(),
    ).resolves.toMatchObject({ status: "processed" });

    expect((await post("/clear-authority-alarm")).status).toBe(204);
    expect(
      (
        await post("/seed-legacy-cache-invalidation", {
          eventId: demoEventId,
          organizationId: demoOrganizationId,
        })
      ).status,
    ).toBe(204);
    const legacyInvalidation = (await (
      await fixtureFetch(invalidationPath)
    ).json()) as {
      invalidation_version: number;
      status: string;
    };
    expect(legacyInvalidation.status).toBe("published");
    await server
      .getWorker("opensession-airtable-authority-completion-runtime")
      .evictDurableObject("BASE_AUTHORITY", {
        name: "local:appAuthorityFixture",
      });
    await fixtureFetch("/authority-state");
    await waitFor(async () => {
      const state = (await (await fixtureFetch(invalidationPath)).json()) as {
        attempt_count: number;
        status: string;
      };
      return state.status === "enqueued" && state.attempt_count >= 1;
    });
    expect(
      (
        await post("/process-cache-invalidation", {
          event_id: demoEventId,
          invalidation_version: legacyInvalidation.invalidation_version,
          kind: "public_schedule.cache.invalidate",
          organization_id: demoOrganizationId,
          version: 2,
        })
      ).status,
    ).toBe(204);

    const redriveEvent = (await providerRecords("events")).find(
      ({ fields }) => fields.ID === demoEventId,
    );
    if (!redriveEvent) throw new Error("Redrive test event disappeared.");
    expect((await post("/clear-authority-alarm")).status).toBe(204);
    expect(
      (
        await post("/mutate-provider", {
          fields: { Name: "Cache redrive probe" },
          id: demoEventId,
          table: "events",
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await post("/reconcile", {
          organizationId: demoOrganizationId,
          tables: ["events"],
        })
      ).status,
    ).toBe(200);
    const scheduledInvalidation = (await (
      await fixtureFetch(invalidationPath)
    ).json()) as {
      attempt_count: number;
      invalidation_version: number;
      status: string;
    };
    expect(scheduledInvalidation).toMatchObject({
      attempt_count: 1,
      status: "enqueued",
    });
    await waitFor(async () => {
      const state = (await (await fixtureFetch(invalidationPath)).json()) as {
        attempt_count: number;
        status: string;
      };
      return (
        state.status === "enqueued" &&
        state.attempt_count > scheduledInvalidation.attempt_count
      );
    });
    expect(
      (
        await post("/process-cache-invalidation", {
          event_id: demoEventId,
          invalidation_version: scheduledInvalidation.invalidation_version,
          kind: "public_schedule.cache.invalidate",
          organization_id: demoOrganizationId,
          version: 2,
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await post("/mutate-provider", {
          fields: { Name: redriveEvent.fields.Name },
          id: demoEventId,
          table: "events",
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await post("/reconcile", {
          organizationId: demoOrganizationId,
          tables: ["events"],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post("/mutate-provider", {
          fields: { ID: roomOperation.entityId },
          id: roomOperation.entityId,
          table: "rooms",
        })
      ).status,
    ).toBe(204);
    const postRecoveryFullScan = await post("/reconcile", {
      organizationId: demoOrganizationId,
    });
    expect(
      postRecoveryFullScan.status,
      await postRecoveryFullScan.clone().text(),
    ).toBe(200);

    const trace = await fixtureFetch(
      `/authority-trace?organizationId=${demoOrganizationId}`,
    );
    const traceRows = (await trace.json()) as Record<string, unknown>[];
    expect(traceRows.length).toBeGreaterThanOrEqual(plan.operations.length);
    expect(traceRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: "projection_pending" }),
        expect.objectContaining({ phase: "projection_repaired" }),
      ]),
    );
    expect(JSON.stringify(traceRows)).not.toContain("@example.invalid");
    expect(JSON.stringify(traceRows)).not.toContain("Body HTML");
    expect(JSON.stringify(traceRows)).not.toContain("demo-staging/");

    const accessBeforeIdTamper = (await (
      await fixtureFetch(speakerAccessPath)
    ).json()) as { permissions: string[] };
    expect(accessBeforeIdTamper.permissions).toContain("portal:write:self");
    expect(
      (
        await post("/mutate-provider", {
          fields: {
            ID: "event_contact_speaker_01_tampered",
            "Portal state": "revoked",
          },
          id: "event_contact_speaker_01",
          table: "event_contacts",
        })
      ).status,
    ).toBe(204);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(
        (
          await post("/reconcile", {
            organizationId: demoOrganizationId,
            tables: ["event_contacts"],
          })
        ).status,
      ).toBe(500);
      const accessAfterIdTamper = (await (
        await fixtureFetch(speakerAccessPath)
      ).json()) as { permissions: string[] };
      expect(accessAfterIdTamper.permissions).not.toContain(
        "portal:write:self",
      );
    }
  }, 120_000);
});
