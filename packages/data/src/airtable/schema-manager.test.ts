import { describe, expect, it } from "vitest";

import { AirtableSchemaDriftError } from "./errors.js";
import {
  expectedAirtableSchema,
  type AirtableFieldSpec,
  type AirtableTableKey,
} from "./schema-definition.js";
import {
  AirtableSchemaManager,
  compareAirtableSchema,
  createAirtableSchemaIndex,
} from "./schema-manager.js";
import type {
  AirtableBaseSchema,
  AirtableFieldSchema,
  AirtableTableSchema,
} from "./types.js";

function optionsFor(
  field: AirtableFieldSpec,
  tableIds: ReadonlyMap<AirtableTableKey, string>,
): Record<string, unknown> | undefined {
  if (field.type === "multipleRecordLinks") {
    return { linkedTableId: tableIds.get(field.linkedTable) };
  }
  if ("options" in field) {
    return field.options;
  }
  return undefined;
}

function completeSchema(): AirtableBaseSchema {
  const tableIds = new Map(
    expectedAirtableSchema.tables.map((table, index) => [
      table.key,
      `tbl_${index}`,
    ]),
  );

  return {
    tables: expectedAirtableSchema.tables.map((table, tableIndex) => ({
      description: table.description,
      fields: table.fields.map((field, fieldIndex) => ({
        ...(field.description ? { description: field.description } : {}),
        id: `fld_${tableIndex}_${fieldIndex}`,
        name: field.name,
        ...(optionsFor(field, tableIds)
          ? { options: optionsFor(field, tableIds) }
          : {}),
        type: field.type,
      })),
      id: tableIds.get(table.key) ?? `tbl_${tableIndex}`,
      name: table.name,
      primaryFieldId: `fld_${tableIndex}_0`,
    })),
  };
}

