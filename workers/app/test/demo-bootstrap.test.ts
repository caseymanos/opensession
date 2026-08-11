import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DemoBootstrapService } from "../src/demo/bootstrap";
import { compileDemoSeed } from "../src/demo/compiler";
import {
  demoEventId,
  demoOrganizationId,
  demoSeedSource,
} from "../src/demo/fixture";
import {
  currentRal34DemoCapabilities,
  D1DemoEventGuardReader,
} from "../src/demo/reset";
import type {
  CompiledDemoSeed,
  DemoBootstrapAuthorityGateway,
  DemoBootstrapRootInspection,
  DemoSeedAuthorityReceipt,
} from "../src/demo/types";

const server = createTestHarness({
  workers: [{ configPath: "workers/app/wrangler.jsonc" }],
});
const baseKey = "local:appDemoBootstrap";
const organizationRecordId = `rec${"O".repeat(14)}`;
const eventRecordId = `rec${"E".repeat(14)}`;
const timestamp = "2026-08-10T20:00:00.000Z";

class RootAuthority implements DemoBootstrapAuthorityGateway {
  synchronizeCalls = 0;

  capabilities(): never {
    throw new Error("Reset must not be reached for conflicting registration");
  }

  inspectDemoBootstrapRoots(): Promise<DemoBootstrapRootInspection> {
    return Promise.resolve({
      eventRecordId,
      eventSourceVersion: 1,
      organizationRecordId,
      organizationSourceVersion: 1,
    });
  }

  replaceDemoEvent(): never {
    throw new Error("Reset must not be reached for conflicting registration");
  }

  synchronize(): Promise<void> {
    this.synchronizeCalls += 1;
    return Promise.resolve();
  }

  synchronizeFull(): Promise<void> {
    return this.synchronize();
  }
}

class ConvergingAuthority implements DemoBootstrapAuthorityGateway {
  readonly #bucket: R2Bucket;
  readonly #database: D1Database;
  readonly #plan: CompiledDemoSeed;
  #interruptOnce: boolean;
  #complete = false;
  #run:
    | Parameters<DemoBootstrapAuthorityGateway["replaceDemoEvent"]>[0]
    | undefined;
  rootInspectionCalls = 0;

  constructor(
    database: D1Database,
    bucket: R2Bucket,
    plan: CompiledDemoSeed,
    options: { interruptOnce?: boolean } = {},
  ) {
    this.#database = database;
    this.#bucket = bucket;
    this.#plan = plan;
    this.#interruptOnce = options.interruptOnce ?? false;
  }

  capabilities() {
    return Promise.resolve(currentRal34DemoCapabilities);
  }

  inspectDemoBootstrapRoots(): Promise<DemoBootstrapRootInspection> {
    this.rootInspectionCalls += 1;
    return Promise.resolve({
      eventRecordId,
      eventSourceVersion: 1,
      organizationRecordId,
      organizationSourceVersion: 1,
    });
  }

  inspectDemoEventReplacement(organizationId: string, resetRunId: string) {
    const input = this.#run;
    return Promise.resolve(
      input &&
        input.plan.organizationId === organizationId &&
        input.resetRunId === resetRunId
        ? {
            actorId: input.actorId,
            digest: input.plan.digest,
            eventId: input.plan.eventId,
            expectedSourceVersion: input.expectedSourceVersion,
            operationCount: input.plan.operations.length,
            organizationId: input.plan.organizationId,
            receiptAvailable: this.#complete,
            resetRunId,
            snapshotId: input.plan.snapshotId,
            state: this.#complete ? "complete" : "applying",
          }
        : null,
    );
  }

