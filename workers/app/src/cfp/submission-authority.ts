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
const maximumPlanBytes = 512 * 1_024;
const maximumPlanItems = 160;

const planTables = [
  "contacts",
  "submissions",
  "submission_answers",
  "submission_participants",
] as const;

export type CfpSubmissionPlanTable = (typeof planTables)[number];
export type CfpSubmissionPlanMode = "draft" | "submit";

export interface CfpSubmissionPlanItemReference {
  readonly itemKey: string;
  readonly kind: "plan_item_record";
}

export interface CfpSubmissionProviderRecordReference {
  readonly kind: "provider_record";
  readonly recordId: string;
}

export type CfpSubmissionPlanFieldValue =
  | AirtableCellValue
  | CfpSubmissionPlanItemReference
  | CfpSubmissionProviderRecordReference;

export interface CfpSubmissionPlanItem {
  readonly entityId: string;
  readonly expectedVersion: number;
  readonly fields: Readonly<Record<string, CfpSubmissionPlanFieldValue>>;
  readonly itemKey: string;
  readonly table: CfpSubmissionPlanTable;
}

export interface CfpSubmissionPlanInput {
  readonly actorId: string;
  readonly eventId: string;
  readonly items: readonly CfpSubmissionPlanItem[];
  readonly mode: CfpSubmissionPlanMode;
  readonly operation: "cfp.submission.persist";
  readonly organizationId: string;
  readonly planId: string;
  readonly requestHash: string;
  readonly submissionId: string;
}

export interface CfpSubmissionPlanReceipt {
  readonly itemCount: number;
  readonly mode: CfpSubmissionPlanMode;
  readonly outcome: "applied" | "replayed";
  readonly planId: string;
  readonly providerRecordId: string;
  readonly sourceVersion: number;
  readonly submissionId: string;
}

export interface CfpSubmissionPlanInspection {
  readonly completedItems: number;
  readonly itemCount: number;
  readonly mode: CfpSubmissionPlanMode;
  readonly planId: string;
  readonly state: "applying" | "complete" | "received";
  readonly submissionId: string;
}

interface PlanRow extends Record<string, SqlStorageValue> {
  item_count: number;
  mode: CfpSubmissionPlanMode;
  plan_json: string;
  receipt_json: string | null;
  request_hash: string;
  state: CfpSubmissionPlanInspection["state"];
  submission_id: string;
}

interface PlanItemRow extends Record<string, SqlStorageValue> {
  item_key: string;
  materialized_command_json: string | null;
  provider_record_id: string | null;
  result_json: string | null;
  state: "complete" | "materialized" | "pending";
  table_key: CfpSubmissionPlanTable;
}

const allowedFields: Readonly<
  Record<CfpSubmissionPlanTable, ReadonlySet<string>>
> = {
  contacts: new Set([
    "Organization",
    "Email normalized",
    "Display name",
    "First name",
    "Last name",
    "Pronouns",
    "Title",
    "Company",
    "Bio",
    "Headshot object key",
    "Social JSON",
  ]),
  submissions: new Set([
    "Event",
    "Form",
    "Form version",
    "Friendly ID",
    "Submitter contact",
    "Title",
    "Track",
    "Status",
    "Route key",
    "Draft JSON",
    "Default reviewer group ID",
    "Submitted at",
  ]),
  submission_answers: new Set([
    "Submission",
    "Field stable key",
    "Field label snapshot",
    "Type",
    "Value JSON",
    "Order",
  ]),
  submission_participants: new Set([
    "Submission",
    "Contact",
    "Role",
    "Order",
    "Is primary",
  ]),
};

const requiredFields: Readonly<
  Record<CfpSubmissionPlanTable, readonly string[]>
> = {
  contacts: ["Organization", "Email normalized", "Display name"],
  submissions: [
    "Event",
    "Form",
    "Form version",
    "Friendly ID",
    "Submitter contact",
    "Title",
    "Status",
    "Draft JSON",
  ],
  submission_answers: [
    "Submission",
    "Field stable key",
    "Field label snapshot",
    "Type",
    "Value JSON",
    "Order",
  ],
  submission_participants: [
    "Submission",
    "Contact",
    "Role",
    "Order",
    "Is primary",
  ],
};

const linkTargets: Readonly<
  Record<CfpSubmissionPlanTable, Readonly<Record<string, string>>>
