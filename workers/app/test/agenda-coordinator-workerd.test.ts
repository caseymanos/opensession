import {
  calendarChangeIntentSchema,
  scheduleCommandResponseSchema,
  scheduleCommittedEventSchema,
  scheduleSnapshotSchema,
  type ScheduleCommand,
  type ScheduleCommandResponse,
} from "@sessionbox-killer/contracts";
import {
  hashAirtableContent,
  managedAirtableContent,
  type AirtableFields,
} from "@sessionbox-killer/data/airtable/internal";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AgendaCoordinator } from "../src/schedule/coordinator";
import { compileDemoSeed, resolveDemoSeedFields } from "../src/demo/compiler";
import {
  demoEventId,
  demoOrganizationId,
  demoSeedSource,
} from "../src/demo/fixture";
import type FixtureAuthorityRuntime from "./fixtures/airtable-authority-runtime";
import type {
  FixtureAgendaCoordinator,
  FixtureBaseAuthority,
} from "./fixtures/airtable-authority-runtime";
import { D1PublicScheduleProjectionReader } from "../src/public-schedule/projection";
import { D1ScheduleProjectionRepository } from "../src/schedule/d1-repository";

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

interface RuntimeEnvironment {
  AGENDA_COORDINATOR: DurableObjectNamespace<AgendaCoordinator>;
  BASE_AUTHORITY: DurableObjectNamespace<FixtureBaseAuthority>;
  DB: D1Database;
  FIXTURE_AGENDA_COORDINATOR: DurableObjectNamespace<FixtureAgendaCoordinator>;
}

const runtimeWorker = server.getWorker<
  RuntimeEnvironment,
  { default: typeof FixtureAuthorityRuntime }
>("opensession-airtable-authority-completion-runtime");
let runtimeFixture: Awaited<ReturnType<typeof runtimeWorker.getExport>>;
let environment: RuntimeEnvironment;

async function fixtureFetch(path: string, body?: unknown): Promise<Response> {
  const response = await runtimeFixture.fetch(
    new URL(path, "http://fixture.invalid").toString(),
    {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: { "Content-Type": "application/json" },
          }),
    },
  );
  const responseBody = await response.arrayBuffer();
  return new Response(responseBody.byteLength === 0 ? null : responseBody, {
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
    "0013_email_queue_handoff.sql",
    "0014_schedule_domain.sql",
    "0015_demo_bootstrap_authorization.sql",
    "0016_organizer_submissions.sql",
    "0018_schedule_publication.sql",
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
      throw new Error(`${filename} is incomplete.`);
    }
  }
  return statements;
}

async function post(path: string, body?: unknown): Promise<Response> {
  return fixtureFetch(path, body ?? {});
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMilliseconds = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for agenda coordinator fixture state.");
}

