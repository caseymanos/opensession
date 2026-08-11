import {
  hashAuthorityValue,
  parseBaseAuthorityCommand,
  type AirtableCellValue,
  type AirtableFields,
  type AuthorityResponse,
  type BaseAuthorityCommand,
} from "../authority/types.js";

const stableIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const providerRecordIdPattern = /^rec[A-Za-z0-9_-]{3,127}$/;
const maximumPlanBytes = 1024 * 1_024;
const maximumPlanItems = 400;
const planTables = ["forms", "form_fields", "form_rules"] as const;

export type CfpFormPlanMode = "close" | "publish" | "save";
export type CfpFormPlanTable = (typeof planTables)[number];

export interface CfpFormPlanItemReference {
  readonly itemKey: string;
  readonly kind: "plan_item_record";
}

export interface CfpFormProviderRecordReference {
  readonly kind: "provider_record";
  readonly recordId: string;
}

export type CfpFormPlanFieldValue =
  AirtableCellValue | CfpFormPlanItemReference | CfpFormProviderRecordReference;

export interface CfpFormPlanItem {
  readonly entityId: string;
  readonly expectedVersion: number;
  readonly fields: Readonly<Record<string, CfpFormPlanFieldValue>>;
  readonly itemKey: string;
  readonly table: CfpFormPlanTable;
}

export interface CfpFormPlanInput {
  readonly actorId: string;
  readonly eventId: string;
  readonly expectedFormId: string;
  readonly expectedSourceVersion: number;
  readonly formId: string;
  readonly items: readonly CfpFormPlanItem[];
  readonly mode: CfpFormPlanMode;
  readonly operation: "cfp.form.persist";
  readonly organizationId: string;
  readonly planId: string;
  readonly requestHash: string;
}

export interface CfpFormPlanReceipt {
  readonly formId: string;
  readonly itemCount: number;
  readonly mode: CfpFormPlanMode;
  readonly outcome: "applied" | "replayed";
  readonly planId: string;
  readonly providerRecordId: string;
  readonly sourceVersion: number;
}

export interface CfpFormPlanInspection {
  readonly completedItems: number;
  readonly formId: string;
  readonly itemCount: number;
  readonly mode: CfpFormPlanMode;
  readonly planId: string;
  readonly state: "applying" | "complete" | "received" | "rejected";
}

interface PlanRow extends Record<string, SqlStorageValue> {
  failure_json: string | null;
  form_id: string;
  item_count: number;
  mode: CfpFormPlanMode;
  plan_json: string;
  receipt_json: string | null;
  request_hash: string;
  state: CfpFormPlanInspection["state"];
}

interface PlanItemRow extends Record<string, SqlStorageValue> {
  item_key: string;
  materialized_command_json: string | null;
  provider_record_id: string | null;
  result_json: string | null;
  state: "complete" | "materialized" | "pending";
  table_key: CfpFormPlanTable;
}

const allowedFields: Readonly<Record<CfpFormPlanTable, ReadonlySet<string>>> = {
  form_fields: new Set([
    "Form",
    "Stable key",
    "Order",
    "Block type",
    "Label",
    "Help",
    "Required",
    "Options JSON",
    "Validation JSON",
  ]),
  form_rules: new Set([
    "Form",
    "Target field",
    "Effect",
    "Source field",
    "Operator",
    "Value JSON",
    "Order",
  ]),
  forms: new Set([
    "Event",
    "Name",
    "Status",
    "Version",
    "Welcome content",
    "Submission limit",
    "Edit after close",
    "Published at",
  ]),
};

const requiredCreateFields: Readonly<
  Record<CfpFormPlanTable, readonly string[]>
> = {
  form_fields: [
    "Form",
    "Stable key",
    "Order",
    "Block type",
    "Label",
    "Required",
    "Options JSON",
    "Validation JSON",
  ],
  form_rules: [
    "Form",
    "Target field",
    "Effect",
    "Source field",
    "Operator",
    "Value JSON",
    "Order",
  ],
  forms: [
    "Event",
    "Name",
    "Status",
    "Version",
    "Welcome content",
    "Edit after close",
  ],
};

