import type {
  AirtableCommandResult,
  AirtableFields,
  AirtableTableKey,
} from "@sessionbox-killer/data/airtable/internal";

import type { BaseAuthorityEnvironment } from "./provider.js";
import { projectionSpecs } from "./projection-spec.js";
import type { ProjectionFieldSpec } from "./projection-spec.js";
import type {
  PublicScheduleCacheInvalidationMessageV1,
  PublicScheduleCacheInvalidationMessageV2,
  PublicScheduleCacheInvalidationMessageV3,
} from "../public-schedule/cache.js";
import {
  durableOperationalEventStatement,
  expiredOperationalEventsStatement,
} from "../observability.js";
import {
  AuthorityIdempotencyConflictError,
  type AuthorityFailure,
  type AuthorityResponse,
  type BaseAuthorityCommand,
} from "./types.js";

const productionCacheInvalidationRedriveDelayMilliseconds = 10 * 60 * 1_000;

export function cacheInvalidationRedriveDelayMilliseconds(
  environment: BaseAuthorityEnvironment,
): number {
  if (environment.APP_ENV !== "local") {
    return productionCacheInvalidationRedriveDelayMilliseconds;
  }
  const configured = Number(
    environment.AUTHORITY_CACHE_INVALIDATION_REDRIVE_MILLISECONDS,
  );
  return Number.isInteger(configured) && configured >= 100
    ? configured
    : productionCacheInvalidationRedriveDelayMilliseconds;
}

interface ProjectionCommit {
  attemptCount: number;
  command: BaseAuthorityCommand;
  requestHash: string;
  response: AuthorityResponse;
  result: AirtableCommandResult;
  sourceContentHash: string;
}

interface FailureCommit {
  attemptCount: number;
  command: BaseAuthorityCommand;
  failure: AuthorityFailure;
  requestHash: string;
}

interface ExistingIdempotency {
  request_hash: string;
}

interface SourceRegistryRow {
  entity_id: string;
  event_id: string | null;
  organization_id: string;
  source_version: number;
}

interface ResolvedLink {
  entityId: string;
  eventId: string | null;
  organizationId: string;
}

export interface SourceProjection {
  cursor?: number | undefined;
  entityId: string;
  eventId?: string | undefined;
  fields: AirtableFields;
  organizationId: string;
  recordId: string;
  scanId?: string | undefined;
  sourceContentHash: string;
  sourceVersion: number;
  table: AirtableTableKey;
}

const updatedAtTables = new Set<AirtableTableKey>([
  "reviews",
  "sessions",
  "submissions",
  "task_assignments",
]);

export function shouldInvalidatePublicSchedule(
  command: Pick<BaseAuthorityCommand, "operation" | "table">,
): boolean {
  return !command.operation.startsWith("schedule.");
}

function isoTimestamp(milliseconds = Date.now()): string {
  return new Date(milliseconds).toISOString();
}

function safeIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new Error("Projection contains an unsafe SQL identifier.");
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new Error("Projection JSON contains an unsupported value.");
}

function jsonValue(raw: unknown, field: ProjectionFieldSpec): string | null {
  const candidate = raw === undefined || raw === "" ? field.defaultValue : raw;
  if (candidate === undefined || candidate === null) {
    if (field.required)
      throw new Error(`${field.field} is required for projection.`);
    return null;
  }
  let parsed: unknown;
  if (typeof candidate === "string") {
    try {
      parsed = JSON.parse(candidate);
    } catch {
      throw new Error(`${field.field} must contain valid JSON.`);
    }
  } else {
    parsed = candidate;
  }
  if (field.kind === "json_array" && !Array.isArray(parsed)) {
    throw new Error(`${field.field} must contain a JSON array.`);
  }
  if (
    field.kind === "json_object" &&
    (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
  ) {
    throw new Error(`${field.field} must contain a JSON object.`);
  }
  return canonicalJson(parsed);
}

function scalarValue(
  raw: unknown,
  field: ProjectionFieldSpec,
): SqlStorageValue {
  const candidate = raw === undefined || raw === "" ? field.defaultValue : raw;
  if (field.kind.startsWith("json_")) return jsonValue(candidate, field);
  if (field.kind === "multiselect") {
    if (candidate === undefined || candidate === null) return "[]";
    if (
      !Array.isArray(candidate) ||
      candidate.some((value) => typeof value !== "string")
    ) {
      throw new Error(`${field.field} must contain a list of text values.`);
    }
    return canonicalJson(candidate);
  }
  if (candidate === undefined || candidate === null) {
    if (field.required)
      throw new Error(`${field.field} is required for projection.`);
    return null;
  }
  if (field.kind === "boolean") {
    if (typeof candidate !== "boolean") {
      throw new Error(`${field.field} must contain a checkbox value.`);
    }
    return candidate ? 1 : 0;
  }
  if (field.kind === "number") {
    if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
      throw new Error(`${field.field} must contain a finite number.`);
    }
    return candidate;
  }
  if (
    typeof candidate !== "string" ||
    (field.required && candidate.length === 0)
  ) {
    throw new Error(`${field.field} must contain text.`);
  }
  return candidate.length === 0 ? null : candidate;
}

