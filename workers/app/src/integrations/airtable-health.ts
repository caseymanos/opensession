import {
  airtableIntegrationHealthSchema,
  airtableReconcilePlanSchema,
  airtableReconcileResponseSchema,
  type AirtableIntegrationHealth,
  type AirtableReconcilePlan,
  type AirtableReconcileResponse,
} from "@sessionbox-killer/contracts";
import { AIRTABLE_SCHEMA_VERSION } from "@sessionbox-killer/data";

import type { BaseAuthority } from "../authority/base-authority.js";
import type { ReconciliationPlan } from "../authority/reconciliation.js";

type Authority = Pick<BaseAuthority, "planReconcile" | "reconcilePlanned">;

interface ReconcileSummaryRow {
  completed_at: string | null;
  failed_count: number;
  running_count: number;
  table_count: number;
}

interface RepairSummaryRow {
  dead: number;
  failed: number;
  pending: number;
}

interface TraceCountRow {
  accepted_sessions: number;
  submitted_proposals: number;
  task_assignments: number;
}

interface AuditReplayRow {
  actor_id: string | null;
  created_at: string;
  metadata_json: string;
}

interface AuditMetadata {
  deleted: number;
  planId: string;
  projected: number;
  tableCount: number;
}

export class AirtableIntegrationError extends Error {
  readonly code: string;
  readonly status: 400 | 403 | 409 | 503;

  constructor(code: string, message: string, status: 400 | 403 | 409 | 503) {
    super(message);
    this.name = "AirtableIntegrationError";
    this.code = code;
    this.status = status;
  }
}

function dateOrNull(value: string | null | undefined): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function safePlan(plan: ReconciliationPlan, confirmation: string) {
  return {
    confirmation,
    counts: plan.counts,
    scope: "organization" as const,
    tables: plan.tables,
  };
}

async function planId(
  organizationId: string,
  plan: ReconciliationPlan,
): Promise<string> {
  return sha256(
    JSON.stringify({
      fingerprint: plan.fingerprint,
      organizationId,
      tables: plan.tables.map(({ key }) => key),
    }),
  );
}

function parseAuditMetadata(value: string): AuditMetadata | null {
  try {
    const parsed = JSON.parse(value) as Partial<AuditMetadata>;
    return typeof parsed.planId === "string" &&
      typeof parsed.deleted === "number" &&
      typeof parsed.projected === "number" &&
      typeof parsed.tableCount === "number"
      ? (parsed as AuditMetadata)
      : null;
  } catch {
    return null;
  }
}

export class AirtableIntegrationService {
  readonly #authority: Authority;
  readonly #baseId: string;
  readonly #database: D1Database;
  readonly #environment: "local" | "preview" | "production";
  readonly #now: () => Date;

  constructor(options: {
    authority: Authority;
    baseId: string;
    database: D1Database;
    environment: "local" | "preview" | "production";
    now?: () => Date;
  }) {
    this.#authority = options.authority;
    this.#baseId = options.baseId;
    this.#database = options.database;
    this.#environment = options.environment;
    this.#now = options.now ?? (() => new Date());
  }