const linkTargets: Readonly<
  Record<
    CfpFormPlanTable,
    Readonly<Record<string, CfpFormPlanTable | "events">>
  >
> = {
  form_fields: { Form: "forms" },
  form_rules: {
    Form: "forms",
    "Source field": "form_fields",
    "Target field": "form_fields",
  },
  forms: { Event: "events" },
};

const numericFields = new Set(["Order", "Submission limit", "Version"]);
const booleanFields = new Set(["Edit after close", "Required"]);
const nullableFields: Readonly<Record<CfpFormPlanTable, ReadonlySet<string>>> =
  {
    form_fields: new Set(["Help"]),
    form_rules: new Set(),
    forms: new Set(["Published at", "Submission limit"]),
  };
const jsonFields = new Set(["Options JSON", "Validation JSON", "Value JSON"]);

export class CfpFormPlanIdempotencyConflictError extends Error {
  constructor(planId: string) {
    super(`CFP form plan ${planId} was already used differently.`);
    this.name = "CfpFormPlanIdempotencyConflictError";
  }
}

export class CfpFormPlanPreconditionError extends Error {
  readonly actualFormId: string;
  readonly actualSourceVersion: number;

  constructor(actualFormId: string, actualSourceVersion: number) {
    super("The CFP form changed before the mutation could be applied.");
    this.name = "CfpFormPlanPreconditionError";
    this.actualFormId = actualFormId;
    this.actualSourceVersion = actualSourceVersion;
  }
}