function traceStatement(
  database: D1Database,
  values: {
    attemptCount: number;
    commandId?: string;
    entityId?: string;
    errorCode?: string;
    eventId?: string;
    organizationId: string;
    outcome: "accepted" | "failure" | "success";
    phase:
      | "complete"
      | "failed"
      | "projection_pending"
      | "projection_repaired"
      | "provider_committed"
      | "provider_dispatched"
      | "received";
    requestId: string;
    table?: string;
  },
  at = new Date(),
): D1PreparedStatement {
  const identity = `${values.organizationId}\u0000${values.requestId}\u0000${values.commandId ?? ""}\u0000${values.entityId ?? ""}\u0000${values.phase}\u0000${values.attemptCount}`;
  return database
    .prepare(
      `INSERT OR IGNORE INTO authority_traces (
         id, organization_id, event_id, request_id, command_id, phase,
         outcome, table_key, entity_id, attempt_count, error_code, occurred_at
       ) VALUES (
         'trc_' || lower(hex(?1)), ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
       )`,
    )
    .bind(
      identity,
      values.organizationId,
      values.eventId ?? null,
      values.requestId,
      values.commandId ?? null,
      values.phase,
      values.outcome,
      values.table ?? null,
      values.entityId ?? null,
      values.attemptCount,
      values.errorCode ?? null,
      at.toISOString(),
    );
}

export class D1AuthorityProjector {
  readonly #env: BaseAuthorityEnvironment;
  readonly #scheduleCacheInvalidationRecovery: () => Promise<void>;

  constructor(
    env: BaseAuthorityEnvironment,
    scheduleCacheInvalidationRecovery: () => Promise<void>,
  ) {
    this.#env = env;
    this.#scheduleCacheInvalidationRecovery = scheduleCacheInvalidationRecovery;
  }

  assertSupported(table: BaseAuthorityCommand["table"]): void {
    if (!projectionSpecs[table]) {
      throw new Error(`Runtime projection for ${table} is not implemented.`);
    }
  }