describe("Airtable schema", () => {
  it("defines every authoritative table with lifecycle fields", () => {
    expect(expectedAirtableSchema.version).toBe(3);
    expect(expectedAirtableSchema.tables).toHaveLength(29);
    expect(
      expectedAirtableSchema.tables.reduce(
        (count, table) => count + table.fields.length,
        0,
      ),
    ).toBe(428);
    expect(
      expectedAirtableSchema.tables.every(
        (table) =>
          table.fields[0]?.name === "ID" &&
          table.fields.some((field) => field.name === "Source version") &&
          table.fields.some((field) => field.name === "Last command ID") &&
          table.fields.some((field) => field.name === "Last command hash") &&
          table.fields.some((field) => field.name === "Applied content hash") &&
          table.fields.some((field) => field.name === "Updated at"),
      ),
    ).toBe(true);
    expect(
      expectedAirtableSchema.tables.every(
        (table) =>
          new Set(table.fields.map((field) => field.key)).size ===
          table.fields.length,
      ),
    ).toBe(true);
    expect(
      expectedAirtableSchema.tables
        .find(({ key }) => key === "email_templates")
        ?.fields.map(({ name }) => name),
    ).toEqual(
      expect.arrayContaining([
        "Sender name",
        "Sender email",
        "Body document JSON",
        "Body HTML",
        "Body text",
        "Used merge fields JSON",
      ]),
    );
    expect(
      expectedAirtableSchema.tables
        .find(({ key }) => key === "campaigns")
        ?.fields.map(({ name }) => name),
    ).toContain("Template snapshot JSON");
  });

  it("accepts a compatible schema and indexes stable table IDs", () => {
    const schema = completeSchema();
    const report = compareAirtableSchema(schema);
    const index = createAirtableSchemaIndex(schema);

    expect(report).toMatchObject({ ready: true, schemaVersion: 3 });
    expect(report.issues).toEqual([]);
    expect(index.tables.get("events")?.id).toBe("tbl_1");
  });

  it("upgrades the credentialed v1 shape through the additive v3 fields", async () => {
    const newFieldsByTable = new Map<string, ReadonlySet<string>>([
      ["Submissions", new Set(["Draft JSON", "Default reviewer group ID"])],
      [
        "Tracks",
        new Set([
          "CFP selection",
          "CFP aliases JSON",
          "Route key",
          "Submission track",
          "Default reviewer group ID",
        ]),
      ],
      [
        "Email Templates",
        new Set([
          "Sender name",
          "Sender email",
          "Body document JSON",
          "Body text",
          "Used merge fields JSON",
        ]),
      ],
      ["Campaigns", new Set(["Template snapshot JSON"])],
    ]);
    const schema = completeSchema();
    for (const table of schema.tables) {
      table.description = table.description?.replace("schema v3", "schema v1");
      table.fields = table.fields
        .filter((field) => !newFieldsByTable.get(table.name)?.has(field.name))
        .map((field) => ({
          ...field,
          ...(field.description
            ? {
                description: field.description.replace(
                  "schema v3",
                  "schema v1",
                ),
              }
            : {}),
        }));
    }
    const before = compareAirtableSchema(schema);
    const created: string[] = [];
    const manager = new AirtableSchemaManager({
      createField: async (tableId, write) => {
        const table = schema.tables.find(
          (candidate) => candidate.id === tableId,
        );
        if (!table) throw new Error("Missing fixture table");
        const field: AirtableFieldSchema = {
          ...(write.description ? { description: write.description } : {}),
          id: `fld_upgrade_${created.length}`,
          name: write.name,
          ...(write.options ? { options: write.options } : {}),
          type: write.type,
        };
        table.fields.push(field);
        created.push(write.name);
        return field;
      },
      createTable: async () => {
        throw new Error("An additive upgrade does not create tables");
      },
      getBaseSchema: async () => schema,
    });

    expect(before.ready).toBe(false);
    expect(before.issues).toHaveLength(13);
    expect(before.issues).toEqual(
      expect.arrayContaining(
        [...newFieldsByTable].flatMap(([table, fields]) =>
          [...fields].map((field) =>
            expect.objectContaining({ code: "missing_field", field, table }),
          ),
        ),
      ),
    );
    await expect(manager.bootstrap()).resolves.toMatchObject({ ready: true });
    expect(created).toEqual([
      "Draft JSON",
      "Default reviewer group ID",
      "CFP selection",
      "CFP aliases JSON",
      "Route key",
      "Submission track",
      "Default reviewer group ID",
      "Sender name",
      "Sender email",
      "Body document JSON",
      "Body text",
      "Used merge fields JSON",
      "Template snapshot JSON",
    ]);
  });

  it("upgrades the credentialed v2 shape by adding exactly seven v3 fields", async () => {
    const newFieldsByTable = new Map<string, ReadonlySet<string>>([
      ["Submissions", new Set(["Draft JSON", "Default reviewer group ID"])],
      [
        "Tracks",
        new Set([
          "CFP selection",
          "CFP aliases JSON",
          "Route key",
          "Submission track",
          "Default reviewer group ID",
        ]),
      ],
    ]);
    const schema = completeSchema();
    for (const table of schema.tables) {
      table.description = table.description?.replace("schema v3", "schema v2");
      table.fields = table.fields
        .filter((field) => !newFieldsByTable.get(table.name)?.has(field.name))
        .map((field) => ({
          ...field,
          ...(field.description
            ? {
                description: field.description.replace(
                  "schema v3",
                  "schema v2",
                ),
              }
            : {}),
        }));
    }
    const before = compareAirtableSchema(schema);
    const created: string[] = [];
    const manager = new AirtableSchemaManager({
      createField: async (tableId, write) => {
        const table = schema.tables.find(
          (candidate) => candidate.id === tableId,
        );
        if (!table) throw new Error("Missing fixture table");
        const field: AirtableFieldSchema = {
          ...(write.description ? { description: write.description } : {}),
          id: `fld_v3_${created.length}`,
          name: write.name,
          ...(write.options ? { options: write.options } : {}),
          type: write.type,
        };
        table.fields.push(field);
        created.push(write.name);
        return field;
      },
      createTable: async () => {
        throw new Error("v3 does not create tables");
      },
      getBaseSchema: async () => schema,
    });

    expect(before.ready).toBe(false);
    expect(before.issues).toHaveLength(7);
    expect(before.issues).toEqual(
      expect.arrayContaining(
        [...newFieldsByTable].flatMap(([table, fields]) =>
          [...fields].map((field) =>
            expect.objectContaining({ code: "missing_field", field, table }),
          ),
        ),
      ),
    );
    await expect(manager.bootstrap()).resolves.toMatchObject({ ready: true });
    expect(created).toEqual([
      "Draft JSON",
      "Default reviewer group ID",
      "CFP selection",
      "CFP aliases JSON",
      "Route key",
      "Submission track",
      "Default reviewer group ID",
    ]);
  });

  it("reports missing, incompatible, and link-target drift", () => {
    const schema = completeSchema();
    const events = schema.tables.find((table) => table.name === "Events");
    const forms = schema.tables.find((table) => table.name === "Forms");
    if (!events || !forms) throw new Error("Fixture is incomplete");

    events.fields = events.fields.filter((field) => field.name !== "Venue");
    const name = events.fields.find((field) => field.name === "Name");
    if (name) name.type = "number";
    const eventLink = forms.fields.find((field) => field.name === "Event");
    if (eventLink) eventLink.options = { linkedTableId: "tbl_wrong" };

    const report = compareAirtableSchema(schema);

    expect(report.ready).toBe(false);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing_field",
          field: "Venue",
          table: "Events",
        }),
        expect.objectContaining({
          code: "field_type_mismatch",
          field: "Name",
          table: "Events",
        }),
        expect.objectContaining({
          code: "link_target_mismatch",
          field: "Event",
          table: "Forms",
        }),
      ]),
    );
  });

  it("rejects drift in declared number and date-time semantics", () => {
    const schema = completeSchema();
    const criteria = schema.tables.find((table) => table.name === "Criteria");
    const events = schema.tables.find((table) => table.name === "Events");
    const weight = criteria?.fields.find((field) => field.name === "Weight");
    const start = events?.fields.find((field) => field.name === "Start");
    if (!weight || !start) throw new Error("Fixture is incomplete");
    weight.options = { precision: 0 };
    start.options = {
      dateFormat: { name: "local" },
      timeFormat: { name: "12hour" },
      timeZone: "client",
    };

    const report = compareAirtableSchema(schema);

    expect(report.ready).toBe(false);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "field_option_mismatch",
          field: "Weight",
        }),
        expect.objectContaining({
          code: "field_option_mismatch",
          field: "Start",
        }),
      ]),
    );
  });

  it("treats unexpected tables and fields as non-destructive warnings", () => {
    const schema = completeSchema();
    schema.tables[0]?.fields.push({
      id: "fld_custom",
      name: "Organizer custom note",
      type: "multilineText",
    });
    schema.tables.push({
      fields: [{ id: "fld_custom_id", name: "ID", type: "singleLineText" }],
      id: "tbl_custom",
      name: "Organizer Custom Data",
      primaryFieldId: "fld_custom_id",
    });

    const report = compareAirtableSchema(schema);

    expect(report.ready).toBe(true);
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unexpected_field" }),
        expect.objectContaining({ code: "unexpected_table" }),
      ]),
    );
  });

  it("bootstraps only missing tables and fields, with links in a second pass", async () => {
    const schema: AirtableBaseSchema = { tables: [] };
    const operations: string[] = [];
    let fieldSequence = 0;

    const manager = new AirtableSchemaManager({
      createField: async (tableId, write) => {
        const table = schema.tables.find(
          (candidate) => candidate.id === tableId,
        );
        if (!table) throw new Error("Missing fixture table");
        const field: AirtableFieldSchema = {
          ...(write.description ? { description: write.description } : {}),
          id: `fld_created_${fieldSequence++}`,
          name: write.name,
          ...(write.options ? { options: write.options } : {}),
          type: write.type,
        };
        table.fields.push(field);
        operations.push(`field:${write.type}:${write.name}`);
        return field;
      },
      createTable: async (write) => {
        const id = `tbl_created_${schema.tables.length}`;
        const primary: AirtableFieldSchema = {
          ...(write.fields[0]?.description
            ? { description: write.fields[0].description }
            : {}),
          id: `fld_primary_${schema.tables.length}`,
          name: write.fields[0]?.name ?? "ID",
          type: write.fields[0]?.type ?? "singleLineText",
        };
        const table: AirtableTableSchema = {
          ...(write.description ? { description: write.description } : {}),
          fields: [primary],
          id,
          name: write.name,
          primaryFieldId: primary.id,
        };
        schema.tables.push(table);
        operations.push(`table:${write.name}`);
        return table;
      },
      getBaseSchema: async () => schema,
    });

    const report = await manager.bootstrap();
    const firstLink = operations.findIndex((operation) =>
      operation.startsWith("field:multipleRecordLinks"),
    );
    const lastNonLink = operations.findLastIndex(
      (operation) =>
        operation.startsWith("field:") &&
        !operation.startsWith("field:multipleRecordLinks"),
    );

    expect(report.ready).toBe(true);
    expect(schema.tables).toHaveLength(29);
    expect(firstLink).toBeGreaterThan(lastNonLink);
  });

  it("refuses to alter incompatible existing fields", async () => {
    const schema = completeSchema();
    const name = schema.tables[0]?.fields.find(
      (field) => field.name === "Name",
    );
    if (name) name.type = "number";
    let writes = 0;
    const manager = new AirtableSchemaManager({
      createField: async () => {
        writes += 1;
        throw new Error("Should not write");
      },
      createTable: async () => {
        writes += 1;
        throw new Error("Should not write");
      },
      getBaseSchema: async () => schema,
    });

    await expect(manager.bootstrap()).rejects.toBeInstanceOf(
      AirtableSchemaDriftError,
    );
    expect(writes).toBe(0);
  });

  it("detects renamed managed tables and fields without creating duplicates", async () => {
    const schema = completeSchema();
    const events = schema.tables.find((table) => table.name === "Events");
    const venue = events?.fields.find((field) => field.name === "Venue");
    if (!events || !venue) throw new Error("Fixture is incomplete");
    events.name = "Conference Events";
    venue.name = "Location";
    events.description = events.description?.replace("schema v3", "schema v4");
    venue.description = venue.description?.replace("schema v3", "schema v4");

    let writes = 0;
    const manager = new AirtableSchemaManager({
      createField: async () => {
        writes += 1;
        throw new Error("Should not write");
      },
      createTable: async () => {
        writes += 1;
        throw new Error("Should not write");
      },
      getBaseSchema: async () => schema,
    });
    const report = await manager.check();

    expect(report.ready).toBe(false);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actual: "Conference Events",
          code: "table_name_mismatch",
          expected: "Events",
        }),
        expect.objectContaining({
          actual: "Location",
          code: "field_name_mismatch",
          expected: "Venue",
        }),
      ]),
    );
    await expect(manager.bootstrap()).rejects.toBeInstanceOf(
      AirtableSchemaDriftError,
    );
    expect(writes).toBe(0);
  });
});
