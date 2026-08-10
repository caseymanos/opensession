import { DurableObject } from "cloudflare:workers";
import {
  AirtableAmbiguousWriteError,
  AirtableError,
  hashAirtableCommand,
  hashAirtableValue,
  type AirtableCommandResult,
} from "@sessionbox-killer/data/airtable/internal";

import {
  AirtableAuthorityProvider,
  type BaseAuthorityEnvironment,
} from "./provider.js";
import {
  cacheInvalidationRedriveDelayMilliseconds,
  D1AuthorityProjector,
} from "./projector.js";
import {
  AirtableReconciliationService,
  type ReconciliationResult,
} from "./reconciliation.js";
import {
  DemoSnapshotAuthority,
  type SnapshotReplaceInput,
} from "./snapshot.js";
import {
  CfpSubmissionAuthority,
  type CfpSubmissionPlanInput,
  type CfpSubmissionPlanInspection,
  type CfpSubmissionPlanItem,
  type CfpSubmissionPlanReceipt,
} from "../cfp/submission-authority.js";
import type {
  DemoSeedAuthorityCapabilities,
  DemoSeedAuthorityReceipt,
} from "../demo/types.js";
import {
  AuthorityIdempotencyConflictError,
  AuthorityCommandFailedError,
  AuthorityOutcomeUnknownError,
  hashAuthorityRequest,
  parseBaseAuthorityCommand,
  type AuthorityCommandInspection,
  type AuthorityFailure,
  type AuthorityResponse,
  type BaseAuthorityCommand,
} from "./types.js";

type CommandState = AuthorityCommandInspection["state"];

interface AuthorityCommandRow extends Record<string, SqlStorageValue> {
  attempt_count: number;
  authoritative_result_json: string | null;
  command_id: string;
  command_json: string;
  failure_json: string | null;
  failure_projected: number;
  last_error_code: string | null;
  lease_until_ms: number | null;
  operation: string;
  organization_id: string;
  original_response_json: string | null;
  original_status: number | null;
  provider_command_hash: string;
  recovery_count: number;
  request_hash: string;
  next_recovery_at_ms: number | null;
  source_content_hash: string | null;
  state: CommandState;
}

interface TenantRoster {
  fingerprint: string;
  ready: boolean;
  tenants: readonly {
    authorityRosterVersion: number;
    organizationId: string;
  }[];
}

const authoritySchemaVersion = 4;
const productionLeaseDurationMilliseconds = 180_000;
const productionRecoveryDelayMilliseconds = 5_000;

function localDuration(
  env: BaseAuthorityEnvironment,
  value: string | undefined,
  productionDefault: number,
): number {
  if (env.APP_ENV !== "local") {
    return productionDefault;
  }
  const configured = Number(value);
  return Number.isInteger(configured) && configured >= 100
    ? configured
    : productionDefault;
}

function leaseDurationMilliseconds(env: BaseAuthorityEnvironment): number {
  return localDuration(
    env,
    env.AUTHORITY_LEASE_MILLISECONDS,
    productionLeaseDurationMilliseconds,
  );
}

function recoveryDelayMilliseconds(env: BaseAuthorityEnvironment): number {
  return localDuration(
    env,
    env.AUTHORITY_RECOVERY_DELAY_MILLISECONDS,
    productionRecoveryDelayMilliseconds,
  );
}

function safeErrorCode(error: unknown): string {
  if (error instanceof AirtableError && error.status === 429) {
    return "airtable_rate_limited";
  }
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9]+$/.test(error.name)) {
    return error.name.slice(0, 80);
  }
  return "unexpected_failure";
}

function authorityFailure(error: unknown): AuthorityFailure {
  const code = safeErrorCode(error);
  const conflictCodes = new Set([
    "AirtableIdempotencyConflictError",
    "AirtableManualEditError",
    "AirtableVersionConflictError",
    "AuthorityIdempotencyConflictError",
  ]);
  return {
    code,
    message: `Authority command failed with ${code}.`,
    status: conflictCodes.has(code) ? 409 : 503,
  };
}

function parseFailure(value: string): AuthorityFailure {
  const parsed = JSON.parse(value) as Partial<AuthorityFailure>;
  if (
    typeof parsed.code !== "string" ||
    typeof parsed.message !== "string" ||
    typeof parsed.status !== "number"
  ) {
    throw new Error("Stored authority failure is invalid.");
  }
  return parsed as AuthorityFailure;
}

function commandKey(command: BaseAuthorityCommand): string {
  return `${command.organizationId}\u0000${command.operation}\u0000${command.commandId}`;
}

function parseResult(value: string): AirtableCommandResult {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Stored authority result is invalid.");
  }
  return parsed as AirtableCommandResult;
}

function parseResponse(value: string): AuthorityResponse {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Stored authority response is invalid.");
  }
  return parsed as AuthorityResponse;
}

export class BaseAuthority extends DurableObject<BaseAuthorityEnvironment> {
  private baseQueue: Promise<void> = Promise.resolve();
  private readonly inFlight = new Map<string, Promise<AuthorityResponse>>();
  private readonly cfpSubmissions: CfpSubmissionAuthority;
  private readonly projector: D1AuthorityProjector;
  private readonly provider: AirtableAuthorityProvider;
  private readonly reconciliation: AirtableReconciliationService;
  private readonly snapshot: DemoSnapshotAuthority;

  constructor(ctx: DurableObjectState, env: BaseAuthorityEnvironment) {
    super(ctx, env);
    this.provider = new AirtableAuthorityProvider(ctx.storage, env);
    this.projector = new D1AuthorityProjector(env, () =>
      this.schedulePendingRecovery(),
    );
    this.reconciliation = new AirtableReconciliationService({
      environment: env,
      projector: this.projector,
      provider: this.provider,
    });
    this.snapshot = new DemoSnapshotAuthority({
      environment: env,
      execute: (command) => this.executeSnapshotCommand(command),
      onAssetDatabaseCommitted: () => this.onSnapshotAssetDatabaseCommitted(),
      projector: this.projector,
      provider: this.provider,
      storage: ctx.storage,
    });
    this.cfpSubmissions = new CfpSubmissionAuthority({
      execute: (command) => this.executeSnapshotCommand(command),
      onItemCommitted: (input, item) =>
        this.onCfpSubmissionItemCommitted(input, item),
      storage: ctx.storage,
    });
    void ctx.blockConcurrencyWhile(async () => {
      ctx.storage.transactionSync(() => this.initializeSchema());
      await this.schedulePendingRecovery();
    });
  }

