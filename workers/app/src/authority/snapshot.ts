import {
  hashAirtableValue,
  type AirtableFields,
  type AirtableTableKey,
} from "@sessionbox-killer/data/airtable/internal";

import { resolveDemoSeedFields } from "../demo/compiler.js";
import type {
  CompiledDemoSeed,
  DemoSeedAuthorityCapabilities,
  DemoSeedAuthorityReceipt,
} from "../demo/types.js";
import {
  projectionSpecs,
  projectionTableOrder,
  reverseProjectionTableOrder,
} from "./projection-spec.js";
import type { D1AuthorityProjector } from "./projector.js";
import type {
  AirtableAuthorityProvider,
  BaseAuthorityEnvironment,
} from "./provider.js";
import type { AuthorityResponse, BaseAuthorityCommand } from "./types.js";

interface SnapshotRunRow extends Record<string, SqlStorageValue> {
  receipt_json: string | null;
  request_hash: string;
  state: string;
}

interface SnapshotItemRow extends Record<string, SqlStorageValue> {
  result_json: string | null;
  state: string;
}

interface ScopedSourceRecord {
  entity_id: string;
  provider_record_id: string;
  provider_table_key: AirtableTableKey;
  source_version: number;
}

export interface SnapshotReplaceInput {
  readonly actorId: string;
  readonly expectedSourceVersion: number;
  readonly operation: "demo.snapshot.replace";
  readonly plan: CompiledDemoSeed;
  readonly requireActiveOwner: true;
  readonly requireAuthoritativeDemo: true;
  readonly resetRunId: string;
}

interface AssetBackup {
  backupKey: string;
  key: string;
}

interface AssetFileBackup {
  byte_size: number;
  checksum_sha256: string | null;
  created_at: string;
  declared_mime_type: string;
  deleted_at: string | null;
  detected_mime_type: string | null;
  display_filename: string;
  event_id: string | null;
  finalized_at: string | null;
  id: string;
  last_error_code: string | null;
  lineage_id: string | null;
  object_key: string;
  organization_id: string;
  owner_contact_id: string | null;
  purpose: string;
  r2_etag: string | null;
  r2_version: string | null;
  replaces_file_id: string | null;
  status: string;
  updated_at: string | null;
  uploaded_by_user_id: string | null;
  version_number: number;
}

interface AssetIntentBackup {
  attempts: number;
  cleanup_after: string;
  created_at: string;
  expires_at: string;
  file_object_id: string;
  finalized_at: string | null;
  id: string;
  last_cleanup_at: string | null;
  lease_expires_at: string | null;
  lease_id: string | null;
  status: string;
  token_hash: string;
  updated_at: string;
  uploaded_at: string | null;
}

interface AssetDatabaseBackup {
  files: readonly AssetFileBackup[];
  intents: readonly AssetIntentBackup[];
}

interface AssetManifest {
  backups: readonly AssetBackup[];
  baselineKeys: readonly string[];
  database: AssetDatabaseBackup;
  desiredKeys: readonly string[];
}

interface WrittenAsset {
  etag: string;
  version: string;
}

export class SnapshotAssetCommitInterruptionError extends Error {}

const stableIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

