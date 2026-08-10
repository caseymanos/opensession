import { BaseAuthority } from "../../src/authority/base-authority.js";
import { loadEventAccess } from "../../src/auth/authorization.js";
import type { BaseAuthorityEnvironment } from "../../src/authority/provider.js";
import { SnapshotAssetCommitInterruptionError } from "../../src/authority/snapshot.js";
import {
  scheduleCommandSchema,
  scheduleSnapshotSchema,
  type ScheduleCommandResult,
} from "@sessionbox-killer/contracts";
import { evaluateScheduleConflicts } from "@sessionbox-killer/domain";
import type {
  CfpSubmissionPlanInput,
  CfpSubmissionPlanItem,
} from "../../src/cfp/submission-authority.js";
import { UploadService } from "../../src/uploads/service.js";
import { processPublicScheduleCacheInvalidation } from "../../src/public-schedule/cache.js";
import { D1ScheduleProjectionRepository } from "../../src/schedule/d1-repository.js";
import {
  AgendaCoordinator,
  type AgendaCoordinatorCommand,
} from "../../src/schedule/coordinator.js";
import { AirtableScheduleCommandService } from "../../src/schedule/service.js";
import {
  D1DemoEventGuardReader,
  DemoResetService,
} from "../../src/demo/reset.js";
import type {
  CompiledDemoSeed,
  DemoResetRequest,
} from "../../src/demo/types.js";
import { WorkerEntrypoint } from "cloudflare:workers";

interface FixtureEnvironment extends BaseAuthorityEnvironment {
  AGENDA_COORDINATOR: DurableObjectNamespace<AgendaCoordinator>;
  AIRTABLE_UPSTREAM: Fetcher;
  BASE_AUTHORITY: DurableObjectNamespace<FixtureBaseAuthority>;
  FIXTURE_AGENDA_COORDINATOR: DurableObjectNamespace<FixtureAgendaCoordinator>;
}

export { AgendaCoordinator };

export class FixtureBaseAuthority extends BaseAuthority {
  constructor(ctx: DurableObjectState, env: FixtureEnvironment) {
    const queue = env.PROJECTION_REPAIR_QUEUE;
    const controlledQueue: BaseAuthorityEnvironment["PROJECTION_REPAIR_QUEUE"] =
      {
        metrics: () => queue.metrics(),
        send: async (message, options) => {
          const state = await env.DB.prepare(
            `SELECT fail_event_id FROM authority_fixture_queue_controls
             WHERE singleton = 1`,
          ).first<{ fail_event_id: string | null }>();
          if (
            state?.fail_event_id &&
            "event_id" in message &&
            message.event_id === state.fail_event_id
          ) {
            throw new Error("fixture queue unavailable");
          }
          return queue.send(message, options);
        },
        sendBatch: (messages, options) => queue.sendBatch(messages, options),
      };
    super(ctx, { ...env, PROJECTION_REPAIR_QUEUE: controlledQueue });
  }

  authorityStateForTest(): {
    committedCursor: number | null;
    committedRosterHash: string | null;
    schemaVersion: number;
    webhookId: string | null;
  } {
    const cursor = this.ctx.storage.sql
      .exec<{
        committed_cursor: number;
        committed_roster_hash: string | null;
        webhook_id: string;
      }>(
        `SELECT webhook_id, committed_cursor, committed_roster_hash
         FROM airtable_cursor_state WHERE singleton = 1`,
      )
      .toArray()[0];
    return {
      committedCursor: cursor?.committed_cursor ?? null,
      committedRosterHash: cursor?.committed_roster_hash ?? null,
      schemaVersion: this.ready().schemaVersion,
      webhookId: cursor?.webhook_id ?? null,
    };
  }

  downgradeAuthoritySchemaToV2ForTest(): void {
    this.ctx.storage.sql.exec(`
      DROP TABLE cfp_submission_plan_items;
      DROP TABLE cfp_submission_plans;
      ALTER TABLE airtable_cursor_state DROP COLUMN committed_roster_hash;
      UPDATE authority_schema SET version = 2 WHERE singleton = 1;
    `);
  }

  downgradeAuthoritySchemaToV3ForTest(): void {
    this.ctx.storage.sql.exec(`
      DROP TABLE cfp_submission_plan_items;
      DROP TABLE cfp_submission_plans;
      UPDATE authority_schema SET version = 3 WHERE singleton = 1;
    `);
  }

  clearAlarmForTest(): Promise<void> {
    return this.ctx.storage.deleteAlarm();
  }

  setProviderLeaseDeadlineForTest(
    commandId: string,
    leaseUntilMilliseconds: number,
  ): void {
    this.ctx.storage.sql.exec(
      `UPDATE authority_commands SET lease_until_ms = ?
       WHERE organization_id = 'org_fixture' AND operation = 'events.update'
         AND command_id = ? AND state = 'outcome_unknown'`,
      leaseUntilMilliseconds,
      commandId,
    );
    const persisted = this.ctx.storage.sql
      .exec<{ lease_until_ms: number }>(
        `SELECT lease_until_ms FROM authority_commands
         WHERE organization_id = 'org_fixture' AND operation = 'events.update'
           AND command_id = ? AND state = 'outcome_unknown'`,
        commandId,
      )
      .toArray()[0];
    if (persisted?.lease_until_ms !== leaseUntilMilliseconds) {
      throw new Error("Fixture authority lease target is not recoverable.");
    }
  }