  async #enqueuePublicScheduleInvalidation(options: {
    eventId: string;
    invalidationVersion: number;
    organizationId: string;
    publicationVersion: number | null;
    surfaces: readonly string[];
  }): Promise<void> {
    if (options.surfaces.join(",") !== "schedule,gallery,feed") {
      throw new Error("Publication cache invalidation surfaces are invalid.");
    }
    const legacyMessage: PublicScheduleCacheInvalidationMessageV1 = {
      event_id: options.eventId,
      kind: "public_schedule.cache.invalidate",
      version: 1,
    };
    const message:
      | PublicScheduleCacheInvalidationMessageV2
      | PublicScheduleCacheInvalidationMessageV3 = options.publicationVersion
      ? {
          event_id: options.eventId,
          invalidation_version: options.invalidationVersion,
          kind: "public_schedule.cache.invalidate",
          organization_id: options.organizationId,
          publication_version: options.publicationVersion,
          surfaces: ["schedule", "gallery", "feed"],
          version: 3,
        }
      : {
          event_id: options.eventId,
          invalidation_version: options.invalidationVersion,
          kind: "public_schedule.cache.invalidate",
          organization_id: options.organizationId,
          version: 2,
        };
    await this.#env.PROJECTION_REPAIR_QUEUE.send(legacyMessage);
    await this.#env.PROJECTION_REPAIR_QUEUE.send(message);
  }

  async #affectedScheduleEventIds(options: {
    entityId: string;
    eventId?: string | null | undefined;
    organizationId: string;
    table: AirtableTableKey;
  }): Promise<string[]> {
    const eventIds = new Set<string>();
    if (options.eventId) eventIds.add(options.eventId);
    if (options.table === "events") eventIds.add(options.entityId);
    if (options.table === "contacts") {
      const linked = await this.#env.DB.prepare(
        `SELECT DISTINCT event_id FROM p_session_participants
         WHERE organization_id = ? AND contact_id = ?
           AND source_deleted_at IS NULL`,
      )
        .bind(options.organizationId, options.entityId)
        .all<{ event_id: string }>();
      linked.results.forEach(({ event_id }) => eventIds.add(event_id));
    }
    return [...eventIds].sort();
  }

  #cacheInvalidationStatement(
    organizationId: string,
    eventIds: readonly string[],
    now: string,
  ): D1PreparedStatement | null {
    if (eventIds.length === 0) return null;
    return this.#env.DB.prepare(
      `INSERT INTO authority_cache_invalidations (
         organization_id, event_id, status, attempt_count, created_at, updated_at
       )
       SELECT ?, value, 'pending', 0, ?, ? FROM json_each(?) WHERE true
       ON CONFLICT (organization_id, event_id) DO UPDATE SET
         status = 'pending',
         invalidation_version = authority_cache_invalidations.invalidation_version + 1,
         publication_version = NULL,
         surfaces_json = excluded.surfaces_json,
         attempt_count = 0, updated_at = excluded.updated_at, enqueued_at = NULL,
         processed_at = NULL, last_error_code = NULL`,
    ).bind(organizationId, now, now, JSON.stringify(eventIds));
  }

  async drainCacheInvalidations(limit = 50): Promise<number> {
    const pending = await this.#env.DB.prepare(
      `SELECT organization_id, event_id, invalidation_version,
              publication_version, surfaces_json, status
       FROM authority_cache_invalidations
       WHERE status IN ('pending', 'published')
          OR (status = 'enqueued' AND updated_at <= ?)
       ORDER BY updated_at, organization_id, event_id LIMIT ?`,
    )
      .bind(
        new Date(
          Date.now() - cacheInvalidationRedriveDelayMilliseconds(this.#env),
        ).toISOString(),
        limit,
      )
      .all<{
        event_id: string;
        invalidation_version: number;
        organization_id: string;
        publication_version: number | null;
        surfaces_json: string;
        status: "enqueued" | "pending" | "published";
      }>();
    let published = 0;
    for (const row of pending.results) {
      try {
        await this.#enqueuePublicScheduleInvalidation({
          eventId: row.event_id,
          invalidationVersion: row.invalidation_version,
          organizationId: row.organization_id,
          publicationVersion: row.publication_version,
          surfaces: JSON.parse(row.surfaces_json) as string[],
        });
      } catch (error) {
        await this.#env.DB.prepare(
          `UPDATE authority_cache_invalidations
           SET attempt_count = attempt_count + 1, last_error_code = ?, updated_at = ?
           WHERE organization_id = ? AND event_id = ?
             AND invalidation_version = ? AND status = ?`,
        )
          .bind(
            error instanceof Error ? error.name : "UnknownError",
            isoTimestamp(),
            row.organization_id,
            row.event_id,
            row.invalidation_version,
            row.status,
          )
          .run();
        throw error;
      }
      const enqueued = await this.#env.DB.prepare(
        `UPDATE authority_cache_invalidations
         SET status = 'enqueued', attempt_count = attempt_count + 1,
             enqueued_at = ?, updated_at = ?, last_error_code = NULL
         WHERE organization_id = ? AND event_id = ?
           AND invalidation_version = ? AND status = ?`,
      )
        .bind(
          isoTimestamp(),
          isoTimestamp(),
          row.organization_id,
          row.event_id,
          row.invalidation_version,
          row.status,
        )
        .run();
      published += enqueued.meta.changes;
    }
    if (published > 0) {
      await this.#scheduleCacheInvalidationRecovery();
    }
    return published;
  }

  async projectSource(source: SourceProjection): Promise<void> {
    const eventIds = await this.#affectedScheduleEventIds({
      entityId: source.entityId,
      eventId: source.eventId,
      organizationId: source.organizationId,
      table: source.table,
    });
    const statements = await this.sourceStatements(source);
    const invalidation = this.#cacheInvalidationStatement(
      source.organizationId,
      eventIds,
      isoTimestamp(),
    );
    if (invalidation) statements.push(invalidation);
    await this.#env.DB.batch(statements);
    await this.drainCacheInvalidations();
  }

  async sourceStatements(
    source: SourceProjection,
  ): Promise<D1PreparedStatement[]> {
    this.assertSupported(source.table);
    if (!Number.isInteger(source.sourceVersion) || source.sourceVersion < 1) {
      throw new Error("Projection Source version must be a positive integer.");
    }
    if (!/^[0-9a-f]{64}$/.test(source.sourceContentHash)) {
      throw new Error("Projection content hash is invalid.");
    }
    const existingEntity = await this.#env.DB.prepare(
      `SELECT organization_id FROM authority_source_records
       WHERE base_key = ? AND provider_table_key = ? AND entity_id = ?`,
    )
      .bind(this.baseKey(), source.table, source.entityId)
      .first<{ organization_id: string }>();
    if (
      existingEntity &&
      existingEntity.organization_id !== source.organizationId
    ) {
      throw new Error("Projection entity belongs to another organization.");
    }

    const spec = projectionSpecs[source.table];
    const columns: string[] = ["id"];
    const values: SqlStorageValue[] = [source.entityId];
    if (source.table !== "organizations") {
      columns.push("organization_id");
      values.push(source.organizationId);
    }
    const resolvedLinks = new Map<string, ResolvedLink | null>();
    for (const field of spec.scopeLinks ?? []) {
      const raw = source.fields[field.field];
      const hasValue =
        raw !== undefined &&
        raw !== null &&
        raw !== "" &&
        (!Array.isArray(raw) || raw.length > 0);
      const envelopeSuppliesScope =
        field.linkedTable === "organizations" ||
        (field.linkedTable === "events" && source.eventId !== undefined);
      if (!hasValue && envelopeSuppliesScope) {
        resolvedLinks.set(field.field, null);
        continue;
      }
      resolvedLinks.set(field.field, await this.resolveLink(source, field));
    }
    for (const field of spec.fields) {
      columns.push(safeIdentifier(field.column));
      if (field.kind === "link") {
        const resolved = await this.resolveLink(source, field);
        resolvedLinks.set(field.field, resolved);
        values.push(resolved?.entityId ?? null);
      } else {
        values.push(scalarValue(source.fields[field.field], field));
      }
    }

    let eventId: string | null = null;
    if (spec.scope === "event") {
      eventId =
        source.table === "events"
          ? source.entityId
          : (source.eventId ??
            [...resolvedLinks.values()].find((link) => link?.eventId)
              ?.eventId ??
            null);
      if (!eventId) throw new Error(`${source.table} requires an event scope.`);
      if (source.eventId && source.eventId !== eventId) {
        throw new Error(
          "Projection link scope does not match the requested event.",
        );
      }
      if (source.table !== "events" && !columns.includes("event_id")) {
        columns.push("event_id");
        values.push(eventId);
      }
    }
    for (const resolved of resolvedLinks.values()) {
      if (resolved && resolved.organizationId !== source.organizationId) {
        throw new Error("Projection link crosses an organization boundary.");
      }
      if (resolved?.eventId && eventId && resolved.eventId !== eventId) {
        throw new Error("Projection link crosses an event boundary.");
      }
    }
    const now = isoTimestamp();
    if (updatedAtTables.has(source.table)) {
      columns.push("updated_at");
      values.push(now);
    }
    columns.push(
      "source_record_id",
      "source_version",
      "source_content_hash",
      "source_cursor",
      "projected_at",
      "last_seen_scan_id",
      "source_deleted_at",
    );
    values.push(
      source.recordId,
      source.sourceVersion,
      source.sourceContentHash,
      source.cursor ?? null,
      now,
      source.scanId ?? null,
      null,
    );

    const table = safeIdentifier(spec.table);
    const updateColumns = columns.filter(
      (column) => column !== "id" && column !== "organization_id",
    );
    const placeholders = columns.map((_, index) => `?${index + 1}`).join(", ");
    const scopeGuard =
      source.table === "organizations"
        ? `${table}.id = excluded.id`
        : `${table}.organization_id = excluded.organization_id`;
    const typed = this.#env.DB.prepare(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})
       ON CONFLICT (id) DO UPDATE SET
         ${updateColumns.map((column) => `${column} = excluded.${column}`).join(", ")}
       WHERE ${scopeGuard}
         AND ${table}.source_version <= excluded.source_version`,
    ).bind(...values);

    const lastCommandId =
      typeof source.fields["Last command ID"] === "string"
        ? source.fields["Last command ID"]
        : null;
    const lastCommandHash =
      typeof source.fields["Last command hash"] === "string"
        ? source.fields["Last command hash"]
        : null;
    const registry = this.#env.DB.prepare(
      `INSERT INTO authority_source_records (
         base_key, provider_table_key, provider_record_id, entity_id,
         organization_id, event_id, source_version, source_content_hash,
         last_command_id, last_command_hash, source_cursor, last_seen_scan_id,
         projected_at, source_deleted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT (base_key, provider_table_key, provider_record_id) DO UPDATE SET
         entity_id = excluded.entity_id,
         event_id = excluded.event_id,
         source_version = excluded.source_version,
         source_content_hash = excluded.source_content_hash,
         last_command_id = excluded.last_command_id,
         last_command_hash = excluded.last_command_hash,
         source_cursor = excluded.source_cursor,
         last_seen_scan_id = excluded.last_seen_scan_id,
         projected_at = excluded.projected_at,
         source_deleted_at = NULL
       WHERE authority_source_records.organization_id = excluded.organization_id
         AND authority_source_records.source_version <= excluded.source_version`,
    ).bind(
      this.baseKey(),
      source.table,
      source.recordId,
      source.entityId,
      source.organizationId,
      spec.scope === "event" ? eventId : null,
      source.sourceVersion,
      source.sourceContentHash,
      lastCommandId,
      lastCommandHash,
      source.cursor ?? null,
      source.scanId ?? null,
      now,
    );
    return [typed, registry];
  }

  async finishScan(
    organizationId: string,
    tableKey: AirtableTableKey,
    scanId: string,
  ): Promise<number> {
    const missing = await this.#env.DB.prepare(
      `SELECT entity_id, event_id, provider_record_id FROM authority_source_records
       WHERE base_key = ? AND provider_table_key = ? AND organization_id = ?
         AND source_deleted_at IS NULL
         AND COALESCE(last_seen_scan_id, '') <> ?`,
    )
      .bind(this.baseKey(), tableKey, organizationId, scanId)
      .all<{
        entity_id: string;
        event_id: string | null;
        provider_record_id: string;
      }>();
    const now = isoTimestamp();
    const spec = projectionSpecs[tableKey];
    for (let index = 0; index < missing.results.length; index += 40) {
      const statements: D1PreparedStatement[] = [];
      const invalidatedEventIds = new Set<string>();
      for (const row of missing.results.slice(index, index + 40)) {
        const eventIds = await this.#affectedScheduleEventIds({
          entityId: row.entity_id,
          eventId: row.event_id,
          organizationId,
          table: tableKey,
        });
        eventIds.forEach((eventId) => invalidatedEventIds.add(eventId));
        const typedScope =
          tableKey === "organizations"
            ? "source_record_id = ?"
            : "source_record_id = ? AND organization_id = ?";
        statements.push(
          this.#env.DB.prepare(
            `UPDATE ${safeIdentifier(spec.table)}
             SET source_deleted_at = ?, projected_at = ?
             WHERE ${typedScope} AND source_deleted_at IS NULL`,
          ).bind(
            now,
            now,
            row.provider_record_id,
            ...(tableKey === "organizations" ? [] : [organizationId]),
          ),
          this.#env.DB.prepare(
            `UPDATE authority_source_records
             SET source_deleted_at = ?, projected_at = ?
             WHERE base_key = ? AND provider_table_key = ?
               AND provider_record_id = ? AND organization_id = ?
               AND source_deleted_at IS NULL`,
          ).bind(
            now,
            now,
            this.baseKey(),
            tableKey,
            row.provider_record_id,
            organizationId,
          ),
        );
      }
      const invalidation = this.#cacheInvalidationStatement(
        organizationId,
        [...invalidatedEventIds],
        now,
      );
      if (invalidation) statements.push(invalidation);
      if (statements.length > 0) await this.#env.DB.batch(statements);
    }
    await this.drainCacheInvalidations();
    return missing.results.length;
  }

  async tombstoneRecord(
    organizationId: string,
    tableKey: AirtableTableKey,
    providerRecordId: string,
  ): Promise<void> {
    const now = isoTimestamp();
    const spec = projectionSpecs[tableKey];
    const source = await this.#env.DB.prepare(
      `SELECT entity_id, event_id FROM authority_source_records
       WHERE base_key = ? AND provider_table_key = ?
         AND provider_record_id = ? AND organization_id = ?`,
    )
      .bind(this.baseKey(), tableKey, providerRecordId, organizationId)
      .first<{ entity_id: string; event_id: string | null }>();
    const typedScope =
      tableKey === "organizations"
        ? "source_record_id = ?"
        : "source_record_id = ? AND organization_id = ?";
    const eventIds = source
      ? await this.#affectedScheduleEventIds({
          entityId: source.entity_id,
          eventId: source.event_id,
          organizationId,
          table: tableKey,
        })
      : [];
    const statements = [
      this.#env.DB.prepare(
        `UPDATE ${safeIdentifier(spec.table)}
         SET source_deleted_at = ?, projected_at = ?
         WHERE ${typedScope} AND source_deleted_at IS NULL`,
      ).bind(
        now,
        now,
        providerRecordId,
        ...(tableKey === "organizations" ? [] : [organizationId]),
      ),
      this.#env.DB.prepare(
        `UPDATE authority_source_records
         SET source_deleted_at = ?, projected_at = ?
         WHERE base_key = ? AND provider_table_key = ?
           AND provider_record_id = ? AND organization_id = ?
           AND source_deleted_at IS NULL`,
      ).bind(
        now,
        now,
        this.baseKey(),
        tableKey,
        providerRecordId,
        organizationId,
      ),
    ];
    const invalidation = this.#cacheInvalidationStatement(
      organizationId,
      eventIds,
      now,
    );
    if (invalidation) statements.push(invalidation);
    await this.#env.DB.batch(statements);
    await this.drainCacheInvalidations();
  }

  async commit(commit: ProjectionCommit): Promise<void> {
    const {
      attemptCount,
      command,
      requestHash,
      response,
      result,
      sourceContentHash,
    } = commit;
    const existing = await this.idempotency(command);
    if (existing && existing.request_hash !== requestHash) {
      throw new AuthorityIdempotencyConflictError(command.commandId);
    }
    const eventId =
      command.table === "events" ? command.entityId : command.audit.eventId;
    const invalidatedEventIds = shouldInvalidatePublicSchedule(command)
      ? await this.#affectedScheduleEventIds({
          entityId: command.entityId,
          eventId,
          organizationId: command.organizationId,
          table: command.table,
        })
      : [];
    if (existing) {
      const invalidation = this.#cacheInvalidationStatement(
        command.organizationId,
        invalidatedEventIds,
        isoTimestamp(),
      );
      if (invalidation) await this.#env.DB.batch([invalidation]);
      await this.drainCacheInvalidations();
      return;
    }

    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = isoTimestamp(now.getTime() + 30 * 24 * 60 * 60 * 1_000);
    const repaired = response.status === "committed_with_repair";
    const statements = await this.sourceStatements({
      entityId: command.entityId,
      ...(eventId ? { eventId } : {}),
      fields: result.fields,
      organizationId: command.organizationId,
      recordId: result.recordId,
      sourceContentHash,
      sourceVersion: result.sourceVersion,
      table: command.table,
    });
    statements.push(
      this.#env.DB.prepare(
        `INSERT INTO idempotency_keys (
           tenant_key, operation, command_id, request_hash, status,
           entity_type, entity_id, original_response_status,
           original_response_json, created_at, updated_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        command.organizationId,
        command.operation,
        command.commandId,
        requestHash,
        repaired ? "committed_with_repair" : "committed",
        command.table,
        command.entityId,
        repaired ? 202 : 200,
        JSON.stringify(response),
        createdAt,
        createdAt,
        expiresAt,
      ),
      this.#env.DB.prepare(
        `INSERT INTO audit_events (
           id, organization_id, event_id, actor_type, actor_id, action,
           entity_type, entity_id, request_id, command_id, redaction_version,
           safe_diff_json, metadata_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      ).bind(
        `aud_${requestHash.slice(0, 26)}`,
        command.organizationId,
        eventId ?? null,
        command.audit.actorType,
        command.audit.actorId ?? null,
        command.audit.action,
        command.table,
        command.entityId,
        command.audit.requestId,
        command.commandId,
        JSON.stringify(command.audit.safeDiff),
        JSON.stringify({
          baseKey: this.baseKey(),
          provider: "airtable",
          sourceContentHash,
          table: command.table,
        }),
        createdAt,
      ),
      this.#env.DB.prepare(
        `INSERT INTO outbox_events (
           id, organization_id, event_id, aggregate_type, aggregate_id,
           event_type, idempotency_key, payload_json, status, available_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      ).bind(
        `out_${requestHash.slice(0, 26)}`,
        command.organizationId,
        eventId ?? null,
        command.table,
        command.entityId,
        `${command.operation}.committed`,
        `authority:${command.organizationId}:${command.operation}:${command.commandId}`,
        JSON.stringify({
          commandId: command.commandId,
          entityId: command.entityId,
          operation: command.operation,
          sourceContentHash,
          table: command.table,
        }),
        createdAt,
        createdAt,
        createdAt,
      ),
      traceStatement(
        this.#env.DB,
        {
          attemptCount,
          commandId: command.commandId,
          entityId: command.entityId,
          ...(eventId ? { eventId } : {}),
          organizationId: command.organizationId,
          outcome: "success",
          phase: repaired ? "projection_repaired" : "complete",
          requestId: command.audit.requestId,
          table: command.table,
        },
        now,
      ),
      durableOperationalEventStatement(
        this.#env.DB,
        {
          attempt: attemptCount,
          command_id: command.commandId,
          dedupe_key: `authority:${requestHash}:${repaired ? "repaired" : "committed"}`,
          event: repaired
            ? "authority.projection.repaired"
            : "authority.command.committed",
          occurred_at: createdAt,
          organization_id: command.organizationId,
          outcome: "success",
          request_id: command.audit.requestId,
          ...(eventId ? { event_id: eventId } : {}),
        },
        now,
      ),
      expiredOperationalEventsStatement(this.#env.DB, now),
    );
    const invalidation = this.#cacheInvalidationStatement(
      command.organizationId,
      invalidatedEventIds,
      createdAt,
    );
    if (invalidation) statements.push(invalidation);
    await this.#env.DB.batch(statements);
    await this.drainCacheInvalidations();
  }

  async commitFailure(commit: FailureCommit): Promise<void> {
    const { attemptCount, command, failure, requestHash } = commit;
    const existing = await this.idempotency(command);
    if (existing && existing.request_hash !== requestHash) {
      throw new AuthorityIdempotencyConflictError(command.commandId);
    }
    if (existing) return;
    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = isoTimestamp(now.getTime() + 30 * 24 * 60 * 60 * 1_000);
    const projectedEvent = command.audit.eventId
      ? await this.#env.DB.prepare(
          `SELECT id FROM p_events WHERE organization_id = ? AND id = ?
           AND source_deleted_at IS NULL`,
        )
          .bind(command.organizationId, command.audit.eventId)
          .first<{ id: string }>()
      : null;
    await this.#env.DB.batch([
      this.#env.DB.prepare(
        `INSERT INTO idempotency_keys (
           tenant_key, operation, command_id, request_hash, status,
           entity_type, entity_id, original_response_status,
           original_response_json, error_code, created_at, updated_at, expires_at
         ) VALUES (?, ?, ?, ?, 'failed', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        command.organizationId,
        command.operation,
        command.commandId,
        requestHash,
        command.table,
        command.entityId,
        failure.status,
        JSON.stringify({ error: failure.code, message: failure.message }),
        failure.code,
        createdAt,
        createdAt,
        expiresAt,
      ),
      this.#env.DB.prepare(
        `INSERT INTO audit_events (
           id, organization_id, event_id, actor_type, actor_id, action,
           entity_type, entity_id, request_id, command_id, redaction_version,
           safe_diff_json, metadata_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      ).bind(
        `aud_${requestHash.slice(0, 26)}`,
        command.organizationId,
        projectedEvent?.id ?? null,
        command.audit.actorType,
        command.audit.actorId ?? null,
        command.audit.action,
        command.table,
        command.entityId,
        command.audit.requestId,
        command.commandId,
        JSON.stringify(command.audit.safeDiff),
        JSON.stringify({
          failureCode: failure.code,
          outcome: "failed",
          provider: "airtable",
          table: command.table,
        }),
        createdAt,
      ),
      traceStatement(
        this.#env.DB,
        {
          attemptCount,
          commandId: command.commandId,
          entityId: command.entityId,
          errorCode: failure.code,
          ...(projectedEvent ? { eventId: projectedEvent.id } : {}),
          organizationId: command.organizationId,
          outcome: "failure",
          phase: "failed",
          requestId: command.audit.requestId,
          table: command.table,
        },
        now,
      ),
      durableOperationalEventStatement(
        this.#env.DB,
        {
          attempt: attemptCount,
          command_id: command.commandId,
          dedupe_key: `authority:${requestHash}:failed`,
          error_type: failure.code,
          event: "authority.command.failed",
          occurred_at: createdAt,
          organization_id: command.organizationId,
          outcome: "failure",
          request_id: command.audit.requestId,
          status: failure.status,
          ...(projectedEvent ? { event_id: projectedEvent.id } : {}),
        },
        now,
      ),
      expiredOperationalEventsStatement(this.#env.DB, now),
    ]);
  }

  async recordRepairPending(options: {
    attemptCount: number;
    command: BaseAuthorityCommand;
    errorCode: string;
    providerRecordId: string;
    requestHash: string;
    sourceContentHash: string;
  }): Promise<void> {
    const now = new Date();
    const event = options.command.audit.eventId
      ? await this.#env.DB.prepare(
          `SELECT id FROM p_events WHERE organization_id = ? AND id = ?
           AND source_deleted_at IS NULL`,
        )
          .bind(options.command.organizationId, options.command.audit.eventId)
          .first<{ id: string }>()
      : null;
    const repairId = `rep_${options.requestHash.slice(0, 26)}`;
    await this.#env.DB.batch([
      this.#env.DB.prepare(
        `INSERT INTO projection_repairs (
           id, repair_key, organization_id, event_id, provider, base_key,
           command_id, operation, provider_table_key, provider_record_id,
           entity_id, reason_code, source_content_hash, status, available_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'airtable', ?, ?, 'upsert', ?, ?, ?, ?, ?,
                   'pending', ?, ?, ?)
         ON CONFLICT (repair_key) DO UPDATE SET
           reason_code = excluded.reason_code,
           source_content_hash = excluded.source_content_hash,
           status = CASE WHEN projection_repairs.status = 'complete' THEN 'complete' ELSE 'pending' END,
           available_at = excluded.available_at,
           updated_at = excluded.updated_at`,
      ).bind(
        repairId,
        `authority:${options.requestHash}`,
        options.command.organizationId,
        event?.id ?? null,
        this.baseKey(),
        options.command.commandId,
        options.command.table,
        options.providerRecordId,
        options.command.entityId,
        options.errorCode,
        options.sourceContentHash,
        now.toISOString(),
        now.toISOString(),
        now.toISOString(),
      ),
      traceStatement(
        this.#env.DB,
        {
          attemptCount: options.attemptCount,
          commandId: options.command.commandId,
          entityId: options.command.entityId,
          errorCode: options.errorCode,
          ...(event ? { eventId: event.id } : {}),
          organizationId: options.command.organizationId,
          outcome: "failure",
          phase: "projection_pending",
          requestId: options.command.audit.requestId,
          table: options.command.table,
        },
        now,
      ),
      durableOperationalEventStatement(
        this.#env.DB,
        {
          attempt: options.attemptCount,
          command_id: options.command.commandId,
          dedupe_key: `authority:${options.requestHash}:repair_pending`,
          error_type: options.errorCode,
          event: "authority.projection.repair_pending",
          occurred_at: now.toISOString(),
          organization_id: options.command.organizationId,
          outcome: "failure",
          request_id: options.command.audit.requestId,
          status: 202,
          ...(event ? { event_id: event.id } : {}),
        },
        now,
      ),
      expiredOperationalEventsStatement(this.#env.DB, now),
    ]);
    await this.#env.PROJECTION_REPAIR_QUEUE.send({
      authority: this.baseKey(),
      commandId: options.command.commandId,
      operation: options.command.operation,
      organizationId: options.command.organizationId,
      type: "projection_repair",
    });
  }

  async markRepairComplete(
    command: BaseAuthorityCommand,
    requestHash: string,
  ): Promise<void> {
    await this.#env.DB.prepare(
      `UPDATE projection_repairs SET status = 'complete', completed_at = ?, updated_at = ?
       WHERE repair_key = ? AND organization_id = ?`,
    )
      .bind(
        isoTimestamp(),
        isoTimestamp(),
        `authority:${requestHash}`,
        command.organizationId,
      )
      .run();
  }

  private async resolveLink(
    source: SourceProjection,
    field: ProjectionFieldSpec,
  ): Promise<ResolvedLink | null> {
    const raw = source.fields[field.field];
    if (
      raw === undefined ||
      raw === null ||
      (Array.isArray(raw) && raw.length === 0)
    ) {
      if (field.required)
        throw new Error(`${field.field} is required for projection.`);
      return null;
    }
    if (!Array.isArray(raw) || raw.length !== 1 || typeof raw[0] !== "string") {
      throw new Error(`${field.field} must contain exactly one linked record.`);
    }
    const row = await this.#env.DB.prepare(
      `SELECT entity_id, event_id, organization_id, source_version
       FROM authority_source_records
       WHERE base_key = ? AND provider_table_key = ? AND provider_record_id = ?
         AND source_deleted_at IS NULL`,
    )
      .bind(this.baseKey(), field.linkedTable, raw[0])
      .first<SourceRegistryRow>();
    if (!row)
      throw new Error(`${field.field} references an unprojected record.`);
    return {
      entityId: row.entity_id,
      eventId: row.event_id,
      organizationId: row.organization_id,
    };
  }

  private idempotency(
    command: BaseAuthorityCommand,
  ): Promise<ExistingIdempotency | null> {
    return this.#env.DB.prepare(
      `SELECT request_hash FROM idempotency_keys
       WHERE tenant_key = ? AND operation = ? AND command_id = ?`,
    )
      .bind(command.organizationId, command.operation, command.commandId)
      .first<ExistingIdempotency>();
  }

  private baseKey(): string {
    return `${this.#env.APP_ENV}:${this.#env.AIRTABLE_BASE_ID}`;
  }
}