  async health(
    organizationId: string,
    eventId: string,
  ): Promise<AirtableIntegrationHealth> {
    const baseKey = this.baseKey();
    const [lastRead, lastWrite, watermark, repairs, reconciliation, traces] =
      await Promise.all([
        this.#database
          .prepare(
            `SELECT MAX(completed_at) AS value FROM projection_scan_runs
             WHERE organization_id = ? AND provider = 'airtable'
               AND base_key = ? AND status = 'complete'`,
          )
          .bind(organizationId, baseKey)
          .first<{ value: string | null }>(),
        this.#database
          .prepare(
            `SELECT MAX(occurred_at) AS value FROM authority_traces
             WHERE organization_id = ? AND phase = 'provider_committed'
               AND outcome = 'success'`,
          )
          .bind(organizationId)
          .first<{ value: string | null }>(),
        this.#database
          .prepare(
            `SELECT MIN(updated_at) AS value FROM projection_watermarks
             WHERE organization_id = ? AND provider = 'airtable' AND base_key = ?`,
          )
          .bind(organizationId, baseKey)
          .first<{ value: string | null }>(),
        this.#database
          .prepare(
            `SELECT
               SUM(CASE WHEN status IN ('pending', 'leased') THEN 1 ELSE 0 END) AS pending,
               SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
               SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) AS dead
             FROM projection_repairs
             WHERE organization_id = ? AND provider = 'airtable' AND base_key = ?`,
          )
          .bind(organizationId, baseKey)
          .first<RepairSummaryRow>(),
        this.#database
          .prepare(
            `WITH latest AS (
               SELECT substr(id, 1, length(id) - length(table_key) - 1) AS scan_id
               FROM projection_scan_runs
               WHERE organization_id = ? AND provider = 'airtable' AND base_key = ?
               ORDER BY created_at DESC LIMIT 1
             )
             SELECT COUNT(*) AS table_count,
                    SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running_count,
                    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
                    MAX(completed_at) AS completed_at
             FROM projection_scan_runs, latest
             WHERE projection_scan_runs.organization_id = ?
               AND substr(
                 projection_scan_runs.id,
                 1,
                 length(projection_scan_runs.id) - length(projection_scan_runs.table_key) - 1
               ) = latest.scan_id`,
          )
          .bind(organizationId, baseKey, organizationId)
          .first<ReconcileSummaryRow>(),
        this.#database
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM p_submissions
                WHERE organization_id = ?1 AND event_id = ?2
                  AND status <> 'draft' AND source_deleted_at IS NULL) AS submitted_proposals,
               (SELECT COUNT(*) FROM p_sessions
                WHERE organization_id = ?1 AND event_id = ?2
                  AND status IN ('accepted', 'scheduled', 'published')
                  AND source_deleted_at IS NULL) AS accepted_sessions,
               (SELECT COUNT(*) FROM p_task_assignments
                WHERE organization_id = ?1 AND event_id = ?2
                  AND source_deleted_at IS NULL) AS task_assignments`,
          )
          .bind(organizationId, eventId)
          .first<TraceCountRow>(),
      ]);

    const generatedAt = this.#now();
    const watermarkAt = dateOrNull(watermark?.value);
    const tableCount = Number(reconciliation?.table_count ?? 0);
    const health = {
      authority: {
        base_suffix: `…${this.#baseId.replaceAll(/[^A-Za-z0-9]/g, "").slice(-6)}`,
        last_read_at: dateOrNull(lastRead?.value),
        last_write_at: dateOrNull(lastWrite?.value),
        schema_version: AIRTABLE_SCHEMA_VERSION,
      },
      generated_at: generatedAt.toISOString(),
      judge_trace: [
        {
          kind: "proposal" as const,
          label: "Submitted proposals",
          projected_count: Number(traces?.submitted_proposals ?? 0),
          tables: ["Submissions", "Submission Participants", "Contacts"],
        },
        {
          kind: "session" as const,
          label: "Accepted sessions",
          projected_count: Number(traces?.accepted_sessions ?? 0),
          tables: ["Sessions", "Session Participants", "Contacts"],
        },
        {
          kind: "task_assignment" as const,
          label: "Task assignments",
          projected_count: Number(traces?.task_assignments ?? 0),
          tables: ["Task Assignments", "Task Definitions", "Contacts"],
        },
      ],
      projection: {
        lag_seconds: watermarkAt
          ? Math.max(
              0,
              (generatedAt.getTime() - Date.parse(watermarkAt)) / 1_000,
            )
          : null,
        last_reconcile: {
          completed_at: dateOrNull(reconciliation?.completed_at),
          status:
            tableCount === 0
              ? ("never" as const)
              : Number(reconciliation?.running_count ?? 0) > 0
                ? ("running" as const)
                : Number(reconciliation?.failed_count ?? 0) > 0
                  ? ("failed" as const)
                  : ("succeeded" as const),
          table_count: tableCount,
        },
        repair_backlog: {
          dead: Number(repairs?.dead ?? 0),
          failed: Number(repairs?.failed ?? 0),
          pending: Number(repairs?.pending ?? 0),
        },
        watermark_at: watermarkAt,
      },
    };
    return airtableIntegrationHealthSchema.parse(health);
  }