  protected override async onSnapshotAssetDatabaseCommitted(): Promise<void> {
    const armed = await this.env.DB.prepare(
      `SELECT armed FROM authority_fixture_snapshot_checkpoint
       WHERE singleton = 1`,
    ).first<{ armed: number }>();
    if (armed?.armed !== 1) return;
    await this.env.DB.prepare(
      `UPDATE authority_fixture_snapshot_checkpoint SET armed = 0, reached = 1
       WHERE singleton = 1 AND armed = 1`,
    ).run();
    throw new SnapshotAssetCommitInterruptionError(
      "Fixture snapshot interrupted after the asset commit.",
    );
  }

  protected override async onCfpSubmissionItemCommitted(
    input: CfpSubmissionPlanInput,
    item: CfpSubmissionPlanItem,
  ): Promise<void> {
    void input;
    void item;
    const armed = await this.env.DB.prepare(
      `SELECT armed FROM authority_fixture_cfp_checkpoint
       WHERE singleton = 1`,
    ).first<{ armed: number }>();
    if (armed?.armed !== 1) return;
    await this.env.DB.prepare(
      `UPDATE authority_fixture_cfp_checkpoint SET armed = 0, reached = 1
       WHERE singleton = 1 AND armed = 1`,
    ).run();
    const error = new Error(
      "Fixture CFP plan interrupted after a child authority commit.",
    );
    error.name = "CfpSubmissionPlanInterruptionError";
    throw error;
  }

  private async waitForRosterCheckpoint(): Promise<void> {
    const armed = await this.env.DB.prepare(
      `SELECT armed FROM authority_fixture_roster_checkpoint
       WHERE singleton = 1`,
    ).first<{ armed: number }>();
    if (armed?.armed !== 1) return;
    await this.env.DB.prepare(
      `UPDATE authority_fixture_roster_checkpoint SET reached = 1
       WHERE singleton = 1 AND armed = 1`,
    ).run();
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const state = await this.env.DB.prepare(
        `SELECT armed FROM authority_fixture_roster_checkpoint
         WHERE singleton = 1`,
      ).first<{ armed: number }>();
      if (state?.armed !== 1) return;
    }
  }

  protected override onWebhookFullScanReady(): Promise<void> {
    return this.waitForRosterCheckpoint();
  }

  protected override onWebhookRosterVerified(): Promise<void> {
    return this.waitForRosterCheckpoint();
  }
}

