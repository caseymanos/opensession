import { createTestHarness } from "wrangler";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { FixtureBaseAuthority } from "./fixtures/airtable-authority-runtime";

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

async function evictAuthority(): Promise<void> {
  await runtimeWorker.evictDurableObject("BASE_AUTHORITY", {
    name: "local:appAuthorityFixture",
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
    "0013_email_queue_handoff.sql",
    "0014_schedule_domain.sql",
    "0015_demo_bootstrap_authorization.sql",
    "0016_organizer_submissions.sql",
    "0018_schedule_publication.sql",
    "0019_speaker_profiles.sql",
  ]) {
    const lines = readFileSync(
      resolve(process.cwd(), "migrations", filename),
      "utf8",
    ).split("\n");
    let current: string[] = [];
    let inTrigger = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("CREATE TRIGGER")) {
        inTrigger = true;
      }
      if (trimmed || current.length > 0) {
        current.push(line);
      }
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

function command(commandId: string, entityId: string) {
  return {
    audit: {
      action: "events.update",
      actorType: "system",
      eventId: entityId,
      requestId: `req_${commandId}`,
      safeDiff: { status: { from: "draft", to: "active" } },
    },
    commandId,
    entityId,
    expectedVersion: 0,
    fields: {
      Name: `Event ${entityId}`,
      Slug: entityId,
      Status: "open",
      Timezone: "UTC",
    },
    operation: "events.update",
    organizationId: "org_fixture",
    table: "events",
  };
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

async function providerMutationCount(): Promise<number> {
  const response = await server.fetch("/provider-stats");
  return ((await response.json()) as { mutationCount: number }).mutationCount;
}

async function providerReadbackCount(): Promise<number> {
  const response = await server.fetch("/provider-readback-count");
  return ((await response.json()) as { readbackCount: number }).readbackCount;
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMilliseconds = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for authority recovery.");
}

beforeAll(async () => {
  await server.listen();
  const response = await post("/setup", {
    statements: readMigrationStatements(),
  });
  expect(response.status).toBe(204);
});

afterAll(async () => {
  await server.close();
});

describe("BaseAuthority Durable Object", () => {
  it("survives Airtable success, D1 failure, eviction, and repair without replaying Airtable", async () => {
    const authorityCommand = command("cmd_projection_failure", "evt_failure");
    const first = await post("/execute", authorityCommand);

    expect(first.status, await first.clone().text()).toBe(200);
    const original = await first.json();
    expect(original).toMatchObject({
      commandId: "cmd_projection_failure",
      projection: "repair_pending",
      status: "committed_with_repair",
    });
    await evictAuthority();
    await post("/allow-projection");
    const recovery = await post("/recover");
    expect(recovery.status).toBe(200);
    const recoveryResult = (await recovery.json()) as { recovered: number };
    expect([0, 1]).toContain(recoveryResult.recovered);

    const inspection = await server.fetch(
      "/inspect?commandId=cmd_projection_failure",
    );
    await expect(inspection.json()).resolves.toMatchObject({
      attemptCount: 1,
      originalResponse: original,
      state: "complete",
    });
    const replay = await post("/execute", authorityCommand);
    await expect(replay.json()).resolves.toEqual(original);
    const provider = await server.fetch("/provider-stats");
    await expect(provider.json()).resolves.toEqual({
      mutationCount: 1,
      recordCount: 1,
    });
    const d1 = await server.fetch("/d1-state");
    await expect(d1.json()).resolves.toEqual({
      audit_count: 1,
      event_count: 1,
      event_name: "Event evt_failure",
      event_source_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      event_status: "open",
      idempotency_count: 1,
      idempotency_response_status: 202,
      idempotency_status: "committed_with_repair",
      outbox_count: 1,
      operational_count: 2,
      operational_events:
        "authority.projection.repair_pending,authority.projection.repaired",
      repair_count: 1,
      repair_status: "complete",
    });
  });

  it("resolves an ambiguous success by readback and rejects command-ID reuse", async () => {
    await post("/ambiguous-next");
    const authorityCommand = command("cmd_ambiguous", "evt_ambiguous");
    const response = await post("/execute", authorityCommand);

    expect(response.status, await response.clone().text()).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      commandId: "cmd_ambiguous",
      status: "committed",
    });
    const conflict = await post(
      "/execute",
      command("cmd_ambiguous", "evt_different"),
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: "AuthorityIdempotencyConflictError",
    });
    const changedAudit = {
      ...authorityCommand,
      audit: {
        ...authorityCommand.audit,
        requestId: "req_changed_audit",
      },
    };
    const auditConflict = await post("/execute", changedAudit);
    expect(auditConflict.status).toBe(409);
    await expect(auditConflict.json()).resolves.toMatchObject({
      error: "AuthorityIdempotencyConflictError",
    });
    const provider = await server.fetch("/provider-stats");
    await expect(provider.json()).resolves.toEqual({
      mutationCount: 2,
      recordCount: 2,
    });
  });

  it("retains the provider lease across an ambiguous negative readback", async () => {
    const before = await providerMutationCount();
    await post("/hide-records");
    await post("/ambiguous-next");
    const authorityCommand = command(
      "cmd_ambiguous_hidden",
      "evt_ambiguous_hidden",
    );

    const first = await post("/execute", authorityCommand);
    await expect(first.json()).resolves.toMatchObject({
      error: "AuthorityOutcomeUnknownError",
    });
    expect(await providerMutationCount()).toBe(before + 1);
    const pending = await server.fetch(
      "/inspect?commandId=cmd_ambiguous_hidden",
    );
    await expect(pending.json()).resolves.toMatchObject({
      attemptCount: 1,
      state: "outcome_unknown",
    });

    const replay = await post("/execute", authorityCommand);
    await expect(replay.json()).resolves.toMatchObject({
      error: "AuthorityOutcomeUnknownError",
    });
    expect(await providerMutationCount()).toBe(before + 1);

    await post("/reveal-records");
    await waitFor(async () => {
      const response = await server.fetch(
        "/inspect?commandId=cmd_ambiguous_hidden",
      );
      const inspection = (await response.json()) as { state?: string } | null;
      return inspection?.state === "complete";
    });
    expect(await providerMutationCount()).toBe(before + 1);
  });

  it("replays deterministic provider failures exactly", async () => {
    const invalidVersion = {
      ...command("cmd_failed_version", "evt_failed_version"),
      expectedVersion: 1,
    };
    const first = await post("/execute", invalidVersion);
    expect(first.status).toBe(409);
    const original = await first.json();
    expect(original).toEqual({
      error: "AirtableVersionConflictError",
      message: "Authority command failed with AirtableVersionConflictError.",
    });

    const replay = await post("/execute", invalidVersion);
    expect(replay.status).toBe(first.status);
    await expect(replay.json()).resolves.toEqual(original);
    const idempotency = await server.fetch(
      "/idempotency-state?commandId=cmd_failed_version",
    );
    await expect(idempotency.json()).resolves.toEqual({
      error_code: "AirtableVersionConflictError",
      original_response_json: JSON.stringify(original),
      original_response_status: 409,
      status: "failed",
    });
    const operational = await server.fetch(
      "/operational-events?commandId=cmd_failed_version",
    );
    await expect(operational.json()).resolves.toEqual([
      {
        attempt_count: 1,
        error_code: "AirtableVersionConflictError",
        event_type: "authority.command.failed",
        outcome: "failure",
        request_id: "req_cmd_failed_version",
      },
    ]);
  });

  it("serializes a later entity mutation through ambiguous readback", async () => {
    const beforeResponse = await server.fetch("/provider-stats");
    const before = (await beforeResponse.json()) as { mutationCount: number };
    await post("/ambiguous-delayed-next");
    const firstCommand = command("cmd_serial_first", "evt_serial");
    const firstPromise = post("/execute", firstCommand);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const secondCommand = {
      ...command("cmd_serial_second", "evt_serial"),
      expectedVersion: 1,
      fields: {
        ...firstCommand.fields,
        Name: "Serialized second event name",
      },
    };
    const [first, second] = await Promise.all([
      firstPromise,
      post("/execute", secondCommand),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const afterResponse = await server.fetch("/provider-stats");
    const after = (await afterResponse.json()) as { mutationCount: number };
    expect(after.mutationCount).toBe(before.mutationCount + 2);
    const event = await server.fetch("/event-state?id=evt_serial");
    await expect(event.json()).resolves.toMatchObject({
      id: "evt_serial",
      name: "Serialized second event name",
      source_content_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      source_version: 2,
    });
  });

  it("recovers an ambiguously applied write by alarm after supported eviction", async () => {
    const before = await providerMutationCount();
    await post("/hide-records");
    await post("/ambiguous-next");
    const authorityCommand = command("cmd_alarm_recovery", "evt_alarm");
    const interrupted = await post("/execute", authorityCommand);
    await expect(interrupted.json()).resolves.toMatchObject({
      error: "AuthorityOutcomeUnknownError",
    });
    await post("/clear-authority-alarm");
    expect(await providerMutationCount()).toBe(before + 1);
    await evictAuthority();
    await post("/reveal-records");

    await waitFor(async () => {
      const response = await server.fetch(
        "/inspect?commandId=cmd_alarm_recovery",
      );
      const inspection = (await response.json()) as { state?: string } | null;
      return inspection?.state === "complete";
    });

    expect(await providerMutationCount()).toBe(before + 1);
    const event = await server.fetch("/event-state?id=evt_alarm");
    await expect(event.json()).resolves.toMatchObject({
      id: "evt_alarm",
      name: "Event evt_alarm",
      source_content_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      source_version: 1,
    });
    const replay = await post("/execute", authorityCommand);
    await expect(replay.json()).resolves.toMatchObject({
      commandId: "cmd_alarm_recovery",
      status: "committed",
    });
  });

  it("does not replay an invisible provider write before its lease expires", async () => {
    const before = await providerMutationCount();
    await post("/hide-records");
    await post("/ambiguous-next");
    const authorityCommand = command("cmd_leased_write", "evt_leased_write");
    const interrupted = await post("/execute", authorityCommand);
    await expect(interrupted.json()).resolves.toMatchObject({
      error: "AuthorityOutcomeUnknownError",
    });
    expect(
      (
        await post("/extend-authority-lease-for-test", {
          commandId: authorityCommand.commandId,
        })
      ).status,
    ).toBe(204);
    await post("/clear-authority-alarm");
    expect(await providerMutationCount()).toBe(before + 1);
    const readsAfterDispatch = await providerReadbackCount();
    const pending = await server.fetch("/inspect?commandId=cmd_leased_write");
    await expect(pending.json()).resolves.toMatchObject({
      attemptCount: 1,
      state: "outcome_unknown",
    });
    await evictAuthority();

    const recovery = await post("/recover");
    await expect(recovery.json()).resolves.toEqual({ recovered: 0 });
    expect(await providerReadbackCount()).toBe(readsAfterDispatch);
    const replayWhileLeased = await post("/execute", authorityCommand);
    await expect(replayWhileLeased.json()).resolves.toMatchObject({
      error: "AuthorityOutcomeUnknownError",
    });
    expect(await providerReadbackCount()).toBe(readsAfterDispatch + 1);
    expect(await providerMutationCount()).toBe(before + 1);
    const leased = await server.fetch("/inspect?commandId=cmd_leased_write");
    await expect(leased.json()).resolves.toMatchObject({
      attemptCount: 1,
      state: "outcome_unknown",
    });

    expect(
      (
        await post("/expire-authority-lease-for-test", {
          commandId: authorityCommand.commandId,
        })
      ).status,
    ).toBe(204);
    await post("/reveal-records");
    const expiredRecovery = await post("/recover");
    await expect(expiredRecovery.json()).resolves.toEqual({ recovered: 1 });
    expect(await providerMutationCount()).toBe(before + 1);
    const event = await server.fetch("/event-state?id=evt_leased_write");
    await expect(event.json()).resolves.toMatchObject({
      id: "evt_leased_write",
      source_version: 1,
    });
  });

  it("upgrades a persisted v2 authority cursor to v5 without losing state", async () => {
    expect(
      (
        await post("/configure-webhook", {
          cursor: 37,
          webhookId: "webhook_v2_upgrade",
        })
      ).status,
    ).toBe(204);
    expect((await post("/downgrade-authority-schema")).status).toBe(204);
    await evictAuthority();

    const state = await server.fetch("/authority-state");
    await expect(state.json()).resolves.toEqual({
      committedCursor: 37,
      committedRosterHash: null,
      schemaVersion: 5,
      webhookId: "webhook_v2_upgrade",
    });
  });

  it("adds the CFP plan ledger to a persisted v3 authority object", async () => {
    expect(
      (
        await post("/configure-webhook", {
          cursor: 41,
          webhookId: "webhook_v3_upgrade",
        })
      ).status,
    ).toBe(204);
    expect((await post("/downgrade-authority-schema-v3")).status).toBe(204);
    await evictAuthority();

    const state = await server.fetch("/authority-state");
    await expect(state.json()).resolves.toEqual({
      committedCursor: 41,
      committedRosterHash: null,
      schemaVersion: 5,
      webhookId: "webhook_v3_upgrade",
    });
  });
});