> = {
  contacts: { Organization: "organizations" },
  submissions: {
    Event: "events",
    Form: "forms",
    "Submitter contact": "contacts",
    Track: "tracks",
  },
  submission_answers: { Submission: "submissions" },
  submission_participants: {
    Contact: "contacts",
    Submission: "submissions",
  },
};

const numericFields = new Set(["Form version", "Order"]);
const booleanFields = new Set(["Is primary"]);
const nullableFields: Readonly<
  Record<CfpSubmissionPlanTable, ReadonlySet<string>>
> = {
  contacts: new Set(["Title"]),
  submissions: new Set([
    "Default reviewer group ID",
    "Route key",
    "Submitted at",
    "Track",
  ]),
  submission_answers: new Set(),
  submission_participants: new Set(),
};

export class CfpSubmissionPlanIdempotencyConflictError extends Error {
  constructor(planId: string) {
    super(`CFP submission plan ${planId} was already used differently.`);
    this.name = "CfpSubmissionPlanIdempotencyConflictError";
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

function isPlanTable(value: unknown): value is CfpSubmissionPlanTable {
  return (
    typeof value === "string" &&
    (planTables as readonly string[]).includes(value)
  );
}

function isItemReference(
  value: unknown,
): value is CfpSubmissionPlanItemReference {
  return (
    isRecord(value) &&
    value.kind === "plan_item_record" &&
    typeof value.itemKey === "string" &&
    Object.keys(value).length === 2
  );
}

function isProviderReference(
  value: unknown,
): value is CfpSubmissionProviderRecordReference {
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
  table: CfpSubmissionPlanTable,
  field: string,
): AirtableCellValue {
  if (value === null && nullableFields[table].has(field)) return null;
  if (numericFields.has(field)) {
    if (
      !Number.isInteger(value) ||
      Number(value) < (field === "Form version" ? 1 : 0) ||
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
  if (["Draft JSON", "Social JSON", "Value JSON"].includes(field)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new TypeError(`${field} must contain valid JSON.`);
    }
    if (
      (field === "Draft JSON" || field === "Social JSON") &&
      (!isRecord(parsed) || Array.isArray(parsed))
    ) {
      throw new TypeError(`${field} must contain a JSON object.`);
    }
  }
  return value;
}

function parseItem(value: unknown, index: number): CfpSubmissionPlanItem {
  if (!isRecord(value)) {
    throw new TypeError(`CFP submission plan item ${index + 1} is invalid.`);
  }
  assertExactKeys(
    value,
    ["entityId", "expectedVersion", "fields", "itemKey", "table"],
    "CFP submission plan item",
  );
  assertStableId(value.itemKey, "CFP submission plan item key");
  assertStableId(value.entityId, "CFP submission entity ID");
  if (!isPlanTable(value.table)) {
    throw new TypeError("CFP submission plan table is not allowed.");
  }
  if (
    !Number.isInteger(value.expectedVersion) ||
    Number(value.expectedVersion) < 0
  ) {
    throw new TypeError("CFP submission expected version is invalid.");
  }
  if (!isRecord(value.fields)) {
    throw new TypeError("CFP submission plan fields are invalid.");
  }

  const fields: Record<string, CfpSubmissionPlanFieldValue> = {};
  for (const [field, fieldValue] of Object.entries(value.fields)) {
    if (!allowedFields[value.table].has(field)) {
      throw new TypeError(`${field} is not writable on ${value.table}.`);
    }
    if (Object.hasOwn(linkTargets[value.table], field)) {
      if (
        fieldValue !== null &&
        !isItemReference(fieldValue) &&
        !isProviderReference(fieldValue)
      ) {
        throw new TypeError(`${field} must use a typed record reference.`);
      }
      if (fieldValue === null && !nullableFields[value.table].has(field)) {
        throw new TypeError(`${field} cannot be cleared.`);
      }
      fields[field] = fieldValue;
    } else {
      fields[field] = parseScalarField(fieldValue, value.table, field);
    }
  }
  for (const field of requiredFields[value.table]) {
    if (!Object.hasOwn(fields, field)) {
      throw new TypeError(`${field} is required on ${value.table}.`);
    }
    if (
      fields[field] === null ||
      (typeof fields[field] === "string" && fields[field].length === 0)
    ) {
      throw new TypeError(`${field} cannot be empty on ${value.table}.`);
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

export function parseCfpSubmissionPlanInput(
  value: unknown,
): CfpSubmissionPlanInput {
  if (!isRecord(value)) {
    throw new TypeError("CFP submission plan must be an object.");
  }
  assertExactKeys(
    value,
    [
      "actorId",
      "eventId",
      "items",
      "mode",
      "operation",
      "organizationId",
      "planId",
      "requestHash",
      "submissionId",
    ],
    "CFP submission plan",
  );
  assertStableId(value.actorId, "CFP submission actor ID");
  assertStableId(value.eventId, "CFP submission event ID");
  assertStableId(value.organizationId, "CFP submission organization ID");
  assertStableId(value.planId, "CFP submission plan ID");
  assertStableId(value.submissionId, "CFP submission ID");
  if (
    typeof value.requestHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.requestHash)
  ) {
    throw new TypeError("CFP submission request hash is invalid.");
  }
  if (value.operation !== "cfp.submission.persist") {
    throw new TypeError("CFP submission plan operation is invalid.");
  }
  if (value.mode !== "draft" && value.mode !== "submit") {
    throw new TypeError("CFP submission plan mode is invalid.");
  }
  if (
    !Array.isArray(value.items) ||
    value.items.length < 1 ||
    value.items.length > maximumPlanItems
  ) {
    throw new TypeError("CFP submission plan item count is invalid.");
  }
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength >
    maximumPlanBytes
  ) {
    throw new TypeError("CFP submission plan exceeds 512 KiB.");
  }

  const items = value.items.map(parseItem);
  const byKey = new Map<string, CfpSubmissionPlanItem>();
  const entities = new Set<string>();
  for (const item of items) {
    if (byKey.has(item.itemKey)) {
      throw new TypeError("CFP submission plan item keys must be unique.");
    }
    const entityKey = `${item.table}\u0000${item.entityId}`;
    if (entities.has(entityKey)) {
      throw new TypeError("CFP submission plan entities must be unique.");
    }
    for (const [field, fieldValue] of Object.entries(item.fields)) {
      if (!isItemReference(fieldValue)) continue;
      const dependency = byKey.get(fieldValue.itemKey);
      if (!dependency) {
        throw new TypeError(
          "CFP submission plan references must target an earlier item.",
        );
      }
      if (dependency.table !== linkTargets[item.table][field]) {
        throw new TypeError(
          `CFP submission ${field} reference targets the wrong table.`,
        );
      }
    }
    byKey.set(item.itemKey, item);
    entities.add(entityKey);
  }

  const contacts = items.filter((item) => item.table === "contacts");
  const answers = items.filter((item) => item.table === "submission_answers");
  const participants = items.filter(
    (item) => item.table === "submission_participants",
  );
  if (contacts.length > 8 || answers.length > 128 || participants.length > 8) {
    throw new TypeError("CFP submission plan table limits are invalid.");
  }
  for (const item of [...answers, ...participants]) {
    if (!isItemReference(item.fields.Submission)) {
      throw new TypeError(
        "CFP answers and participants must reference the planned submission.",
      );
    }
  }
  const answerKeys = answers.map((item) => item.fields["Field stable key"]);
  if (new Set(answerKeys).size !== answerKeys.length) {
    throw new TypeError("CFP submission answer keys must be unique.");
  }

  const submissionItems = items.filter((item) => item.table === "submissions");
  if (
    submissionItems.length !== 1 ||
    submissionItems[0]?.entityId !== value.submissionId
  ) {
    throw new TypeError(
      "CFP submission plans require one matching submission item.",
    );
  }
  const submissionFields = submissionItems[0].fields;
  if (
    submissionFields.Status !==
    (value.mode === "submit" ? "submitted" : "draft")
  ) {
    throw new TypeError("CFP submission plan status does not match its mode.");
  }
  if (
    value.mode === "submit" &&
    (["Track", "Route key", "Default reviewer group ID", "Submitted at"].some(
      (field) => !Object.hasOwn(submissionFields, field),
    ) ||
      submissionFields.Track === null)
  ) {
    throw new TypeError("Final CFP submission routing is incomplete.");
  }
  if (
    value.mode === "submit" &&
    [
      submissionFields["Route key"],
      submissionFields["Default reviewer group ID"],
      submissionFields["Submitted at"],
    ].some((field) => typeof field !== "string" || !field.trim())
  ) {
    throw new TypeError("Final CFP submission routing is invalid.");
  }
  if (
    value.mode === "submit" &&
    !Number.isFinite(Date.parse(String(submissionFields["Submitted at"])))
  ) {
    throw new TypeError("Final CFP submission time is invalid.");
  }
  if (
    value.mode === "submit" &&
    (answers.length < 1 ||
      participants.length < 1 ||
      participants.filter((item) => item.fields["Is primary"] === true)
        .length !== 1)
  ) {
    throw new TypeError(
      "Final CFP submissions require answers and one primary participant.",
    );
  }

  return {
    actorId: value.actorId,
    eventId: value.eventId,
    items,
    mode: value.mode,
    operation: value.operation,
    organizationId: value.organizationId,
    planId: value.planId,
    requestHash: value.requestHash,
    submissionId: value.submissionId,
  };
}

function parseReceipt(value: string): CfpSubmissionPlanReceipt {
  return JSON.parse(value) as CfpSubmissionPlanReceipt;
}

export class CfpSubmissionAuthority {
  readonly #execute: (
    command: BaseAuthorityCommand,
  ) => Promise<AuthorityResponse>;
  readonly #onItemCommitted: (
    input: CfpSubmissionPlanInput,
    item: CfpSubmissionPlanItem,
  ) => Promise<void>;
  readonly #storage: DurableObjectStorage;

  constructor(options: {
    execute: (command: BaseAuthorityCommand) => Promise<AuthorityResponse>;
    onItemCommitted?: (
      input: CfpSubmissionPlanInput,
      item: CfpSubmissionPlanItem,
    ) => Promise<void>;
    storage: DurableObjectStorage;
  }) {
    this.#execute = options.execute;
    this.#onItemCommitted =
      options.onItemCommitted ?? (() => Promise.resolve());
    this.#storage = options.storage;
  }

  async execute(value: unknown): Promise<CfpSubmissionPlanReceipt> {
    const input = parseCfpSubmissionPlanInput(value);
    const requestHash = await hashAuthorityValue({
      ...input,
      schemaVersion: 1,
    });
    this.persistPlan(input, requestHash);
    const run = this.plan(input.organizationId, input.planId);
    if (!run || run.request_hash !== requestHash) {
      throw new CfpSubmissionPlanIdempotencyConflictError(input.planId);
    }
    if (run.receipt_json) {
      return { ...parseReceipt(run.receipt_json), outcome: "replayed" };
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
      await this.#onItemCommitted(input, item);
      this.completeItem(input, item, response);
    }

    const submissionItem = input.items.find(
      (item) => item.table === "submissions",
    );
    if (!submissionItem) {
      throw new Error("CFP submission plan is missing its submission item.");
    }
    const result = this.item(input, submissionItem.itemKey);
    if (
      result?.state !== "complete" ||
      !result.provider_record_id ||
      !result.result_json
    ) {
      throw new Error("CFP submission plan is not durably complete.");
    }
    const authority = JSON.parse(result.result_json) as {
      sourceVersion: number;
    };
    const receipt: CfpSubmissionPlanReceipt = {
      itemCount: input.items.length,
      mode: input.mode,
      outcome: "applied",
      planId: input.planId,
      providerRecordId: result.provider_record_id,
      sourceVersion: authority.sourceVersion,
      submissionId: input.submissionId,
    };
    this.completePlan(input, receipt);
    return receipt;
  }

  async resume(
    organizationId: string,
    planId: string,
    requestHash: string,
  ): Promise<CfpSubmissionPlanReceipt | null> {
    assertStableId(organizationId, "CFP submission organization ID");
    assertStableId(planId, "CFP submission plan ID");
    if (!/^[0-9a-f]{64}$/.test(requestHash)) {
      throw new TypeError("CFP submission request hash is invalid.");
    }
    const row = this.plan(organizationId, planId);
    if (!row) return null;
    const input = parseCfpSubmissionPlanInput(JSON.parse(row.plan_json));
    if (input.requestHash !== requestHash) {
      throw new CfpSubmissionPlanIdempotencyConflictError(planId);
    }
    return this.execute(input);
  }

  inspect(
    organizationId: string,
    planId: string,
  ): CfpSubmissionPlanInspection | null {
    assertStableId(organizationId, "CFP submission organization ID");
    assertStableId(planId, "CFP submission plan ID");
    const row = this.plan(organizationId, planId);
    if (!row) return null;
    const completed = this.#storage.sql
      .exec<{ count: number }>(
        `SELECT count(*) AS count FROM cfp_submission_plan_items
         WHERE organization_id = ? AND plan_id = ? AND state = 'complete'`,
        organizationId,
        planId,
      )
      .one().count;
    return {
      completedItems: completed,
      itemCount: row.item_count,
      mode: row.mode,
      planId,
      state: row.state,
      submissionId: row.submission_id,
    };
  }

  private persistPlan(
    input: CfpSubmissionPlanInput,
    requestHash: string,
  ): void {
    this.#storage.transactionSync(() => {
      const now = Date.now();
      this.#storage.sql.exec(
        `INSERT INTO cfp_submission_plans (
           organization_id, plan_id, event_id, submission_id, mode,
           request_hash, plan_json, item_count, state, created_at_ms,
           updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)
         ON CONFLICT (organization_id, plan_id) DO NOTHING`,
        input.organizationId,
        input.planId,
        input.eventId,
        input.submissionId,
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
          `INSERT INTO cfp_submission_plan_items (
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

  private materializeCommand(
    input: CfpSubmissionPlanInput,
    item: CfpSubmissionPlanItem,
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
            `CFP submission dependency ${fieldValue.itemKey} is incomplete.`,
          );
        }
        fields[field] = [dependency.provider_record_id];
      } else {
        fields[field] = fieldValue;
      }
    }
    const command = parseBaseAuthorityCommand({
      audit: {
        action: `cfp.submission.${input.mode}`,
        actorId: input.actorId,
        actorType: "user",
        eventId: input.eventId,
        requestId: input.planId,
        safeDiff: {
          itemKey: item.itemKey,
          mode: input.mode,
          submissionId: input.submissionId,
          table: item.table,
        },
      },
      commandId: `cfp_${requestHash.slice(0, 24)}_${String(index + 1).padStart(3, "0")}`,
      entityId: item.entityId,
      expectedVersion: item.expectedVersion,
      fields,
      operation: `cfp.submission.${input.mode}.${item.table}.upsert`,
      organizationId: input.organizationId,
      table: item.table,
    });
    this.#storage.sql.exec(
      `UPDATE cfp_submission_plan_items
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
    input: CfpSubmissionPlanInput,
    item: CfpSubmissionPlanItem,
    response: AuthorityResponse,
  ): void {
    this.#storage.sql.exec(
      `UPDATE cfp_submission_plan_items
       SET state = 'complete', provider_record_id = ?, result_json = ?,
           updated_at_ms = ?
       WHERE organization_id = ? AND plan_id = ? AND item_key = ?`,
      response.authority.recordId,
      JSON.stringify({
        sourceVersion: response.authority.sourceVersion,
      }),
      Date.now(),
      input.organizationId,
      input.planId,
      item.itemKey,
    );
  }

  private completePlan(
    input: CfpSubmissionPlanInput,
    receipt: CfpSubmissionPlanReceipt,
  ): void {
    this.#storage.sql.exec(
      `UPDATE cfp_submission_plans
       SET state = 'complete', receipt_json = ?, updated_at_ms = ?,
           completed_at_ms = ?
       WHERE organization_id = ? AND plan_id = ?`,
      JSON.stringify(receipt),
      Date.now(),
      Date.now(),
      input.organizationId,
      input.planId,
    );
  }