  async synchronize(): Promise<void> {
    const hash = this.#plan.digest;
    await this.#database.batch([
      this.#database
        .prepare(
          `INSERT INTO p_organizations (
             id, name, slug, default_timezone, source_record_id,
             source_version, source_content_hash, projected_at
           ) VALUES (?1, 'OpenSession Demo Organization', 'opensession-demo',
                     'America/Los_Angeles', ?2, 1, ?3, ?4)
           ON CONFLICT(id) DO UPDATE SET projected_at = excluded.projected_at`,
        )
        .bind(demoOrganizationId, organizationRecordId, hash, timestamp),
      this.#database
        .prepare(
          `INSERT INTO p_events (
             id, organization_id, name, slug, timezone, status, is_demo,
             source_record_id, source_version, source_content_hash, projected_at
           ) VALUES (?1, ?2, 'AI Engineer Summit 2026', 'ai-engineer-summit',
                     'America/Los_Angeles', 'published', 1, ?3, 1, ?4, ?5)
           ON CONFLICT(id) DO UPDATE SET projected_at = excluded.projected_at`,
        )
        .bind(demoEventId, demoOrganizationId, eventRecordId, hash, timestamp),
      this.#database
        .prepare(
          `INSERT INTO authority_source_records (
             base_key, provider_table_key, provider_record_id, entity_id,
             organization_id, event_id, source_version, source_content_hash,
             projected_at
           ) VALUES (?1, 'organizations', ?2, ?3, ?3, NULL, 1, ?4, ?5)
           ON CONFLICT(base_key, provider_table_key, provider_record_id)
           DO UPDATE SET projected_at = excluded.projected_at`,
        )
        .bind(
          baseKey,
          organizationRecordId,
          demoOrganizationId,
          hash,
          timestamp,
        ),
      this.#database
        .prepare(
          `INSERT INTO authority_source_records (
             base_key, provider_table_key, provider_record_id, entity_id,
             organization_id, event_id, source_version, source_content_hash,
             projected_at
           ) VALUES (?1, 'events', ?2, ?3, ?4, ?3, 1, ?5, ?6)
           ON CONFLICT(base_key, provider_table_key, provider_record_id)
           DO UPDATE SET projected_at = excluded.projected_at`,
        )
        .bind(
          baseKey,
          eventRecordId,
          demoEventId,
          demoOrganizationId,
          hash,
          timestamp,
        ),
      this.#database
        .prepare(
          `UPDATE tenant_registry SET authority_ready_at = ?2, updated_at = ?2
           WHERE organization_id = ?1`,
        )
        .bind(demoOrganizationId, timestamp),
    ]);
  }

  synchronizeFull(): Promise<void> {
    return this.synchronize();
  }

  async replaceDemoEvent(
    input: Parameters<DemoBootstrapAuthorityGateway["replaceDemoEvent"]>[0],
  ): Promise<DemoSeedAuthorityReceipt> {
    const replayed = this.#run !== undefined;
    this.#run ??= input;
    if (this.#interruptOnce) {
      this.#interruptOnce = false;
      await this.#database.batch([
        this.#database
          .prepare(
            `UPDATE p_organizations SET source_version = 2,
               source_content_hash = ?2, projected_at = ?3 WHERE id = ?1`,
          )
          .bind(demoOrganizationId, input.plan.digest, timestamp),
        this.#database
          .prepare(
            `UPDATE p_events SET source_version = 2,
               source_content_hash = ?2, projected_at = ?3 WHERE id = ?1`,
          )
          .bind(demoEventId, input.plan.digest, timestamp),
        this.#database
          .prepare(
            `UPDATE authority_source_records SET source_version = 2,
               source_content_hash = ?3, projected_at = ?4
             WHERE base_key = ?1 AND organization_id = ?2`,
          )
          .bind(baseKey, demoOrganizationId, input.plan.digest, timestamp),
      ]);
      throw new Error("Simulated interruption after root item commits");
    }
    await this.#database
      .prepare(
        `DELETE FROM authority_source_records
         WHERE base_key = ?1 AND organization_id = ?2`,
      )
      .bind(baseKey, demoOrganizationId)
      .run();
    const writes = input.plan.operations.map((operation, index) => {
      const providerRecordId =
        operation.entityId === demoOrganizationId
          ? organizationRecordId
          : operation.entityId === demoEventId
            ? eventRecordId
            : `rec${index.toString(36).padStart(14, "0")}`;
      return this.#database
        .prepare(
          `INSERT INTO authority_source_records (
             base_key, provider_table_key, provider_record_id, entity_id,
             organization_id, event_id, source_version, source_content_hash,
             projected_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8)`,
        )
        .bind(
          baseKey,
          operation.table,
          providerRecordId,
          operation.entityId,
          demoOrganizationId,
          operation.table === "organizations" ? null : demoEventId,
          input.plan.digest,
          timestamp,
        );
    });
    for (let index = 0; index < writes.length; index += 50) {
      await this.#database.batch(writes.slice(index, index + 50));
    }
    await this.#database
      .prepare(
        `INSERT INTO demo_snapshot_runs (
           organization_id, event_id, reset_run_id, snapshot_id, digest,
           actor_id, expected_source_version, operation_count, state,
           audit_event_id, created_at, updated_at, completed_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, 'complete', ?8, ?9, ?9, ?9)
         ON CONFLICT(organization_id, reset_run_id) DO NOTHING`,
      )
      .bind(
        demoOrganizationId,
        demoEventId,
        input.resetRunId,
        input.plan.snapshotId,
        input.plan.digest,
        input.actorId,
        input.plan.operations.length,
        `audit_${input.resetRunId}`,
        timestamp,
      )
      .run();
    await Promise.all(
      input.plan.assets.map((asset) =>
        this.#bucket.put(asset.objectKey, new Uint8Array([1])),
      ),
    );
    this.#complete = true;
    return {
      auditEventId: `audit_${input.resetRunId}`,
      digest: input.plan.digest,
      operationCount: input.plan.operations.length,
      outcome: replayed ? "replayed" : "applied",
      resetRunId: input.resetRunId,
      snapshotId: input.plan.snapshotId,
    };
  }
}