  async dryRun(
    organizationId: string,
    eventSlug: string,
  ): Promise<{
    generated_at: string;
    mode: "dry_run";
    plan: AirtableReconcilePlan;
  }> {
    const plan = await this.#authority.planReconcile(organizationId);
    const confirmation = `RECONCILE ORGANIZATION FOR ${eventSlug}`;
    return {
      generated_at: this.#now().toISOString(),
      mode: "dry_run",
      plan: airtableReconcilePlanSchema.parse({
        ...safePlan(plan, confirmation),
        plan_id: await planId(organizationId, plan),
      }),
    };
  }

  async apply(options: {
    actorId: string;
    confirmation: string;
    eventId: string;
    eventSlug: string;
    idempotencyKey: string;
    organizationId: string;
    planId: string;
    requestId: string;
  }): Promise<AirtableReconcileResponse> {
    const auditHash = await sha256(
      `${options.organizationId}:airtable.reconciliation:${options.idempotencyKey}`,
    );
    const auditId = `aud_${auditHash.slice(0, 26)}`;
    const replay = await this.#database
      .prepare(
        `SELECT actor_id, metadata_json, created_at FROM audit_events
         WHERE organization_id = ? AND id = ? AND action = 'airtable.reconciliation.completed'`,
      )
      .bind(options.organizationId, auditId)
      .first<AuditReplayRow>();
    if (replay) {
      const metadata = parseAuditMetadata(replay.metadata_json);
      if (
        replay.actor_id !== options.actorId ||
        !metadata ||
        metadata.planId !== options.planId
      ) {
        throw new AirtableIntegrationError(
          "reconcile_idempotency_conflict",
          "This reconciliation key was already used for another request.",
          409,
        );
      }
      return airtableReconcileResponseSchema.parse({
        audit_id: auditId,
        completed_at: replay.created_at,
        mode: "apply",
        result: {
          deleted: metadata.deleted,
          projected: metadata.projected,
          table_count: metadata.tableCount,
        },
      });
    }

    const plan = await this.#authority.planReconcile(options.organizationId);
    const currentPlanId = await planId(options.organizationId, plan);
    if (currentPlanId !== options.planId) {
      throw new AirtableIntegrationError(
        "reconcile_plan_changed",
        "Airtable changed after the dry run. Review a fresh plan before applying.",
        409,
      );
    }
    const expectedConfirmation = `RECONCILE ORGANIZATION FOR ${options.eventSlug}`;
    if (options.confirmation !== expectedConfirmation) {
      throw new AirtableIntegrationError(
        "invalid_reconcile_confirmation",
        "Type the organization-wide confirmation exactly as shown.",
        400,
      );
    }

    let result;
    try {
      result = await this.#authority.reconcilePlanned(
        options.organizationId,
        plan.fingerprint,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "ReconciliationPlanChangedError"
      ) {
        throw new AirtableIntegrationError(
          "reconcile_plan_changed",
          "Airtable changed after the dry run. Review a fresh plan before applying.",
          409,
        );
      }
      throw error;
    }
    const completedAt = this.#now().toISOString();
    await this.#database
      .prepare(
        `INSERT INTO audit_events (
           id, organization_id, event_id, actor_type, actor_id, action,
           entity_type, entity_id, request_id, redaction_version,
           safe_diff_json, metadata_json, created_at
         ) VALUES (?, ?, ?, 'user', ?, 'airtable.reconciliation.completed',
                   'integration', 'airtable', ?, 1, ?, ?, ?)`,
      )
      .bind(
        auditId,
        options.organizationId,
        options.eventId,
        options.actorId,
        options.requestId,
        JSON.stringify({ divergence: plan.counts }),
        JSON.stringify({
          deleted: result.deleted,
          planId: options.planId,
          projected: result.projected,
          scope: "organization",
          tableCount: result.tables.length,
        }),
        completedAt,
      )
      .run();
    return airtableReconcileResponseSchema.parse({
      audit_id: auditId,
      completed_at: completedAt,
      mode: "apply",
      result: {
        deleted: result.deleted,
        projected: result.projected,
        table_count: result.tables.length,
      },
    });
  }

  private baseKey(): string {
    return `${this.#environment}:${this.#baseId}`;
  }
}
