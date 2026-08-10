import type {
  AirtableClient,
  AirtableFieldWrite,
  AirtableTableWrite,
} from "./client.js";
import { AirtableSchemaDriftError } from "./errors.js";
import {
  expectedAirtableSchema,
  type AirtableFieldSpec,
  type AirtableSchemaSpec,
  type AirtableTableKey,
  type AirtableTableSpec,
} from "./schema-definition.js";
import type {
  AirtableBaseSchema,
  AirtableFieldSchema,
  AirtableTableSchema,
} from "./types.js";

export type AirtableSchemaIssueCode =
  | "field_name_mismatch"
  | "field_option_mismatch"
  | "field_type_mismatch"
  | "link_target_mismatch"
  | "missing_field"
  | "missing_select_choice"
  | "missing_table"
  | "primary_field_mismatch"
  | "table_name_mismatch";

export interface AirtableSchemaIssue {
  actual?: string;
  code: AirtableSchemaIssueCode;
  expected?: string;
  field?: string;
  table: string;
}

export interface AirtableSchemaWarning {
  code: "unexpected_field" | "unexpected_table";
  field?: string;
  table: string;
}

export interface AirtableSchemaReport {
  issues: AirtableSchemaIssue[];
  ready: boolean;
  schemaVersion: number;
  summary: {
    actualTables: number;
    expectedFields: number;
    expectedTables: number;
  };
  warnings: AirtableSchemaWarning[];
}

export interface AirtableResolvedTable {
  fieldSpecsByName: ReadonlyMap<string, AirtableFieldSpec>;
  fieldsByName: ReadonlyMap<string, AirtableFieldSchema>;
  id: string;
  key: AirtableTableKey;
  name: string;
}

export interface AirtableSchemaIndex {
  tables: ReadonlyMap<AirtableTableKey, AirtableResolvedTable>;
  version: number;
}

type SchemaClient = Pick<
  AirtableClient,
  "createField" | "createTable" | "getBaseSchema"
>;

const normalizeName = (value: string) =>
  value.trim().toLocaleLowerCase("en-US");

function markerIdentity(description: string | undefined): string | undefined {
  return description
    ?.match(/^OpenSession (?:table|field) · key=([^·]+?)(?: ·|$)/)?.[1]
    ?.trim();
}

function findTable(
  schema: AirtableBaseSchema,
  expected: AirtableTableSpec,
): AirtableTableSchema | undefined {
  const expectedMarker = markerIdentity(expected.description);
  const marked = expectedMarker
    ? schema.tables.find(
        (table) => markerIdentity(table.description) === expectedMarker,
      )
    : undefined;
  if (marked) {
    return marked;
  }

  const name = normalizeName(expected.name);
  return schema.tables.find((table) => normalizeName(table.name) === name);
}

function findField(
  table: AirtableTableSchema,
  expected: AirtableFieldSpec,
): AirtableFieldSchema | undefined {
  const expectedMarker = markerIdentity(expected.description);
  const marked = expectedMarker
    ? table.fields.find(
        (field) => markerIdentity(field.description) === expectedMarker,
      )
    : undefined;
  if (marked) {
    return marked;
  }

  const name = normalizeName(expected.name);
  return table.fields.find((field) => normalizeName(field.name) === name);
}

function getExpectedChoices(field: AirtableFieldSpec): readonly string[] {
  if (field.type !== "singleSelect" && field.type !== "multipleSelects") {
    return [];
  }
  return field.options.choices.map((choice) => choice.name);
}

function getActualChoices(field: AirtableFieldSchema): readonly string[] {
  const choices = field.options?.choices;
  if (!Array.isArray(choices)) {
    return [];
  }

  return choices.flatMap((choice) => {
    if (
      typeof choice === "object" &&
      choice !== null &&
      "name" in choice &&
      typeof choice.name === "string"
    ) {
      return [choice.name];
    }
    return [];
  });
}

