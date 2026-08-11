import type {
  CompiledDemoSeed,
  DemoAirtableTableKey,
  DemoEventGuard,
  DemoEventGuardReader,
  DemoResetRequest,
  DemoSeedAuthorityCapabilities,
  DemoSeedAuthorityGateway,
  DemoSeedAuthorityReceipt,
} from "./types";

export type DemoResetErrorCode =
  | "authority_unavailable"
  | "idempotency_conflict"
  | "invalid_audit_context"
  | "invalid_confirmation"
  | "invalid_target"
  | "not_demo"
  | "not_privileged"
  | "receipt_mismatch";

export class DemoResetError extends Error {
  readonly code: DemoResetErrorCode;

  constructor(code: DemoResetErrorCode, message: string) {
    super(message);
    this.name = "DemoResetError";
    this.code = code;
  }
}

const stableAuditIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;

function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export const currentRal34DemoCapabilities: DemoSeedAuthorityCapabilities = {
  activeOwnerRevalidation: true,
  authoritativeDemoGuard: true,
  durableAudit: true,
  idempotentSnapshotReplace: true,
  privateAssets: true,
  supportedTables: [
    "organizations",
    "events",
    "forms",
    "form_fields",
    "form_rules",
    "contacts",
    "event_contacts",
    "submissions",
    "submission_answers",
    "submission_participants",
    "rubrics",
    "criteria",
    "reviews",
    "review_scores",
    "sessions",
    "session_participants",
    "rooms",
    "tracks",
    "formats",
    "schedule_slots",
    "task_definitions",
    "task_assignments",
    "resources",
    "email_templates",
    "campaigns",
    "messages",
    "integrations",
    "external_mappings",
    "sync_runs",
  ],
};

export function demoAuthorityBlockers(
  plan: CompiledDemoSeed,
  capabilities: DemoSeedAuthorityCapabilities,
): string[] {
  const requiredTables = new Set(plan.operations.map(({ table }) => table));
  const supportedTables = new Set(capabilities.supportedTables);
  const unsupported = [...requiredTables]
    .filter((table) => !supportedTables.has(table))
    .sort(compareCanonicalStrings);
  return [
    ...(unsupported.length === 0
      ? []
      : [`unsupported_tables:${unsupported.join(",")}`]),
    ...(capabilities.activeOwnerRevalidation
      ? []
      : ["missing_active_owner_revalidation"]),
    ...(capabilities.authoritativeDemoGuard
      ? []
      : ["missing_authoritative_demo_guard"]),
    ...(capabilities.idempotentSnapshotReplace
      ? []
      : ["missing_idempotent_snapshot_replace"]),
    ...(capabilities.durableAudit ? [] : ["missing_durable_audit"]),
    ...(plan.assets.length === 0 || capabilities.privateAssets
      ? []
      : ["missing_private_asset_replace"]),
  ];
}

export class D1DemoEventGuardReader implements DemoEventGuardReader {
  readonly #baseKey: string;
  readonly #database: D1Database;

  constructor(database: D1Database, baseKey: string) {
    this.#database = database;
    this.#baseKey = baseKey;
  }

  async activeOrganizationIds(): Promise<readonly string[]> {
    const rows = await this.#database
      .prepare(
        `SELECT organization_id FROM tenant_registry
         WHERE base_key = ? AND status = 'active'
         ORDER BY organization_id`,
      )
      .bind(this.#baseKey)
      .all<{ organization_id: string }>();
    return rows.results.map(({ organization_id }) => organization_id);
  }

  async read(
    organizationId: string,
    eventId: string,
  ): Promise<DemoEventGuard | null> {
    const row = await this.#database
      .prepare(
        `SELECT event.id AS event_id, event.organization_id,
                event.is_demo, event.source_version
         FROM p_events event
         JOIN tenant_registry tenant
           ON tenant.organization_id = event.organization_id
          AND tenant.base_key = ?3
          AND tenant.status = 'active'
          AND tenant.authority_ready_at IS NOT NULL
         WHERE event.organization_id = ?1
           AND event.id = ?2
           AND event.source_deleted_at IS NULL
         LIMIT 1`,
      )
      .bind(organizationId, eventId, this.#baseKey)
      .first<{
        event_id: string;
        is_demo: number;
        organization_id: string;
        source_version: number;
      }>();
    if (!row) {
      return null;
    }
    return {
      eventId: row.event_id,
      isDemo: row.is_demo === 1,
      organizationId: row.organization_id,
      sourceVersion: row.source_version,
    };
  }
}

function assertReceipt(
  plan: CompiledDemoSeed,
  resetRunId: string,
  receipt: DemoSeedAuthorityReceipt,
): void {
  if (
    receipt.snapshotId !== plan.snapshotId ||
    receipt.resetRunId !== resetRunId ||
    receipt.digest !== plan.digest ||
    receipt.operationCount !== plan.operations.length ||
    !stableAuditIdPattern.test(receipt.auditEventId) ||
    (receipt.outcome !== "applied" && receipt.outcome !== "replayed")
  ) {
    throw new DemoResetError(
      "receipt_mismatch",
      "Demo authority returned an invalid reset receipt.",
    );
  }
}

export class DemoResetService {
  readonly #authority: DemoSeedAuthorityGateway;
  readonly #eventReader: DemoEventGuardReader;
  readonly #plan: CompiledDemoSeed;

  constructor(options: {
    authority: DemoSeedAuthorityGateway;
    eventReader: DemoEventGuardReader;
    plan: CompiledDemoSeed;
  }) {
    this.#authority = options.authority;
    this.#eventReader = options.eventReader;
    this.#plan = options.plan;
  }

  #assertEventGuard(
    request: DemoResetRequest,
    minimumSourceVersion: number | null,
    event: DemoEventGuard | null,
  ): DemoEventGuard {
    if (!event?.isDemo) {
      throw new DemoResetError(
        "not_demo",
        "Demo reset is not available for this event.",
      );
    }
    if (
      event.organizationId !== request.organizationId ||
      event.eventId !== request.eventId ||
      !Number.isInteger(event.sourceVersion) ||
      event.sourceVersion < 0 ||
      (minimumSourceVersion !== null &&
        event.sourceVersion < minimumSourceVersion)
    ) {
      throw new DemoResetError(
        "invalid_target",
        "Demo reset guard returned a different event target.",
      );
    }
    return event;
  }

  async #activeOrganizationIds(): Promise<readonly string[]> {
    const organizationIds = await this.#eventReader.activeOrganizationIds();
    const sorted = [...new Set(organizationIds)].sort(compareCanonicalStrings);
    if (
      !sorted.includes(this.#plan.organizationId) ||
      sorted.length !== organizationIds.length ||
      sorted.some(
        (organizationId, index) => organizationId !== organizationIds[index],
      )
    ) {
      throw new DemoResetError(
        "authority_unavailable",
        "Demo authority returned an invalid active tenant roster.",
      );
    }
    return sorted;
  }

  async #synchronize(organizationIds?: readonly string[]): Promise<void> {
    try {
      await this.#authority.synchronizeFull(
        organizationIds ?? (await this.#activeOrganizationIds()),
      );
    } catch {
      throw new DemoResetError(
        "authority_unavailable",
        "Demo authority did not converge after the reset.",
      );
    }
  }