export class CfpFormPlanInProgressError extends Error {
  constructor() {
    super("Another CFP form mutation is still being resolved.");
    this.name = "CfpFormPlanInProgressError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertStableId(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !stableIdPattern.test(value)) {
    throw new TypeError(`${label} is not a stable identifier.`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const allowed = new Set(expected);
  if (
    Object.keys(value).length !== allowed.size ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new TypeError(`${label} has unsupported properties.`);
  }
}

function isPlanTable(value: unknown): value is CfpFormPlanTable {
  return (
    typeof value === "string" &&
    (planTables as readonly string[]).includes(value)
  );
}

function isItemReference(value: unknown): value is CfpFormPlanItemReference {
  return (
    isRecord(value) &&
    value.kind === "plan_item_record" &&
    typeof value.itemKey === "string" &&
    Object.keys(value).length === 2
  );
}

function isProviderReference(
  value: unknown,
): value is CfpFormProviderRecordReference {
  return (
    isRecord(value) &&
    value.kind === "provider_record" &&
    typeof value.recordId === "string" &&
    providerRecordIdPattern.test(value.recordId) &&
    Object.keys(value).length === 2
  );
}

function parseScalarField(
  value: unknown,
  table: CfpFormPlanTable,
  field: string,
): AirtableCellValue {
  if (value === null && nullableFields[table].has(field)) return null;
  if (numericFields.has(field)) {
    if (
      !Number.isInteger(value) ||
      Number(value) < (field === "Submission limit" ? 1 : 0) ||
      Number(value) > 1_000_000
    ) {
      throw new TypeError(`${field} must be a valid bounded integer.`);
    }
    return Number(value);
  }
  if (booleanFields.has(field)) {
    if (typeof value !== "boolean") {
      throw new TypeError(`${field} must be a boolean.`);
    }
    return value;
  }
  if (typeof value !== "string" || value.length > 100_000) {
    throw new TypeError(`${field} must be bounded text.`);
  }
  if (jsonFields.has(field)) {
    try {
      JSON.parse(value);
    } catch {
      throw new TypeError(`${field} must contain valid JSON.`);
    }
  }
  return value;
}

function parseItem(value: unknown, index: number): CfpFormPlanItem {
  if (!isRecord(value)) {
    throw new TypeError(`CFP form plan item ${index + 1} is invalid.`);
  }
  assertExactKeys(
    value,
    ["entityId", "expectedVersion", "fields", "itemKey", "table"],
    "CFP form plan item",
  );
  assertStableId(value.itemKey, "CFP form plan item key");
  assertStableId(value.entityId, "CFP form entity ID");
  if (!isPlanTable(value.table)) {
    throw new TypeError("CFP form plan table is not allowed.");
  }
  if (
    !Number.isInteger(value.expectedVersion) ||
    Number(value.expectedVersion) < 0
  ) {
    throw new TypeError("CFP form expected version is invalid.");
  }
  if (!isRecord(value.fields)) {
    throw new TypeError("CFP form plan fields are invalid.");
  }

  const fields: Record<string, CfpFormPlanFieldValue> = {};
  for (const [field, fieldValue] of Object.entries(value.fields)) {
    if (!allowedFields[value.table].has(field)) {
      throw new TypeError(`${field} is not writable on ${value.table}.`);
    }
    if (Object.hasOwn(linkTargets[value.table], field)) {
      if (!isItemReference(fieldValue) && !isProviderReference(fieldValue)) {
        throw new TypeError(`${field} must use a typed record reference.`);
      }
      fields[field] = fieldValue;
    } else {
      fields[field] = parseScalarField(fieldValue, value.table, field);
    }
  }
  if (Number(value.expectedVersion) === 0) {
    for (const field of requiredCreateFields[value.table]) {
      if (!Object.hasOwn(fields, field)) {
        throw new TypeError(`${field} is required on new ${value.table}.`);
      }
      if (
        fields[field] === null ||
        (typeof fields[field] === "string" && fields[field].length === 0)
      ) {
        throw new TypeError(`${field} cannot be empty on new ${value.table}.`);
      }
    }
  }
  return {
    entityId: value.entityId,
    expectedVersion: Number(value.expectedVersion),
    fields,
    itemKey: value.itemKey,
    table: value.table,
  };
}

export function parseCfpFormPlanInput(value: unknown): CfpFormPlanInput {
  if (!isRecord(value)) {
    throw new TypeError("CFP form plan must be an object.");
  }
  assertExactKeys(
    value,
    [
      "actorId",
      "eventId",
      "expectedFormId",
      "expectedSourceVersion",
      "formId",
      "items",
      "mode",
      "operation",
      "organizationId",
      "planId",
      "requestHash",
    ],
    "CFP form plan",
  );
  assertStableId(value.actorId, "CFP form actor ID");
  assertStableId(value.eventId, "CFP form event ID");
  assertStableId(value.expectedFormId, "Expected CFP form ID");
  assertStableId(value.formId, "CFP form ID");
  assertStableId(value.organizationId, "CFP form organization ID");
  assertStableId(value.planId, "CFP form plan ID");
  if (
    !Number.isInteger(value.expectedSourceVersion) ||
    Number(value.expectedSourceVersion) < 1
  ) {
    throw new TypeError("Expected CFP form source version is invalid.");
  }
  if (
    typeof value.requestHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.requestHash)
  ) {
    throw new TypeError("CFP form request hash is invalid.");
  }
  if (value.operation !== "cfp.form.persist") {
    throw new TypeError("CFP form plan operation is invalid.");
  }
  if (!(["close", "publish", "save"] as const).includes(value.mode as never)) {
    throw new TypeError("CFP form plan mode is invalid.");
  }
  if (
    !Array.isArray(value.items) ||
    value.items.length < 1 ||
    value.items.length > maximumPlanItems
  ) {
    throw new TypeError("CFP form plan item count is invalid.");
  }
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength >
    maximumPlanBytes
  ) {
    throw new TypeError("CFP form plan exceeds 1 MiB.");
  }