async function invocationCount(eventId: string): Promise<number> {
  const row = await environment.DB.prepare(
    `SELECT COUNT(*) AS count FROM agenda_fixture_invocations
     WHERE event_id = ?`,
  )
    .bind(eventId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function providerMutationCount(): Promise<number> {
  const response = await fixtureFetch("/provider-stats");
  return ((await response.json()) as { mutationCount: number }).mutationCount;
}

async function invalidationVersion(): Promise<number> {
  const row = await environment.DB.prepare(
    `SELECT invalidation_version FROM authority_cache_invalidations
     WHERE organization_id = ? AND event_id = ?`,
  )
    .bind(demoOrganizationId, demoEventId)
    .first<{ invalidation_version: number }>();
  return row?.invalidation_version ?? 0;
}

function coordinatorInput(command: ScheduleCommand) {
  return {
    actorId: "usr_demo_owner",
    command,
    requestId: `req_${command.commandId}`,
  };
}

async function execute(
  command: ScheduleCommand,
): Promise<ScheduleCommandResponse> {
  const response = await fixtureFetch(
    "/agenda-command",
    coordinatorInput(command),
  );
  return scheduleCommandResponseSchema.parse(await response.json());
}

beforeAll(async () => {
  await server.listen();
  runtimeFixture = await runtimeWorker.getExport();
  environment = await runtimeWorker.getEnv();
  const setup = await post("/setup", {
    statements: readMigrationStatements(),
  });
  expect(setup.status).toBe(204);
  expect((await post("/allow-projection")).status).toBe(204);
  expect(
    (await post("/setup-tenant", { organizationId: demoOrganizationId }))
      .status,
  ).toBe(204);

  const plan = await compileDemoSeed(demoSeedSource);
  const recordIds = new Map(
    plan.operations.map((operation) => [
      operation.entityId,
      `rec_${operation.table}_${operation.entityId}`,
    ]),
  );
  for (const operation of plan.operations) {
    const fields: AirtableFields = {
      ...resolveDemoSeedFields(operation.fields, recordIds),
      ID: operation.entityId,
    };
    const sourceVersion = 1;
    const sourceContentHash = await hashAirtableContent(
      managedAirtableContent(operation.table, fields),
      sourceVersion,
    );
    const seeded = await post("/seed-provider", {
      fields: {
        ...fields,
        "Applied content hash": sourceContentHash,
        "Source version": sourceVersion,
      },
      recordId: recordIds.get(operation.entityId),
      table: operation.table,
    });
    expect(seeded.status).toBe(204);
  }
  const reconciled = await post("/reconcile", {
    organizationId: demoOrganizationId,
  });
  expect(reconciled.status, await reconciled.clone().text()).toBe(200);
}, 120_000);

afterAll(async () => {
  await server.close();
});

describe.sequential("RAL-63 AgendaCoordinator Workerd invariants", () => {
  it("serializes one event while a different event proceeds independently", async () => {
    const eventA = "evt_coordinator_lane_a";
    const eventB = "evt_coordinator_lane_b";
    await environment.DB.prepare(
      `INSERT INTO agenda_fixture_controls (event_id, blocked)
       VALUES (?, 1), (?, 0)`,
    )
      .bind(eventA, eventB)
      .run();
    const coordinatorA =
      environment.FIXTURE_AGENDA_COORDINATOR.getByName(eventA);
    const coordinatorB =
      environment.FIXTURE_AGENDA_COORDINATOR.getByName(eventB);
    const first = coordinatorA.execute(
      coordinatorInput({
        commandId: "cmd_fixture_lane_a_first",
        eventId: eventA,
        expectedVersion: 3,
        type: "publish_schedule",
      }),
    );
    await waitFor(async () => (await invocationCount(eventA)) === 1);
    const second = coordinatorA.execute(
      coordinatorInput({
        commandId: "cmd_fixture_lane_a_second",
        eventId: eventA,
        expectedVersion: 3,
        type: "publish_schedule",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await invocationCount(eventA)).toBe(1);

    const independent = await coordinatorB.execute(
      coordinatorInput({
        commandId: "cmd_fixture_lane_b",
        eventId: eventB,
        expectedVersion: 3,
        type: "publish_schedule",
      }),
    );
    expect(scheduleCommandResponseSchema.parse(independent).ok).toBe(true);
    expect(await invocationCount(eventB)).toBe(1);

    await environment.DB.prepare(
      `UPDATE agenda_fixture_controls SET blocked = 0 WHERE event_id = ?`,
    )
      .bind(eventA)
      .run();
    const sameEvent = await Promise.all([first, second]);
    expect(sameEvent.map((response) => response.ok)).toEqual([true, true]);
    expect(await invocationCount(eventA)).toBe(2);
  });

  it("allows exactly one concurrent conflicting organizer command", async () => {
    const beforeMutations = await providerMutationCount();
    const commands = ["session_05", "session_06"].map(
      (sessionId, index) =>
        ({
          commandId: `cmd_race_organizer_${index + 1}`,
          durationMinutes: 60,
          eventId: demoEventId,
          expectedVersion: 3,
          overrideReason:
            "Organizer approved the rehearsal readiness exception",
          roomId: "room_redwood",
          sessionId,
          startAt: "2026-10-14T19:00:00.000Z",
          type: "place_session",
        }) satisfies ScheduleCommand,
    );
    const responses = await Promise.all(commands.map(execute));
    const winner = responses.find((response) => response.ok);
    const loser = responses.find((response) => !response.ok);
    expect(responses.filter((response) => response.ok)).toHaveLength(1);
    expect(loser).toMatchObject({
      error: {
        actualVersion: 4,
        code: "schedule_version_conflict",
        expectedVersion: 3,
      },
      ok: false,
    });
    if (!winner?.ok) throw new Error("The race did not produce a winner.");
    expect(winner.result.snapshot.event.version).toBe(4);
    expect(await providerMutationCount()).toBe(beforeMutations + 3);

    const snapshot = scheduleSnapshotSchema.parse(
      await (
        await fixtureFetch(`/schedule-state?eventId=${demoEventId}`)
      ).json(),
    );
    const racedSessions = snapshot.sessions.filter(({ id }) =>
      commands.some((command) => command.sessionId === id),
    );
    expect(racedSessions.filter(({ slot }) => slot !== null)).toHaveLength(1);

    const losingCommand = commands.find(
      ({ sessionId }) =>
        winner.result.snapshot.sessions.find(({ id }) => id === sessionId)
          ?.slot === null,
    );
    if (!losingCommand) throw new Error("The race loser was not recoverable.");
    const beforeConflict = await providerMutationCount();
    const revalidated = await execute({
      ...losingCommand,
      commandId: "cmd_race_loser_revalidated",
      expectedVersion: 4,
    });
    expect(revalidated).toMatchObject({
      error: { code: "schedule_hard_conflict" },
      ok: false,
    });
    expect(await providerMutationCount()).toBe(beforeConflict);

    const winningCommand = commands.find(
      ({ commandId }) => winner.result.commandId === commandId,
    );
    if (!winningCommand)
      throw new Error("The race winner was not recoverable.");
    const duplicate = await execute(winningCommand);
    expect(duplicate).toMatchObject({ ok: true, result: { replayed: true } });
    expect(await providerMutationCount()).toBe(beforeConflict);
    await runtimeWorker.evictDurableObject("AGENDA_COORDINATOR", {
      name: demoEventId,
    });
    const afterRestart = await execute(winningCommand);
    expect(afterRestart).toMatchObject({
      ok: true,
      result: { replayed: true },
    });
    expect(await providerMutationCount()).toBe(beforeConflict);
  }, 60_000);

  it("repairs a projection failure before invalidation and broadcast", async () => {
    const snapshot = scheduleSnapshotSchema.parse(
      await (
        await fixtureFetch(`/schedule-state?eventId=${demoEventId}`)
      ).json(),
    );
    const unscheduled = snapshot.sessions.find(
      ({ id, slot }) =>
        (id === "session_05" || id === "session_06") && slot === null,
    );
    if (!unscheduled) throw new Error("Fixture has no race-loser session.");
    const upgrade = await runtimeFixture.fetch(
      `http://fixture.invalid/agenda-stream?eventId=${demoEventId}`,
      { headers: { Upgrade: "websocket" } },
    );
    expect(upgrade.status).toBe(101);
    const socket = upgrade.webSocket;
    if (!socket) throw new Error("Fixture WebSocket upgrade failed.");
    socket.accept();
    const messages: unknown[] = [];
    socket.addEventListener("message", (event: MessageEvent) => {
      messages.push(JSON.parse(String(event.data)) as unknown);
    });

    const beforeInvalidation = await invalidationVersion();
    const beforeMutations = await providerMutationCount();
    await environment.DB.prepare(
      `CREATE TRIGGER authority_fixture_fail_schedule_projection
       BEFORE INSERT ON p_schedule_slots
       BEGIN SELECT RAISE(ABORT, 'injected schedule projection failure'); END`,
    ).run();
    const command = {
      commandId: "cmd_projection_repair_agenda",
      durationMinutes: 45,
      eventId: demoEventId,
      expectedVersion: snapshot.event.version,
      overrideReason: "Organizer approved the rehearsal readiness exception",
      roomId: "room_redwood",
      sessionId: unscheduled.id,
      startAt: "2026-10-14T21:00:00.000Z",
      type: "place_session",
    } satisfies ScheduleCommand;
    const pending = await execute(command);
    expect(pending).toMatchObject({
      error: {
        code: "schedule_authority_pending",
        commandId: command.commandId,
        retryable: true,
        state: "projection_pending",
      },
      ok: false,
    });
    expect(await providerMutationCount()).toBe(beforeMutations + 1);
    expect(await invalidationVersion()).toBe(beforeInvalidation);
    expect(messages).toHaveLength(0);
    const visibleWhilePending = scheduleSnapshotSchema.parse(
      await (
        await fixtureFetch(`/schedule-state?eventId=${demoEventId}`)
      ).json(),
    );
    expect(visibleWhilePending.event.version).toBe(snapshot.event.version);
    expect(
      visibleWhilePending.sessions.find(({ id }) => id === unscheduled.id)
        ?.slot,
    ).toBeNull();

    await runtimeWorker.evictDurableObject("AGENDA_COORDINATOR", {
      name: demoEventId,
      webSockets: "hibernate",
    });
    await environment.DB.prepare(
      "DROP TRIGGER authority_fixture_fail_schedule_projection",
    ).run();
    await environment.BASE_AUTHORITY.getByName(
      "local:appAuthorityFixture",
    ).recoverPending();
    expect(await invalidationVersion()).toBe(beforeInvalidation);
    expect(messages).toHaveLength(0);
    expect(
      scheduleSnapshotSchema.parse(
        await (
          await fixtureFetch(`/schedule-state?eventId=${demoEventId}`)
        ).json(),
      ).event.version,
    ).toBe(snapshot.event.version);

    await waitFor(async () => {
      const current = scheduleSnapshotSchema.parse(
        await (
          await fixtureFetch(`/schedule-state?eventId=${demoEventId}`)
        ).json(),
      );
      return current.event.version === snapshot.event.version + 1;
    });
    await waitFor(() => messages.length === 1);
    expect(await providerMutationCount()).toBe(beforeMutations + 3);
    expect(await invalidationVersion()).toBe(beforeInvalidation);
    expect(scheduleCommittedEventSchema.parse(messages[0])).toMatchObject({
      commandId: command.commandId,
      eventId: demoEventId,
      scheduleVersion: snapshot.event.version + 1,
    });

    const mutationsAfterCommit = await providerMutationCount();
    const invalidationAfterCommit = await invalidationVersion();
    const replay = await execute(command);
    expect(replay).toMatchObject({ ok: true, result: { replayed: true } });
    expect(await providerMutationCount()).toBe(mutationsAfterCommit);
    expect(await invalidationVersion()).toBe(invalidationAfterCommit);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(messages).toHaveLength(1);
    socket.close(1000, "Fixture complete");
  }, 60_000);

  it("recovers an outcome-unknown write without replaying Airtable", async () => {
    const snapshot = scheduleSnapshotSchema.parse(
      await (
        await fixtureFetch(`/schedule-state?eventId=${demoEventId}`)
      ).json(),
    );
    const session = snapshot.sessions.find(
      ({ id, slot }) =>
        (id === "session_05" || id === "session_06") &&
        slot?.startAt === "2026-10-14T19:00:00.000Z",
    );
    if (!session?.slot) {
      throw new Error("Fixture race winner is not available for rescheduling.");
    }
    const upgrade = await runtimeFixture.fetch(
      `http://fixture.invalid/agenda-stream?eventId=${demoEventId}`,
      { headers: { Upgrade: "websocket" } },
    );
    const socket = upgrade.webSocket;
    if (!socket) throw new Error("Fixture WebSocket upgrade failed.");
    socket.accept();
    const messages: unknown[] = [];
    socket.addEventListener("message", (event: MessageEvent) => {
      messages.push(JSON.parse(String(event.data)) as unknown);
    });

    const beforeMutations = await providerMutationCount();
    const beforeInvalidation = await invalidationVersion();
    expect((await post("/ambiguous-hidden-next")).status).toBe(204);
    const command = {
      commandId: "cmd_outcome_unknown_agenda",
      durationMinutes: session.durationMinutes,
      eventId: demoEventId,
      expectedVersion: snapshot.event.version,
      overrideReason: "Organizer approved the rehearsal readiness exception",
      roomId: session.slot.roomId,
      sessionId: session.id,
      startAt: "2026-10-14T20:00:00.000Z",
      type: "reschedule_session",
    } satisfies ScheduleCommand;
    const pending = await execute(command);
    expect(pending).toMatchObject({
      error: {
        code: "schedule_authority_pending",
        commandId: command.commandId,
        retryable: true,
        state: "outcome_unknown",
      },
      ok: false,
    });
    expect(await providerMutationCount()).toBe(beforeMutations + 1);
    expect(await invalidationVersion()).toBe(beforeInvalidation);
    expect(messages).toHaveLength(0);
    const visibleWhilePending = scheduleSnapshotSchema.parse(
      await (
        await fixtureFetch(`/schedule-state?eventId=${demoEventId}`)
      ).json(),
    );
    expect(visibleWhilePending.event.version).toBe(snapshot.event.version);
    expect(
      visibleWhilePending.sessions.find(({ id }) => id === session.id)?.slot
        ?.startAt,
    ).toBe(session.slot.startAt);

    expect((await post("/reveal-records")).status).toBe(204);
    await waitFor(async () => {
      const current = scheduleSnapshotSchema.parse(
        await (
          await fixtureFetch(`/schedule-state?eventId=${demoEventId}`)
        ).json(),
      );
      return current.event.version === snapshot.event.version + 1;
    });
    await waitFor(() => messages.length === 1);

    expect(await providerMutationCount()).toBe(beforeMutations + 2);
    expect(await invalidationVersion()).toBe(beforeInvalidation);
    expect(scheduleCommittedEventSchema.parse(messages[0])).toMatchObject({
      commandId: command.commandId,
      scheduleVersion: snapshot.event.version + 1,
    });
    const replay = await execute(command);
    expect(replay).toMatchObject({ ok: true, result: { replayed: true } });
    expect(await providerMutationCount()).toBe(beforeMutations + 2);
    expect(await invalidationVersion()).toBe(beforeInvalidation);
    socket.close(1000, "Fixture complete");
  }, 60_000);

  it("rejects a revalidated hard conflict before any authority mutation", async () => {
    const coordinator = environment.AGENDA_COORDINATOR.getByName(demoEventId);
    const previewBefore = await coordinator.previewPublication(demoEventId);
    expect(previewBefore.counts.hardConflicts).toBeGreaterThan(0);
    const beforeMutations = await providerMutationCount();
    const rejected = await execute({
      commandId: "cmd_publish_hard_conflict",
      eventId: demoEventId,
      expectedVersion: previewBefore.scheduleVersion,
      type: "publish_schedule",
    });
    expect(rejected).toMatchObject({
      error: { code: "schedule_hard_conflict" },
      ok: false,
    });
    expect(await providerMutationCount()).toBe(beforeMutations);

    const conflict = previewBefore.hardConflicts[0];
    if (!conflict) throw new Error("Fixture hard conflict disappeared.");
    const snapshot = await new D1ScheduleProjectionRepository(
      environment.DB,
    ).read(demoEventId);
    const session = snapshot?.sessions.find(
      ({ id }) => id === conflict.sessionB.id,
    );
    if (!session?.slot) throw new Error("Conflict session has no placement.");
    const startAt = "2026-10-14T22:00:00.000Z";
    const endAt = new Date(
      Date.parse(startAt) + session.durationMinutes * 60_000,
    ).toISOString();
    await environment.DB.prepare(
      `UPDATE p_schedule_slots SET room_id = 'room_redwood',
         starts_at = ?, ends_at = ?
       WHERE organization_id = ? AND event_id = ? AND session_id = ?`,
    )
      .bind(
        startAt,
        endAt,
        demoOrganizationId,
        demoEventId,
        conflict.sessionB.id,
      )
      .run();
    const resolved = await coordinator.previewPublication(demoEventId);
    expect(resolved.counts.hardConflicts).toBe(0);
  });

  it("commits one immutable public snapshot with warning audit and replay safety", async () => {
    const coordinator = environment.AGENDA_COORDINATOR.getByName(demoEventId);
    await environment.DB.prepare(
      `UPDATE p_sessions SET expected_attendance = 10000
       WHERE organization_id = ? AND event_id = ?
         AND id = (
           SELECT session_id FROM p_schedule_slots
           WHERE organization_id = ? AND event_id = ?
             AND source_deleted_at IS NULL
           ORDER BY session_id LIMIT 1
         )`,
    )
      .bind(demoOrganizationId, demoEventId, demoOrganizationId, demoEventId)
      .run();
    const preview = await coordinator.previewPublication(demoEventId);
    expect(preview.canPublish).toBe(true);
    expect(preview.softWarnings.length).toBeGreaterThan(0);
    const command = {
      commandId: "cmd_publication_snapshot",
      eventId: demoEventId,
      expectedVersion: preview.scheduleVersion,
      ...(preview.softWarnings.length > 0
        ? {
            softWarningOverride: {
              reason: "Organizer reviewed every named publication warning",
              warningKeys: preview.softWarnings.map(({ key }) => key),
            },
          }
        : {}),
      type: "publish_schedule" as const,
    };
    if (preview.softWarnings.length > 0) {
      const missingOverride = await execute({
        commandId: "cmd_publication_missing_override",
        eventId: demoEventId,
        expectedVersion: preview.scheduleVersion,
        type: "publish_schedule",
      });
      expect(missingOverride).toMatchObject({
        error: {
          code: "schedule_validation_error",
          reason: "soft_warning_override_required",
        },
        ok: false,
      });
    }
    const beforeMutations = await providerMutationCount();
    const published = await execute(command);
    if (!published.ok) throw new Error(JSON.stringify(published.error));
    expect(published.result.snapshot.event.publicationVersion).toBe(
      preview.nextPublicationVersion,
    );
    expect(await providerMutationCount()).toBeGreaterThan(beforeMutations);

    const publication = await environment.DB.prepare(
      `SELECT publication_version, schedule_version, snapshot_id,
              snapshot_sha256, soft_warning_override_json
       FROM schedule_publications
       WHERE organization_id = ? AND event_id = ?
       ORDER BY publication_version DESC LIMIT 1`,
    )
      .bind(demoOrganizationId, demoEventId)
      .first<{
        publication_version: number;
        schedule_version: number;
        snapshot_id: string;
        snapshot_sha256: string;
        soft_warning_override_json: string | null;
      }>();
    expect(publication).toMatchObject({
      publication_version: preview.nextPublicationVersion,
      schedule_version: preview.scheduleVersion + 1,
    });
    expect(publication?.snapshot_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Boolean(publication?.soft_warning_override_json)).toBe(
      preview.softWarnings.length > 0,
    );

    const audit = await environment.DB.prepare(
      `SELECT action, safe_diff_json, metadata_json FROM audit_events
       WHERE organization_id = ? AND command_id = ?`,
    )
      .bind(demoOrganizationId, command.commandId)
      .first<{
        action: string;
        metadata_json: string;
        safe_diff_json: string;
      }>();
    expect(audit?.action).toBe("schedule.publication.committed");
    expect(JSON.parse(audit?.safe_diff_json ?? "{}")).toMatchObject({
      from_publication_version: preview.currentPublicationVersion,
      to_publication_version: preview.nextPublicationVersion,
    });

    const invalidation = await environment.DB.prepare(
      `SELECT invalidation_version, publication_version, surfaces_json, status
       FROM authority_cache_invalidations
       WHERE organization_id = ? AND event_id = ?`,
    )
      .bind(demoOrganizationId, demoEventId)
      .first<{
        invalidation_version: number;
        publication_version: number;
        status: string;
        surfaces_json: string;
      }>();
    if (!invalidation)
      throw new Error("Publication invalidation was not saved.");
    expect(invalidation.publication_version).toBe(
      preview.nextPublicationVersion,
    );
    expect(JSON.parse(invalidation.surfaces_json)).toEqual([
      "schedule",
      "gallery",
      "feed",
    ]);
    expect(invalidation.status).toBe("enqueued");
    const invalidationMessage = {
      event_id: demoEventId,
      invalidation_version: invalidation.invalidation_version,
      kind: "public_schedule.cache.invalidate",
      organization_id: demoOrganizationId,
      publication_version: preview.nextPublicationVersion,
      surfaces: ["schedule", "gallery", "feed"],
      version: 3,
    };
    expect(
      (
        await post("/process-cache-invalidation", {
          ...invalidationMessage,
          publication_version: preview.nextPublicationVersion + 1,
        })
      ).status,
    ).toBe(204);
    expect(
      await environment.DB.prepare(
        `SELECT status FROM authority_cache_invalidations
         WHERE organization_id = ? AND event_id = ?`,
      )
        .bind(demoOrganizationId, demoEventId)
        .first<{ status: string }>(),
    ).toEqual({ status: "enqueued" });
    expect(
      (await post("/process-cache-invalidation", invalidationMessage)).status,
    ).toBe(204);
    expect(
      await environment.DB.prepare(
        `SELECT status FROM authority_cache_invalidations
         WHERE organization_id = ? AND event_id = ?`,
      )
        .bind(demoOrganizationId, demoEventId)
        .first<{ status: string }>(),
    ).toEqual({ status: "processed" });

    const publicRead = await new D1PublicScheduleProjectionReader(
      environment.DB,
    ).readBySlug(published.result.snapshot.event.slug);
    expect(publicRead?.projection.version).toBe(preview.nextPublicationVersion);

    const mutationCount = await providerMutationCount();
    const replay = await execute(command);
    expect(replay).toMatchObject({ ok: true, result: { replayed: true } });
    expect(await providerMutationCount()).toBe(mutationCount);
    const publicationCount = await environment.DB.prepare(
      `SELECT COUNT(*) AS count FROM schedule_publications
       WHERE organization_id = ? AND event_id = ? AND command_id = ?`,
    )
      .bind(demoOrganizationId, demoEventId, command.commandId)
      .first<{ count: number }>();
    expect(publicationCount?.count).toBe(1);
  }, 60_000);

  it("keeps the last public version through change facts and failed finalization", async () => {
    const coordinator = environment.AGENDA_COORDINATOR.getByName(demoEventId);
    const published = await new D1ScheduleProjectionRepository(
      environment.DB,
    ).read(demoEventId);
    const publishedSessions =
      published?.sessions.filter(
        (session) => session.state === "published" && session.slot,
      ) ?? [];
    const rescheduledSession = publishedSessions[0];
    const canceledSession = publishedSessions[1];
    if (!published || !rescheduledSession?.slot || !canceledSession?.slot) {
      throw new Error("Fixture has fewer than two published sessions.");
    }
    const oldPublicVersion = published.event.publicationVersion;

    const rescheduleCommand = {
      commandId: "cmd_public_change_reschedule",
      durationMinutes: rescheduledSession.durationMinutes,
      eventId: demoEventId,
      expectedVersion: published.event.version,
      roomId: rescheduledSession.slot.roomId,
      sessionId: rescheduledSession.id,
      startAt: rescheduledSession.slot.startAt,
      type: "reschedule_session" as const,
    };
    await environment.DB.prepare(
      `CREATE TRIGGER fail_calendar_change_handoff
       BEFORE INSERT ON outbox_events
       WHEN NEW.event_type = 'calendar.change.requested'
       BEGIN SELECT RAISE(ABORT, 'injected calendar handoff failure'); END`,
    ).run();
    const calendarPending = await execute(rescheduleCommand);
    expect(calendarPending).toMatchObject({
      error: {
        code: "schedule_authority_pending",
        state: "projection_pending",
      },
      ok: false,
    });
    await environment.DB.prepare(
      "DROP TRIGGER fail_calendar_change_handoff",
    ).run();
    const rescheduled = await execute(rescheduleCommand);
    if (!rescheduled.ok) throw new Error(JSON.stringify(rescheduled.error));
    expect(rescheduled.result.replayed).toBe(true);
    const canceled = await execute({
      commandId: "cmd_public_change_cancel",
      eventId: demoEventId,
      expectedVersion: rescheduled.result.snapshot.event.version,
      sessionId: canceledSession.id,
      type: "cancel_session",
    });
    if (!canceled.ok) throw new Error(JSON.stringify(canceled.error));

    const facts = await environment.DB.prepare(
      `SELECT command_id, change_type, source_publication_version,
              request_id, actor_type, actor_id,
              calendar_intent_enqueued_at, calendar_outbox_id
       FROM schedule_public_changes
       WHERE organization_id = ? AND event_id = ?
         AND command_id IN (?, ?) ORDER BY command_id`,
    )
      .bind(
        demoOrganizationId,
        demoEventId,
        "cmd_public_change_reschedule",
        "cmd_public_change_cancel",
      )
      .all<{
        change_type: string;
        actor_id: string;
        actor_type: string;
        calendar_intent_enqueued_at: string;
        calendar_outbox_id: string;
        command_id: string;
        request_id: string;
        source_publication_version: number;
      }>();
    expect(facts.results).toMatchObject([
      expect.objectContaining({
        actor_id: "usr_demo_owner",
        actor_type: "user",
        change_type: "canceled",
        command_id: "cmd_public_change_cancel",
        request_id: "req_cmd_public_change_cancel",
        source_publication_version: oldPublicVersion,
      }),
      expect.objectContaining({
        actor_id: "usr_demo_owner",
        actor_type: "user",
        change_type: "rescheduled",
        command_id: "cmd_public_change_reschedule",
        request_id: "req_cmd_public_change_reschedule",
        source_publication_version: oldPublicVersion,
      }),
    ]);
    for (const fact of facts.results) {
      expect(fact.calendar_intent_enqueued_at).toMatch(/Z$/);
      expect(fact.calendar_outbox_id).toMatch(/^out_[0-9a-f]{26}$/);
    }
    const calendarChanges = await environment.DB.prepare(
      `SELECT payload_json FROM outbox_events
       WHERE organization_id = ? AND event_id = ?
         AND event_type = 'calendar.change.requested'
       ORDER BY idempotency_key`,
    )
      .bind(demoOrganizationId, demoEventId)
      .all<{ payload_json: string }>();
    expect(
      calendarChanges.results
        .map(({ payload_json }) =>
          calendarChangeIntentSchema.parse(JSON.parse(payload_json)),
        )
        .sort((left, right) => left.commandId.localeCompare(right.commandId)),
    ).toEqual([
      expect.objectContaining({
        changeType: "canceled",
        commandId: "cmd_public_change_cancel",
        previousPlacement: {
          endAt: canceledSession.slot.endAt,
          roomId: canceledSession.slot.roomId,
          startAt: canceledSession.slot.startAt,
        },
        requestId: "req_cmd_public_change_cancel",
        sourcePublicationVersion: oldPublicVersion,
      }),
      expect.objectContaining({
        changeType: "rescheduled",
        commandId: "cmd_public_change_reschedule",
        previousPlacement: {
          endAt: rescheduledSession.slot.endAt,
          roomId: rescheduledSession.slot.roomId,
          startAt: rescheduledSession.slot.startAt,
        },
        requestId: "req_cmd_public_change_reschedule",
        sourcePublicationVersion: oldPublicVersion,
      }),
    ]);
    const publicBeforeRetry = await new D1PublicScheduleProjectionReader(
      environment.DB,
    ).readBySlug(published.event.slug);
    expect(publicBeforeRetry?.projection.version).toBe(oldPublicVersion);

    const preview = await coordinator.previewPublication(demoEventId);
    expect(preview.canPublish).toBe(true);
    const publishCommand = {
      commandId: "cmd_publication_retry_finalization",
      eventId: demoEventId,
      expectedVersion: preview.scheduleVersion,
      ...(preview.softWarnings.length > 0
        ? {
            softWarningOverride: {
              reason: "Organizer reviewed every named publication warning",
              warningKeys: preview.softWarnings.map(({ key }) => key),
            },
          }
        : {}),
      type: "publish_schedule" as const,
    };
    const invalidationBefore = await invalidationVersion();
    await environment.DB.prepare(
      `CREATE TRIGGER fail_publication_finalization
       BEFORE INSERT ON schedule_publications
       WHEN NEW.command_id = 'cmd_publication_retry_finalization'
       BEGIN SELECT RAISE(ABORT, 'injected publication commit failure'); END`,
    ).run();
    const pending = await execute(publishCommand);
    expect(pending).toMatchObject({
      error: {
        code: "schedule_authority_pending",
        state: "projection_pending",
      },
      ok: false,
    });
    expect(await invalidationVersion()).toBe(invalidationBefore);
    const publicWhileFailed = await new D1PublicScheduleProjectionReader(
      environment.DB,
    ).readBySlug(published.event.slug);
    expect(publicWhileFailed?.projection.version).toBe(oldPublicVersion);

    await environment.DB.prepare(
      "DROP TRIGGER fail_publication_finalization",
    ).run();
    await waitFor(async () => {
      const receipt = await environment.DB.prepare(
        `SELECT state FROM schedule_command_receipts
         WHERE event_id = ? AND command_id = ?`,
      )
        .bind(demoEventId, publishCommand.commandId)
        .first<{ state: string }>();
      return receipt?.state === "complete";
    });
    const repaired = await execute(publishCommand);
    if (!repaired.ok) throw new Error(JSON.stringify(repaired.error));
    expect(repaired.result.replayed).toBe(true);
    expect(repaired.result.snapshot.event.publicationVersion).toBe(
      preview.nextPublicationVersion,
    );
    const repairedAudit = await environment.DB.prepare(
      `SELECT actor_id, request_id FROM audit_events
       WHERE organization_id = ? AND command_id = ?
         AND action = 'schedule.publication.committed'`,
    )
      .bind(demoOrganizationId, publishCommand.commandId)
      .first<{ actor_id: string; request_id: string }>();
    expect(repairedAudit).toEqual({
      actor_id: "usr_demo_owner",
      request_id: `req_${publishCommand.commandId}`,
    });
    const completedReceipt = await environment.DB.prepare(
      `SELECT result_json FROM schedule_command_receipts
       WHERE event_id = ? AND command_id = ? AND state = 'complete'`,
    )
      .bind(demoEventId, publishCommand.commandId)
      .first<{ result_json: string }>();
    expect(JSON.parse(completedReceipt?.result_json ?? "{}")).toMatchObject({
      actorId: "usr_demo_owner",
      command: { commandId: publishCommand.commandId },
      requestId: `req_${publishCommand.commandId}`,
      version: 3,
    });
    const publicAfterRepair = await new D1PublicScheduleProjectionReader(
      environment.DB,
    ).readBySlug(published.event.slug);
    expect(publicAfterRepair?.projection.version).toBe(
      preview.nextPublicationVersion,
    );
    expect(await invalidationVersion()).toBe(invalidationBefore + 1);

    const immutable = await environment.DB.prepare(
      `UPDATE schedule_publications SET published_at = published_at
       WHERE organization_id = ? AND event_id = ? AND publication_version = ?`,
    )
      .bind(demoOrganizationId, demoEventId, preview.nextPublicationVersion)
      .run()
      .then(
        () => false,
        () => true,
      );
    expect(immutable).toBe(true);
  }, 60_000);

  it("serializes a concurrent publication and move to exactly one winner", async () => {
    const coordinator = environment.AGENDA_COORDINATOR.getByName(demoEventId);
    const preview = await coordinator.previewPublication(demoEventId);
    expect(preview.canPublish).toBe(true);
    const snapshot = await new D1ScheduleProjectionRepository(
      environment.DB,
    ).read(demoEventId);
    const session = snapshot?.sessions.find(
      (candidate) => candidate.state === "published" && candidate.slot,
    );
    if (!snapshot || !session?.slot) {
      throw new Error("Fixture has no published session to race.");
    }
    const publication = {
      commandId: "cmd_concurrent_publication",
      eventId: demoEventId,
      expectedVersion: preview.scheduleVersion,
      ...(preview.softWarnings.length > 0
        ? {
            softWarningOverride: {
              reason: "Organizer reviewed every named publication warning",
              warningKeys: preview.softWarnings.map(({ key }) => key),
            },
          }
        : {}),
      type: "publish_schedule" as const,
    };
    const move = {
      commandId: "cmd_concurrent_public_move",
      durationMinutes: session.durationMinutes,
      eventId: demoEventId,
      expectedVersion: preview.scheduleVersion,
      roomId: session.slot.roomId,
      sessionId: session.id,
      startAt: session.slot.startAt,
      type: "reschedule_session" as const,
    };

    const responses = await Promise.all([execute(publication), execute(move)]);
    expect(responses.filter((response) => response.ok)).toHaveLength(1);
    expect(responses.filter((response) => !response.ok)).toHaveLength(1);
    expect(responses.find((response) => !response.ok)).toMatchObject({
      error: {
        actualVersion: preview.scheduleVersion + 1,
        code: "schedule_version_conflict",
        expectedVersion: preview.scheduleVersion,
      },
      ok: false,
    });
    const receipts = await environment.DB.prepare(
      `SELECT command_id, state FROM schedule_command_receipts
       WHERE event_id = ? AND command_id IN (?, ?) ORDER BY command_id`,
    )
      .bind(demoEventId, publication.commandId, move.commandId)
      .all<{ command_id: string; state: string }>();
    expect(receipts.results).toHaveLength(1);
    expect(receipts.results[0]?.state).toBe("complete");
  }, 60_000);
});