function getOptionName(value: unknown): unknown {
  if (typeof value === "object" && value !== null && "name" in value) {
    return value.name;
  }
  return undefined;
}

function compareField(
  expectedTable: AirtableTableSpec,
  expectedField: AirtableFieldSpec,
  actualField: AirtableFieldSchema,
  actualTablesByKey: ReadonlyMap<AirtableTableKey, AirtableTableSchema>,
): AirtableSchemaIssue[] {
  const issues: AirtableSchemaIssue[] = [];

  if (actualField.type !== expectedField.type) {
    issues.push({
      actual: actualField.type,
      code: "field_type_mismatch",
      expected: expectedField.type,
      field: expectedField.name,
      table: expectedTable.name,
    });
    return issues;
  }

  if (expectedField.type === "multipleRecordLinks") {
    const linkedTable = actualTablesByKey.get(expectedField.linkedTable);
    const actualLinkedTableId = actualField.options?.linkedTableId;

    if (!linkedTable || actualLinkedTableId !== linkedTable.id) {
      issues.push({
        actual:
          typeof actualLinkedTableId === "string"
            ? actualLinkedTableId
            : "missing",
        code: "link_target_mismatch",
        expected: linkedTable?.id ?? expectedField.linkedTable,
        field: expectedField.name,
        table: expectedTable.name,
      });
    }
  }

  if (
    expectedField.type === "number" &&
    actualField.options?.precision !== expectedField.options.precision
  ) {
    issues.push({
      actual: String(actualField.options?.precision ?? "missing"),
      code: "field_option_mismatch",
      expected: String(expectedField.options.precision),
      field: expectedField.name,
      table: expectedTable.name,
    });
  }

  if (expectedField.type === "checkbox") {
    for (const option of ["color", "icon"] as const) {
      if (actualField.options?.[option] !== expectedField.options[option]) {
        issues.push({
          actual: String(actualField.options?.[option] ?? "missing"),
          code: "field_option_mismatch",
          expected: expectedField.options[option],
          field: expectedField.name,
          table: expectedTable.name,
        });
      }
    }
  }

  if (expectedField.type === "dateTime") {
    const actualDateFormat = actualField.options?.dateFormat;
    const actualTimeFormat = actualField.options?.timeFormat;
    const actualValues = {
      dateFormat: getOptionName(actualDateFormat),
      timeFormat: getOptionName(actualTimeFormat),
      timeZone: actualField.options?.timeZone,
    };
    const expectedValues = {
      dateFormat: expectedField.options.dateFormat.name,
      timeFormat: expectedField.options.timeFormat.name,
      timeZone: expectedField.options.timeZone,
    };

    for (const option of Object.keys(
      expectedValues,
    ) as (keyof typeof expectedValues)[]) {
      if (actualValues[option] !== expectedValues[option]) {
        issues.push({
          actual: String(actualValues[option] ?? "missing"),
          code: "field_option_mismatch",
          expected: expectedValues[option],
          field: expectedField.name,
          table: expectedTable.name,
        });
      }
    }
  }

  const actualChoices = new Set(
    getActualChoices(actualField).map((choice) => normalizeName(choice)),
  );
  for (const choice of getExpectedChoices(expectedField)) {
    if (!actualChoices.has(normalizeName(choice))) {
      issues.push({
        code: "missing_select_choice",
        expected: choice,
        field: expectedField.name,
        table: expectedTable.name,
      });
    }
  }

  return issues;
}