  const items = value.items.map(parseItem);
  const byKey = new Map<string, CfpFormPlanItem>();
  const entities = new Set<string>();
  for (const item of items) {
    if (byKey.has(item.itemKey)) {
      throw new TypeError("CFP form plan item keys must be unique.");
    }
    const entityKey = `${item.table}\u0000${item.entityId}`;
    if (entities.has(entityKey)) {
      throw new TypeError("CFP form plan entities must be unique.");
    }
    for (const [field, fieldValue] of Object.entries(item.fields)) {
      if (!isItemReference(fieldValue)) continue;
      const dependency = byKey.get(fieldValue.itemKey);
      if (!dependency) {
        throw new TypeError(
          "CFP form plan references must target an earlier item.",
        );
      }
      if (dependency.table !== linkTargets[item.table][field]) {
        throw new TypeError(
          `CFP form ${field} reference targets the wrong table.`,
        );
      }
    }
    byKey.set(item.itemKey, item);
    entities.add(entityKey);
  }

  const target = items.find(
    (item) => item.table === "forms" && item.entityId === value.formId,
  );
  const targetStatus = target?.fields.Status;
  const expectedStatus =
    value.mode === "save"
      ? "draft"
      : value.mode === "publish"
        ? "published"
        : "closed";
  if (!target || targetStatus !== expectedStatus) {
    throw new TypeError("CFP form plan target status does not match its mode.");
  }

  return {
    actorId: value.actorId,
    eventId: value.eventId,
    expectedFormId: value.expectedFormId,
    expectedSourceVersion: Number(value.expectedSourceVersion),
    formId: value.formId,
    items,
    mode: value.mode as CfpFormPlanMode,
    operation: value.operation,
    organizationId: value.organizationId,
    planId: value.planId,
    requestHash: value.requestHash,
  };
}

function parseReceipt(value: string): CfpFormPlanReceipt {
  return JSON.parse(value) as CfpFormPlanReceipt;
}

function parsePreconditionFailure(value: string): {
  actualFormId: string;
  actualSourceVersion: number;
} {
  const failure = JSON.parse(value) as Record<string, unknown>;
  assertStableId(failure.actualFormId, "Rejected CFP form ID");
  if (
    !Number.isInteger(failure.actualSourceVersion) ||
    Number(failure.actualSourceVersion) < 1
  ) {
    throw new Error("Rejected CFP form source version is invalid.");
  }
  return {
    actualFormId: failure.actualFormId,
    actualSourceVersion: Number(failure.actualSourceVersion),
  };
}