async function sha256(value: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function parseReceipt(value: string): DemoSeedAuthorityReceipt {
  return JSON.parse(value) as DemoSeedAuthorityReceipt;
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

export class DemoSnapshotAuthority {
  readonly #env: BaseAuthorityEnvironment;
  readonly #onAssetDatabaseCommitted: () => Promise<void>;
  readonly #execute: (
    command: BaseAuthorityCommand,
  ) => Promise<AuthorityResponse>;
  readonly #projector: D1AuthorityProjector;
  readonly #provider: AirtableAuthorityProvider;
  readonly #storage: DurableObjectStorage;

  constructor(options: {
    environment: BaseAuthorityEnvironment;
    execute: (command: BaseAuthorityCommand) => Promise<AuthorityResponse>;
    onAssetDatabaseCommitted?: () => Promise<void>;
    projector: D1AuthorityProjector;
    provider: AirtableAuthorityProvider;
    storage: DurableObjectStorage;
  }) {
    this.#env = options.environment;
    this.#execute = options.execute;
    this.#onAssetDatabaseCommitted =
      options.onAssetDatabaseCommitted ?? (() => Promise.resolve());
    this.#projector = options.projector;
    this.#provider = options.provider;
    this.#storage = options.storage;
  }

  capabilities(): DemoSeedAuthorityCapabilities {
    return {
      activeOwnerRevalidation: true,
      authoritativeDemoGuard: true,
      durableAudit: true,
      idempotentSnapshotReplace: true,
      privateAssets: true,
      supportedTables: [...projectionTableOrder],
    };
  }

  async replace(
    input: SnapshotReplaceInput,
  ): Promise<DemoSeedAuthorityReceipt> {
    this.assertInput(input);
    const requestHash = await hashAirtableValue({
      actorId: input.actorId,
      expectedSourceVersion: input.expectedSourceVersion,
      operation: input.operation,
      plan: input.plan,
      resetRunId: input.resetRunId,
    });
    this.insertRun(input, requestHash);
    const existing = this.run(input);
    if (!existing || existing.request_hash !== requestHash) {
      throw new Error("Demo snapshot request conflicts with durable state.");
    }
    if (existing.receipt_json) {
      return { ...parseReceipt(existing.receipt_json), outcome: "replayed" };
    }

    const createdAt = new Date().toISOString();
    await this.#env.DB.prepare(
      `INSERT INTO demo_snapshot_runs (
         organization_id, event_id, reset_run_id, snapshot_id, digest,
         actor_id, expected_source_version, operation_count, state,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)
       ON CONFLICT (organization_id, reset_run_id) DO NOTHING`,
    )
      .bind(
        input.plan.organizationId,
        input.plan.eventId,
        input.resetRunId,
        input.plan.snapshotId,
        input.plan.digest,
        input.actorId,
        input.expectedSourceVersion,
        input.plan.operations.length,
        createdAt,
        createdAt,
      )
      .run();
    await this.assertCommitGuards(input, existing.state === "received");
    this.setRunState(input, "applying");
    const recordIds = await this.loadRecordIds(input);
    for (const [index, operation] of input.plan.operations.entries()) {
      const itemKey = `upsert:${operation.templateOperationId}`;
      const existingItem = this.item(input, itemKey);
      if (existingItem?.state === "complete" && existingItem.result_json) {
        const result = JSON.parse(existingItem.result_json) as {
          recordId: string;
        };
        recordIds.set(operation.entityId, result.recordId);
        continue;
      }
      const current = await this.#provider.readEntity(
        operation.table,
        operation.entityId,
      );
      if (current) recordIds.set(operation.entityId, current.id);
      const persisted = existingItem?.result_json
        ? (JSON.parse(existingItem.result_json) as {
            command?: BaseAuthorityCommand;
          })
        : null;
      const command: BaseAuthorityCommand =
        persisted?.command ??
        ({
          audit: {
            action: "demo.snapshot.upsert",
            actorId: input.actorId,
            actorType: "user",
            eventId: input.plan.eventId,
            requestId: input.resetRunId,
            safeDiff: {
              snapshotId: input.plan.snapshotId,
              table: operation.table,
            },
          },
          commandId: `demo_${requestHash.slice(0, 20)}_${String(index + 1).padStart(3, "0")}`,
          entityId: operation.entityId,
          expectedVersion: current
            ? this.sourceVersion(
                current.fields,
                operation.table,
                operation.entityId,
              )
            : 0,
          fields: resolveDemoSeedFields(
            operation.fields,
            recordIds,
          ) as AirtableFields,
          operation: operation.operation,
          organizationId: input.plan.organizationId,
          table: operation.table,
        } satisfies BaseAuthorityCommand);
      this.leaseItem(
        input,
        itemKey,
        "record_upsert",
        operation.table,
        operation.entityId,
        { command },
      );
      const response = await this.#execute(command);
      recordIds.set(operation.entityId, response.authority.recordId);
      this.completeItem(input, itemKey, response.authority.recordId, {
        recordId: response.authority.recordId,
        sourceVersion: response.authority.sourceVersion,
      });
    }

    await this.assertCommitGuards(input, false);
    this.setRunState(input, "assets");
    await this.replaceAssets(input);
    this.setRunState(input, "deleting");
    await this.deleteStaleRecords(input);
    await this.assertCommitGuards(input, false);

    const auditEventId = `aud_demo_${requestHash.slice(0, 20)}`;
    const receipt: DemoSeedAuthorityReceipt = {
      auditEventId,
      digest: input.plan.digest,
      operationCount: input.plan.operations.length,
      outcome: "applied",
      resetRunId: input.resetRunId,
      snapshotId: input.plan.snapshotId,
    };
    const now = new Date().toISOString();
    await this.#env.DB.batch([
      this.#env.DB.prepare(
        `INSERT OR IGNORE INTO audit_events (
           id, organization_id, event_id, actor_type, actor_id, action,
           entity_type, entity_id, request_id, redaction_version,
           safe_diff_json, metadata_json, created_at
         ) VALUES (?, ?, ?, 'user', ?, 'demo.snapshot.replace', 'events', ?, ?, 1, ?, ?, ?)`,
      ).bind(
        auditEventId,
        input.plan.organizationId,
        input.plan.eventId,
        input.actorId,
        input.plan.eventId,
        input.resetRunId,
        JSON.stringify({
          assetCount: input.plan.assets.length,
          operationCount: input.plan.operations.length,
          snapshotId: input.plan.snapshotId,
        }),
        JSON.stringify({ digest: input.plan.digest, outcome: "complete" }),
        now,
      ),
      this.#env.DB.prepare(
        `UPDATE demo_snapshot_runs
         SET state = 'complete', audit_event_id = ?, updated_at = ?, completed_at = ?
         WHERE organization_id = ? AND reset_run_id = ?`,
      ).bind(
        auditEventId,
        now,
        now,
        input.plan.organizationId,
        input.resetRunId,
      ),
    ]);
    this.#storage.sql.exec(
      `UPDATE demo_snapshot_runs
       SET state = 'complete', receipt_json = ?, updated_at_ms = ?
       WHERE organization_id = ? AND reset_run_id = ?`,
      JSON.stringify(receipt),
      Date.now(),
      input.plan.organizationId,
      input.resetRunId,
    );
    return receipt;
  }

  private assertInput(input: SnapshotReplaceInput): void {
    if (
      !stableIdPattern.test(input.actorId) ||
      !stableIdPattern.test(input.resetRunId) ||
      input.plan.organizationId.length === 0 ||
      input.plan.eventId.length === 0 ||
      input.expectedSourceVersion < 0 ||
      input.plan.operations.length === 0
    ) {
      throw new Error("Demo snapshot request is invalid.");
    }
    if (
      new Set(input.plan.operations.map(({ entityId }) => entityId)).size !==
      input.plan.operations.length
    ) {
      throw new Error("Demo snapshot contains duplicate entity IDs.");
    }
    for (const asset of input.plan.assets) {
      if (!asset.objectKey.startsWith(`demo/${input.plan.eventId}/`)) {
        throw new Error("Demo asset is outside the target event prefix.");
      }
    }
  }

  private async assertCommitGuards(
    input: SnapshotReplaceInput,
    requireExpectedVersion: boolean,
  ): Promise<void> {
    const guard = await this.#env.DB.prepare(
      `SELECT event.source_version
       FROM p_events event
       JOIN tenant_registry tenant
         ON tenant.organization_id = event.organization_id
        AND tenant.status = 'active' AND tenant.authority_ready_at IS NOT NULL
       JOIN organization_memberships membership
         ON membership.organization_id = event.organization_id
        AND membership.user_id = ? AND membership.role = 'owner'
        AND membership.revoked_at IS NULL
       WHERE event.organization_id = ? AND event.id = ?
         AND event.is_demo = 1 AND event.source_deleted_at IS NULL`,
    )
      .bind(input.actorId, input.plan.organizationId, input.plan.eventId)
      .first<{ source_version: number }>();
    if (
      !guard ||
      (requireExpectedVersion
        ? guard.source_version !== input.expectedSourceVersion
        : guard.source_version < input.expectedSourceVersion)
    ) {
      throw new Error("Demo snapshot active-owner or D1 demo guard failed.");
    }
    const authoritative = await this.#provider.readEntity(
      "events",
      input.plan.eventId,
    );
    if (
      !authoritative ||
      authoritative.fields["Is demo"] !== true ||
      (requireExpectedVersion
        ? this.sourceVersion(
            authoritative.fields,
            "events",
            input.plan.eventId,
          ) !== input.expectedSourceVersion
        : this.sourceVersion(
            authoritative.fields,
            "events",
            input.plan.eventId,
          ) < input.expectedSourceVersion)
    ) {
      throw new Error("Authoritative Airtable demo guard failed.");
    }
    const organization = await this.#env.DB.prepare(
      `SELECT provider_record_id FROM authority_source_records
       WHERE base_key = ? AND provider_table_key = 'organizations'
         AND organization_id = ? AND entity_id = ? AND source_deleted_at IS NULL`,
    )
      .bind(
        this.baseKey(),
        input.plan.organizationId,
        input.plan.organizationId,
      )
      .first<{ provider_record_id: string }>();
    const linkedOrganization = authoritative.fields.Organization;
    if (
      !organization ||
      !Array.isArray(linkedOrganization) ||
      linkedOrganization.length !== 1 ||
      linkedOrganization[0] !== organization.provider_record_id
    ) {
      throw new Error("Authoritative Airtable event scope guard failed.");
    }
  }

  private async loadRecordIds(
    input: SnapshotReplaceInput,
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const rows = await this.#env.DB.prepare(
      `SELECT entity_id, provider_record_id FROM authority_source_records
       WHERE base_key = ? AND organization_id = ? AND source_deleted_at IS NULL`,
    )
      .bind(this.baseKey(), input.plan.organizationId)
      .all<{
        entity_id: string;
        provider_record_id: string;
      }>();
    rows.results.forEach((row) =>
      map.set(row.entity_id, row.provider_record_id),
    );
    return map;
  }

  private async replaceAssets(input: SnapshotReplaceInput): Promise<void> {
    const prefix = `demo/${input.plan.eventId}/`;
    const desiredKeys = input.plan.assets.map(({ objectKey }) => objectKey);
    await this.assertAssetScope(input);
    const previous = this.assetManifest(input);
    if (previous) {
      if (previous.state === "leased") {
        await this.restoreAssetManifest(input, previous.manifest);
        this.completeItem(
          input,
          "asset:manifest",
          input.plan.eventId,
          previous.manifest,
        );
      }
      await this.cleanupAssetManifest(previous.manifest);
    }
    const database = await this.backupAssetDatabase(input, prefix);
    const backups = await this.backupAssets(input, prefix);
    const manifest: AssetManifest = {
      backups,
      baselineKeys: backups.map(({ key }) => key),
      database,
      desiredKeys,
    };
    this.leaseAssetManifest(input, manifest);
    const desired = new Set(desiredKeys);
    const written = new Map<string, WrittenAsset>();
    try {
      for (const asset of input.plan.assets) {
        const bytes = decodeBase64(asset.contentBase64);
        const digest = await sha256(bytes);
        if (digest !== asset.contentDigest) {
          throw new Error("Demo asset digest changed after compilation.");
        }
        const stagingKey = `demo-staging/${input.plan.eventId}/${input.resetRunId}/${asset.assetId}`;
        await this.#env.UPLOADS.put(stagingKey, bytes, {
          customMetadata: {
            checksumSha256: asset.contentDigest,
            eventId: input.plan.eventId,
            fileId: asset.assetId,
            organizationId: input.plan.organizationId,
            purpose: asset.kind,
          },
          httpMetadata: { contentType: asset.contentType },
          sha256: asset.contentDigest,
        });
        const staged = await this.#env.UPLOADS.get(stagingKey);
        if (!staged) throw new Error("Demo asset staging failed.");
        const object = await this.#env.UPLOADS.put(
          asset.objectKey,
          staged.body,
          {
            customMetadata: {
              checksumSha256: asset.contentDigest,
              eventId: input.plan.eventId,
              fileId: asset.assetId,
              organizationId: input.plan.organizationId,
              purpose: asset.kind,
            },
            httpMetadata: { contentType: asset.contentType },
            sha256: asset.contentDigest,
          },
        );
        if (!object) throw new Error("Demo asset replacement failed.");
        written.set(asset.assetId, {
          etag: object.etag,
          version: object.version,
        });
      }
      const stale = manifest.baselineKeys.filter((key) => !desired.has(key));
      if (stale.length > 0) await this.#env.UPLOADS.delete(stale);
      const now = new Date().toISOString();
      const statements: D1PreparedStatement[] = [];
      for (const asset of input.plan.assets) {
        const object = written.get(asset.assetId);
        if (!object) throw new Error("Demo asset identity was not recorded.");
        const tokenHash = await sha256(
          new TextEncoder().encode(
            `demo-asset-intent:${input.plan.organizationId}:${input.plan.eventId}:${asset.assetId}`,
          ),
        );
        statements.push(
          this.#env.DB.prepare(
            `INSERT INTO file_objects (
               id, organization_id, event_id, owner_contact_id,
               uploaded_by_user_id, object_key, display_filename,
               declared_mime_type, detected_mime_type, byte_size,
               checksum_sha256, status, created_at, finalized_at, purpose,
               lineage_id, version_number, r2_version, r2_etag, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, 1, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET
               owner_contact_id = excluded.owner_contact_id,
               uploaded_by_user_id = excluded.uploaded_by_user_id,
               object_key = excluded.object_key,
               display_filename = excluded.display_filename,
               declared_mime_type = excluded.declared_mime_type,
               detected_mime_type = excluded.detected_mime_type,
               byte_size = excluded.byte_size,
               checksum_sha256 = excluded.checksum_sha256,
               status = 'ready', finalized_at = excluded.finalized_at,
               deleted_at = NULL, purpose = excluded.purpose,
               lineage_id = excluded.lineage_id, version_number = 1,
               replaces_file_id = NULL, r2_version = excluded.r2_version,
               r2_etag = excluded.r2_etag, last_error_code = NULL,
               updated_at = excluded.updated_at
             WHERE file_objects.organization_id = excluded.organization_id
               AND file_objects.event_id = excluded.event_id`,
          ).bind(
            asset.assetId,
            input.plan.organizationId,
            input.plan.eventId,
            asset.ownerContactId,
            input.actorId,
            asset.objectKey,
            asset.objectKey.split("/").at(-1) ?? asset.assetId,
            asset.contentType,
            asset.contentType,
            asset.sizeBytes,
            asset.contentDigest,
            now,
            now,
            asset.kind,
            asset.assetId,
            object.version,
            object.etag,
            now,
          ),
          this.#env.DB.prepare(
            `INSERT INTO file_upload_intents (
               id, file_object_id, token_hash, status, expires_at,
               cleanup_after, attempts, created_at, updated_at, uploaded_at,
               finalized_at
             ) VALUES (?, ?, ?, 'finalized', ?, ?, 1, ?, ?, ?, ?)
             ON CONFLICT (file_object_id) DO UPDATE SET
               token_hash = excluded.token_hash, status = 'finalized',
               expires_at = excluded.expires_at,
               cleanup_after = excluded.cleanup_after,
               lease_id = NULL, lease_expires_at = NULL,
               attempts = MAX(file_upload_intents.attempts, 1),
               updated_at = excluded.updated_at,
               uploaded_at = excluded.uploaded_at,
               finalized_at = excluded.finalized_at,
               last_cleanup_at = NULL
             WHERE EXISTS (
               SELECT 1 FROM file_objects file
               WHERE file.id = excluded.file_object_id
                 AND file.organization_id = ?
                 AND file.event_id = ?
             )`,
          ).bind(
            `demo_intent_${asset.assetId}`,
            asset.assetId,
            tokenHash,
            now,
            now,
            now,
            now,
            now,
            now,
            input.plan.organizationId,
            input.plan.eventId,
          ),
        );
      }
      statements.push(
        this.#env.DB.prepare(
          `UPDATE file_objects SET status = 'deleted', deleted_at = ?, updated_at = ?
           WHERE organization_id = ? AND event_id = ?
             AND substr(object_key, 1, length(?)) = ?
             AND object_key NOT IN (
               SELECT value FROM json_each(?))`,
        ).bind(
          now,
          now,
          input.plan.organizationId,
          input.plan.eventId,
          prefix,
          prefix,
          JSON.stringify(desiredKeys),
        ),
      );
      const persisted = await this.#env.DB.batch(statements);
      for (let index = 0; index < input.plan.assets.length; index += 1) {
        if (
          persisted[index * 2]?.meta.changes !== 1 ||
          persisted[index * 2 + 1]?.meta.changes !== 1
        ) {
          throw new Error("Demo asset identity crossed an event scope.");
        }
      }
      await this.#onAssetDatabaseCommitted();
      for (const asset of input.plan.assets) {
        this.completeItem(input, `asset:${asset.assetId}`, asset.objectKey, {
          objectKey: asset.objectKey,
          ...written.get(asset.assetId),
        });
      }
      this.completeItem(input, "asset:manifest", input.plan.eventId, manifest);
    } catch (error) {
      if (!(error instanceof SnapshotAssetCommitInterruptionError)) {
        try {
          await this.restoreAssetManifest(input, manifest);
          this.completeItem(
            input,
            "asset:manifest",
            input.plan.eventId,
            manifest,
          );
          await this.cleanupAssetManifest(manifest);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "Demo asset replacement and durable rollback failed.",
            { cause: rollbackError },
          );
        }
      }
      throw error;
    } finally {
      await this.cleanupPrefix(
        `demo-staging/${input.plan.eventId}/${input.resetRunId}/`,
      );
    }
    await this.cleanupAssetManifest(manifest);
  }

  private async assertAssetScope(input: SnapshotReplaceInput): Promise<void> {
    const ids = input.plan.assets.map(({ assetId }) => assetId);
    const keys = input.plan.assets.map(({ objectKey }) => objectKey);
    const existing = await this.#env.DB.prepare(
      `SELECT id, organization_id, event_id, object_key
       FROM file_objects
       WHERE id IN (SELECT value FROM json_each(?))
          OR object_key IN (SELECT value FROM json_each(?))`,
    )
      .bind(JSON.stringify(ids), JSON.stringify(keys))
      .all<{
        event_id: string | null;
        id: string;
        object_key: string;
        organization_id: string;
      }>();
    const keyById = new Map(
      input.plan.assets.map(({ assetId, objectKey }) => [assetId, objectKey]),
    );
    const idByKey = new Map(
      input.plan.assets.map(({ assetId, objectKey }) => [objectKey, assetId]),
    );
    if (
      existing.results.some(
        (row) =>
          row.organization_id !== input.plan.organizationId ||
          row.event_id !== input.plan.eventId ||
          keyById.get(row.id) !== row.object_key ||
          idByKey.get(row.object_key) !== row.id,
      )
    ) {
      throw new Error("Demo asset identity crossed an event scope.");
    }
  }

  private async backupAssets(
    input: SnapshotReplaceInput,
    prefix: string,
  ): Promise<AssetBackup[]> {
    const backups: AssetBackup[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.#env.UPLOADS.list({
        prefix,
        ...(cursor ? { cursor } : {}),
      });
      for (const object of page.objects) {
        const value = await this.#env.UPLOADS.get(object.key);
        if (!value) throw new Error("Demo asset disappeared during backup.");
        const bytes = new Uint8Array(await value.arrayBuffer());
        const digest = await sha256(bytes);
        const keyDigest = await sha256(new TextEncoder().encode(object.key));
        const backupKey = `demo-backups/${input.plan.eventId}/${input.resetRunId}/${keyDigest}`;
        const backup = await this.#env.UPLOADS.put(backupKey, bytes, {
          ...(value.customMetadata
            ? { customMetadata: value.customMetadata }
            : {}),
          ...(value.httpMetadata ? { httpMetadata: value.httpMetadata } : {}),
          sha256: digest,
        });
        if (!backup) throw new Error("Demo asset backup failed.");
        backups.push({ backupKey, key: object.key });
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return backups;
  }

  private async backupAssetDatabase(
    input: SnapshotReplaceInput,
    prefix: string,
  ): Promise<AssetDatabaseBackup> {
    const assetIds = input.plan.assets.map(({ assetId }) => assetId);
    const files = await this.#env.DB.prepare(
      `SELECT id, organization_id, event_id, owner_contact_id,
              uploaded_by_user_id, object_key, display_filename,
              declared_mime_type, detected_mime_type, byte_size,
              checksum_sha256, status, created_at, finalized_at, deleted_at,
              purpose, lineage_id, version_number, replaces_file_id,
              r2_version, r2_etag, last_error_code, updated_at
       FROM file_objects
       WHERE organization_id = ? AND event_id = ?
         AND (id IN (SELECT value FROM json_each(?))
           OR substr(object_key, 1, length(?)) = ?)`,
    )
      .bind(
        input.plan.organizationId,
        input.plan.eventId,
        JSON.stringify(assetIds),
        prefix,
        prefix,
      )
      .all<AssetFileBackup>();
    const fileIds = files.results.map(({ id }) => id);
    if (fileIds.length === 0) return { files: [], intents: [] };
    const intents = await this.#env.DB.prepare(
      `SELECT id, file_object_id, token_hash, status, expires_at,
              cleanup_after, lease_id, lease_expires_at, attempts,
              created_at, updated_at, uploaded_at, finalized_at,
              last_cleanup_at
       FROM file_upload_intents
       WHERE file_object_id IN (SELECT value FROM json_each(?))`,
    )
      .bind(JSON.stringify(fileIds))
      .all<AssetIntentBackup>();
    return { files: files.results, intents: intents.results };
  }

  private async restoreAssetManifest(
    input: SnapshotReplaceInput,
    manifest: AssetManifest,
  ): Promise<void> {
    const prefix = `demo/${input.plan.eventId}/`;
    const backupPrefix = `demo-backups/${input.plan.eventId}/${input.resetRunId}/`;
    const desiredAssets = new Map(
      input.plan.assets.map((asset) => [asset.objectKey, asset.assetId]),
    );
    const desiredKeySet = new Set(manifest.desiredKeys);
    const baselineKeySet = new Set(manifest.baselineKeys);
    const backupKeySet = new Set(manifest.backups.map(({ key }) => key));
    const databaseFileIds = new Set(
      manifest.database.files.map(({ id }) => id),
    );
    const databaseIntentIds = new Set(
      manifest.database.intents.map(({ id }) => id),
    );
    const databaseIntentFileIds = new Set(
      manifest.database.intents.map(({ file_object_id }) => file_object_id),
    );
    if (
      manifest.backups.some(
        ({ backupKey, key }) =>
          !backupKey.startsWith(backupPrefix) || !key.startsWith(prefix),
      ) ||
      manifest.desiredKeys.some(
        (key) => !key.startsWith(prefix) || !desiredAssets.has(key),
      ) ||
      manifest.desiredKeys.length !== desiredAssets.size ||
      desiredKeySet.size !== desiredAssets.size ||
      baselineKeySet.size !== manifest.baselineKeys.length ||
      backupKeySet.size !== manifest.backups.length ||
      manifest.baselineKeys.some((key) => !backupKeySet.has(key)) ||
      manifest.backups.some(({ key }) => !baselineKeySet.has(key)) ||
      databaseFileIds.size !== manifest.database.files.length ||
      databaseIntentIds.size !== manifest.database.intents.length ||
      databaseIntentFileIds.size !== manifest.database.intents.length ||
      manifest.database.files.some(
        (file) =>
          file.organization_id !== input.plan.organizationId ||
          file.event_id !== input.plan.eventId ||
          (!file.object_key.startsWith(prefix) &&
            !input.plan.assets.some(({ assetId }) => assetId === file.id)),
      ) ||
      manifest.database.intents.some(
        ({ file_object_id }) => !databaseFileIds.has(file_object_id),
      )
    ) {
      throw new Error("Demo asset rollback manifest is invalid.");
    }
    const introduced = manifest.desiredKeys.filter(
      (key) => !baselineKeySet.has(key),
    );
    if (introduced.length > 0) await this.#env.UPLOADS.delete(introduced);
    const restoredObjects = new Map<string, WrittenAsset>();
    for (const entry of manifest.backups) {
      const backup = await this.#env.UPLOADS.get(entry.backupKey);
      if (!backup) throw new Error("Demo asset rollback backup is missing.");
      const bytes = new Uint8Array(await backup.arrayBuffer());
      const restored = await this.#env.UPLOADS.put(entry.key, bytes, {
        ...(backup.customMetadata
          ? { customMetadata: backup.customMetadata }
          : {}),
        ...(backup.httpMetadata ? { httpMetadata: backup.httpMetadata } : {}),
        sha256: await sha256(bytes),
      });
      if (!restored) throw new Error("Demo asset rollback failed.");
      restoredObjects.set(entry.key, {
        etag: restored.etag,
        version: restored.version,
      });
    }
    const introducedFileIds = input.plan.assets
      .filter(
        ({ assetId, objectKey }) =>
          manifest.desiredKeys.includes(objectKey) &&
          !databaseFileIds.has(assetId),
      )
      .map(({ assetId }) => assetId);
    const affectedFileIds = [
      ...new Set([...databaseFileIds, ...introducedFileIds]),
    ];
    const statements: D1PreparedStatement[] = [];
    if (affectedFileIds.length > 0) {
      statements.push(
        this.#env.DB.prepare(
          `DELETE FROM file_upload_intents
           WHERE file_object_id IN (SELECT value FROM json_each(?))
             AND EXISTS (
               SELECT 1 FROM file_objects file
               WHERE file.id = file_upload_intents.file_object_id
                 AND file.organization_id = ? AND file.event_id = ?)`,
        ).bind(
          JSON.stringify(affectedFileIds),
          input.plan.organizationId,
          input.plan.eventId,
        ),
      );
    }
    if (introducedFileIds.length > 0) {
      statements.push(
        this.#env.DB.prepare(
          `DELETE FROM file_objects
           WHERE organization_id = ? AND event_id = ?
             AND id IN (SELECT value FROM json_each(?))`,
        ).bind(
          input.plan.organizationId,
          input.plan.eventId,
          JSON.stringify(introducedFileIds),
        ),
      );
    }
    const fileStatementOffset = statements.length;
    const restoredAt = new Date().toISOString();
    for (const file of manifest.database.files) {
      const restored = restoredObjects.get(file.object_key);
      statements.push(
        this.#env.DB.prepare(
          `INSERT INTO file_objects (
             id, organization_id, event_id, owner_contact_id,
             uploaded_by_user_id, object_key, display_filename,
             declared_mime_type, detected_mime_type, byte_size,
             checksum_sha256, status, created_at, finalized_at, deleted_at,
             purpose, lineage_id, version_number, replaces_file_id,
             r2_version, r2_etag, last_error_code, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             owner_contact_id = excluded.owner_contact_id,
             uploaded_by_user_id = excluded.uploaded_by_user_id,
             object_key = excluded.object_key,
             display_filename = excluded.display_filename,
             declared_mime_type = excluded.declared_mime_type,
             detected_mime_type = excluded.detected_mime_type,
             byte_size = excluded.byte_size,
             checksum_sha256 = excluded.checksum_sha256,
             status = excluded.status, created_at = excluded.created_at,
             finalized_at = excluded.finalized_at,
             deleted_at = excluded.deleted_at, purpose = excluded.purpose,
             lineage_id = excluded.lineage_id,
             version_number = excluded.version_number,
             replaces_file_id = excluded.replaces_file_id,
             r2_version = excluded.r2_version, r2_etag = excluded.r2_etag,
             last_error_code = excluded.last_error_code,
             updated_at = excluded.updated_at
           WHERE file_objects.organization_id = excluded.organization_id
             AND file_objects.event_id = excluded.event_id`,
        ).bind(
          file.id,
          file.organization_id,
          file.event_id,
          file.owner_contact_id,
          file.uploaded_by_user_id,
          file.object_key,
          file.display_filename,
          file.declared_mime_type,
          file.detected_mime_type,
          file.byte_size,
          file.checksum_sha256,
          file.status,
          file.created_at,
          file.finalized_at,
          file.deleted_at,
          file.purpose,
          file.lineage_id,
          file.version_number,
          file.replaces_file_id,
          restored?.version ?? file.r2_version,
          restored?.etag ?? file.r2_etag,
          file.last_error_code,
          restored ? restoredAt : file.updated_at,
        ),
      );
    }
    const intentStatementOffset = statements.length;
    for (const intent of manifest.database.intents) {
      statements.push(
        this.#env.DB.prepare(
          `INSERT INTO file_upload_intents (
             id, file_object_id, token_hash, status, expires_at,
             cleanup_after, lease_id, lease_expires_at, attempts,
             created_at, updated_at, uploaded_at, finalized_at,
             last_cleanup_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          intent.id,
          intent.file_object_id,
          intent.token_hash,
          intent.status,
          intent.expires_at,
          intent.cleanup_after,
          intent.lease_id,
          intent.lease_expires_at,
          intent.attempts,
          intent.created_at,
          intent.updated_at,
          intent.uploaded_at,
          intent.finalized_at,
          intent.last_cleanup_at,
        ),
      );
    }
    if (statements.length === 0) return;
    const restored = await this.#env.DB.batch(statements);
    if (
      manifest.database.files.some(
        (_, index) => restored[fileStatementOffset + index]?.meta.changes !== 1,
      ) ||
      manifest.database.intents.some(
        (_, index) =>
          restored[intentStatementOffset + index]?.meta.changes !== 1,
      )
    ) {
      throw new Error("Demo asset database rollback crossed an event scope.");
    }
  }

  private async cleanupAssetManifest(manifest: AssetManifest): Promise<void> {
    const keys = manifest.backups.map(({ backupKey }) => backupKey);
    if (keys.length > 0) await this.#env.UPLOADS.delete(keys);
  }

  private async cleanupPrefix(prefix: string): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await this.#env.UPLOADS.list({
        prefix,
        ...(cursor ? { cursor } : {}),
      });
      if (page.objects.length > 0) {
        await this.#env.UPLOADS.delete(page.objects.map(({ key }) => key));
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }

  private async deleteStaleRecords(input: SnapshotReplaceInput): Promise<void> {
    const desired = new Set(
      input.plan.operations.map(({ entityId }) => entityId),
    );
    const rows = await this.#env.DB.prepare(
      `SELECT provider_table_key, provider_record_id, entity_id, source_version
       FROM authority_source_records
       WHERE base_key = ? AND organization_id = ? AND event_id = ?
         AND source_deleted_at IS NULL`,
    )
      .bind(this.baseKey(), input.plan.organizationId, input.plan.eventId)
      .all<ScopedSourceRecord>();
    const order = new Map(
      reverseProjectionTableOrder.map((table, index) => [table, index]),
    );
    const stale = rows.results
      .filter(({ entity_id }) => !desired.has(entity_id))
      .sort(
        (left, right) =>
          (order.get(left.provider_table_key) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(right.provider_table_key) ?? Number.MAX_SAFE_INTEGER),
      );
    for (const row of stale) {
      if (row.provider_table_key === "events") {
        throw new Error("Demo snapshot cannot delete its guarded event root.");
      }
      const itemKey = `delete:${row.provider_table_key}:${row.entity_id}`;
      if (this.item(input, itemKey)?.state === "complete") continue;
      this.leaseItem(
        input,
        itemKey,
        "record_delete",
        row.provider_table_key,
        row.entity_id,
      );
      const authoritative = await this.assertCurrentDeleteScope(input, row);
      if (authoritative) {
        await this.#provider.deleteRecord(
          row.provider_table_key,
          authoritative.id,
        );
      }
      await this.#projector.tombstoneRecord(
        input.plan.organizationId,
        row.provider_table_key,
        row.provider_record_id,
      );
      this.completeItem(input, itemKey, row.provider_record_id, {
        recordId: row.provider_record_id,
      });
    }
  }

  private async assertCurrentDeleteScope(
    input: SnapshotReplaceInput,
    row: ScopedSourceRecord,
  ): Promise<{ id: string } | null> {
    const authoritative = await this.#provider.readEntity(
      row.provider_table_key,
      row.entity_id,
    );
    if (!authoritative) return null;
    if (
      authoritative.id !== row.provider_record_id ||
      authoritative.fields.ID !== row.entity_id
    ) {
      throw new Error("Authoritative Airtable record identity changed.");
    }
    const links = [
      ...new Set(linkedRecordIds(authoritative.fields, row.provider_table_key)),
    ];
    if (links.length === 0) {
      throw new Error("Authoritative Airtable record scope is unresolved.");
    }
    const linked = await this.#env.DB.prepare(
      `SELECT provider_record_id, organization_id, event_id
       FROM authority_source_records
       WHERE base_key = ? AND provider_record_id IN (
         SELECT value FROM json_each(?)
       ) AND source_deleted_at IS NULL`,
    )
      .bind(this.baseKey(), JSON.stringify(links))
      .all<{
        event_id: string | null;
        organization_id: string;
        provider_record_id: string;
      }>();
    if (
      new Set(
        linked.results.map(({ provider_record_id }) => provider_record_id),
      ).size !== links.length
    ) {
      throw new Error("Authoritative Airtable record scope is unresolved.");
    }
    if (
      linked.results.some(
        ({ organization_id }) => organization_id !== input.plan.organizationId,
      )
    ) {
      throw new Error("Authoritative Airtable record crossed an organization.");
    }
    const eventIds = new Set(
      linked.results.flatMap(({ event_id }) => (event_id ? [event_id] : [])),
    );
    if (eventIds.size !== 1 || !eventIds.has(input.plan.eventId)) {
      throw new Error("Authoritative Airtable record crossed an event.");
    }
    return authoritative;
  }

  private insertRun(input: SnapshotReplaceInput, requestHash: string): void {
    const now = Date.now();
    this.#storage.sql.exec(
      `INSERT INTO demo_snapshot_runs (
         organization_id, event_id, reset_run_id, request_hash, snapshot_id,
         digest, actor_id, expected_source_version, operation_count, state,
         created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)
       ON CONFLICT (organization_id, reset_run_id) DO NOTHING`,
      input.plan.organizationId,
      input.plan.eventId,
      input.resetRunId,
      requestHash,
      input.plan.snapshotId,
      input.plan.digest,
      input.actorId,
      input.expectedSourceVersion,
      input.plan.operations.length,
      now,
      now,
    );
  }

  private run(input: SnapshotReplaceInput): SnapshotRunRow | null {
    return (
      this.#storage.sql
        .exec<SnapshotRunRow>(
          `SELECT request_hash, state, receipt_json FROM demo_snapshot_runs
       WHERE organization_id = ? AND reset_run_id = ?`,
          input.plan.organizationId,
          input.resetRunId,
        )
        .toArray()[0] ?? null
    );
  }

  private setRunState(input: SnapshotReplaceInput, state: string): void {
    this.#storage.sql.exec(
      `UPDATE demo_snapshot_runs SET state = ?, updated_at_ms = ?
       WHERE organization_id = ? AND reset_run_id = ?`,
      state,
      Date.now(),
      input.plan.organizationId,
      input.resetRunId,
    );
  }

  private item(
    input: SnapshotReplaceInput,
    itemKey: string,
  ): SnapshotItemRow | null {
    return (
      this.#storage.sql
        .exec<SnapshotItemRow>(
          `SELECT state, result_json FROM demo_snapshot_items
       WHERE organization_id = ? AND reset_run_id = ? AND item_key = ?`,
          input.plan.organizationId,
          input.resetRunId,
          itemKey,
        )
        .toArray()[0] ?? null
    );
  }

  private assetManifest(input: SnapshotReplaceInput): {
    manifest: AssetManifest;
    state: string;
  } | null {
    const item = this.item(input, "asset:manifest");
    if (!item?.result_json) return null;
    const parsed = JSON.parse(item.result_json) as Partial<AssetManifest>;
    if (
      !Array.isArray(parsed.backups) ||
      !Array.isArray(parsed.baselineKeys) ||
      typeof parsed.database !== "object" ||
      parsed.database === null ||
      !Array.isArray(parsed.database.files) ||
      !Array.isArray(parsed.database.intents) ||
      !Array.isArray(parsed.desiredKeys) ||
      parsed.backups.some(
        (entry) =>
          typeof entry !== "object" ||
          entry === null ||
          typeof (entry as Partial<AssetBackup>).backupKey !== "string" ||
          typeof (entry as Partial<AssetBackup>).key !== "string",
      ) ||
      parsed.database.files.some(
        (file) =>
          typeof file !== "object" ||
          file === null ||
          typeof (file as Partial<AssetFileBackup>).id !== "string" ||
          typeof (file as Partial<AssetFileBackup>).object_key !== "string" ||
          typeof (file as Partial<AssetFileBackup>).organization_id !==
            "string",
      ) ||
      parsed.database.intents.some(
        (intent) =>
          typeof intent !== "object" ||
          intent === null ||
          typeof (intent as Partial<AssetIntentBackup>).id !== "string" ||
          typeof (intent as Partial<AssetIntentBackup>).file_object_id !==
            "string",
      ) ||
      parsed.baselineKeys.some((key) => typeof key !== "string") ||
      parsed.desiredKeys.some((key) => typeof key !== "string")
    ) {
      throw new Error("Stored demo asset rollback manifest is invalid.");
    }
    return {
      manifest: parsed as AssetManifest,
      state: item.state,
    };
  }

  private leaseAssetManifest(
    input: SnapshotReplaceInput,
    manifest: AssetManifest,
  ): void {
    this.#storage.sql.exec(
      `INSERT INTO demo_snapshot_items (
         organization_id, reset_run_id, item_key, item_type, table_key,
         entity_id, state, attempt_count, result_json, updated_at_ms
       ) VALUES (?, ?, 'asset:manifest', 'asset', 'events', ?, 'leased', 1, ?, ?)
       ON CONFLICT (organization_id, reset_run_id, item_key) DO UPDATE SET
         state = 'leased', attempt_count = demo_snapshot_items.attempt_count + 1,
         result_json = excluded.result_json, last_error_code = NULL,
         updated_at_ms = excluded.updated_at_ms`,
      input.plan.organizationId,
      input.resetRunId,
      input.plan.eventId,
      JSON.stringify(manifest),
      Date.now(),
    );
  }

  private leaseItem(
    input: SnapshotReplaceInput,
    itemKey: string,
    itemType: "asset" | "record_delete" | "record_upsert",
    table: AirtableTableKey,
    entityId: string,
    intent?: unknown,
  ): void {
    this.#storage.sql.exec(
      `INSERT INTO demo_snapshot_items (
         organization_id, reset_run_id, item_key, item_type, table_key,
         entity_id, state, attempt_count, result_json, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, 'leased', 1, ?, ?)
       ON CONFLICT (organization_id, reset_run_id, item_key) DO UPDATE SET
         state = 'leased', attempt_count = demo_snapshot_items.attempt_count + 1,
         result_json = COALESCE(demo_snapshot_items.result_json, excluded.result_json),
         updated_at_ms = excluded.updated_at_ms`,
      input.plan.organizationId,
      input.resetRunId,
      itemKey,
      itemType,
      table,
      entityId,
      intent === undefined ? null : JSON.stringify(intent),
      Date.now(),
    );
  }

  private completeItem(
    input: SnapshotReplaceInput,
    itemKey: string,
    providerRecordId: string,
    result: unknown,
  ): void {
    this.#storage.sql.exec(
      `INSERT INTO demo_snapshot_items (
         organization_id, reset_run_id, item_key, item_type, provider_record_id,
         state, attempt_count, result_json, updated_at_ms
       ) VALUES (?, ?, ?, 'asset', ?, 'complete', 1, ?, ?)
       ON CONFLICT (organization_id, reset_run_id, item_key) DO UPDATE SET
         provider_record_id = excluded.provider_record_id, state = 'complete',
         result_json = excluded.result_json, last_error_code = NULL,
         updated_at_ms = excluded.updated_at_ms`,
      input.plan.organizationId,
      input.resetRunId,
      itemKey,
      providerRecordId,
      JSON.stringify(result),
      Date.now(),
    );
  }

  private sourceVersion(
    fields: AirtableFields,
    table: AirtableTableKey,
    entityId: string,
  ): number {
    const value = fields["Source version"];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw new Error(
        `Airtable ${table} ${entityId} has an invalid Source version.`,
      );
    }
    return value;
  }

  private baseKey(): string {
    return `${this.#env.APP_ENV}:${this.#env.AIRTABLE_BASE_ID}`;
  }
}
