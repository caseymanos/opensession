import {
  AirtableClient,
  AirtableCommandStore,
  AirtableError,
  AirtableIdempotencyConflictError,
  AirtableManualEditError,
  AirtableSchemaDriftError,
  createAirtableSchemaIndex,
  hashAirtableContent,
  managedAirtableContent,
  type AirtableCommandResult,
  type AirtableFields,
  type AirtableRecord,
  type AirtableSchemaIndex,
  type AirtableTableKey,
  type AirtableWebhookPayloadPage,
} from "@sessionbox-killer/data/airtable/internal";

import { PersistentAirtableRateLimiter } from "./persistent-rate-limiter.js";
import type { PublicScheduleCacheInvalidationMessage } from "../public-schedule/cache.js";
import type { BaseAuthorityCommand } from "./types.js";

export interface ProjectionRepairWakeMessage {
  authority: string;
  commandId: string;
  operation: string;
  organizationId: string;
  type: "projection_repair";
}

export interface BaseAuthorityEnvironment {
  AIRTABLE_BASE_ID: string;
  AIRTABLE_PAT: string;
  AUTHORITY_LEASE_MILLISECONDS?: string;
  AUTHORITY_CACHE_INVALIDATION_REDRIVE_MILLISECONDS?: string;
  AUTHORITY_RECOVERY_DELAY_MILLISECONDS?: string;
  AIRTABLE_REQUESTS_PER_SECOND?: string;
  AIRTABLE_UPSTREAM?: Fetcher;
  APP_ENV: "local" | "preview" | "production";
  DB: D1Database;
  PROJECTION_REPAIR_QUEUE: Queue<
    PublicScheduleCacheInvalidationMessage | ProjectionRepairWakeMessage
  >;
  UPLOADS: R2Bucket;
}

export type ProviderRecovery =
  | { outcome: "applied"; result: AirtableCommandResult }
  | { outcome: "not_applied" }
  | { outcome: "unknown" };

interface ProviderRuntime {
  client: AirtableClient;
  schema: AirtableSchemaIndex;
  store: AirtableCommandStore;
}

export interface ReconciliationBaseline {
  entityId: string;
  lastCommandHash: string | null;
  lastCommandId: string | null;
  sourceContentHash: string;
  sourceVersion: number;
}

export interface PreparedAirtableRecord {
  fields: AirtableFields;
  recordId: string;
  sourceContentHash: string;
  sourceVersion: number;
}

export interface ReconciliationInspection {
  disposition: "create" | "unchanged" | "update";
  fields: AirtableFields;
  lifecyclePatch: AirtableFields | null;
  recordId: string;
  sourceContentHash: string;
  sourceVersion: number;
}

function readVersion(fields: AirtableFields): number {
  const value = fields["Source version"];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new AirtableSchemaDriftError(
      "Airtable authority record has an invalid Source version.",
    );
  }
  return value;
}

function authorityResult(
  entityId: string,
  fields: AirtableFields,
  recordId: string,
): AirtableCommandResult {
  return {
    entityId,
    fields,
    recordId,
    replayed: true,
    sourceVersion: readVersion(fields),
  };
}