async function tableSnapshot(database: D1Database): Promise<string> {
  const [tenants, users, memberships] = await Promise.all([
    database
      .prepare("SELECT * FROM tenant_registry ORDER BY organization_id")
      .all(),
    database.prepare("SELECT * FROM users ORDER BY id").all(),
    database
      .prepare("SELECT * FROM organization_memberships ORDER BY id")
      .all(),
  ]);
  return JSON.stringify({
    memberships: memberships.results,
    tenants: tenants.results,
    users: users.results,
  });
}

beforeAll(async () => {
  await server.listen();
  await server.getWorker<Env>().applyD1Migrations("DB");
});

afterAll(async () => {
  await server.close();
});

describe("demo bootstrap registration", () => {
  it("scopes and sorts the active tenant roster for the exact base", async () => {
    const environment = await server.getWorker<Env>().getEnv();
    await environment.DB.batch([
      environment.DB.prepare(
        `INSERT INTO tenant_registry (
           organization_id, base_key, source_record_id, status,
           created_at, updated_at
         ) VALUES ('org_zeta', ?1, ?2, 'active', ?3, ?3)`,
      ).bind(baseKey, `rec${"Z".repeat(14)}`, timestamp),
      environment.DB.prepare(
        `INSERT INTO tenant_registry (
           organization_id, base_key, source_record_id, status,
           created_at, updated_at
         ) VALUES (?1, ?2, ?3, 'active', ?4, ?4)`,
      ).bind(demoOrganizationId, baseKey, organizationRecordId, timestamp),
      environment.DB.prepare(
        `INSERT INTO tenant_registry (
           organization_id, base_key, source_record_id, status,
           created_at, updated_at
         ) VALUES ('org_foreign', 'local:appForeign', ?1, 'active', ?2, ?2)`,
      ).bind(`rec${"F".repeat(14)}`, timestamp),
    ]);

    await expect(
      new D1DemoEventGuardReader(
        environment.DB,
        baseKey,
      ).activeOrganizationIds(),
    ).resolves.toEqual([demoOrganizationId, "org_zeta"]);

    await environment.DB.prepare("DELETE FROM tenant_registry").run();
  });

  it("does not repair an owner when an exact tenant coexists with a foreign tenant", async () => {
    const environment = await server.getWorker<Env>().getEnv();
    await environment.DB.batch([
      environment.DB.prepare(
        `INSERT INTO tenant_registry (
           organization_id, base_key, source_record_id, status,
           created_at, updated_at
         ) VALUES (?1, ?2, ?3, 'active', ?4, ?4)`,
      ).bind(demoOrganizationId, baseKey, organizationRecordId, timestamp),
      environment.DB.prepare(
        `INSERT INTO tenant_registry (
           organization_id, base_key, source_record_id, status,
           created_at, updated_at
         ) VALUES ('org_foreign', 'local:appForeign', ?1, 'active', ?2, ?2)`,
      ).bind(`rec${"F".repeat(14)}`, timestamp),
    ]);
    const before = await tableSnapshot(environment.DB);
    const authority = new RootAuthority();
    const service = new DemoBootstrapService({
      authority,
      baseKey,
      bucket: environment.UPLOADS,
      database: environment.DB,
      plan: await compileDemoSeed(demoSeedSource),
    });

    await expect(
      service.bootstrap({
        eventSourceRecordId: eventRecordId,
        operationId: "demo_bootstrap_conflicting_registry",
        organizationSourceRecordId: organizationRecordId,
        ownerEmail: "owner@example.test",
      }),
    ).rejects.toMatchObject({ code: "conflicting_state" });

    expect(await tableSnapshot(environment.DB)).toBe(before);
    expect(authority.synchronizeCalls).toBe(0);
    await environment.DB.prepare("DELETE FROM tenant_registry").run();
  });

  it("does not register a tenant around a conflicting inactive owner identity", async () => {
    const environment = await server.getWorker<Env>().getEnv();
    await environment.DB.prepare(
      `INSERT INTO users (
         id, email_normalized, status, created_at, updated_at
       ) VALUES ('usr_inactive_demo_owner', 'owner@example.test',
                 'disabled', ?1, ?1)`,
    )
      .bind(timestamp)
      .run();
    const before = await tableSnapshot(environment.DB);
    const authority = new RootAuthority();
    const service = new DemoBootstrapService({
      authority,
      baseKey,
      bucket: environment.UPLOADS,
      database: environment.DB,
      plan: await compileDemoSeed(demoSeedSource),
    });

    await expect(
      service.bootstrap({
        eventSourceRecordId: eventRecordId,
        operationId: "demo_bootstrap_conflicting_owner",
        organizationSourceRecordId: organizationRecordId,
        ownerEmail: "owner@example.test",
      }),
    ).rejects.toMatchObject({ code: "conflicting_state" });

    expect(await tableSnapshot(environment.DB)).toBe(before);
    expect(authority.synchronizeCalls).toBe(0);
    await environment.DB.prepare("DELETE FROM users").run();
  });

  it("becomes ready only through synchronization and verifies the full snapshot", async () => {
    const environment = await server.getWorker<Env>().getEnv();
    const plan = await compileDemoSeed(demoSeedSource);
    const authority = new ConvergingAuthority(
      environment.DB,
      environment.UPLOADS,
      plan,
    );
    const service = new DemoBootstrapService({
      authority,
      baseKey,
      bucket: environment.UPLOADS,
      database: environment.DB,
      plan,
    });

    await expect(
      service.bootstrap({
        eventSourceRecordId: eventRecordId,
        operationId: "demo_bootstrap_complete_snapshot",
        organizationSourceRecordId: organizationRecordId,
        ownerEmail: "owner@example.test",
      }),
    ).resolves.toMatchObject({
      assetCount: plan.assets.length,
      authorityReady: true,
      receipt: {
        digest: plan.digest,
        operationCount: plan.operations.length,
        snapshotId: plan.snapshotId,
      },
      rootLineageVerified: true,
    });
    await expect(
      environment.DB.prepare(
        `SELECT authority_ready_at FROM tenant_registry
         WHERE organization_id = ?1`,
      )
        .bind(demoOrganizationId)
        .first(),
    ).resolves.toEqual({ authority_ready_at: timestamp });
  });

  it("resumes after root items advance without reapplying the strict initial-root gate", async () => {
    const environment = await server.getWorker<Env>().getEnv();
    await environment.DB.prepare("DELETE FROM demo_snapshot_items").run();
    await environment.DB.prepare("DELETE FROM demo_snapshot_runs").run();
    await environment.DB.prepare("DELETE FROM organization_memberships").run();
    await environment.DB.prepare("DELETE FROM users").run();
    await environment.DB.prepare("DELETE FROM authority_source_records").run();
    await environment.DB.prepare("DELETE FROM p_events").run();
    await environment.DB.prepare("DELETE FROM p_organizations").run();
    await environment.DB.prepare("DELETE FROM tenant_registry").run();
    const plan = await compileDemoSeed(demoSeedSource);
    const authority = new ConvergingAuthority(
      environment.DB,
      environment.UPLOADS,
      plan,
      { interruptOnce: true },
    );
    const service = new DemoBootstrapService({
      authority,
      baseKey,
      bucket: environment.UPLOADS,
      database: environment.DB,
      plan,
    });
    const input = {
      eventSourceRecordId: eventRecordId,
      operationId: "demo_bootstrap_interrupted_roots",
      organizationSourceRecordId: organizationRecordId,
      ownerEmail: "owner@example.test",
    };

    await expect(service.bootstrap(input)).rejects.toMatchObject({
      code: "authority_unavailable",
    });
    await expect(service.bootstrap(input)).resolves.toMatchObject({
      authorityReady: true,
      receipt: { outcome: "replayed" },
      rootLineageVerified: true,
    });
    expect(authority.rootInspectionCalls).toBe(1);
  });
});
