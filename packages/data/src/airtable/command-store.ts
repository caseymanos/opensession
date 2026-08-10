import type { AirtableClient } from "./client.js";
import {
  AirtableIdempotencyConflictError,
  AirtableManualEditError,
  AirtableResponseError,
  AirtableSchemaDriftError,
  AirtableVersionConflictError,
} from "./errors.js";
import type {
  AirtableSchemaIndex,
  AirtableResolvedTable,
} from "./schema-manager.js";
import type {
  AirtableFieldSpec,
  AirtableTableKey,
} from "./schema-definition.js";
import { getExpectedTable } from "./schema-definition.js";
import type {
  AirtableCellValue,
  AirtableFields,
  AirtableRecord,
} from "./types.js";

const reservedFieldNames = new Set([
  "id",
  "source version",
  "last command id",
  "last command hash",
  "applied content hash",
  "created at",
  "updated at",
]);
const stableIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;

export interface AirtableCommand {
  commandId: string;
  entityId: string;
  expectedVersion: number;
  fields: Readonly<Record<string, AirtableCellValue>>;
  table: AirtableTableKey;
}

export interface AirtableCommandResult {
  entityId: string;
  fields: AirtableFields;
  recordId: string;
  replayed: boolean;
  sourceVersion: number;
}

export interface AirtableCommandStoreOptions {
  client: Pick<
    AirtableClient,
    "listRecords" | "updateRecords" | "upsertRecords"
  >;
  now?: () => Date;
  schema: AirtableSchemaIndex;
}

function assertStableIdentifier(value: string, label: string) {
  if (!stableIdentifierPattern.test(value)) {
    throw new Error(
      `${label} must be 3-128 characters containing only letters, numbers, underscores, and dashes.`,
    );
  }
}

function assertCommandFields(
  table: AirtableResolvedTable,
  fields: Readonly<Record<string, AirtableCellValue>>,
) {
  for (const [name, value] of Object.entries(fields)) {
    const normalizedName = name.trim().toLocaleLowerCase("en-US");
    if (reservedFieldNames.has(normalizedName)) {
      throw new Error(`${name} is managed by the Airtable command store.`);
    }
    const spec = table.fieldSpecsByName.get(normalizedName);
    if (!spec) {
      throw new Error(`${name} is not a managed field on ${table.name}.`);
    }
    assertFieldValue(spec, value);
  }
}

function assertFieldValue(field: AirtableFieldSpec, value: AirtableCellValue) {
  if (value === null) {
    return;
  }

  const invalid = (): never => {
    throw new Error(`${field.name} has an invalid value for ${field.type}.`);
  };

  if (
    field.type === "singleLineText" ||
    field.type === "multilineText" ||
    field.type === "email"
  ) {
    if (typeof value !== "string") invalid();
    return;
  }
  if (field.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) invalid();
    return;
  }
  if (field.type === "checkbox") {
    if (typeof value !== "boolean") invalid();
    return;
  }
  if (field.type === "dateTime") {
    if (
      typeof value !== "string" ||
      !Number.isFinite(Date.parse(value)) ||
      !value.endsWith("Z")
    ) {
      invalid();
    }
    return;
  }
  if (field.type === "multipleRecordLinks") {
    if (
      !Array.isArray(value) ||
      value.some((recordId) =>
        typeof recordId === "string" ? recordId.length === 0 : true,
      )
    ) {
      invalid();
    }
    return;
  }

  if (field.type === "singleSelect" || field.type === "multipleSelects") {
    const choices = new Set(field.options.choices.map((choice) => choice.name));
    if (field.type === "singleSelect") {
      if (typeof value !== "string" || !choices.has(value)) invalid();
      return;
    }
    if (
      !Array.isArray(value) ||
      value.some((choice) =>
        typeof choice === "string" ? !choices.has(choice) : true,
      )
    ) {
      invalid();
    }
    return;
  }
  invalid();
}

function readVersion(record: AirtableRecord): number {
  const value = record.fields["Source version"];
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1) {
    throw new AirtableSchemaDriftError(
      `Airtable record ${record.id} has an invalid Source version.`,
    );
  }
  return value;
}

function toResult(
  record: AirtableRecord,
  entityId: string,
  replayed: boolean,
): AirtableCommandResult {
  return {
    entityId,
    fields: record.fields,
    recordId: record.id,
    replayed,
    sourceVersion: readVersion(record),
  };
}

function idFormula(entityId: string): string {
  return `{ID} = '${entityId}'`;
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Airtable command fields must contain finite numbers.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(
        "Airtable command fields must contain only JSON objects and arrays.",
      );
    }
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right, "en-US"))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new Error("Airtable command fields must be JSON serializable.");
}