  async reset(request: DemoResetRequest): Promise<DemoSeedAuthorityReceipt> {
    if (
      !stableAuditIdPattern.test(request.actor.id) ||
      !stableAuditIdPattern.test(request.requestId)
    ) {
      throw new DemoResetError(
        "invalid_audit_context",
        "Demo reset requires stable actor and request identifiers.",
      );
    }
    if (
      !request.actor.permissions.includes("organization:manage") ||
      request.actor.organizationId !== request.organizationId
    ) {
      throw new DemoResetError(
        "not_privileged",
        "Demo reset requires an organization owner.",
      );
    }
    if (request.confirmation !== this.#plan.resetPhrase) {
      throw new DemoResetError(
        "invalid_confirmation",
        "Demo reset confirmation did not match.",
      );
    }
    if (
      request.organizationId !== this.#plan.organizationId ||
      request.eventId !== this.#plan.eventId
    ) {
      throw new DemoResetError(
        "invalid_target",
        "Demo reset target does not match the compiled seed.",
      );
    }

    const existingRun =
      (await this.#authority.inspectDemoEventReplacement?.(
        request.organizationId,
        request.requestId,
      )) ?? null;
    if (
      existingRun &&
      (existingRun.actorId !== request.actor.id ||
        existingRun.organizationId !== request.organizationId ||
        existingRun.eventId !== request.eventId ||
        existingRun.resetRunId !== request.requestId ||
        existingRun.snapshotId !== this.#plan.snapshotId ||
        existingRun.digest !== this.#plan.digest ||
        existingRun.operationCount !== this.#plan.operations.length)
    ) {
      throw new DemoResetError(
        "idempotency_conflict",
        "Demo reset idempotency key conflicts with durable state.",
      );
    }

    let synchronizedExistingRun = false;
    let event = await this.#eventReader.read(
      request.organizationId,
      request.eventId,
    );
    if (!event && existingRun) {
      await this.#synchronize();
      synchronizedExistingRun = true;
      event = await this.#eventReader.read(
        request.organizationId,
        request.eventId,
      );
    }
    const guardedEvent = this.#assertEventGuard(
      request,
      existingRun?.expectedSourceVersion ?? null,
      event,
    );
    const activeOrganizationIds = await this.#activeOrganizationIds();

    const blockers = demoAuthorityBlockers(
      this.#plan,
      await this.#authority.capabilities(),
    );
    if (blockers.length > 0) {
      throw new DemoResetError(
        "authority_unavailable",
        `Demo authority is not ready: ${blockers.join("; ")}.`,
      );
    }

    const receipt = await this.#authority.replaceDemoEvent({
      actorId: request.actor.id,
      expectedSourceVersion:
        existingRun?.expectedSourceVersion ?? guardedEvent.sourceVersion,
      operation: "demo.snapshot.replace",
      plan: this.#plan,
      requireActiveOwner: true,
      requireAuthoritativeDemo: true,
      resetRunId: request.requestId,
    });
    assertReceipt(this.#plan, request.requestId, receipt);
    if (!existingRun?.receiptAvailable || !synchronizedExistingRun) {
      await this.#synchronize(activeOrganizationIds);
      this.#assertEventGuard(
        request,
        existingRun?.expectedSourceVersion ?? guardedEvent.sourceVersion,
        await this.#eventReader.read(request.organizationId, request.eventId),
      );
    }
    return receipt;
  }
}

export function requiredDemoTables(
  plan: CompiledDemoSeed,
): readonly DemoAirtableTableKey[] {
  return [...new Set(plan.operations.map(({ table }) => table))].sort(
    compareCanonicalStrings,
  );
}