export function compareAirtableSchema(
  actual: AirtableBaseSchema,
  expected: AirtableSchemaSpec = expectedAirtableSchema,
): AirtableSchemaReport {
  const issues: AirtableSchemaIssue[] = [];
  const warnings: AirtableSchemaWarning[] = [];
  const actualTablesByKey = new Map<AirtableTableKey, AirtableTableSchema>();

  for (const expectedTable of expected.tables) {
    const actualTable = findTable(actual, expectedTable);
    if (actualTable) {
      actualTablesByKey.set(expectedTable.key, actualTable);
    }
  }

  for (const expectedTable of expected.tables) {
    const actualTable = actualTablesByKey.get(expectedTable.key);
    if (!actualTable) {
      issues.push({ code: "missing_table", table: expectedTable.name });
      continue;
    }

    if (normalizeName(actualTable.name) !== normalizeName(expectedTable.name)) {
      issues.push({
        actual: actualTable.name,
        code: "table_name_mismatch",
        expected: expectedTable.name,
        table: expectedTable.name,
      });
    }

    const primaryField = actualTable.fields.find(
      (field) => field.id === actualTable.primaryFieldId,
    );
    if (normalizeName(primaryField?.name ?? "") !== "id") {
      issues.push({
        actual: primaryField?.name ?? "missing",
        code: "primary_field_mismatch",
        expected: "ID",
        table: expectedTable.name,
      });
    }

    for (const expectedField of expectedTable.fields) {
      const actualField = findField(actualTable, expectedField);
      if (!actualField) {
        issues.push({
          code: "missing_field",
          field: expectedField.name,
          table: expectedTable.name,
        });
        continue;
      }
      if (
        normalizeName(actualField.name) !== normalizeName(expectedField.name)
      ) {
        issues.push({
          actual: actualField.name,
          code: "field_name_mismatch",
          expected: expectedField.name,
          field: expectedField.name,
          table: expectedTable.name,
        });
      }
      issues.push(
        ...compareField(
          expectedTable,
          expectedField,
          actualField,
          actualTablesByKey,
        ),
      );
    }

    for (const actualField of actualTable.fields) {
      if (
        !expectedTable.fields.some(
          (expectedField) =>
            findField(actualTable, expectedField)?.id === actualField.id,
        )
      ) {
        warnings.push({
          code: "unexpected_field",
          field: actualField.name,
          table: expectedTable.name,
        });
      }
    }
  }

  for (const actualTable of actual.tables) {
    if (
      !expected.tables.some(
        (expectedTable) =>
          findTable(actual, expectedTable)?.id === actualTable.id,
      )
    ) {
      warnings.push({ code: "unexpected_table", table: actualTable.name });
    }
  }

  return {
    issues,
    ready: issues.length === 0,
    schemaVersion: expected.version,
    summary: {
      actualTables: actual.tables.length,
      expectedFields: expected.tables.reduce(
        (total, table) => total + table.fields.length,
        0,
      ),
      expectedTables: expected.tables.length,
    },
    warnings,
  };
}

function toFieldWrite(
  field: AirtableFieldSpec,
  tables: ReadonlyMap<AirtableTableKey, AirtableTableSchema>,
): AirtableFieldWrite {
  if (field.type === "multipleRecordLinks") {
    const linkedTable = tables.get(field.linkedTable);
    if (!linkedTable) {
      throw new AirtableSchemaDriftError(
        `Cannot create ${field.name}; linked table ${field.linkedTable} is missing.`,
      );
    }
    return {
      ...(field.description ? { description: field.description } : {}),
      name: field.name,
      options: { linkedTableId: linkedTable.id },
      type: field.type,
    };
  }

  return {
    ...(field.description ? { description: field.description } : {}),
    name: field.name,
    ...(field.type === "number" ||
    field.type === "checkbox" ||
    field.type === "dateTime" ||
    field.type === "singleSelect" ||
    field.type === "multipleSelects"
      ? { options: field.options }
      : {}),
    type: field.type,
  };
}

function indexActualTables(
  actual: AirtableBaseSchema,
  expected: AirtableSchemaSpec,
): Map<AirtableTableKey, AirtableTableSchema> {
  const result = new Map<AirtableTableKey, AirtableTableSchema>();
  for (const expectedTable of expected.tables) {
    const actualTable = findTable(actual, expectedTable);
    if (actualTable) {
      result.set(expectedTable.key, actualTable);
    }
  }
  return result;
}