export class CfpFormAuthority {
  readonly #execute: (
    command: BaseAuthorityCommand,
  ) => Promise<AuthorityResponse>;
  readonly #storage: DurableObjectStorage;
  readonly #validatePrecondition: (input: CfpFormPlanInput) => Promise<void>;

  constructor(options: {
    execute: (command: BaseAuthorityCommand) => Promise<AuthorityResponse>;
    storage: DurableObjectStorage;
    validatePrecondition: (input: CfpFormPlanInput) => Promise<void>;
  }) {
    this.#execute = options.execute;
    this.#storage = options.storage;
    this.#validatePrecondition = options.validatePrecondition;
  }

  async execute(value: unknown): Promise<CfpFormPlanReceipt> {
    const input = parseCfpFormPlanInput(value);
    const requestHash = await hashAuthorityValue({
      ...input,
      schemaVersion: 1,
    });
    this.persistPlan(input, requestHash);
    const run = this.plan(input.organizationId, input.planId);
    if (!run || run.request_hash !== requestHash) {
      throw new CfpFormPlanIdempotencyConflictError(input.planId);
    }
    if (run.receipt_json) {
      return { ...parseReceipt(run.receipt_json), outcome: "replayed" };
    }
    if (run.failure_json) {
      const failure = parsePreconditionFailure(run.failure_json);
      throw new CfpFormPlanPreconditionError(
        failure.actualFormId,
        failure.actualSourceVersion,
      );
    }
    if (run.state === "received") {
      if (this.hasApplyingPlan(input)) {
        throw new CfpFormPlanInProgressError();
      }
      const prior = this.eventHead(input);
      if (
        prior &&
        (prior.formId !== input.expectedFormId ||
          prior.sourceVersion !== input.expectedSourceVersion)
      ) {
        const error = new CfpFormPlanPreconditionError(
          prior.formId,
          prior.sourceVersion,
        );
        this.rejectPlan(input, error);
        throw error;
      }
      if (!prior) {
        try {
          await this.#validatePrecondition(input);
        } catch (error) {
          if (error instanceof CfpFormPlanPreconditionError) {
            this.rejectPlan(input, error);
          }
          throw error;
        }
      }
    }

    this.setPlanState(input, "applying");
    for (const [index, item] of input.items.entries()) {
      const existing = this.item(input, item.itemKey);
      if (existing?.state === "complete") continue;
      const command = existing?.materialized_command_json
        ? parseBaseAuthorityCommand(
            JSON.parse(existing.materialized_command_json),
          )
        : this.materializeCommand(input, item, index, requestHash);
      const response = await this.#execute(command);
      this.completeItem(input, item, response);
    }

    const target = input.items.find(
      (item) => item.table === "forms" && item.entityId === input.formId,
    );
    if (!target) throw new Error("CFP form plan target is missing.");
    const result = this.item(input, target.itemKey);
    if (
      result?.state !== "complete" ||
      !result.provider_record_id ||
      !result.result_json
    ) {
      throw new Error("CFP form plan is not durably complete.");
    }
    const authority = JSON.parse(result.result_json) as {
      sourceVersion: number;
    };
    const receipt: CfpFormPlanReceipt = {
      formId: input.formId,
      itemCount: input.items.length,
      mode: input.mode,
      outcome: "applied",
      planId: input.planId,
      providerRecordId: result.provider_record_id,
      sourceVersion: authority.sourceVersion,
    };
    this.completePlan(input, receipt);
    return receipt;
  }

  async resume(
    organizationId: string,
    planId: string,
    requestHash: string,
  ): Promise<CfpFormPlanReceipt | null> {
    assertStableId(organizationId, "CFP form organization ID");
    assertStableId(planId, "CFP form plan ID");
    if (!/^[0-9a-f]{64}$/.test(requestHash)) {
      throw new TypeError("CFP form request hash is invalid.");
    }
    const row = this.plan(organizationId, planId);
    if (!row) return null;
    const input = parseCfpFormPlanInput(JSON.parse(row.plan_json));
    if (input.requestHash !== requestHash) {
      throw new CfpFormPlanIdempotencyConflictError(planId);
    }
    return this.execute(input);
  }

  inspect(
    organizationId: string,
    planId: string,
  ): CfpFormPlanInspection | null {
    assertStableId(organizationId, "CFP form organization ID");
    assertStableId(planId, "CFP form plan ID");
    const row = this.plan(organizationId, planId);
    if (!row) return null;
    const completedItems = this.#storage.sql
      .exec<{ count: number }>(
        `SELECT count(*) AS count FROM cfp_form_plan_items
         WHERE organization_id = ? AND plan_id = ? AND state = 'complete'`,
        organizationId,
        planId,
      )
      .one().count;
    return {
      completedItems,
      formId: row.form_id,
      itemCount: row.item_count,
      mode: row.mode,
      planId,
      state: row.failure_json ? "rejected" : row.state,
    };
  }

  async recoverPending(limit = 4): Promise<number> {
    const rows = this.#storage.sql
      .exec<{ plan_json: string }>(
        `SELECT plan_json FROM cfp_form_plans
         WHERE state IN ('received', 'applying')
         ORDER BY updated_at_ms, organization_id, plan_id
         LIMIT ?`,
        limit,
      )
      .toArray();
    let recovered = 0;
    for (const row of rows) {
      try {
        await this.execute(JSON.parse(row.plan_json));
        recovered += 1;
      } catch {
        // The durable plan remains eligible for the next authority alarm.
      }
    }
    return recovered;
  }

  private persistPlan(input: CfpFormPlanInput, requestHash: string): void {
    this.#storage.transactionSync(() => {
      const now = Date.now();
      this.#storage.sql.exec(
        `INSERT INTO cfp_form_plans (
           organization_id, plan_id, event_id, form_id, mode, request_hash,
           plan_json, item_count, state, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)
         ON CONFLICT (organization_id, plan_id) DO NOTHING`,
        input.organizationId,
        input.planId,
        input.eventId,
        input.formId,
        input.mode,
        requestHash,
        JSON.stringify(input),
        input.items.length,
        now,
        now,
      );
      const existing = this.plan(input.organizationId, input.planId);
      if (!existing || existing.request_hash !== requestHash) return;
      for (const [index, item] of input.items.entries()) {
        this.#storage.sql.exec(
          `INSERT INTO cfp_form_plan_items (
             organization_id, plan_id, item_key, item_index, table_key,
             entity_id, state, created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
           ON CONFLICT (organization_id, plan_id, item_key) DO NOTHING`,
          input.organizationId,
          input.planId,
          item.itemKey,
          index,
          item.table,
          item.entityId,
          now,
          now,
        );
      }
    });
  }

  private eventHead(
    input: CfpFormPlanInput,
  ): { formId: string; sourceVersion: number } | null {
    const row = this.#storage.sql
      .exec<{ form_id: string; source_version: number }>(
        `SELECT form_id, source_version
         FROM cfp_form_event_heads
         WHERE organization_id = ? AND event_id = ?`,
        input.organizationId,
        input.eventId,
      )
      .toArray()[0];
    return row
      ? { formId: row.form_id, sourceVersion: row.source_version }
      : null;
  }

  private hasApplyingPlan(input: CfpFormPlanInput): boolean {
    return Boolean(
      this.#storage.sql
        .exec<{ present: number }>(
          `SELECT 1 AS present
           FROM cfp_form_plans
           WHERE organization_id = ? AND event_id = ? AND state = 'applying'
             AND plan_id <> ?
           LIMIT 1`,
          input.organizationId,
          input.eventId,
          input.planId,
        )
        .toArray()[0],
    );
  }

  private materializeCommand(
    input: CfpFormPlanInput,
    item: CfpFormPlanItem,
    index: number,
    requestHash: string,
  ): BaseAuthorityCommand {
    const fields: AirtableFields = {};
    for (const [field, fieldValue] of Object.entries(item.fields)) {
      if (isProviderReference(fieldValue)) {
        fields[field] = [fieldValue.recordId];
      } else if (isItemReference(fieldValue)) {
        const dependency = this.item(input, fieldValue.itemKey);
        if (
          dependency?.state !== "complete" ||
          !dependency.provider_record_id
        ) {
          throw new Error(
            `CFP form dependency ${fieldValue.itemKey} is incomplete.`,
          );
        }
        fields[field] = [dependency.provider_record_id];
      } else {
        fields[field] = fieldValue;
      }
    }
    const command = parseBaseAuthorityCommand({
      audit: {
        action: `cfp.form.${input.mode}`,
        actorId: input.actorId,
        actorType: "user",
        eventId: input.eventId,
        requestId: input.planId,
        safeDiff: {
          formId: input.formId,
          itemKey: item.itemKey,
          mode: input.mode,
          table: item.table,
        },
      },
      commandId: `cfp_form_${requestHash.slice(0, 20)}_${String(index + 1).padStart(3, "0")}`,
      entityId: item.entityId,
      expectedVersion: item.expectedVersion,
      fields,
      operation: `cfp.form.${input.mode}.${item.table}.upsert`,
      organizationId: input.organizationId,
      table: item.table,
    });
    this.#storage.sql.exec(
      `UPDATE cfp_form_plan_items
       SET state = 'materialized', materialized_command_json = ?, updated_at_ms = ?
       WHERE organization_id = ? AND plan_id = ? AND item_key = ?
         AND state = 'pending'`,
      JSON.stringify(command),
      Date.now(),
      input.organizationId,
      input.planId,
      item.itemKey,
    );
    return command;
  }

  private completeItem(
    input: CfpFormPlanInput,
    item: CfpFormPlanItem,
    response: AuthorityResponse,
  ): void {
    this.#storage.sql.exec(
      `UPDATE cfp_form_plan_items
       SET state = 'complete', provider_record_id = ?, result_json = ?,
           updated_at_ms = ?
       WHERE organization_id = ? AND plan_id = ? AND item_key = ?`,
      response.authority.recordId,
      JSON.stringify({ sourceVersion: response.authority.sourceVersion }),
      Date.now(),
      input.organizationId,
      input.planId,
      item.itemKey,
    );
  }

  private completePlan(
    input: CfpFormPlanInput,
    receipt: CfpFormPlanReceipt,
  ): void {
    const now = Date.now();
    this.#storage.transactionSync(() => {
      this.#storage.sql.exec(
        `UPDATE cfp_form_plans
         SET state = 'complete', receipt_json = ?, updated_at_ms = ?,
             completed_at_ms = ?
         WHERE organization_id = ? AND plan_id = ?`,
        JSON.stringify(receipt),
        now,
        now,
        input.organizationId,
        input.planId,
      );
      this.#storage.sql.exec(
        `INSERT INTO cfp_form_event_heads (
           organization_id, event_id, form_id, source_version, plan_id,
           updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (organization_id, event_id) DO UPDATE SET
           form_id = excluded.form_id,
           source_version = excluded.source_version,
           plan_id = excluded.plan_id,
           updated_at_ms = excluded.updated_at_ms`,
        input.organizationId,
        input.eventId,
        receipt.formId,
        receipt.sourceVersion,
        receipt.planId,
        now,
      );
    });
  }

  private setPlanState(
    input: CfpFormPlanInput,
    state: CfpFormPlanInspection["state"],
  ): void {
    this.#storage.sql.exec(
      `UPDATE cfp_form_plans SET state = ?, updated_at_ms = ?
       WHERE organization_id = ? AND plan_id = ?`,
      state,
      Date.now(),
      input.organizationId,
      input.planId,
    );
  }

  private rejectPlan(
    input: CfpFormPlanInput,
    error: CfpFormPlanPreconditionError,
  ): void {
    this.#storage.sql.exec(
      `UPDATE cfp_form_plans
       SET state = 'complete', failure_json = ?, updated_at_ms = ?,
           completed_at_ms = ?
       WHERE organization_id = ? AND plan_id = ? AND state = 'received'`,
      JSON.stringify({
        actualFormId: error.actualFormId,
        actualSourceVersion: error.actualSourceVersion,
      }),
      Date.now(),
      Date.now(),
      input.organizationId,
      input.planId,
    );
  }

  private plan(organizationId: string, planId: string): PlanRow | null {
    return (
      this.#storage.sql
        .exec<PlanRow>(
          `SELECT request_hash, plan_json, form_id, mode, item_count, state,
                  receipt_json, failure_json
           FROM cfp_form_plans
           WHERE organization_id = ? AND plan_id = ?`,
          organizationId,
          planId,
        )
        .toArray()[0] ?? null
    );
  }

  private item(input: CfpFormPlanInput, itemKey: string): PlanItemRow | null {
    return (
      this.#storage.sql
        .exec<PlanItemRow>(
          `SELECT item_key, table_key, state, materialized_command_json,
                  provider_record_id, result_json
           FROM cfp_form_plan_items
           WHERE organization_id = ? AND plan_id = ? AND item_key = ?`,
          input.organizationId,
          input.planId,
          itemKey,
        )
        .toArray()[0] ?? null
    );
  }
}