  async execute(value: unknown): Promise<AuthorityResponse> {
    const command = parseBaseAuthorityCommand(value);
    this.projector.assertSupported(command.table);
    const [requestHash, providerCommandHash] = await Promise.all([
      hashAuthorityRequest(command),
      hashAirtableCommand(command),
    ]);
    const existing = this.readCommand(command);

    if (existing && existing.request_hash !== requestHash) {
      throw new AuthorityIdempotencyConflictError(command.commandId);
    }
    if (existing?.state === "failed") {
      if (!existing.failure_json) {
        throw new Error("Stored authority failure is missing.");
      }
      if (existing.failure_projected === 0) {
        this.ctx.waitUntil(this.finishFailureProjection(command, existing));
      }
      throw new AuthorityCommandFailedError(
        parseFailure(existing.failure_json),
      );
    }
    if (existing?.original_response_json) {
      if (existing.state !== "complete") {
        this.ctx.waitUntil(this.recoverPending());
      }
      return parseResponse(existing.original_response_json);
    }

    const key = commandKey(command);
    const active = this.inFlight.get(key);
    if (active) {
      return active;
    }

    const execution = this.serializeBase(() =>
      this.executeDurably(command, requestHash, providerCommandHash),
    ).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, execution);
    return execution;
  }

  ready(): { schemaVersion: number } {
    const version = this.ctx.storage.sql
      .exec<{ version: number }>(
        "SELECT version FROM authority_schema WHERE singleton = 1",
      )
      .one().version;
    return { schemaVersion: version };
  }

  protected onSnapshotAssetDatabaseCommitted(): Promise<void> {
    return Promise.resolve();
  }

  protected onCfpSubmissionItemCommitted(
    input: CfpSubmissionPlanInput,
    item: CfpSubmissionPlanItem,
  ): Promise<void> {
    void input;
    void item;
    return Promise.resolve();
  }

  protected onWebhookRosterVerified(): Promise<void> {
    return Promise.resolve();
  }

  protected onWebhookFullScanReady(): Promise<void> {
    return Promise.resolve();
  }

  capabilities(): DemoSeedAuthorityCapabilities {
    return this.snapshot.capabilities();
  }

  replaceDemoEvent(
    input: SnapshotReplaceInput,
  ): Promise<DemoSeedAuthorityReceipt> {
    return this.serializeBase(() => this.snapshot.replace(input));
  }

  executeCfpSubmissionPlan(input: unknown): Promise<CfpSubmissionPlanReceipt> {
    return this.serializeBase(() => this.cfpSubmissions.execute(input));
  }

  inspectCfpSubmissionPlan(
    organizationId: string,
    planId: string,
  ): CfpSubmissionPlanInspection | null {
    return this.cfpSubmissions.inspect(organizationId, planId);
  }

  async reconcile(
    organizationId: string,
    tables?: readonly BaseAuthorityCommand["table"][],
  ): Promise<ReconciliationResult> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(organizationId)) {
      throw new Error("Reconciliation requires a stable organization ID.");
    }
    if (
      tables &&
      (tables.length === 0 || new Set(tables).size !== tables.length)
    ) {
      throw new Error("Reconciliation table selection is invalid.");
    }
    return this.serializeBase(() =>
      this.reconcileTenant({
        organizationId,
        ...(tables ? { tables } : {}),
      }),
    );
  }

  configureWebhook(webhookId: string, cursor = 1): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(webhookId)) {
      throw new Error("Airtable webhook ID is invalid.");
    }
    if (!Number.isInteger(cursor) || cursor < 1) {
      throw new Error("Airtable webhook cursor must be positive.");
    }
    return this.serializeBase(async () => {
      const existing = this.ctx.storage.sql
        .exec<{
          committed_cursor: number;
          webhook_id: string | null;
        }>(
          `SELECT webhook_id, committed_cursor FROM airtable_cursor_state
         WHERE singleton = 1`,
        )
        .one();
      if (
        existing.webhook_id === webhookId &&
        existing.committed_cursor >= cursor
      ) {
        return;
      }
      this.ctx.storage.sql.exec(
        `UPDATE airtable_cursor_state
         SET webhook_id = ?, committed_cursor = ?, in_flight_cursor = NULL,
             committed_roster_hash = NULL, full_scan_required = 1,
             updated_at_ms = ?
         WHERE singleton = 1`,
        webhookId,
        cursor,
        Date.now(),
      );
    });
  }

  synchronize(
    organizationIds: readonly string[],
  ): Promise<ReconciliationResult> {
    this.assertOrganizationIds(organizationIds);
    const configured = this.ctx.storage.sql
      .exec<{ webhook_id: string | null }>(
        "SELECT webhook_id FROM airtable_cursor_state WHERE singleton = 1",
      )
      .one();
    return configured.webhook_id
      ? this.ingestWebhook(organizationIds)
      : this.serializeBase(() => this.reconcileAll(organizationIds));
  }

  async ingestWebhook(
    organizationIds: readonly string[],
  ): Promise<ReconciliationResult> {
    this.assertOrganizationIds(organizationIds);
    return this.serializeBase(async () => {
      const cursor = this.ctx.storage.sql
        .exec<{
          committed_cursor: number;
          committed_roster_hash: string | null;
          full_scan_required: number;
          webhook_id: string | null;
        }>(
          `SELECT webhook_id, committed_cursor, committed_roster_hash,
                  full_scan_required
         FROM airtable_cursor_state WHERE singleton = 1`,
        )
        .one();
      if (!cursor.webhook_id) {
        throw new Error("Airtable webhook is not configured.");
      }
      const roster = await this.loadCompleteTenantRoster(organizationIds);
      if (
        cursor.full_scan_required === 1 ||
        cursor.committed_roster_hash !== roster.fingerprint ||
        !roster.ready
      ) {
        await this.invalidateCompleteTenantRoster(roster);
        const results = [];
        for (const organizationId of organizationIds) {
          results.push(await this.reconcileTenant({ organizationId }));
        }
        await this.onWebhookFullScanReady();
        const committedRoster =
          await this.loadCompleteTenantRoster(organizationIds);
        if (
          !committedRoster.ready ||
          committedRoster.fingerprint !== roster.fingerprint
        ) {
          throw new Error(
            "Active tenant roster changed during webhook full scan.",
          );
        }
        await this.onWebhookRosterVerified();
        this.ctx.storage.sql.exec(
          `UPDATE airtable_cursor_state
           SET committed_roster_hash = ?, full_scan_required = 0,
               updated_at_ms = ? WHERE singleton = 1`,
          committedRoster.fingerprint,
          Date.now(),
        );
        await this.env.DB.prepare(
          `UPDATE airtable_webhooks
           SET full_scan_required = 0, updated_at = ? WHERE base_key = ?`,
        )
          .bind(new Date().toISOString(), this.baseKey())
          .run();
        return this.combineReconciliationResults(results);
      }
      let committedCursor = cursor.committed_cursor;
      let deleted = 0;
      let projected = 0;
      const scanned = new Set<BaseAuthorityCommand["table"]>();
      let finalScanId = `webhook_${committedCursor}`;
      try {
        for (let pageNumber = 0; pageNumber < 50; pageNumber += 1) {
          await this.invalidateCompleteTenantRoster(roster);
          const page = await this.provider.webhookPayloads(
            cursor.webhook_id,
            committedCursor,
          );
          this.ctx.storage.sql.exec(
            `UPDATE airtable_cursor_state SET in_flight_cursor = ?, updated_at_ms = ?
             WHERE singleton = 1`,
            page.cursor,
            Date.now(),
          );
          const tableIds = page.payloads.flatMap(
            ({ changedTableIds }) => changedTableIds,
          );
          const tables = await this.provider.tableKeysForIds(tableIds);
          if (page.payloads.length > 0 && tables.length === 0) {
            throw new Error("Airtable webhook referenced unknown tables.");
          }
          if (tables.length > 0) {
            for (const organizationId of organizationIds) {
              const result = await this.reconcileTenant({
                cursor: page.cursor,
                organizationId,
                tables,
              });
              deleted += result.deleted;
              projected += result.projected;
              finalScanId = result.scanId;
            }
            tables.forEach((table) => scanned.add(table));
          }
          if (!page.mightHaveMore) {
            await this.restoreCompleteTenantRoster(roster);
          }
          committedCursor = page.cursor;
          const committedRoster =
            await this.loadCompleteTenantRoster(organizationIds);
          if (
            (!page.mightHaveMore && !committedRoster.ready) ||
            committedRoster.fingerprint !== roster.fingerprint
          ) {
            throw new Error(
              "Active tenant roster changed during webhook ingestion.",
            );
          }
          await this.onWebhookRosterVerified();
          this.ctx.storage.transactionSync(() => {
            this.ctx.storage.sql.exec(
              `UPDATE airtable_cursor_state
               SET committed_cursor = ?, in_flight_cursor = NULL,
                   committed_roster_hash = ?, last_transaction_number = ?,
                   updated_at_ms = ?
               WHERE singleton = 1`,
              committedCursor,
              committedRoster.fingerprint,
              page.payloads.reduce<number | null>(
                (maximum, payload) =>
                  payload.baseTransactionNumber === undefined
                    ? maximum
                    : Math.max(maximum ?? 0, payload.baseTransactionNumber),
                null,
              ),
              Date.now(),
            );
          });
          await this.env.DB.prepare(
            `UPDATE airtable_webhooks
             SET committed_cursor = MAX(committed_cursor, ?),
                 in_flight_cursor = NULL,
                 last_transaction_number = COALESCE(?, last_transaction_number),
                 last_payload_at = ?, full_scan_required = 0, updated_at = ?
             WHERE base_key = ?`,
          )
            .bind(
              committedCursor,
              page.payloads.reduce<number | null>(
                (maximum, payload) =>
                  payload.baseTransactionNumber === undefined
                    ? maximum
                    : Math.max(maximum ?? 0, payload.baseTransactionNumber),
                null,
              ),
              new Date().toISOString(),
              new Date().toISOString(),
              this.baseKey(),
            )
            .run();
          if (!page.mightHaveMore) break;
          if (pageNumber === 49) {
            throw new Error(
              "Airtable webhook pagination exceeded its safety bound.",
            );
          }
        }
      } catch (error) {
        this.ctx.storage.sql.exec(
          `UPDATE airtable_cursor_state
           SET in_flight_cursor = NULL, full_scan_required = 1, updated_at_ms = ?
           WHERE singleton = 1`,
          Date.now(),
        );
        await this.env.DB.prepare(
          `UPDATE airtable_webhooks SET full_scan_required = 1,
                  last_error_code = ?, updated_at = ?
           WHERE base_key = ?`,
        )
          .bind(safeErrorCode(error), new Date().toISOString(), this.baseKey())
          .run();
        throw error;
      }
      return {
        cursor: committedCursor,
        deleted,
        projected,
        scanId: finalScanId,
        tables: [...scanned],
      };
    });
  }

  private async reconcileAll(
    organizationIds: readonly string[],
  ): Promise<ReconciliationResult> {
    const roster = await this.loadCompleteTenantRoster(organizationIds);
    await this.invalidateCompleteTenantRoster(roster);
    const results = [];
    for (const organizationId of organizationIds) {
      results.push(await this.reconcileTenant({ organizationId }));
    }
    const committedRoster =
      await this.loadCompleteTenantRoster(organizationIds);
    if (
      !committedRoster.ready ||
      committedRoster.fingerprint !== roster.fingerprint
    ) {
      throw new Error("Active tenant roster changed during reconciliation.");
    }
    return this.combineReconciliationResults(results);
  }

  private async reconcileTenant(
    input: Parameters<AirtableReconciliationService["fullScan"]>[0],
  ): Promise<ReconciliationResult> {
    try {
      return await this.reconciliation.fullScan(input);
    } catch (error) {
      await this.schedulePendingRecovery();
      throw error;
    }
  }

  private assertOrganizationIds(organizationIds: readonly string[]): void {
    if (
      organizationIds.length === 0 ||
      new Set(organizationIds).size !== organizationIds.length ||
      organizationIds.some(
        (value) => !/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(value),
      )
    ) {
      throw new Error("Synchronization requires unique organization IDs.");
    }
  }

  private async loadCompleteTenantRoster(
    organizationIds: readonly string[],
  ): Promise<TenantRoster> {
    const active = await this.env.DB.prepare(
      `SELECT organization_id, authority_roster_version, authority_ready_at
       FROM tenant_registry
       WHERE base_key = ? AND status = 'active'
       ORDER BY organization_id`,
    )
      .bind(this.baseKey())
      .all<{
        authority_roster_version: number;
        authority_ready_at: string | null;
        organization_id: string;
      }>();
    const expected = [...organizationIds].sort();
    const actual = active.results.map(({ organization_id }) => organization_id);
    if (
      expected.length !== actual.length ||
      expected.some((organizationId, index) => organizationId !== actual[index])
    ) {
      throw new Error(
        "Synchronization requires the complete active tenant roster.",
      );
    }
    return {
      fingerprint: await hashAirtableValue(
        active.results.map(({ authority_roster_version, organization_id }) => ({
          authorityRosterVersion: authority_roster_version,
          organizationId: organization_id,
        })),
      ),
      ready: active.results.every(
        ({ authority_ready_at }) => authority_ready_at !== null,
      ),
      tenants: active.results.map(
        ({ authority_roster_version, organization_id }) => ({
          authorityRosterVersion: authority_roster_version,
          organizationId: organization_id,
        }),
      ),
    };
  }

  private async invalidateCompleteTenantRoster(
    roster: TenantRoster,
  ): Promise<void> {
    const now = new Date().toISOString();
    const invalidated = await this.env.DB.batch(
      roster.tenants.map(({ authorityRosterVersion, organizationId }) =>
        this.env.DB.prepare(
          `UPDATE tenant_registry
           SET authority_ready_at = NULL, updated_at = ?
           WHERE organization_id = ? AND base_key = ? AND status = 'active'
             AND authority_roster_version = ?`,
        ).bind(now, organizationId, this.baseKey(), authorityRosterVersion),
      ),
    );
    if (invalidated.some(({ meta }) => meta.changes !== 1)) {
      throw new Error("Active tenant roster changed before reconciliation.");
    }
    const current = await this.loadCompleteTenantRoster(
      roster.tenants.map(({ organizationId }) => organizationId),
    );
    if (current.ready || current.fingerprint !== roster.fingerprint) {
      throw new Error("Active tenant roster changed during invalidation.");
    }
  }

  private async restoreCompleteTenantRoster(
    roster: TenantRoster,
  ): Promise<void> {
    const now = new Date().toISOString();
    const restored = await this.env.DB.batch(
      roster.tenants.map(({ authorityRosterVersion, organizationId }) =>
        this.env.DB.prepare(
          `UPDATE tenant_registry
           SET authority_ready_at = ?, updated_at = ?
           WHERE organization_id = ? AND base_key = ? AND status = 'active'
             AND authority_roster_version = ?`,
        ).bind(
          now,
          now,
          organizationId,
          this.baseKey(),
          authorityRosterVersion,
        ),
      ),
    );
    if (restored.some(({ meta }) => meta.changes !== 1)) {
      throw new Error("Active tenant roster changed during reconciliation.");
    }
  }

  private combineReconciliationResults(
    results: readonly ReconciliationResult[],
  ): ReconciliationResult {
    const tables = new Set<BaseAuthorityCommand["table"]>();
    for (const result of results) {
      result.tables.forEach((table) => tables.add(table));
    }
    return {
      cursor: results.at(-1)?.cursor ?? null,
      deleted: results.reduce((total, result) => total + result.deleted, 0),
      projected: results.reduce((total, result) => total + result.projected, 0),
      scanId: results.map(({ scanId }) => scanId).join(":"),
      tables: [...tables],
    };
  }

  inspect(
    organizationId: string,
    operation: string,
    commandId: string,
  ): AuthorityCommandInspection | null {
    const command = parseBaseAuthorityCommand({
      audit: {
        action: "authority.inspect",
        actorType: "system",
        requestId: "req_inspect",
        safeDiff: {},
      },
      commandId,
      entityId: "entity_inspect",
      expectedVersion: 0,
      fields: {},
      operation,
      organizationId,
      table: "events",
    });
    const row = this.readCommand(command);
    return row
      ? {
          attemptCount: row.attempt_count,
          commandId: row.command_id,
          operation: row.operation,
          organizationId: row.organization_id,
          originalResponse: row.original_response_json
            ? parseResponse(row.original_response_json)
            : null,
          requestHash: row.request_hash,
          state: row.state,
        }
      : null;
  }

  async recoverPending(): Promise<number> {
    const now = Date.now();
    const rows = this.ctx.storage.sql
      .exec<AuthorityCommandRow>(
        `SELECT * FROM authority_commands
         WHERE ((state = 'leased' AND COALESCE(lease_until_ms, 0) <= ?)
            OR state IN ('airtable_committed', 'projection_pending')
            OR (state = 'outcome_unknown'
                AND COALESCE(lease_until_ms, 0) <= ?
                AND COALESCE(next_recovery_at_ms, 0) <= ?)
            OR (state = 'failed' AND failure_projected = 0))
         ORDER BY updated_at_ms
         LIMIT 25`,
        now,
        now,
        now,
      )
      .toArray();
    let recovered = 0;

    for (const row of rows) {
      const command = parseBaseAuthorityCommand(JSON.parse(row.command_json));
      const key = commandKey(command);
      if (this.inFlight.has(key)) {
        continue;
      }
      if (row.state === "failed") {
        try {
          await this.serializeBase(() =>
            this.finishFailureProjection(command, row),
          );
          recovered += 1;
        } catch {
          await this.schedulePendingRecovery();
        }
        continue;
      }
      const recovery = this.serializeBase(() =>
        this.recoverRow(command, row),
      ).finally(() => {
        this.inFlight.delete(key);
      });
      this.inFlight.set(key, recovery);
      try {
        await recovery;
        recovered += 1;
      } catch {
        await this.schedulePendingRecovery();
      }
    }
    try {
      await this.serializeBase(() => this.projector.drainCacheInvalidations());
    } catch {
      await this.schedulePendingRecovery();
    }
    return recovered;
  }

  override async alarm(): Promise<void> {
    await this.recoverPending();
    await this.schedulePendingRecovery();
  }

  private migrateCfpSubmissionPlanSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE cfp_submission_plans (
        organization_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        submission_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('draft', 'submit')),
        request_hash TEXT NOT NULL CHECK (
          length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'
        ),
        plan_json TEXT NOT NULL CHECK (json_valid(plan_json)),
        item_count INTEGER NOT NULL CHECK (item_count BETWEEN 1 AND 160),
        state TEXT NOT NULL CHECK (state IN ('received', 'applying', 'complete')),
        receipt_json TEXT CHECK (receipt_json IS NULL OR json_valid(receipt_json)),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        completed_at_ms INTEGER,
        PRIMARY KEY (organization_id, plan_id)
      ) WITHOUT ROWID, STRICT;

      CREATE TABLE cfp_submission_plan_items (
        organization_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        item_key TEXT NOT NULL,
        item_index INTEGER NOT NULL CHECK (item_index >= 0),
        table_key TEXT NOT NULL CHECK (table_key IN (
          'contacts', 'submissions', 'submission_answers',
          'submission_participants'
        )),
        entity_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'materialized', 'complete')),
        materialized_command_json TEXT CHECK (
          materialized_command_json IS NULL OR json_valid(materialized_command_json)
        ),
        provider_record_id TEXT,
        result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (organization_id, plan_id, item_key),
        UNIQUE (organization_id, plan_id, item_index),
        FOREIGN KEY (organization_id, plan_id)
          REFERENCES cfp_submission_plans (organization_id, plan_id)
      ) WITHOUT ROWID, STRICT;
      CREATE INDEX cfp_submission_plan_items_state
        ON cfp_submission_plan_items (organization_id, plan_id, state, item_index);
      UPDATE authority_schema SET version = 4 WHERE singleton = 1;
    `);
  }

  private initializeSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS authority_schema (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        version INTEGER NOT NULL CHECK (version > 0)
      ) STRICT
    `);
    const version = this.ctx.storage.sql
      .exec<{ version: number }>(
        "SELECT version FROM authority_schema WHERE singleton = 1",
      )
      .toArray()[0]?.version;
    if (version === authoritySchemaVersion) {
      return;
    }
    if (
      version !== undefined &&
      version !== 1 &&
      version !== 2 &&
      version !== 3
    ) {
      throw new Error(`Unsupported BaseAuthority schema version ${version}.`);
    }

    if (version === 3) {
      this.migrateCfpSubmissionPlanSchema();
      return;
    }

    if (version === 1) {
      this.ctx.storage.sql.exec(`
        CREATE INDEX IF NOT EXISTS reconciliation_work_pending
          ON reconciliation_work (status, operation, table_key, updated_at_ms);

        CREATE TABLE demo_snapshot_runs (
          organization_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          reset_run_id TEXT NOT NULL,
          request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
          snapshot_id TEXT NOT NULL,
          digest TEXT NOT NULL CHECK (length(digest) = 64),
          actor_id TEXT NOT NULL,
          expected_source_version INTEGER NOT NULL,
          operation_count INTEGER NOT NULL,
          state TEXT NOT NULL CHECK (state IN (
            'received', 'applying', 'assets', 'deleting', 'complete', 'failed'
          )),
          receipt_json TEXT CHECK (receipt_json IS NULL OR json_valid(receipt_json)),
          last_error_code TEXT,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          PRIMARY KEY (organization_id, reset_run_id)
        ) WITHOUT ROWID, STRICT;

        CREATE TABLE demo_snapshot_items (
          organization_id TEXT NOT NULL,
          reset_run_id TEXT NOT NULL,
          item_key TEXT NOT NULL,
          item_type TEXT NOT NULL CHECK (item_type IN (
            'record_upsert', 'record_delete', 'asset'
          )),
          table_key TEXT,
          entity_id TEXT,
          provider_record_id TEXT,
          state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'complete', 'failed')),
          attempt_count INTEGER NOT NULL DEFAULT 0,
          result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
          last_error_code TEXT,
          updated_at_ms INTEGER NOT NULL,
          PRIMARY KEY (organization_id, reset_run_id, item_key),
          FOREIGN KEY (organization_id, reset_run_id)
            REFERENCES demo_snapshot_runs (organization_id, reset_run_id)
        ) WITHOUT ROWID, STRICT;
        CREATE INDEX demo_snapshot_items_pending
          ON demo_snapshot_items (organization_id, reset_run_id, state, item_type, item_key);

        ALTER TABLE airtable_cursor_state ADD COLUMN committed_roster_hash TEXT
          CHECK (
            committed_roster_hash IS NULL OR
            (length(committed_roster_hash) = 64 AND
             committed_roster_hash NOT GLOB '*[^0-9a-f]*')
          );
        UPDATE authority_schema SET version = 3 WHERE singleton = 1;
      `);
      this.migrateCfpSubmissionPlanSchema();
      return;
    }

    if (version === 2) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE airtable_cursor_state ADD COLUMN committed_roster_hash TEXT
          CHECK (
            committed_roster_hash IS NULL OR
            (length(committed_roster_hash) = 64 AND
             committed_roster_hash NOT GLOB '*[^0-9a-f]*')
          );
        UPDATE authority_schema SET version = 3 WHERE singleton = 1;
      `);
      this.migrateCfpSubmissionPlanSchema();
      return;
    }

    this.ctx.storage.sql.exec(`
      CREATE TABLE gate_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        next_request_at_ms INTEGER NOT NULL DEFAULT 0,
        paused_until_ms INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      INSERT INTO gate_state (singleton) VALUES (1);

      CREATE TABLE authority_commands (
        organization_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        command_id TEXT NOT NULL,
        request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
        provider_command_hash TEXT NOT NULL CHECK (length(provider_command_hash) = 64),
        command_json TEXT NOT NULL CHECK (json_valid(command_json)),
        table_key TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'received', 'leased', 'outcome_unknown', 'airtable_committed',
          'projection_pending', 'complete', 'failed'
        )),
        lease_token TEXT,
        lease_until_ms INTEGER,
        airtable_record_id TEXT,
        source_version INTEGER,
        source_content_hash TEXT,
        authoritative_result_json TEXT CHECK (
          authoritative_result_json IS NULL OR json_valid(authoritative_result_json)
        ),
        failure_json TEXT CHECK (failure_json IS NULL OR json_valid(failure_json)),
        failure_projected INTEGER NOT NULL DEFAULT 0 CHECK (failure_projected IN (0, 1)),
        recovery_count INTEGER NOT NULL DEFAULT 0 CHECK (recovery_count >= 0),
        next_recovery_at_ms INTEGER,
        original_status INTEGER,
        original_response_json TEXT CHECK (
          original_response_json IS NULL OR json_valid(original_response_json)
        ),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        last_error_code TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (organization_id, operation, command_id)
      ) WITHOUT ROWID, STRICT;
      CREATE INDEX authority_commands_recovery
        ON authority_commands (state, lease_until_ms, updated_at_ms);

      CREATE TABLE provider_attempts (
        organization_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        command_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
        request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
        dispatched_at_ms INTEGER NOT NULL,
        completed_at_ms INTEGER,
        outcome TEXT NOT NULL CHECK (
          outcome IN ('dispatched', 'applied', 'not_applied', 'unknown', 'rejected')
        ),
        provider_status INTEGER,
        error_code TEXT,
        PRIMARY KEY (organization_id, operation, command_id, attempt_number),
        FOREIGN KEY (organization_id, operation, command_id)
          REFERENCES authority_commands (organization_id, operation, command_id)
      ) WITHOUT ROWID, STRICT;

      CREATE TABLE reconciliation_work (
        work_key TEXT PRIMARY KEY,
        table_key TEXT NOT NULL,
        record_id TEXT,
        entity_id TEXT,
        operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete', 'full_scan')),
        desired_hash TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'complete', 'failed')),
        lease_until_ms INTEGER,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      ) WITHOUT ROWID, STRICT;
      CREATE INDEX reconciliation_work_pending
        ON reconciliation_work (status, operation, table_key, updated_at_ms);

      CREATE TABLE airtable_cursor_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        webhook_id TEXT,
        committed_cursor INTEGER NOT NULL DEFAULT 0 CHECK (committed_cursor >= 0),
        in_flight_cursor INTEGER CHECK (in_flight_cursor >= 0),
        committed_roster_hash TEXT CHECK (
          committed_roster_hash IS NULL OR
          (length(committed_roster_hash) = 64 AND
           committed_roster_hash NOT GLOB '*[^0-9a-f]*')
        ),
        last_transaction_number INTEGER,
        full_scan_required INTEGER NOT NULL DEFAULT 1 CHECK (full_scan_required IN (0, 1)),
        updated_at_ms INTEGER NOT NULL
      ) STRICT;
      INSERT INTO airtable_cursor_state (singleton, updated_at_ms) VALUES (1, 0);

      CREATE TABLE demo_snapshot_runs (
        organization_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        reset_run_id TEXT NOT NULL,
        request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
        snapshot_id TEXT NOT NULL,
        digest TEXT NOT NULL CHECK (length(digest) = 64),
        actor_id TEXT NOT NULL,
        expected_source_version INTEGER NOT NULL,
        operation_count INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'received', 'applying', 'assets', 'deleting', 'complete', 'failed'
        )),
        receipt_json TEXT CHECK (receipt_json IS NULL OR json_valid(receipt_json)),
        last_error_code TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (organization_id, reset_run_id)
      ) WITHOUT ROWID, STRICT;

      CREATE TABLE demo_snapshot_items (
        organization_id TEXT NOT NULL,
        reset_run_id TEXT NOT NULL,
        item_key TEXT NOT NULL,
        item_type TEXT NOT NULL CHECK (item_type IN (
          'record_upsert', 'record_delete', 'asset'
        )),
        table_key TEXT,
        entity_id TEXT,
        provider_record_id TEXT,
        state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'complete', 'failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
        last_error_code TEXT,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (organization_id, reset_run_id, item_key),
        FOREIGN KEY (organization_id, reset_run_id)
          REFERENCES demo_snapshot_runs (organization_id, reset_run_id)
      ) WITHOUT ROWID, STRICT;
      CREATE INDEX demo_snapshot_items_pending
        ON demo_snapshot_items (organization_id, reset_run_id, state, item_type, item_key);
      INSERT INTO authority_schema (singleton, version) VALUES (1, 3);
    `);
    this.migrateCfpSubmissionPlanSchema();
  }

  private async executeDurably(
    command: BaseAuthorityCommand,
    requestHash: string,
    providerCommandHash: string,
  ): Promise<AuthorityResponse> {
    this.insertCommand(command, requestHash, providerCommandHash);
    const row = this.readCommand(command);
    if (!row) {
      throw new Error("Authority command intent was not persisted.");
    }
    if (row.request_hash !== requestHash) {
      throw new AuthorityIdempotencyConflictError(command.commandId);
    }
    return this.recoverRow(command, row);
  }

  private async executeSnapshotCommand(
    value: BaseAuthorityCommand,
  ): Promise<AuthorityResponse> {
    const command = parseBaseAuthorityCommand(value);
    this.projector.assertSupported(command.table);
    const [requestHash, providerCommandHash] = await Promise.all([
      hashAuthorityRequest(command),
      hashAirtableCommand(command),
    ]);
    const existing = this.readCommand(command);
    if (existing && existing.request_hash !== requestHash) {
      throw new AuthorityIdempotencyConflictError(command.commandId);
    }
    const response = existing?.original_response_json
      ? parseResponse(existing.original_response_json)
      : await this.executeDurably(command, requestHash, providerCommandHash);
    let row = this.readCommand(command);
    if (row?.state === "projection_pending") {
      await this.finishProjection(command, row);
      row = this.readCommand(command);
    }
    if (row?.state !== "complete") {
      throw new Error("Snapshot command projection is not durable.");
    }
    return {
      authority: response.authority,
      commandId: response.commandId,
      projection: "durable",
      status: "committed",
    };
  }

  private async recoverRow(
    command: BaseAuthorityCommand,
    row: AuthorityCommandRow,
  ): Promise<AuthorityResponse> {
    if (row.original_response_json) {
      if (row.state !== "complete") {
        this.ctx.waitUntil(this.finishProjection(command, row));
      }
      return parseResponse(row.original_response_json);
    }
    if (row.authoritative_result_json) {
      return this.finishProjection(command, row);
    }
    if (row.state === "leased" || row.state === "outcome_unknown") {
      return this.recoverProviderOutcome(command, row);
    }
    if (row.state === "failed") {
      if (!row.failure_json) {
        throw new Error("Stored authority failure is missing.");
      }
      throw new AuthorityCommandFailedError(parseFailure(row.failure_json));
    }
    return this.attemptProvider(command);
  }

  private async attemptProvider(
    command: BaseAuthorityCommand,
  ): Promise<AuthorityResponse> {
    const leaseUntil = Date.now() + leaseDurationMilliseconds(this.env);
    await this.scheduleRecoveryAt(leaseUntil);
    const attemptNumber = this.beginAttempt(command, leaseUntil);
    let result: AirtableCommandResult;
    try {
      result = await this.provider.execute(command);
    } catch (error) {
      if (error instanceof AirtableAmbiguousWriteError) {
        this.finishAttempt(command, attemptNumber, "unknown", error);
        this.markOutcomeUnknown(command, error);
        const row = this.readCommand(command);
        if (!row) {
          throw error;
        }
        return this.recoverProviderOutcome(command, row);
      }
      this.finishAttempt(command, attemptNumber, "rejected", error);
      const failure = authorityFailure(error);
      this.persistFailure(command, failure);
      const failed = this.readCommand(command);
      if (!failed) {
        throw new Error("Failed authority command was not persisted.", {
          cause: error,
        });
      }
      try {
        await this.finishFailureProjection(command, failed);
      } catch {
        await this.scheduleRecovery();
      }
      throw new AuthorityCommandFailedError(failure);
    }

    this.finishAttempt(command, attemptNumber, "applied");
    await this.persistAuthorityResult(command, result);
    const row = this.readCommand(command);
    if (!row) {
      throw new Error("Committed authority result was not persisted.");
    }
    return this.finishProjection(command, row);
  }

  private async recoverProviderOutcome(
    command: BaseAuthorityCommand,
    row: AuthorityCommandRow,
  ): Promise<AuthorityResponse> {
    const recovery = await this.provider.recover(
      command,
      row.provider_command_hash,
    );
    if (recovery.outcome === "applied") {
      this.finishLastDispatchedAttempt(command, "applied");
      await this.persistAuthorityResult(command, recovery.result);
      const committed = this.readCommand(command);
      if (!committed) {
        throw new Error("Recovered authority result was not persisted.");
      }
      return this.finishProjection(command, committed);
    }
    if (row.lease_until_ms !== null && row.lease_until_ms > Date.now()) {
      await this.scheduleRecoveryAt(row.lease_until_ms);
      throw new AuthorityOutcomeUnknownError(command.commandId);
    }
    if (recovery.outcome === "not_applied" && row.attempt_count < 2) {
      this.finishLastDispatchedAttempt(command, "not_applied");
      return this.attemptProvider(command);
    }

    await this.deferOutcomeRecovery(command, row.recovery_count);
    throw new AuthorityOutcomeUnknownError(command.commandId);
  }

  private async persistAuthorityResult(
    command: BaseAuthorityCommand,
    result: AirtableCommandResult,
  ): Promise<void> {
    const providerHash = result.fields["Applied content hash"];
    const sourceContentHash =
      typeof providerHash === "string" && /^[0-9a-f]{64}$/.test(providerHash)
        ? providerHash
        : await hashAirtableValue(result.fields);
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE authority_commands
       SET state = 'airtable_committed', lease_token = NULL, lease_until_ms = NULL,
           airtable_record_id = ?, source_version = ?, source_content_hash = ?,
           authoritative_result_json = ?, recovery_count = 0,
           next_recovery_at_ms = NULL, last_error_code = NULL, updated_at_ms = ?
       WHERE organization_id = ? AND operation = ? AND command_id = ?`,
      result.recordId,
      result.sourceVersion,
      sourceContentHash,
      JSON.stringify(result),
      now,
      command.organizationId,
      command.operation,
      command.commandId,
    );
  }

  private async finishProjection(
    command: BaseAuthorityCommand,
    row: AuthorityCommandRow,
  ): Promise<AuthorityResponse> {
    if (!row.authoritative_result_json || !row.source_content_hash) {
      throw new Error("Projection cannot run without an authority result.");
    }
    const result = parseResult(row.authoritative_result_json);
    const existingResponse = row.original_response_json
      ? parseResponse(row.original_response_json)
      : null;
    const committedResponse: AuthorityResponse =
      existingResponse ??
      ({
        authority: result,
        commandId: command.commandId,
        projection: "durable",
        status: "committed",
      } satisfies AuthorityResponse);

    try {
      await this.projector.commit({
        attemptCount: row.attempt_count,
        command,
        requestHash: row.request_hash,
        response: committedResponse,
        result,
        sourceContentHash: row.source_content_hash,
      });
      await this.projector.markRepairComplete(command, row.request_hash);
      this.persistResponse(command, "complete", committedResponse, 200);
      return committedResponse;
    } catch (error) {
      const repairResponse: AuthorityResponse = existingResponse ?? {
        authority: result,
        commandId: command.commandId,
        projection: "repair_pending",
        status: "committed_with_repair",
      };
      this.persistResponse(
        command,
        "projection_pending",
        repairResponse,
        202,
        error,
      );
      try {
        await this.projector.recordRepairPending({
          attemptCount: row.attempt_count,
          command,
          errorCode: safeErrorCode(error),
          providerRecordId: result.recordId,
          requestHash: row.request_hash,
          sourceContentHash: row.source_content_hash,
        });
      } catch {
        // The Durable Object remains the retry authority when D1 telemetry is unavailable.
      }
      await this.scheduleRecovery();
      return repairResponse;
    }
  }

  private insertCommand(
    command: BaseAuthorityCommand,
    requestHash: string,
    providerCommandHash: string,
  ): void {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO authority_commands (
         organization_id, operation, command_id, request_hash,
         provider_command_hash, command_json,
         table_key, entity_id, state, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)
       ON CONFLICT (organization_id, operation, command_id) DO NOTHING`,
      command.organizationId,
      command.operation,
      command.commandId,
      requestHash,
      providerCommandHash,
      JSON.stringify(command),
      command.table,
      command.entityId,
      now,
      now,
    );
  }

  private beginAttempt(
    command: BaseAuthorityCommand,
    leaseUntil: number,
  ): number {
    return this.ctx.storage.transactionSync(() => {
      const row = this.readCommand(command);
      if (!row) {
        throw new Error(
          "Authority command is missing before provider attempt.",
        );
      }
      const attemptNumber = row.attempt_count + 1;
      const now = Date.now();
      const leaseToken = crypto.randomUUID();
      this.ctx.storage.sql.exec(
        `UPDATE authority_commands
         SET state = 'leased', lease_token = ?, lease_until_ms = ?,
             attempt_count = ?, updated_at_ms = ?
         WHERE organization_id = ? AND operation = ? AND command_id = ?`,
        leaseToken,
        leaseUntil,
        attemptNumber,
        now,
        command.organizationId,
        command.operation,
        command.commandId,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO provider_attempts (
           organization_id, operation, command_id, attempt_number,
           request_hash, dispatched_at_ms, outcome
         ) VALUES (?, ?, ?, ?, ?, ?, 'dispatched')`,
        command.organizationId,
        command.operation,
        command.commandId,
        attemptNumber,
        row.request_hash,
        now,
      );
      return attemptNumber;
    });
  }

  private finishAttempt(
    command: BaseAuthorityCommand,
    attemptNumber: number,
    outcome: "applied" | "not_applied" | "unknown" | "rejected",
    error?: unknown,
  ): void {
    this.ctx.storage.sql.exec(
      `UPDATE provider_attempts
       SET completed_at_ms = ?, outcome = ?, error_code = ?
       WHERE organization_id = ? AND operation = ? AND command_id = ?
         AND attempt_number = ?`,
      Date.now(),
      outcome,
      error === undefined ? null : safeErrorCode(error),
      command.organizationId,
      command.operation,
      command.commandId,
      attemptNumber,
    );
  }

  private finishLastDispatchedAttempt(
    command: BaseAuthorityCommand,
    outcome: "applied" | "not_applied",
  ): void {
    const row = this.readCommand(command);
    if (row && row.attempt_count > 0) {
      this.finishAttempt(command, row.attempt_count, outcome);
    }
  }

  private markOutcomeUnknown(
    command: BaseAuthorityCommand,
    error: unknown,
  ): void {
    this.ctx.storage.sql.exec(
      `UPDATE authority_commands
       SET state = 'outcome_unknown', next_recovery_at_ms = NULL,
           last_error_code = ?, updated_at_ms = ?
       WHERE organization_id = ? AND operation = ? AND command_id = ?`,
      safeErrorCode(error),
      Date.now(),
      command.organizationId,
      command.operation,
      command.commandId,
    );
  }

  private persistFailure(
    command: BaseAuthorityCommand,
    failure: AuthorityFailure,
  ): void {
    this.ctx.storage.sql.exec(
      `UPDATE authority_commands
       SET state = 'failed', lease_token = NULL, lease_until_ms = NULL,
           failure_json = ?, last_error_code = ?, updated_at_ms = ?
       WHERE organization_id = ? AND operation = ? AND command_id = ?`,
      JSON.stringify(failure),
      failure.code,
      Date.now(),
      command.organizationId,
      command.operation,
      command.commandId,
    );
  }

  private async finishFailureProjection(
    command: BaseAuthorityCommand,
    row: AuthorityCommandRow,
  ): Promise<void> {
    if (!row.failure_json) {
      throw new Error("Stored authority failure is missing.");
    }
    await this.projector.commitFailure({
      attemptCount: row.attempt_count,
      command,
      failure: parseFailure(row.failure_json),
      requestHash: row.request_hash,
    });
    this.ctx.storage.sql.exec(
      `UPDATE authority_commands
       SET failure_projected = 1, updated_at_ms = ?
       WHERE organization_id = ? AND operation = ? AND command_id = ?`,
      Date.now(),
      command.organizationId,
      command.operation,
      command.commandId,
    );
  }

  private persistResponse(
    command: BaseAuthorityCommand,
    state: "complete" | "projection_pending",
    response: AuthorityResponse,
    status: number,
    error?: unknown,
  ): void {
    this.ctx.storage.sql.exec(
      `UPDATE authority_commands
       SET state = ?, original_status = COALESCE(original_status, ?),
           original_response_json = COALESCE(original_response_json, ?),
           last_error_code = ?, updated_at_ms = ?
       WHERE organization_id = ? AND operation = ? AND command_id = ?`,
      state,
      status,
      JSON.stringify(response),
      error === undefined ? null : safeErrorCode(error),
      Date.now(),
      command.organizationId,
      command.operation,
      command.commandId,
    );
  }

  private readCommand(
    command: Pick<
      BaseAuthorityCommand,
      "commandId" | "operation" | "organizationId"
    >,
  ): AuthorityCommandRow | null {
    return (
      this.ctx.storage.sql
        .exec<AuthorityCommandRow>(
          `SELECT * FROM authority_commands
           WHERE organization_id = ? AND operation = ? AND command_id = ?`,
          command.organizationId,
          command.operation,
          command.commandId,
        )
        .toArray()[0] ?? null
    );
  }

  private async scheduleRecovery(): Promise<void> {
    await this.scheduleRecoveryAt(
      Date.now() + recoveryDelayMilliseconds(this.env),
    );
  }

  private async scheduleRecoveryAt(scheduled: number): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing > scheduled) {
      await this.ctx.storage.setAlarm(scheduled);
    }
  }

  protected async schedulePendingRecovery(): Promise<void> {
    const now = Date.now();
    const rows = this.ctx.storage.sql
      .exec<
        Pick<
          AuthorityCommandRow,
          "lease_until_ms" | "next_recovery_at_ms" | "state"
        >
      >(
        `SELECT state, lease_until_ms, next_recovery_at_ms FROM authority_commands
         WHERE state IN ('leased', 'outcome_unknown', 'airtable_committed', 'projection_pending')
            OR (state = 'failed' AND failure_projected = 0)`,
      )
      .toArray();
    let earliest: number | null = null;
    for (const row of rows) {
      const candidate =
        row.state === "leased" || row.state === "outcome_unknown"
          ? Math.max(
              row.lease_until_ms ?? 0,
              row.next_recovery_at_ms ?? 0,
              now + 100,
            )
          : now + recoveryDelayMilliseconds(this.env);
      earliest = earliest === null ? candidate : Math.min(earliest, candidate);
    }
    try {
      const invalidation = await this.env.DB.prepare(
        `SELECT status, updated_at FROM authority_cache_invalidations
         WHERE status IN ('pending', 'published', 'enqueued')
         ORDER BY CASE status
                    WHEN 'pending' THEN 0
                    WHEN 'published' THEN 1
                    ELSE 2
                  END,
                  updated_at, organization_id, event_id
         LIMIT 1`,
      ).first<{
        status: "enqueued" | "pending" | "published";
        updated_at: string;
      }>();
      if (invalidation) {
        const candidate =
          invalidation.status !== "enqueued"
            ? now + recoveryDelayMilliseconds(this.env)
            : Math.max(
                now + recoveryDelayMilliseconds(this.env),
                Date.parse(invalidation.updated_at) +
                  cacheInvalidationRedriveDelayMilliseconds(this.env),
              );
        earliest =
          earliest === null ? candidate : Math.min(earliest, candidate);
      }
    } catch {
      const candidate = now + recoveryDelayMilliseconds(this.env);
      earliest = earliest === null ? candidate : Math.min(earliest, candidate);
    }
    if (earliest !== null) {
      await this.scheduleRecoveryAt(earliest);
    }
  }

  private async deferOutcomeRecovery(
    command: BaseAuthorityCommand,
    previousRecoveryCount: number,
  ): Promise<void> {
    const recoveryCount = previousRecoveryCount + 1;
    const delay = Math.min(
      productionRecoveryDelayMilliseconds * 2 ** Math.min(recoveryCount - 1, 8),
      15 * 60 * 1_000,
    );
    const nextRecovery = Date.now() + delay;
    this.ctx.storage.sql.exec(
      `UPDATE authority_commands
       SET state = 'outcome_unknown', lease_token = NULL, lease_until_ms = NULL,
           recovery_count = ?, next_recovery_at_ms = ?, updated_at_ms = ?
       WHERE organization_id = ? AND operation = ? AND command_id = ?`,
      recoveryCount,
      nextRecovery,
      Date.now(),
      command.organizationId,
      command.operation,
      command.commandId,
    );
    await this.scheduleRecoveryAt(nextRecovery);
  }

  private serializeBase<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.baseQueue.then(operation);
    this.baseQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private baseKey(): string {
    return `${this.env.APP_ENV}:${this.env.AIRTABLE_BASE_ID}`;
  }
}