  private setPlanState(
    input: CfpSubmissionPlanInput,
    state: CfpSubmissionPlanInspection["state"],
  ): void {
    this.#storage.sql.exec(
      `UPDATE cfp_submission_plans SET state = ?, updated_at_ms = ?
       WHERE organization_id = ? AND plan_id = ?`,
      state,
      Date.now(),
      input.organizationId,
      input.planId,
    );
  }

  private plan(organizationId: string, planId: string): PlanRow | null {
    return (
      this.#storage.sql
        .exec<PlanRow>(
          `SELECT request_hash, plan_json, submission_id, mode, item_count,
                  state, receipt_json
           FROM cfp_submission_plans
           WHERE organization_id = ? AND plan_id = ?`,
          organizationId,
          planId,
        )
        .toArray()[0] ?? null
    );
  }

  private item(
    input: CfpSubmissionPlanInput,
    itemKey: string,
  ): PlanItemRow | null {
    return (
      this.#storage.sql
        .exec<PlanItemRow>(
          `SELECT item_key, table_key, state, materialized_command_json,
                  provider_record_id, result_json
           FROM cfp_submission_plan_items
           WHERE organization_id = ? AND plan_id = ? AND item_key = ?`,
          input.organizationId,
          input.planId,
          itemKey,
        )
        .toArray()[0] ?? null
    );
  }
}
