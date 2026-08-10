import { sha256Hex } from "../auth/crypto.js";
import type {
  CompiledDemoSeed,
  DemoBootstrapAuthorityGateway,
  DemoSeedAuthorityReceipt,
  DemoSnapshotRunInspection,
} from "./types.js";
import {
  D1DemoEventGuardReader,
  DemoResetError,
  DemoResetService,
} from "./reset.js";

export type DemoBootstrapErrorCode =
  | "authority_unavailable"
  | "conflicting_state"
  | "invalid_roots"
  | "verification_failed";

export class DemoBootstrapError extends Error {
  readonly code: DemoBootstrapErrorCode;

  constructor(code: DemoBootstrapErrorCode, message: string) {
    super(message);
    this.name = "DemoBootstrapError";
    this.code = code;
  }
}

export interface DemoBootstrapInput {
  readonly eventSourceRecordId: string;
  readonly operationId: string;
  readonly organizationSourceRecordId: string;
  readonly ownerEmail: string;
}

export interface DemoBootstrapResult {
  readonly assetCount: number;
  readonly authorityReady: true;
  readonly receipt: DemoSeedAuthorityReceipt;
  readonly rootLineageVerified: true;
}

interface TenantState {
  authority_ready_at: string | null;
  base_key: string;
  organization_id: string;
  source_record_id: string;
  status: string;
}

interface OwnerState {
  id: string;
  membership_role: string | null;
  membership_revoked_at: string | null;
  status: string;
}

const stableIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const airtableRecordPattern = /^rec[A-Za-z0-9]{14}$/;

export class DemoBootstrapService {
  readonly #authority: DemoBootstrapAuthorityGateway;
  readonly #baseKey: string;
  readonly #bucket: R2Bucket;
  readonly #database: D1Database;
  readonly #plan: CompiledDemoSeed;

  constructor(options: {
    authority: DemoBootstrapAuthorityGateway;
    baseKey: string;
    bucket: R2Bucket;
    database: D1Database;
    plan: CompiledDemoSeed;
  }) {
    this.#authority = options.authority;
    this.#baseKey = options.baseKey;
    this.#bucket = options.bucket;
    this.#database = options.database;
    this.#plan = options.plan;
  }

