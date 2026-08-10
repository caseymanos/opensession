import type {
  AirtableFields,
  AirtableRecord,
  AirtableTableKey,
} from "@sessionbox-killer/data/airtable/internal";

import { projectionSpecs, projectionTableOrder } from "./projection-spec.js";
import type {
  AirtableAuthorityProvider,
  BaseAuthorityEnvironment,
  ReconciliationBaseline,
} from "./provider.js";
import type { D1AuthorityProjector } from "./projector.js";

interface SourceRow extends Record<string, unknown> {
  entity_id: string;
  event_id: string | null;
  last_command_hash: string | null;
  last_command_id: string | null;
  organization_id: string;
  source_content_hash: string;
  source_version: number;
}

export interface ReconciliationResult {
  cursor: number | null;
  deleted: number;
  projected: number;
  scanId: string;
  tables: readonly AirtableTableKey[];
}

function safeErrorCode(error: unknown): string {
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9]+$/.test(error.name)
    ? error.name.slice(0, 80)
    : "reconciliation_failed";
}

function entityId(fields: AirtableFields, table: AirtableTableKey): string {
  const value = fields.ID;
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(value)
  ) {
    throw new Error(`Airtable ${table} record has an invalid stable ID.`);
  }
  return value;
}

function linkedRecordIds(
  fields: AirtableFields,
  table: AirtableTableKey,
): readonly string[] {
  return [
    ...projectionSpecs[table].fields,
    ...(projectionSpecs[table].scopeLinks ?? []),
  ].flatMap((field) => {
    if (field.kind !== "link") return [];
    const value = fields[field.field];
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
  });
}

export class AirtableReconciliationService {
  readonly #env: BaseAuthorityEnvironment;
  readonly #projector: D1AuthorityProjector;
  readonly #provider: AirtableAuthorityProvider;

  constructor(options: {
    environment: BaseAuthorityEnvironment;
    projector: D1AuthorityProjector;
    provider: AirtableAuthorityProvider;
  }) {
    this.#env = options.environment;
    this.#projector = options.projector;
    this.#provider = options.provider;
  }