function hasUnsafeDrift(report: AirtableSchemaReport): boolean {
  return report.issues.some(
    (issue) => issue.code !== "missing_field" && issue.code !== "missing_table",
  );
}

export class AirtableSchemaManager {
  private readonly client: SchemaClient;
  private readonly expected: AirtableSchemaSpec;

  constructor(
    client: SchemaClient,
    expected: AirtableSchemaSpec = expectedAirtableSchema,
  ) {
    this.client = client;
    this.expected = expected;
  }

  async check(): Promise<AirtableSchemaReport> {
    return compareAirtableSchema(
      await this.client.getBaseSchema(),
      this.expected,
    );
  }

  async bootstrap(): Promise<AirtableSchemaReport> {
    let actual = await this.client.getBaseSchema();
    const initialReport = compareAirtableSchema(actual, this.expected);

    if (hasUnsafeDrift(initialReport)) {
      throw new AirtableSchemaDriftError(
        "Airtable schema has incompatible fields; bootstrap will not modify existing definitions.",
      );
    }

    let tablesByKey = indexActualTables(actual, this.expected);
    for (const expectedTable of this.expected.tables) {
      if (!tablesByKey.has(expectedTable.key)) {
        const primaryField = expectedTable.fields[0];
        if (!primaryField || primaryField.type === "multipleRecordLinks") {
          throw new AirtableSchemaDriftError(
            `${expectedTable.name} must begin with a non-link primary field.`,
          );
        }
        const write: AirtableTableWrite = {
          description: expectedTable.description,
          fields: [toFieldWrite(primaryField, tablesByKey)],
          name: expectedTable.name,
        };
        await this.client.createTable(write);
      }
    }

    actual = await this.client.getBaseSchema();
    tablesByKey = indexActualTables(actual, this.expected);

    for (const linkPass of [false, true]) {
      for (const expectedTable of this.expected.tables) {
        const actualTable = tablesByKey.get(expectedTable.key);
        if (!actualTable) {
          throw new AirtableSchemaDriftError(
            `Airtable did not return newly created table ${expectedTable.name}.`,
          );
        }

        for (const expectedField of expectedTable.fields.slice(1)) {
          const isLink = expectedField.type === "multipleRecordLinks";
          if (isLink !== linkPass || findField(actualTable, expectedField)) {
            continue;
          }
          await this.client.createField(
            actualTable.id,
            toFieldWrite(expectedField, tablesByKey),
          );
        }
      }

      actual = await this.client.getBaseSchema();
      tablesByKey = indexActualTables(actual, this.expected);
    }

    return compareAirtableSchema(actual, this.expected);
  }
}

export function createAirtableSchemaIndex(
  actual: AirtableBaseSchema,
  expected: AirtableSchemaSpec = expectedAirtableSchema,
): AirtableSchemaIndex {
  const report = compareAirtableSchema(actual, expected);
  if (!report.ready) {
    throw new AirtableSchemaDriftError(
      `Airtable schema v${expected.version} is not ready (${report.issues.length} issue(s)).`,
    );
  }

  const tables = new Map<AirtableTableKey, AirtableResolvedTable>();
  for (const expectedTable of expected.tables) {
    const actualTable = findTable(actual, expectedTable);
    if (!actualTable) {
      throw new AirtableSchemaDriftError(
        `Airtable table ${expectedTable.name} is missing.`,
      );
    }
    tables.set(expectedTable.key, {
      fieldSpecsByName: new Map(
        expectedTable.fields.map((field) => [normalizeName(field.name), field]),
      ),
      fieldsByName: new Map(
        actualTable.fields.map((field) => [normalizeName(field.name), field]),
      ),
      id: actualTable.id,
      key: expectedTable.key,
      name: actualTable.name,
    });
  }

  return { tables, version: expected.version };
}