async function hashCanonicalValue(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(value)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function hashAirtableValue(value: unknown): Promise<string> {
  return hashCanonicalValue(value);
}

export function hashAirtableContent(
  fields: AirtableFields,
  sourceVersion: number,
): Promise<string> {
  return hashCanonicalValue({ fields, sourceVersion });
}

export function managedAirtableContent(
  tableKey: AirtableTableKey,
  fields: AirtableFields,
): AirtableFields {
  const content: AirtableFields = {};
  for (const spec of getExpectedTable(tableKey).fields) {
    const normalizedName = spec.name.trim().toLocaleLowerCase("en-US");
    if (reservedFieldNames.has(normalizedName)) continue;
    const value = fields[spec.name];
    const empty =
      value === undefined ||
      value === null ||
      value === "" ||
      (Array.isArray(value) && value.length === 0) ||
      (spec.type === "checkbox" && value === false);
    if (!empty) content[spec.name] = value;
  }
  if (fields.ID !== undefined) content.ID = fields.ID;
  return content;
}

export async function hashAirtableCommand(
  command: AirtableCommand,
): Promise<string> {
  return hashCanonicalValue({
    entityId: command.entityId,
    expectedVersion: command.expectedVersion,
    fields: command.fields,
    table: command.table,
  });
}

export class AirtableCommandStore {
  private readonly client: AirtableCommandStoreOptions["client"];
  private commandQueue: Promise<void> = Promise.resolve();
  private readonly now: () => Date;
  private readonly schema: AirtableSchemaIndex;

  constructor(options: AirtableCommandStoreOptions) {
    this.client = options.client;
    this.now = options.now ?? (() => new Date());
    this.schema = options.schema;
  }

  execute(command: AirtableCommand): Promise<AirtableCommandResult> {
    const result = this.commandQueue.then(() =>
      this.executeSerialized(command),
    );
    this.commandQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async executeSerialized(
    command: AirtableCommand,
  ): Promise<AirtableCommandResult> {
    assertStableIdentifier(command.commandId, "Command ID");
    assertStableIdentifier(command.entityId, "Entity ID");

    if (
      !Number.isInteger(command.expectedVersion) ||
      command.expectedVersion < 0
    ) {
      throw new Error("Expected version must be a non-negative integer.");
    }

    const table = this.getTable(command.table);
    assertCommandFields(table, command.fields);
    const commandHash = await hashAirtableCommand(command);
    const existing = await this.findRecord(table, command.entityId);

    if (existing) {
      const actualVersion = readVersion(existing);
      await this.assertAppliedContent(
        table,
        existing,
        command.entityId,
        actualVersion,
      );
      if (existing.fields["Last command ID"] === command.commandId) {
        if (existing.fields["Last command hash"] !== commandHash) {
          throw new AirtableIdempotencyConflictError(
            command.commandId,
            command.entityId,
          );
        }
        return toResult(existing, command.entityId, true);
      }
      if (actualVersion !== command.expectedVersion) {
        throw new AirtableVersionConflictError(
          command.entityId,
          command.expectedVersion,
          actualVersion,
        );
      }

      const [updated] = await this.client.updateRecords(table.id, [
        {
          fields: await this.fieldsForWrite(
            table,
            command,
            commandHash,
            actualVersion + 1,
            false,
            existing.fields,
          ),
          id: existing.id,
        },
      ]);
      if (!updated) {
        throw new AirtableResponseError("update authoritative record");
      }
      return toResult(updated, command.entityId, false);
    }

    if (command.expectedVersion !== 0) {
      throw new AirtableVersionConflictError(
        command.entityId,
        command.expectedVersion,
        0,
      );
    }

    const [created] = await this.client.upsertRecords(
      table.id,
      [
        {
          fields: await this.fieldsForWrite(
            table,
            command,
            commandHash,
            1,
            true,
          ),
        },
      ],
      ["ID"],
    );
    if (!created) {
      throw new AirtableResponseError("create authoritative record");
    }
    return toResult(created, command.entityId, false);
  }

  private async fieldsForWrite(
    table: AirtableResolvedTable,
    command: AirtableCommand,
    commandHash: string,
    sourceVersion: number,
    includeCreatedAt: boolean,
    existingFields: AirtableFields = {},
  ): Promise<AirtableFields> {
    const timestamp = this.now().toISOString();
    const content = this.contentFields(table, {
      ...existingFields,
      ...command.fields,
      ID: command.entityId,
    });
    return {
      ...command.fields,
      ID: command.entityId,
      "Applied content hash": await hashAirtableContent(content, sourceVersion),
      "Last command hash": commandHash,
      "Last command ID": command.commandId,
      "Source version": sourceVersion,
      ...(includeCreatedAt ? { "Created at": timestamp } : {}),
      "Updated at": timestamp,
    };
  }

  private async assertAppliedContent(
    table: AirtableResolvedTable,
    record: AirtableRecord,
    entityId: string,
    sourceVersion: number,
  ): Promise<void> {
    const appliedHash = record.fields["Applied content hash"];
    if (appliedHash === undefined) {
      return;
    }
    if (
      typeof appliedHash !== "string" ||
      appliedHash !==
        (await hashAirtableContent(
          this.contentFields(table, record.fields),
          sourceVersion,
        ))
    ) {
      throw new AirtableManualEditError(entityId);
    }
  }

  private contentFields(
    table: AirtableResolvedTable,
    fields: AirtableFields,
  ): AirtableFields {
    return managedAirtableContent(table.key, fields);
  }

  private async findRecord(
    table: AirtableResolvedTable,
    entityId: string,
  ): Promise<AirtableRecord | null> {
    const records = await this.client.listRecords(table.id, {
      filterByFormula: idFormula(entityId),
      maxRecords: 2,
      pageSize: 2,
    });

    if (records.length > 1) {
      throw new AirtableSchemaDriftError(
        `Airtable table ${table.name} contains duplicate ID ${entityId}.`,
      );
    }
    return records[0] ?? null;
  }

  private getTable(key: AirtableTableKey): AirtableResolvedTable {
    const table = this.schema.tables.get(key);
    if (!table) {
      throw new AirtableSchemaDriftError(
        `Airtable schema does not contain table ${key}.`,
      );
    }
    return table;
  }
}