export class FixtureAgendaCoordinator extends AgendaCoordinator {
  protected override async executeSerialized(
    input: AgendaCoordinatorCommand,
  ): Promise<ScheduleCommandResult> {
    const inserted = await this.env.DB.prepare(
      `INSERT INTO agenda_fixture_invocations (
         event_id, command_id, started_at, completed_at
       ) VALUES (?, ?, ?, NULL) RETURNING id`,
    )
      .bind(
        input.command.eventId,
        input.command.commandId,
        new Date().toISOString(),
      )
      .first<{ id: number }>();
    if (!inserted) throw new Error("Fixture invocation was not recorded.");

    while (true) {
      const control = await this.env.DB.prepare(
        `SELECT blocked FROM agenda_fixture_controls WHERE event_id = ?`,
      )
        .bind(input.command.eventId)
        .first<{ blocked: number }>();
      if (control?.blocked !== 1) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const source = await this.env.DB.prepare(
      `SELECT id FROM p_events WHERE source_deleted_at IS NULL ORDER BY id LIMIT 1`,
    ).first<{ id: string }>();
    if (!source) throw new Error("Fixture schedule source is missing.");
    const current = await new D1ScheduleProjectionRepository(this.env.DB).read(
      source.id,
    );
    if (!current) throw new Error("Fixture schedule projection is missing.");
    const snapshot = scheduleSnapshotSchema.parse({
      ...current,
      event: { ...current.event, eventId: input.command.eventId },
    });
    await this.env.DB.prepare(
      `UPDATE agenda_fixture_invocations SET completed_at = ? WHERE id = ?`,
    )
      .bind(new Date().toISOString(), inserted.id)
      .run();
    return {
      analysis: evaluateScheduleConflicts(snapshot),
      changedSessionIds: [],
      commandId: input.command.commandId,
      replayed: false,
      snapshot,
    };
  }
}

function authority(env: FixtureEnvironment) {
  return env.BASE_AUTHORITY.getByName(`${env.APP_ENV}:${env.AIRTABLE_BASE_ID}`);
}

async function sha256Hex(value: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function initializeD1(
  env: FixtureEnvironment,
  migrationStatements: readonly string[],
): Promise<void> {
  if (
    migrationStatements.length < 120 ||
    migrationStatements.some((statement) => !statement.trim().endsWith(";"))
  ) {
    throw new Error("Fixture requires the complete production migration.");
  }
  for (let index = 0; index < migrationStatements.length; index += 40) {
    await env.DB.batch(
      migrationStatements
        .slice(index, index + 40)
        .map((statement) => env.DB.prepare(statement)),
    );
  }
  await env.DB.batch(
    [
      `CREATE TABLE IF NOT EXISTS authority_fixture_controls (
       singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
       fail_projection INTEGER NOT NULL CHECK (fail_projection IN (0, 1))
     ) STRICT`,
      `INSERT OR IGNORE INTO authority_fixture_controls (singleton, fail_projection)
     VALUES (1, 1)`,
      `CREATE TABLE IF NOT EXISTS authority_fixture_snapshot_checkpoint (
       singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
       armed INTEGER NOT NULL CHECK (armed IN (0, 1)),
       reached INTEGER NOT NULL CHECK (reached IN (0, 1))
     ) STRICT`,
      `INSERT OR IGNORE INTO authority_fixture_snapshot_checkpoint (
       singleton, armed, reached
     ) VALUES (1, 0, 0)`,
      `CREATE TABLE IF NOT EXISTS authority_fixture_roster_checkpoint (
       singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
       armed INTEGER NOT NULL CHECK (armed IN (0, 1)),
       reached INTEGER NOT NULL CHECK (reached IN (0, 1))
     ) STRICT`,
      `INSERT OR IGNORE INTO authority_fixture_roster_checkpoint (
       singleton, armed, reached
     ) VALUES (1, 0, 0)`,
      `CREATE TABLE IF NOT EXISTS authority_fixture_cfp_checkpoint (
       singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
       armed INTEGER NOT NULL CHECK (armed IN (0, 1)),
       reached INTEGER NOT NULL CHECK (reached IN (0, 1))
     ) STRICT`,
      `INSERT OR IGNORE INTO authority_fixture_cfp_checkpoint (
       singleton, armed, reached
     ) VALUES (1, 0, 0)`,
      `CREATE TABLE IF NOT EXISTS authority_fixture_queue_controls (
       singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
       fail_event_id TEXT
     ) STRICT`,
      `INSERT OR IGNORE INTO authority_fixture_queue_controls (
       singleton, fail_event_id
     ) VALUES (1, NULL)`,
      `CREATE TABLE IF NOT EXISTS agenda_fixture_controls (
       event_id TEXT PRIMARY KEY,
       blocked INTEGER NOT NULL CHECK (blocked IN (0, 1))
     ) STRICT`,
      `CREATE TABLE IF NOT EXISTS agenda_fixture_invocations (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       event_id TEXT NOT NULL,
       command_id TEXT NOT NULL UNIQUE,
       started_at TEXT NOT NULL,
       completed_at TEXT
     ) STRICT`,
      `CREATE TRIGGER IF NOT EXISTS authority_fixture_fail_projection
       BEFORE INSERT ON p_events
       WHEN (SELECT fail_projection FROM authority_fixture_controls WHERE singleton = 1) = 1
       BEGIN SELECT RAISE(ABORT, 'injected projection failure'); END`,
      `INSERT OR IGNORE INTO tenant_registry (
       organization_id, base_key, source_record_id, status, created_at, updated_at
     ) VALUES (
       'org_fixture', 'local:appAuthorityFixture', 'rec_org_fixture', 'active',
       '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z'
     )`,
    ].map((statement) => env.DB.prepare(statement)),
  );
}

const fixtureHandler = {
  async fetch(request, env, executionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/agenda-command") {
      const body = (await request.json()) as {
        command?: { eventId?: unknown };
      };
      if (typeof body.command?.eventId !== "string") {
        return Response.json({ error: "invalid_event" }, { status: 400 });
      }
      return Response.json(
        await env.AGENDA_COORDINATOR.getByName(body.command.eventId).execute(
          body,
        ),
      );
    }
    if (url.pathname === "/agenda-stream") {
      const eventId = url.searchParams.get("eventId");
      if (!eventId) {
        return Response.json({ error: "invalid_event" }, { status: 400 });
      }
      const target = new URL("https://agenda-coordinator.invalid/stream");
      target.searchParams.set("eventId", eventId);
      return env.AGENDA_COORDINATOR.getByName(eventId).fetch(
        new Request(target, { headers: request.headers }),
      );
    }
    if (url.pathname === "/setup") {
      const body = (await request.json()) as { statements?: unknown };
      if (
        !Array.isArray(body.statements) ||
        body.statements.some((statement) => typeof statement !== "string")
      ) {
        return Response.json({ error: "invalid_migration" }, { status: 400 });
      }
      await initializeD1(env, body.statements as string[]);
      await env.AIRTABLE_UPSTREAM.fetch("https://airtable.test/test/reset", {
        method: "POST",
      });
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/allow-projection") {
      await env.DB.prepare(
        "UPDATE authority_fixture_controls SET fail_projection = 0 WHERE singleton = 1",
      ).run();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/arm-snapshot-asset-checkpoint") {
      await env.DB.prepare(
        `UPDATE authority_fixture_snapshot_checkpoint
         SET armed = 1, reached = 0 WHERE singleton = 1`,
      ).run();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/arm-cfp-plan-checkpoint") {
      await env.DB.prepare(
        `UPDATE authority_fixture_cfp_checkpoint
         SET armed = 1, reached = 0 WHERE singleton = 1`,
      ).run();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/cfp-plan-checkpoint") {
      const checkpoint = await env.DB.prepare(
        `SELECT armed, reached FROM authority_fixture_cfp_checkpoint
         WHERE singleton = 1`,
      ).first();
      return Response.json(checkpoint);
    }
    if (url.pathname === "/snapshot-asset-checkpoint") {
      const checkpoint = await env.DB.prepare(
        `SELECT armed, reached FROM authority_fixture_snapshot_checkpoint
         WHERE singleton = 1`,
      ).first();
      return Response.json(checkpoint);
    }
    if (url.pathname === "/arm-webhook-roster-checkpoint") {
      await env.DB.prepare(
        `UPDATE authority_fixture_roster_checkpoint
         SET armed = 1, reached = 0 WHERE singleton = 1`,
      ).run();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/release-webhook-roster-checkpoint") {
      await env.DB.prepare(
        `UPDATE authority_fixture_roster_checkpoint
         SET armed = 0 WHERE singleton = 1`,
      ).run();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/webhook-roster-checkpoint") {
      const checkpoint = await env.DB.prepare(
        `SELECT armed, reached FROM authority_fixture_roster_checkpoint
         WHERE singleton = 1`,
      ).first();
      return Response.json(checkpoint);
    }
    if (url.pathname === "/reactivate-tenant") {
      const body = (await request.json()) as { organizationId: string };
      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE tenant_registry SET status = 'suspended', updated_at = ?
           WHERE organization_id = ? AND status = 'active'`,
        ).bind(now, body.organizationId),
        env.DB.prepare(
          `UPDATE tenant_registry SET status = 'active', updated_at = ?
           WHERE organization_id = ? AND status = 'suspended'`,
        ).bind(now, body.organizationId),
      ]);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/replace-tenant-source") {
      const body = (await request.json()) as {
        organizationId: string;
        preserveReadiness?: boolean;
        sourceRecordId: string;
      };
      const now = new Date().toISOString();
      const current = await env.DB.prepare(
        `SELECT authority_ready_at FROM tenant_registry
         WHERE organization_id = ? AND base_key = ?`,
      )
        .bind(body.organizationId, `${env.APP_ENV}:${env.AIRTABLE_BASE_ID}`)
        .first<{ authority_ready_at: string | null }>();
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE tenant_registry
           SET source_record_id = ?, authority_ready_at = NULL, updated_at = ?
           WHERE organization_id = ? AND base_key = ?`,
        ).bind(
          body.sourceRecordId,
          now,
          body.organizationId,
          `${env.APP_ENV}:${env.AIRTABLE_BASE_ID}`,
        ),
        env.DB.prepare(
          `UPDATE tenant_registry
           SET authority_roster_version = 1, authority_ready_at = ?,
               updated_at = ?
           WHERE organization_id = ? AND base_key = ? AND source_record_id = ?`,
        ).bind(
          body.preserveReadiness ? (current?.authority_ready_at ?? null) : null,
          now,
          body.organizationId,
          `${env.APP_ENV}:${env.AIRTABLE_BASE_ID}`,
          body.sourceRecordId,
        ),
      ]);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/fail-room-projection") {
      await env.DB.prepare(
        `CREATE TRIGGER IF NOT EXISTS authority_fixture_fail_room_projection
         BEFORE INSERT ON p_rooms
         BEGIN SELECT RAISE(ABORT, 'injected room projection failure'); END`,
      ).run();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/allow-room-projection") {
      await env.DB.prepare(
        "DROP TRIGGER IF EXISTS authority_fixture_fail_room_projection",
      ).run();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/seed-provider") {
      return env.AIRTABLE_UPSTREAM.fetch("https://airtable.test/test/seed", {
        body: await request.text(),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    }
    if (url.pathname === "/mutate-provider") {
      return env.AIRTABLE_UPSTREAM.fetch("https://airtable.test/test/mutate", {
        body: await request.text(),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    }
    if (url.pathname === "/remove-provider") {
      return env.AIRTABLE_UPSTREAM.fetch("https://airtable.test/test/remove", {
        body: await request.text(),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    }
    if (url.pathname === "/provider-records") {
      const table = url.searchParams.get("table") ?? "";
      return env.AIRTABLE_UPSTREAM.fetch(
        `https://airtable.test/test/records?table=${encodeURIComponent(table)}`,
      );
    }
    if (url.pathname === "/webhook-page") {
      return env.AIRTABLE_UPSTREAM.fetch(
        "https://airtable.test/test/webhook-page",
        {
          body: await request.text(),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      );
    }
    if (url.pathname === "/ambiguous-next") {
      return env.AIRTABLE_UPSTREAM.fetch(
        "https://airtable.test/test/ambiguous-next",
        { method: "POST" },
      );
    }
    if (url.pathname === "/ambiguous-delayed-next") {
      return env.AIRTABLE_UPSTREAM.fetch(
        "https://airtable.test/test/ambiguous-delayed-next",
        { method: "POST" },
      );
    }
    if (url.pathname === "/ambiguous-hidden-next") {
      return env.AIRTABLE_UPSTREAM.fetch(
        "https://airtable.test/test/ambiguous-hidden-next",
        { method: "POST" },
      );
    }
    if (url.pathname === "/delay-next-write") {
      return env.AIRTABLE_UPSTREAM.fetch(
        "https://airtable.test/test/delay-next-write",
        { method: "POST" },
      );
    }
    if (url.pathname === "/hide-records") {
      return env.AIRTABLE_UPSTREAM.fetch(
        "https://airtable.test/test/hide-records",
        { method: "POST" },
      );
    }
    if (url.pathname === "/reveal-records") {
      return env.AIRTABLE_UPSTREAM.fetch(
        "https://airtable.test/test/reveal-records",
        { method: "POST" },
      );
    }
    if (url.pathname === "/provider-readback-count") {
      return env.AIRTABLE_UPSTREAM.fetch(
        "https://airtable.test/test/readback-count",
      );
    }
    if (url.pathname === "/provider-stats") {
      return env.AIRTABLE_UPSTREAM.fetch("https://airtable.test/test/stats");
    }
    if (url.pathname === "/execute") {
      try {
        return Response.json(
          await Promise.resolve(authority(env).execute(await request.json())),
        );
      } catch (error) {
        const status =
          typeof error === "object" &&
          error !== null &&
          "status" in error &&
          typeof error.status === "number"
            ? error.status
            : 409;
        return Response.json(
          {
            error: error instanceof Error ? error.name : "UnknownError",
            message: error instanceof Error ? error.message : "Unknown error",
          },
          { status },
        );
      }
    }
    if (url.pathname === "/execute-cfp-plan") {
      try {
        return Response.json(
          await authority(env).executeCfpSubmissionPlan(await request.json()),
        );
      } catch (error) {
        return Response.json(
          {
            error: error instanceof Error ? error.name : "UnknownError",
            message: error instanceof Error ? error.message : "Unknown error",
          },
          { status: 409 },
        );
      }
    }
    if (url.pathname === "/resume-cfp-plan") {
      const body = (await request.json()) as {
        organizationId?: string;
        planId?: string;
        requestHash?: string;
      };
      try {
        return Response.json(
          await authority(env).resumeCfpSubmissionPlan(
            body.organizationId ?? "",
            body.planId ?? "",
            body.requestHash ?? "",
          ),
        );
      } catch (error) {
        return Response.json(
          {
            error: error instanceof Error ? error.name : "UnknownError",
            message: error instanceof Error ? error.message : "Unknown error",
          },
          { status: 409 },
        );
      }
    }
    if (url.pathname === "/inspect-cfp-plan") {
      return Response.json(
        await authority(env).inspectCfpSubmissionPlan(
          url.searchParams.get("organizationId") ?? "",
          url.searchParams.get("planId") ?? "",
        ),
      );
    }
    if (url.pathname === "/reconcile") {
      const body = (await request.json()) as {
        organizationId?: string;
        tables?: Parameters<ReturnType<typeof authority>["reconcile"]>[1];
      };
      try {
        return Response.json(
          await authority(env).reconcile(
            body.organizationId ?? "org_fixture",
            body.tables,
          ),
        );
      } catch (error) {
        return Response.json(
          {
            error: error instanceof Error ? error.name : "UnknownError",
            message: error instanceof Error ? error.message : "Unknown error",
          },
          { status: 500 },
        );
      }
    }
    if (url.pathname === "/configure-webhook") {
      const body = (await request.json()) as {
        cursor?: number;
        webhookId: string;
      };
      await authority(env).configureWebhook(body.webhookId, body.cursor);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/authority-state") {
      return Response.json(await authority(env).authorityStateForTest());
    }
    if (url.pathname === "/downgrade-authority-schema") {
      await authority(env).downgradeAuthoritySchemaToV2ForTest();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/downgrade-authority-schema-v3") {
      await authority(env).downgradeAuthoritySchemaToV3ForTest();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/ingest-webhook") {
      try {
        return Response.json(
          await authority(env).ingestWebhook(
            url.searchParams.getAll("organizationId").length > 0
              ? url.searchParams.getAll("organizationId")
              : ["org_fixture"],
          ),
        );
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.name : "UnknownError" },
          { status: 500 },
        );
      }
    }
    if (url.pathname === "/setup-owner") {
      const body = (await request.json()) as {
        actorId: string;
        organizationId?: string;
      };
      const organizationId = body.organizationId ?? "org_fixture";
      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(
          `INSERT OR IGNORE INTO users (
             id, email_normalized, display_name, status, created_at, updated_at
           ) VALUES (?, ?, 'Demo owner', 'active', ?, ?)`,
        ).bind(body.actorId, `${body.actorId}@example.invalid`, now, now),
        env.DB.prepare(
          `INSERT OR REPLACE INTO organization_memberships (
             id, organization_id, user_id, role, created_at, updated_at, revoked_at
             ) VALUES (?, ?, ?, 'owner', ?, ?, NULL)`,
        ).bind(
          `membership_${body.actorId}`,
          organizationId,
          body.actorId,
          now,
          now,
        ),
      ]);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/setup-tenant") {
      const body = (await request.json()) as { organizationId: string };
      const now = new Date().toISOString();
      await env.DB.prepare(
        `INSERT OR REPLACE INTO tenant_registry (
           organization_id, base_key, source_record_id, status, created_at, updated_at
         ) VALUES (?, 'local:appAuthorityFixture', ?, 'active', ?, ?)`,
      )
        .bind(
          body.organizationId,
          `rec_organizations_${body.organizationId}`,
          now,
          now,
        )
        .run();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/snapshot") {
      try {
        return Response.json(
          await authority(env).replaceDemoEvent(await request.json()),
        );
      } catch (error) {
        return Response.json(
          {
            error: error instanceof Error ? error.name : "UnknownError",
            message: error instanceof Error ? error.message : "Unknown error",
          },
          { status: 409 },
        );
      }
    }
    if (url.pathname === "/demo-reset") {
      const body = (await request.json()) as {
        plan: CompiledDemoSeed;
        request: DemoResetRequest;
      };
      try {
        return Response.json(
          await new DemoResetService({
            authority: authority(env),
            eventReader: new D1DemoEventGuardReader(env.DB),
            plan: body.plan,
          }).reset(body.request),
        );
      } catch (error) {
        return Response.json(
          {
            error: error instanceof Error ? error.name : "UnknownError",
            message: error instanceof Error ? error.message : "Unknown error",
          },
          { status: 409 },
        );
      }
    }
    if (url.pathname === "/assets") {
      const listed = await env.UPLOADS.list({
        prefix: url.searchParams.get("prefix") ?? "demo/",
      });
      return Response.json(
        listed.objects.map(({ key, size }) => ({ key, size })),
      );
    }
    if (url.pathname === "/asset-state") {
      const object = await env.UPLOADS.get(url.searchParams.get("key") ?? "");
      if (!object) return Response.json(null, { status: 404 });
      const bytes = await object.arrayBuffer();
      return Response.json({
        checksum: await sha256Hex(bytes),
        checksums: object.checksums.toJSON(),
        contentType: object.httpMetadata?.contentType ?? null,
        customMetadata: object.customMetadata ?? {},
        etag: object.etag,
        size: object.size,
        version: object.version,
      });
    }
    if (url.pathname === "/file-identity") {
      const row = await env.DB.prepare(
        `SELECT file.id, file.organization_id, file.event_id,
                file.checksum_sha256, file.purpose, file.r2_etag,
                file.r2_version, file.status, intent.status AS intent_status
         FROM file_objects file
         LEFT JOIN file_upload_intents intent ON intent.file_object_id = file.id
         WHERE file.id = ?`,
      )
        .bind(url.searchParams.get("id"))
        .first();
      return Response.json(row);
    }
    if (url.pathname === "/move-file-identity") {
      const body = (await request.json()) as {
        eventId: string;
        id: string;
        organizationId: string;
        ownerContactId: string | null;
      };
      const moved = await env.DB.prepare(
        `UPDATE file_objects
         SET organization_id = ?, event_id = ?, owner_contact_id = ?
         WHERE id = ?`,
      )
        .bind(body.organizationId, body.eventId, body.ownerContactId, body.id)
        .run();
      return new Response(null, {
        status: moved.meta.changes === 1 ? 204 : 404,
      });
    }
    if (url.pathname === "/download-asset") {
      try {
        const actorId = url.searchParams.get("actorId") ?? "usr_missing";
        const download = await new UploadService({
          bucket: env.UPLOADS,
          database: env.DB,
        }).download(
          {
            csrfTokenHash: "fixture-csrf",
            expiresAt: "2099-01-01T00:00:00.000Z",
            id: "fixture-session",
            tokenHash: "fixture-token",
            user: {
              displayName: "Fixture owner",
              email: `${actorId}@example.invalid`,
              id: actorId,
            },
          },
          url.searchParams.get("id") ?? "file_missing",
        );
        return new Response(download.body, {
          headers: { "Content-Type": download.contentType },
        });
      } catch (error) {
        return Response.json(
          {
            code:
              typeof error === "object" && error !== null && "code" in error
                ? error.code
                : "download_failed",
          },
          { status: 404 },
        );
      }
    }
    if (url.pathname === "/seed-asset") {
      const body = (await request.json()) as { content: string; key: string };
      await env.UPLOADS.put(body.key, body.content, {
        httpMetadata: { contentType: "text/plain" },
      });
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/seed-stale-asset") {
      const body = (await request.json()) as {
        actorId: string;
        eventId: string;
        id: string;
        key: string;
        organizationId: string;
      };
      const bytes = new TextEncoder().encode("durable rollback sentinel");
      const digest = await sha256Hex(bytes);
      const object = await env.UPLOADS.put(body.key, bytes, {
        customMetadata: {
          checksumSha256: digest,
          eventId: body.eventId,
          fileId: body.id,
          organizationId: body.organizationId,
          purpose: "resource",
        },
        httpMetadata: { contentType: "text/plain" },
        sha256: digest,
      });
      if (!object) throw new Error("Fixture stale asset write failed.");
      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO file_objects (
             id, organization_id, event_id, owner_contact_id,
             uploaded_by_user_id, object_key, display_filename,
             declared_mime_type, detected_mime_type, byte_size,
             checksum_sha256, status, created_at, finalized_at, purpose,
             lineage_id, version_number, r2_version, r2_etag, updated_at
           ) VALUES (?, ?, ?, NULL, ?, ?, ?, 'text/plain', 'text/plain', ?, ?,
                     'ready', ?, ?, 'resource', ?, 1, ?, ?, ?)`,
        ).bind(
          body.id,
          body.organizationId,
          body.eventId,
          body.actorId,
          body.key,
          body.key.split("/").at(-1) ?? body.id,
          bytes.byteLength,
          digest,
          now,
          now,
          body.id,
          object.version,
          object.etag,
          now,
        ),
        env.DB.prepare(
          `INSERT INTO file_upload_intents (
             id, file_object_id, token_hash, status, expires_at,
             cleanup_after, attempts, created_at, updated_at, uploaded_at,
             finalized_at
           ) VALUES (?, ?, ?, 'finalized', ?, ?, 1, ?, ?, ?, ?)`,
        ).bind(
          `intent_${body.id}`,
          body.id,
          await sha256Hex(new TextEncoder().encode(`intent:${body.id}`)),
          now,
          now,
          now,
          now,
          now,
          now,
        ),
      ]);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/fail-asset-projection") {
      await env.DB.prepare(
        `CREATE TRIGGER IF NOT EXISTS authority_fixture_fail_asset_projection
         BEFORE INSERT ON file_objects
         BEGIN SELECT RAISE(ABORT, 'injected asset projection failure'); END`,
      ).run();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/fail-stale-asset-deletion") {
      const body = (await request.json()) as { id: string };
      await env.DB.batch([
        env.DB.prepare(
          `CREATE TABLE IF NOT EXISTS authority_fixture_asset_failpoint (
             file_id TEXT PRIMARY KEY
           ) STRICT`,
        ),
        env.DB.prepare("DELETE FROM authority_fixture_asset_failpoint"),
        env.DB.prepare(
          "INSERT INTO authority_fixture_asset_failpoint (file_id) VALUES (?)",
        ).bind(body.id),
        env.DB.prepare(
          `CREATE TRIGGER IF NOT EXISTS authority_fixture_fail_asset_after_recovery
           BEFORE UPDATE ON file_objects
           WHEN OLD.id IN (SELECT file_id FROM authority_fixture_asset_failpoint)
             AND OLD.status != 'deleted' AND NEW.status = 'deleted'
           BEGIN SELECT RAISE(ABORT, 'injected stale asset deletion failure'); END`,
        ),
      ]);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/allow-asset-projection") {
      await env.DB.batch([
        env.DB.prepare(
          "DROP TRIGGER IF EXISTS authority_fixture_fail_asset_projection",
        ),
        env.DB.prepare(
          "DROP TRIGGER IF EXISTS authority_fixture_fail_asset_after_recovery",
        ),
      ]);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/recover") {
      return Response.json({
        recovered: await authority(env).recoverPending(),
      });
    }
    if (url.pathname === "/set-queue-failure") {
      const body = (await request.json()) as {
        enabled?: unknown;
        eventId?: unknown;
      };
      if (body.enabled === true && typeof body.eventId !== "string") {
        return Response.json({ error: "invalid_event" }, { status: 400 });
      }
      await env.DB.prepare(
        `UPDATE authority_fixture_queue_controls SET fail_event_id = ?
         WHERE singleton = 1`,
      )
        .bind(body.enabled === true ? body.eventId : null)
        .run();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/cache-invalidation-state") {
      const state = await env.DB.prepare(
        `SELECT status, invalidation_version, attempt_count, last_error_code
         FROM authority_cache_invalidations
         WHERE organization_id = ? AND event_id = ?`,
      )
        .bind(
          url.searchParams.get("organizationId"),
          url.searchParams.get("eventId"),
        )
        .first();
      return Response.json(state);
    }
    if (url.pathname === "/process-cache-invalidation") {
      await processPublicScheduleCacheInvalidation(
        executionContext,
        env,
        await request.json(),
      );
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/seed-legacy-cache-invalidation") {
      const body = (await request.json()) as {
        eventId: string;
        organizationId: string;
      };
      const now = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO authority_cache_invalidations (
           organization_id, event_id, status, invalidation_version,
           attempt_count, created_at, updated_at, published_at
         ) VALUES (?, ?, 'published', 1, 0, ?, ?, ?)
         ON CONFLICT (organization_id, event_id) DO UPDATE SET
           status = 'published',
           invalidation_version = authority_cache_invalidations.invalidation_version + 1,
           attempt_count = 0, updated_at = excluded.updated_at,
           published_at = excluded.published_at, enqueued_at = NULL,
           processed_at = NULL, last_error_code = NULL`,
      )
        .bind(body.organizationId, body.eventId, now, now, now)
        .run();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/tenant-readiness") {
      const state = await env.DB.prepare(
        `SELECT authority_ready_at, authority_roster_version
         FROM tenant_registry WHERE organization_id = ? AND base_key = ?`,
      )
        .bind(
          url.searchParams.get("organizationId"),
          `${env.APP_ENV}:${env.AIRTABLE_BASE_ID}`,
        )
        .first();
      return Response.json(state);
    }
    if (url.pathname === "/inspect") {
      return Response.json(
        await authority(env).inspect(
          "org_fixture",
          "events.update",
          url.searchParams.get("commandId") ?? "cmd_missing",
        ),
      );
    }
    if (url.pathname === "/clear-authority-alarm") {
      await authority(env).clearAlarmForTest();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/extend-authority-lease-for-test") {
      const body = (await request.json()) as { commandId: string };
      await authority(env).setProviderLeaseDeadlineForTest(
        body.commandId,
        Date.now() + 120_000,
      );
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/expire-authority-lease-for-test") {
      const body = (await request.json()) as { commandId: string };
      await authority(env).setProviderLeaseDeadlineForTest(
        body.commandId,
        Date.now() - 1,
      );
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/d1-state") {
      const result = await env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM idempotency_keys) AS idempotency_count,
           (SELECT COUNT(*) FROM projection_repairs) AS repair_count,
           (SELECT status FROM projection_repairs LIMIT 1) AS repair_status,
           (SELECT COUNT(*) FROM audit_events) AS audit_count,
           (SELECT COUNT(*) FROM outbox_events) AS outbox_count,
           (SELECT COUNT(*) FROM operational_events) AS operational_count,
           (SELECT group_concat(event_type, ',') FROM (
              SELECT event_type FROM operational_events ORDER BY id
            )) AS operational_events,
           (SELECT COUNT(*) FROM p_events) AS event_count,
           (SELECT status FROM idempotency_keys LIMIT 1) AS idempotency_status,
           (SELECT original_response_status FROM idempotency_keys LIMIT 1) AS idempotency_response_status,
           (SELECT name FROM p_events LIMIT 1) AS event_name,
           (SELECT status FROM p_events LIMIT 1) AS event_status,
           (SELECT source_content_hash FROM p_events LIMIT 1) AS event_source_hash`,
      ).first();
      return Response.json(result);
    }
    if (url.pathname === "/operational-events") {
      const result = await env.DB.prepare(
        `SELECT event_type, outcome, request_id, attempt_count, error_code
         FROM operational_events
         WHERE command_id = ?
         ORDER BY id`,
      )
        .bind(url.searchParams.get("commandId"))
        .all();
      return Response.json(result.results);
    }
    if (url.pathname === "/idempotency-state") {
      const result = await env.DB.prepare(
        `SELECT status, original_response_status, error_code,
                original_response_json
         FROM idempotency_keys
         WHERE tenant_key = 'org_fixture' AND command_id = ?`,
      )
        .bind(url.searchParams.get("commandId"))
        .first();
      return Response.json(result);
    }
    if (url.pathname === "/event-state") {
      const result = await env.DB.prepare(
        `SELECT id, name, source_version, source_content_hash
         FROM p_events WHERE organization_id = ? AND id = ?`,
      )
        .bind(
          url.searchParams.get("organizationId") ?? "org_fixture",
          url.searchParams.get("id"),
        )
        .first();
      return Response.json(result);
    }
    if (url.pathname === "/room-state") {
      const result = await env.DB.prepare(
        `SELECT id, name, source_version, source_content_hash, source_deleted_at
         FROM p_rooms WHERE organization_id = ? AND id = ?`,
      )
        .bind(
          url.searchParams.get("organizationId") ?? "org_fixture",
          url.searchParams.get("id"),
        )
        .first();
      return Response.json(result);
    }
    if (url.pathname === "/schedule-state") {
      const schedule = await new D1ScheduleProjectionRepository(env.DB).read(
        url.searchParams.get("eventId") ?? "",
      );
      return schedule
        ? Response.json(schedule)
        : Response.json({ error: "not_found" }, { status: 404 });
    }
    if (url.pathname === "/schedule-command") {
      const command = scheduleCommandSchema.parse(await request.json());
      const result = await new AirtableScheduleCommandService({
        actorId: "usr_demo_owner",
        authority: authority(env),
        database: env.DB,
        requestId: "req_schedule_fixture",
      }).execute(command);
      return Response.json(result);
    }
    if (url.pathname === "/access-state") {
      return Response.json(
        await loadEventAccess(
          env.DB,
          {
            email: url.searchParams.get("email") ?? "missing@example.invalid",
            id: url.searchParams.get("userId") ?? "usr_missing",
          },
          url.searchParams.get("organizationId") ?? "org_fixture",
          url.searchParams.get("eventId") ?? "evt_missing",
        ),
      );
    }
    if (url.pathname === "/source-state") {
      const organizationId =
        url.searchParams.get("organizationId") ?? "org_fixture";
      const sources = await env.DB.prepare(
        `SELECT provider_table_key AS table_key, COUNT(*) AS record_count,
                SUM(CASE WHEN source_deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted_count
         FROM authority_source_records
         WHERE organization_id = ?
         GROUP BY provider_table_key ORDER BY provider_table_key`,
      )
        .bind(organizationId)
        .all();
      const projections = await env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM p_events WHERE source_deleted_at IS NULL) AS events,
           (SELECT COUNT(*) FROM p_sessions WHERE source_deleted_at IS NULL) AS sessions,
           (SELECT COUNT(*) FROM p_schedule_slots WHERE source_deleted_at IS NULL) AS schedule_slots,
           (SELECT COUNT(*) FROM p_rooms WHERE source_deleted_at IS NULL) AS rooms,
           (SELECT COUNT(*) FROM p_tracks WHERE source_deleted_at IS NULL) AS tracks,
           (SELECT COUNT(*) FROM p_formats WHERE source_deleted_at IS NULL) AS formats,
           (SELECT COUNT(*) FROM p_session_participants WHERE source_deleted_at IS NULL) AS session_participants,
           (SELECT COUNT(*) FROM p_contacts WHERE source_deleted_at IS NULL) AS contacts`,
      ).first();
      return Response.json({ projections, sources: sources.results });
    }
    if (url.pathname === "/authority-trace") {
      const organizationId =
        url.searchParams.get("organizationId") ?? "org_fixture";
      const rows = await env.DB.prepare(
        `SELECT request_id, command_id, phase, outcome, table_key, entity_id,
                attempt_count, error_code
         FROM authority_traces WHERE organization_id = ?
         ORDER BY occurred_at, phase`,
      )
        .bind(organizationId)
        .all();
      return Response.json(rows.results);
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<FixtureEnvironment>;

export default class FixtureAuthorityRuntime extends WorkerEntrypoint<FixtureEnvironment> {
  override fetch(request: Request): Promise<Response> {
    return fixtureHandler.fetch(
      request as Request<unknown, IncomingRequestCfProperties>,
      this.env,
      this.ctx,
    );
  }
}