  async bootstrap(input: DemoBootstrapInput): Promise<DemoBootstrapResult> {
    this.#assertInput(input);
    const resumeActorId = await this.#resumeActorId(input);
    const existingRun =
      (await this.#authority.inspectDemoEventReplacement?.(
        this.#plan.organizationId,
        input.operationId,
      )) ?? null;
    if (existingRun) {
      this.#assertExistingRun(existingRun, resumeActorId, input);
      await this.#assertReadyRoots(input);
      const receipt = await this.#reset(resumeActorId, input);
      await this.#verifyComplete(input, receipt);
      return {
        assetCount: this.#plan.assets.length,
        authorityReady: true,
        receipt,
        rootLineageVerified: true,
      };
    }
    let roots;
    try {
      roots = await this.#authority.inspectDemoBootstrapRoots(
        this.#plan.organizationId,
        this.#plan.eventId,
      );
    } catch {
      throw new DemoBootstrapError(
        "invalid_roots",
        "The authoritative demo roots are unavailable or invalid.",
      );
    }
    if (
      roots.organizationRecordId !== input.organizationSourceRecordId ||
      roots.eventRecordId !== input.eventSourceRecordId
    ) {
      throw new DemoBootstrapError(
        "invalid_roots",
        "The authorized demo roots do not match Airtable.",
      );
    }

    const actorId = await this.#registerTenantAndOwner(input);
    try {
      await this.#authority.synchronize([this.#plan.organizationId]);
    } catch {
      throw new DemoBootstrapError(
        "authority_unavailable",
        "The demo roots could not be reconciled.",
      );
    }

    const sourceVersion = await this.#assertReadyRoots(input);
    const receipt = await this.#reset(actorId, input);
    if (sourceVersion < 1) {
      throw new DemoBootstrapError(
        "verification_failed",
        "The demo event source version is invalid.",
      );
    }
    await this.#verifyComplete(input, receipt);
    return {
      assetCount: this.#plan.assets.length,
      authorityReady: true,
      receipt,
      rootLineageVerified: true,
    };
  }

  #assertExistingRun(
    run: DemoSnapshotRunInspection,
    actorId: string,
    input: DemoBootstrapInput,
  ): void {
    if (
      run.actorId !== actorId ||
      run.organizationId !== this.#plan.organizationId ||
      run.eventId !== this.#plan.eventId ||
      run.resetRunId !== input.operationId ||
      run.snapshotId !== this.#plan.snapshotId ||
      run.digest !== this.#plan.digest ||
      run.operationCount !== this.#plan.operations.length
    ) {
      throw new DemoBootstrapError(
        "conflicting_state",
        "The durable demo bootstrap operation conflicts with this request.",
      );
    }
  }

  #assertInput(input: DemoBootstrapInput): void {
    if (
      !stableIdPattern.test(input.operationId) ||
      !airtableRecordPattern.test(input.organizationSourceRecordId) ||
      !airtableRecordPattern.test(input.eventSourceRecordId) ||
      input.ownerEmail !== input.ownerEmail.trim().toLowerCase() ||
      input.ownerEmail.length > 320 ||
      !input.ownerEmail.includes("@")
    ) {
      throw new DemoBootstrapError(
        "invalid_roots",
        "The demo bootstrap request is invalid.",
      );
    }
  }

  async #registerTenantAndOwner(input: DemoBootstrapInput): Promise<string> {
    const now = new Date().toISOString();
    const userId = await this.#deterministicActorId(input.ownerEmail);
    const membershipId = `om_demo_${userId.slice("usr_demo_".length)}`;

    await this.#database.batch([
      this.#database
        .prepare(
          `INSERT INTO tenant_registry (
             organization_id, base_key, source_record_id, status,
             created_at, updated_at, authority_ready_at
           )
           SELECT ?1, ?2, ?3, 'active', ?4, ?4, NULL
           WHERE NOT EXISTS (
             SELECT 1 FROM tenant_registry
             WHERE organization_id != ?1 OR base_key != ?2
                OR source_record_id != ?3 OR status != 'active'
           )
             AND NOT EXISTS (
               SELECT 1 FROM users
               WHERE id = ?5
                 AND (email_normalized != ?6 COLLATE NOCASE OR status != 'active')
             )
             AND NOT EXISTS (
               SELECT 1 FROM users
               WHERE email_normalized = ?6 COLLATE NOCASE AND status != 'active'
             )
           ON CONFLICT(organization_id) DO NOTHING`,
        )
        .bind(
          this.#plan.organizationId,
          this.#baseKey,
          input.organizationSourceRecordId,
          now,
          userId,
          input.ownerEmail,
        ),
      this.#database
        .prepare(
          `INSERT INTO users (
             id, email_normalized, status, created_at, updated_at
           )
           SELECT ?1, ?2, 'active', ?3, ?3
           WHERE EXISTS (
             SELECT 1 FROM tenant_registry
             WHERE organization_id = ?4 AND base_key = ?5
               AND source_record_id = ?6 AND status = 'active'
           )
             AND (SELECT COUNT(*) FROM tenant_registry) = 1
           ON CONFLICT(email_normalized) DO NOTHING`,
        )
        .bind(
          userId,
          input.ownerEmail,
          now,
          this.#plan.organizationId,
          this.#baseKey,
          input.organizationSourceRecordId,
        ),
      this.#database
        .prepare(
          `INSERT INTO organization_memberships (
             id, organization_id, user_id, role, created_at, updated_at
           )
           SELECT ?1, ?2, user.id, 'owner', ?4, ?4
           FROM users user
           JOIN tenant_registry tenant ON tenant.organization_id = ?2
             AND tenant.base_key = ?5 AND tenant.source_record_id = ?6
             AND tenant.status = 'active'
           WHERE user.email_normalized = ?3 COLLATE NOCASE
             AND user.status = 'active'
             AND (SELECT COUNT(*) FROM tenant_registry) = 1
           ON CONFLICT(organization_id, user_id) DO UPDATE SET
             role = 'owner', revoked_at = NULL, updated_at = excluded.updated_at`,
        )
        .bind(
          membershipId,
          this.#plan.organizationId,
          input.ownerEmail,
          now,
          this.#baseKey,
          input.organizationSourceRecordId,
        ),
    ]);

    const [tenants, owner] = await Promise.all([
      this.#database
        .prepare(
          `SELECT organization_id, base_key, source_record_id, status,
                  authority_ready_at
           FROM tenant_registry ORDER BY organization_id`,
        )
        .all<TenantState>(),
      this.#database
        .prepare(
          `SELECT user.id, user.status, membership.role AS membership_role,
                  membership.revoked_at AS membership_revoked_at
           FROM users user
           LEFT JOIN organization_memberships membership
             ON membership.organization_id = ?1 AND membership.user_id = user.id
           WHERE user.email_normalized = ?2 COLLATE NOCASE
           LIMIT 1`,
        )
        .bind(this.#plan.organizationId, input.ownerEmail)
        .first<OwnerState>(),
    ]);
    const tenant = tenants.results[0];
    if (
      tenants.results.length !== 1 ||
      !tenant ||
      tenant.organization_id !== this.#plan.organizationId ||
      tenant.base_key !== this.#baseKey ||
      tenant.source_record_id !== input.organizationSourceRecordId ||
      tenant.status !== "active" ||
      !owner ||
      owner.status !== "active" ||
      owner.membership_role !== "owner" ||
      owner.membership_revoked_at !== null
    ) {
      throw new DemoBootstrapError(
        "conflicting_state",
        "The demo tenant or owner state conflicts with this bootstrap.",
      );
    }
    return owner.id;
  }

  async #deterministicActorId(ownerEmail: string): Promise<string> {
    const ownerDigest = await sha256Hex(
      `${this.#plan.organizationId}\u0000${ownerEmail}`,
    );
    return `usr_demo_${ownerDigest.slice(0, 24)}`;
  }

  async #resumeActorId(input: DemoBootstrapInput): Promise<string> {
    const owner = await this.#database
      .prepare(
        `SELECT user.id
         FROM users user
         JOIN organization_memberships membership
           ON membership.user_id = user.id
          AND membership.organization_id = ?1
          AND membership.role = 'owner' AND membership.revoked_at IS NULL
         JOIN tenant_registry tenant
           ON tenant.organization_id = membership.organization_id
          AND tenant.base_key = ?2 AND tenant.source_record_id = ?3
          AND tenant.status = 'active'
         WHERE user.email_normalized = ?4 COLLATE NOCASE
           AND user.status = 'active'
           AND (SELECT COUNT(*) FROM tenant_registry) = 1
         LIMIT 1`,
      )
      .bind(
        this.#plan.organizationId,
        this.#baseKey,
        input.organizationSourceRecordId,
        input.ownerEmail,
      )
      .first<{ id: string }>();
    return owner?.id ?? this.#deterministicActorId(input.ownerEmail);
  }

  async #reset(
    actorId: string,
    input: DemoBootstrapInput,
  ): Promise<DemoSeedAuthorityReceipt> {
    try {
      return await new DemoResetService({
        authority: this.#authority,
        eventReader: new D1DemoEventGuardReader(this.#database),
        plan: this.#plan,
      }).reset({
        actor: {
          id: actorId,
          organizationId: this.#plan.organizationId,
          permissions: ["organization:manage"],
        },
        confirmation: this.#plan.resetPhrase,
        eventId: this.#plan.eventId,
        organizationId: this.#plan.organizationId,
        requestId: input.operationId,
      });
    } catch (error) {
      if (error instanceof DemoResetError) {
        if (error.code === "idempotency_conflict") {
          throw new DemoBootstrapError(
            "conflicting_state",
            "The durable demo bootstrap operation conflicts with this request.",
          );
        }
        if (error.code === "receipt_mismatch") {
          throw new DemoBootstrapError(
            "verification_failed",
            "The guarded demo snapshot returned an invalid receipt.",
          );
        }
      }
      throw new DemoBootstrapError(
        "authority_unavailable",
        "The guarded demo snapshot could not be applied.",
      );
    }
  }

  async #assertReadyRoots(input: DemoBootstrapInput): Promise<number> {
    const row = await this.#database
      .prepare(
        `SELECT event.source_version
         FROM tenant_registry tenant
         JOIN p_organizations organization ON organization.id = tenant.organization_id
           AND organization.source_record_id = tenant.source_record_id
           AND organization.source_deleted_at IS NULL
         JOIN authority_source_records organization_source
           ON organization_source.base_key = tenant.base_key
          AND organization_source.organization_id = tenant.organization_id
          AND organization_source.provider_table_key = 'organizations'
          AND organization_source.provider_record_id = tenant.source_record_id
          AND organization_source.entity_id = tenant.organization_id
          AND organization_source.source_deleted_at IS NULL
         JOIN p_events event ON event.organization_id = tenant.organization_id
           AND event.id = ?4 AND event.source_record_id = ?5
           AND event.is_demo = 1 AND event.source_deleted_at IS NULL
         JOIN authority_source_records event_source
           ON event_source.base_key = tenant.base_key
          AND event_source.organization_id = tenant.organization_id
          AND event_source.provider_table_key = 'events'
          AND event_source.provider_record_id = event.source_record_id
          AND event_source.entity_id = event.id
          AND event_source.source_deleted_at IS NULL
         WHERE tenant.organization_id = ?1 AND tenant.base_key = ?2
           AND tenant.source_record_id = ?3 AND tenant.status = 'active'
           AND tenant.authority_ready_at IS NOT NULL
         LIMIT 1`,
      )
      .bind(
        this.#plan.organizationId,
        this.#baseKey,
        input.organizationSourceRecordId,
        this.#plan.eventId,
        input.eventSourceRecordId,
      )
      .first<{ source_version: number }>();
    if (!row) {
      throw new DemoBootstrapError(
        "verification_failed",
        "The demo roots did not become authoritative and ready.",
      );
    }
    return row.source_version;
  }

  async #verifyComplete(
    input: DemoBootstrapInput,
    receipt: DemoSeedAuthorityReceipt,
  ): Promise<void> {
    const [activeSources, run, tenant] = await Promise.all([
      this.#database
        .prepare(
          `SELECT COUNT(*) AS count FROM authority_source_records
           WHERE base_key = ?1 AND organization_id = ?2
             AND source_deleted_at IS NULL`,
        )
        .bind(this.#baseKey, this.#plan.organizationId)
        .first<{ count: number }>(),
      this.#database
        .prepare(
          `SELECT state, snapshot_id, digest, operation_count
           FROM demo_snapshot_runs
           WHERE organization_id = ?1 AND event_id = ?2 AND reset_run_id = ?3`,
        )
        .bind(this.#plan.organizationId, this.#plan.eventId, input.operationId)
        .first<{
          digest: string;
          operation_count: number;
          snapshot_id: string;
          state: string;
        }>(),
      this.#database
        .prepare(
          `SELECT authority_ready_at FROM tenant_registry
           WHERE organization_id = ?1 AND base_key = ?2
             AND source_record_id = ?3 AND status = 'active'`,
        )
        .bind(
          this.#plan.organizationId,
          this.#baseKey,
          input.organizationSourceRecordId,
        )
        .first<{ authority_ready_at: string | null }>(),
    ]);
    const assets = await Promise.all(
      this.#plan.assets.map((asset) => this.#bucket.head(asset.objectKey)),
    );
    if (
      activeSources?.count !== this.#plan.operations.length ||
      !tenant?.authority_ready_at ||
      !run ||
      run.state !== "complete" ||
      run.snapshot_id !== this.#plan.snapshotId ||
      run.digest !== this.#plan.digest ||
      run.operation_count !== this.#plan.operations.length ||
      receipt.snapshotId !== this.#plan.snapshotId ||
      receipt.digest !== this.#plan.digest ||
      assets.some((asset) => !asset)
    ) {
      throw new DemoBootstrapError(
        "verification_failed",
        "The demo bootstrap did not converge to the compiled snapshot.",
      );
    }
  }
}