  async fullScan(options: {
    cursor?: number | undefined;
    organizationId: string;
    tables?: readonly AirtableTableKey[] | undefined;
  }): Promise<ReconciliationResult> {
    const tenant = await this.assertActiveTenant(options.organizationId);
    const requested = new Set(options.tables ?? projectionTableOrder);
    const tables = projectionTableOrder.filter((table) => requested.has(table));
    if (tables.length !== requested.size) {
      throw new Error("Reconciliation requested an unknown Airtable table.");
    }
    const isCompleteFullScan = tables.length === projectionTableOrder.length;
    const now = new Date().toISOString();
    const invalidated = await this.#env.DB.prepare(
      `UPDATE tenant_registry
       SET authority_ready_at = NULL, updated_at = ?
       WHERE organization_id = ? AND base_key = ? AND status = 'active'
         AND authority_roster_version = ?`,
    )
      .bind(
        now,
        options.organizationId,
        this.baseKey(),
        tenant.authorityRosterVersion,
      )
      .run();
    if (invalidated.meta.changes !== 1) {
      throw new Error("Reconciliation tenant changed before the scan.");
    }
    const scanId = `scan_${Date.now()}_${crypto.randomUUID().replaceAll("-", "")}`;
    let projected = 0;
    let deleted = 0;
    for (const table of tables) {
      const tableScanId = `${scanId}_${table}`;
      const startedAt = new Date().toISOString();
      await this.#env.DB.prepare(
        `INSERT INTO projection_scan_runs (
           id, organization_id, provider, base_key, table_key, status,
           start_cursor, created_at
         ) VALUES (?, ?, 'airtable', ?, ?, 'running', ?, ?)`,
      )
        .bind(
          tableScanId,
          options.organizationId,
          this.baseKey(),
          table,
          options.cursor ?? null,
          startedAt,
        )
        .run();
      try {
        const records = await this.#provider.listTableRecords(table);
        let seen = 0;
        for (const record of records) {
          if (
            !(await this.belongsToOrganization(
              options.organizationId,
              table,
              record,
            ))
          ) {
            continue;
          }
          const stableId = entityId(record.fields, table);
          const baseline = await this.baseline(table, record.id);
          if (baseline && baseline.entityId !== stableId) {
            await this.#projector.tombstoneRecord(
              options.organizationId,
              table,
              record.id,
            );
            throw new Error(
              `Airtable ${table} stable ID changed outside the authority.`,
            );
          }
          const prepared = await this.#provider.prepareReconciliationRecord(
            table,
            record,
            baseline,
          );
          if (prepared.fields.ID !== stableId) {
            await this.#projector.tombstoneRecord(
              options.organizationId,
              table,
              record.id,
            );
            throw new Error(
              "Airtable stable ID changed during reconciliation.",
            );
          }
          const eventId = await this.deriveEventId(
            options.organizationId,
            table,
            stableId,
            prepared.fields,
          );
          await this.#projector.projectSource({
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
            entityId: stableId,
            ...(eventId ? { eventId } : {}),
            fields: prepared.fields,
            organizationId: options.organizationId,
            recordId: prepared.recordId,
            scanId: tableScanId,
            sourceContentHash: prepared.sourceContentHash,
            sourceVersion: prepared.sourceVersion,
            table,
          });
          seen += 1;
        }
        const removed = await this.#projector.finishScan(
          options.organizationId,
          table,
          tableScanId,
        );
        deleted += removed;
        projected += seen;
        const completedAt = new Date().toISOString();
        await this.#env.DB.batch([
          this.#env.DB.prepare(
            `UPDATE projection_scan_runs
             SET status = 'complete', end_cursor = ?, seen_count = ?, completed_at = ?
             WHERE organization_id = ? AND id = ?`,
          ).bind(
            options.cursor ?? null,
            seen,
            completedAt,
            options.organizationId,
            tableScanId,
          ),
          this.#env.DB.prepare(
            `INSERT INTO projection_watermarks (
               organization_id, provider, base_key, table_key, committed_cursor,
               last_full_scan_id, last_full_scan_at, updated_at
             ) VALUES (?, 'airtable', ?, ?, ?, ?, ?, ?)
             ON CONFLICT (organization_id, provider, base_key, table_key) DO UPDATE SET
               committed_cursor = COALESCE(excluded.committed_cursor, projection_watermarks.committed_cursor),
               last_full_scan_id = excluded.last_full_scan_id,
               last_full_scan_at = excluded.last_full_scan_at,
               updated_at = excluded.updated_at`,
          ).bind(
            options.organizationId,
            this.baseKey(),
            table,
            options.cursor ?? null,
            tableScanId,
            completedAt,
            completedAt,
          ),
        ]);
      } catch (error) {
        await this.#env.DB.prepare(
          `UPDATE projection_scan_runs
           SET status = 'failed', completed_at = ?, error_code = ?
           WHERE organization_id = ? AND id = ?`,
        )
          .bind(
            new Date().toISOString(),
            safeErrorCode(error),
            options.organizationId,
            tableScanId,
          )
          .run();
        throw error;
      }
    }
    if (isCompleteFullScan || tenant.wasReady) {
      const ready = await this.#env.DB.prepare(
        `UPDATE tenant_registry SET authority_ready_at = ?, updated_at = ?
         WHERE organization_id = ? AND base_key = ? AND status = 'active'
           AND authority_roster_version = ?`,
      )
        .bind(
          new Date().toISOString(),
          new Date().toISOString(),
          options.organizationId,
          this.baseKey(),
          tenant.authorityRosterVersion,
        )
        .run();
      if (ready.meta.changes !== 1) {
        throw new Error("Reconciliation tenant changed during the scan.");
      }
    }
    return {
      cursor: options.cursor ?? null,
      deleted,
      projected,
      scanId,
      tables,
    };
  }

  private async assertActiveTenant(organizationId: string): Promise<{
    authorityRosterVersion: number;
    wasReady: boolean;
  }> {
    const tenant = await this.#env.DB.prepare(
      `SELECT authority_roster_version, authority_ready_at FROM tenant_registry
       WHERE organization_id = ? AND base_key = ? AND status = 'active'`,
    )
      .bind(organizationId, this.baseKey())
      .first<{
        authority_ready_at: string | null;
        authority_roster_version: number;
      }>();
    if (!tenant)
      throw new Error("Reconciliation tenant is not active for this base.");
    return {
      authorityRosterVersion: tenant.authority_roster_version,
      wasReady: tenant.authority_ready_at !== null,
    };
  }

  private async baseline(
    table: AirtableTableKey,
    recordId: string,
  ): Promise<ReconciliationBaseline | null> {
    const row = await this.#env.DB.prepare(
      `SELECT entity_id, organization_id, event_id, source_version, source_content_hash,
              last_command_id, last_command_hash
       FROM authority_source_records
       WHERE base_key = ? AND provider_table_key = ? AND provider_record_id = ?`,
    )
      .bind(this.baseKey(), table, recordId)
      .first<SourceRow>();
    return row
      ? {
          entityId: row.entity_id,
          lastCommandHash: row.last_command_hash,
          lastCommandId: row.last_command_id,
          sourceContentHash: row.source_content_hash,
          sourceVersion: row.source_version,
        }
      : null;
  }

  private async belongsToOrganization(
    organizationId: string,
    table: AirtableTableKey,
    record: AirtableRecord,
  ): Promise<boolean> {
    const existing = await this.#env.DB.prepare(
      `SELECT organization_id FROM authority_source_records
       WHERE base_key = ? AND provider_table_key = ? AND provider_record_id = ?`,
    )
      .bind(this.baseKey(), table, record.id)
      .first<{ organization_id: string }>();
    if (existing) return existing.organization_id === organizationId;
    if (table === "organizations")
      return entityId(record.fields, table) === organizationId;
    const links = linkedRecordIds(record.fields, table);
    for (const recordId of links) {
      const linked = await this.#env.DB.prepare(
        `SELECT organization_id FROM authority_source_records
         WHERE base_key = ? AND provider_record_id = ? AND source_deleted_at IS NULL
         LIMIT 1`,
      )
        .bind(this.baseKey(), recordId)
        .first<{ organization_id: string }>();
      if (linked) return linked.organization_id === organizationId;
    }
    return false;
  }

  private async deriveEventId(
    organizationId: string,
    table: AirtableTableKey,
    stableId: string,
    fields: AirtableFields,
  ): Promise<string | undefined> {
    if (table === "events") return stableId;
    if (projectionSpecs[table].scope === "organization") return undefined;
    const eventIds = new Set<string>();
    for (const recordId of linkedRecordIds(fields, table)) {
      const linked = await this.#env.DB.prepare(
        `SELECT event_id, organization_id FROM authority_source_records
         WHERE base_key = ? AND provider_record_id = ? AND source_deleted_at IS NULL
         LIMIT 1`,
      )
        .bind(this.baseKey(), recordId)
        .first<{
          event_id: string | null;
          organization_id: string;
        }>();
      if (!linked) {
        throw new Error(
          `${table} ${stableId} references unprojected Airtable record ${recordId}.`,
        );
      }
      if (linked.organization_id !== organizationId) {
        throw new Error(
          `${table} ${stableId} link crosses an organization boundary.`,
        );
      }
      if (linked.event_id) eventIds.add(linked.event_id);
    }
    if (eventIds.size !== 1) {
      throw new Error(`${table} must resolve to exactly one event scope.`);
    }
    return [...eventIds][0];
  }

  private baseKey(): string {
    return `${this.#env.APP_ENV}:${this.#env.AIRTABLE_BASE_ID}`;
  }
}