export class AirtableAuthorityProvider {
  private readonly env: BaseAuthorityEnvironment;
  private runtimePromise: Promise<ProviderRuntime> | null = null;
  private readonly storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage, env: BaseAuthorityEnvironment) {
    this.storage = storage;
    this.env = env;
  }

  async execute(command: BaseAuthorityCommand): Promise<AirtableCommandResult> {
    return (await this.runtime()).store.execute(command);
  }

  async recover(
    command: BaseAuthorityCommand,
    requestHash: string,
  ): Promise<ProviderRecovery> {
    const runtime = await this.runtime();
    const table = this.getTable(runtime.schema, command.table);
    const records = await runtime.client.listRecords(table.id, {
      filterByFormula: `{ID} = '${command.entityId}'`,
      maxRecords: 2,
      pageSize: 2,
    });

    if (records.length > 1) {
      throw new AirtableSchemaDriftError(
        `Airtable table ${table.name} contains duplicate ID ${command.entityId}.`,
      );
    }
    const record = records[0];
    if (!record) {
      return { outcome: "not_applied" };
    }

    const lastCommandId = record.fields["Last command ID"];
    const lastCommandHash = record.fields["Last command hash"];
    if (lastCommandId === command.commandId) {
      if (lastCommandHash !== requestHash) {
        throw new AirtableIdempotencyConflictError(
          command.commandId,
          command.entityId,
        );
      }
      return {
        outcome: "applied",
        result: authorityResult(command.entityId, record.fields, record.id),
      };
    }

    const currentVersion = record.fields["Source version"];
    if (
      typeof currentVersion === "number" &&
      Number.isInteger(currentVersion) &&
      currentVersion === command.expectedVersion
    ) {
      return { outcome: "not_applied" };
    }
    return { outcome: "unknown" };
  }

  async listTableRecords(
    tableKey: AirtableTableKey,
  ): Promise<readonly AirtableRecord[]> {
    const runtime = await this.runtime();
    return runtime.client.listRecords(
      this.getTable(runtime.schema, tableKey).id,
      {
        pageSize: 100,
      },
    );
  }

  async readEntity(
    tableKey: AirtableTableKey,
    entityId: string,
  ): Promise<AirtableRecord | null> {
    const runtime = await this.runtime();
    const records = await runtime.client.listRecords(
      this.getTable(runtime.schema, tableKey).id,
      {
        filterByFormula: `{ID} = '${entityId.replaceAll("'", "\\'")}'`,
        maxRecords: 2,
        pageSize: 2,
      },
    );
    if (records.length > 1) {
      throw new AirtableSchemaDriftError(
        `Airtable table ${tableKey} contains duplicate ID ${entityId}.`,
      );
    }
    return records[0] ?? null;
  }

  async prepareReconciliationRecord(
    tableKey: AirtableTableKey,
    record: AirtableRecord,
    baseline: ReconciliationBaseline | null,
  ): Promise<PreparedAirtableRecord> {
    const inspection = await this.inspectReconciliationRecord(
      tableKey,
      record,
      baseline,
    );
    const fields = inspection.lifecyclePatch
      ? await this.patchRecord(tableKey, record.id, inspection.lifecyclePatch)
      : inspection.fields;
    return {
      fields,
      recordId: record.id,
      sourceContentHash: inspection.sourceContentHash,
      sourceVersion: inspection.sourceVersion,
    };
  }

  async inspectReconciliationRecord(
    tableKey: AirtableTableKey,
    record: AirtableRecord,
    baseline: ReconciliationBaseline | null,
  ): Promise<ReconciliationInspection> {
    const fields = record.fields;
    const version = fields["Source version"];
    const storedHash = fields["Applied content hash"];
    const commandId = fields["Last command ID"];
    const commandHash = fields["Last command hash"];
    const lifecycleEmpty =
      version === undefined &&
      storedHash === undefined &&
      commandId === undefined &&
      commandHash === undefined;
    if (lifecycleEmpty) {
      if (baseline) {
        throw new AirtableManualEditError(
          `Airtable ${tableKey} lifecycle metadata was removed outside the authority.`,
        );
      }
      const sourceVersion = 1;
      const sourceContentHash = await hashAirtableContent(
        managedAirtableContent(tableKey, fields),
        sourceVersion,
      );
      return {
        disposition: "create",
        fields,
        lifecyclePatch: {
          "Applied content hash": sourceContentHash,
          "Source version": sourceVersion,
        },
        recordId: record.id,
        sourceContentHash,
        sourceVersion,
      };
    }
    const sourceVersion = readVersion(fields);
    if (baseline && sourceVersion < baseline.sourceVersion) {
      throw new AirtableManualEditError(
        `Airtable ${tableKey} Source version is older than its projection.`,
      );
    }
    const sourceContentHash = await hashAirtableContent(
      managedAirtableContent(tableKey, fields),
      sourceVersion,
    );
    if (storedHash === sourceContentHash) {
      return {
        disposition:
          baseline === null
            ? "create"
            : baseline.sourceContentHash === sourceContentHash &&
                baseline.sourceVersion === sourceVersion
              ? "unchanged"
              : "update",
        fields,
        lifecyclePatch: null,
        recordId: record.id,
        sourceContentHash,
        sourceVersion,
      };
    }
    const baselineMarkersMatch =
      baseline !== null &&
      baseline.sourceVersion === sourceVersion &&
      baseline.sourceContentHash === storedHash &&
      baseline.lastCommandId ===
        (typeof commandId === "string" ? commandId : null) &&
      baseline.lastCommandHash ===
        (typeof commandHash === "string" ? commandHash : null);
    if (!baselineMarkersMatch) {
      throw new AirtableManualEditError(
        `Airtable ${tableKey} lifecycle metadata changed outside the authority.`,
      );
    }
    const adoptedVersion = sourceVersion + 1;
    const adoptedHash = await hashAirtableContent(
      managedAirtableContent(tableKey, fields),
      adoptedVersion,
    );
    return {
      disposition: "update",
      fields,
      lifecyclePatch: {
        "Applied content hash": adoptedHash,
        "Source version": adoptedVersion,
      },
      recordId: record.id,
      sourceContentHash: adoptedHash,
      sourceVersion: adoptedVersion,
    };
  }

  async deleteRecord(
    tableKey: AirtableTableKey,
    recordId: string,
  ): Promise<void> {
    const runtime = await this.runtime();
    try {
      await runtime.client.deleteRecords(
        this.getTable(runtime.schema, tableKey).id,
        [recordId],
      );
    } catch (error) {
      if (error instanceof AirtableError && error.status === 404) return;
      throw error;
    }
  }

  async webhookPayloads(
    webhookId: string,
    cursor: number,
  ): Promise<AirtableWebhookPayloadPage> {
    return (await this.runtime()).client.getWebhookPayloads(webhookId, cursor);
  }

  async tableKeysForIds(
    tableIds: readonly string[],
  ): Promise<AirtableTableKey[]> {
    const runtime = await this.runtime();
    const requested = new Set(tableIds);
    return [...runtime.schema.tables.entries()]
      .filter(([, table]) => requested.has(table.id))
      .map(([key]) => key)
      .sort();
  }

  private async patchRecord(
    tableKey: AirtableTableKey,
    recordId: string,
    fields: AirtableFields,
  ): Promise<AirtableFields> {
    const runtime = await this.runtime();
    const records = await runtime.client.updateRecords(
      this.getTable(runtime.schema, tableKey).id,
      [{ fields, id: recordId }],
    );
    const written = records[0];
    if (!written) {
      throw new AirtableSchemaDriftError(
        `Airtable ${tableKey} lifecycle update returned no record.`,
      );
    }
    return written.fields;
  }

  private getTable(
    schema: AirtableSchemaIndex,
    key: BaseAuthorityCommand["table"],
  ) {
    const table = schema.tables.get(key);
    if (!table) {
      throw new AirtableSchemaDriftError(
        `Airtable schema does not contain table ${key}.`,
      );
    }
    return table;
  }

  private runtime(): Promise<ProviderRuntime> {
    this.runtimePromise ??= this.createRuntime().catch((error: unknown) => {
      this.runtimePromise = null;
      throw error;
    });
    return this.runtimePromise;
  }

  private async createRuntime(): Promise<ProviderRuntime> {
    const upstream = this.env.AIRTABLE_UPSTREAM;
    const fetcher = upstream
      ? (input: string | URL, init?: RequestInit) =>
          upstream.fetch(new Request(input, init))
      : globalThis.fetch.bind(globalThis);
    const client = new AirtableClient({
      baseId: this.env.AIRTABLE_BASE_ID,
      fetcher,
      rateLimiter: new PersistentAirtableRateLimiter(this.storage, {
        requestsPerSecond:
          this.env.APP_ENV === "local"
            ? Number(this.env.AIRTABLE_REQUESTS_PER_SECOND) || 5
            : 5,
      }),
      token: this.env.AIRTABLE_PAT,
    });
    const schema = createAirtableSchemaIndex(await client.getBaseSchema());
    return {
      client,
      schema,
      store: new AirtableCommandStore({ client, schema }),
    };
  }
}
