import { describe, expect, it } from "vitest";

import type { AirtableClient } from "./client.js";
import { runAirtableDemoRootBootstrap } from "./demo-root.js";
import { AirtableSchemaDriftError } from "./errors.js";
import {
  expectedAirtableSchema,
  type AirtableFieldSpec,
  type AirtableTableKey,
} from "./schema-definition.js";
import type {
  AirtableBaseSchema,
  AirtableFields,
  AirtableRecord,
} from "./types.js";

function optionsFor(
  field: AirtableFieldSpec,
  tableIds: ReadonlyMap<AirtableTableKey, string>,
): Record<string, unknown> | undefined {
  if (field.type === "multipleRecordLinks") {
    return { linkedTableId: tableIds.get(field.linkedTable) };
  }
  return "options" in field ? field.options : undefined;
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

class MemoryAirtableClient {
  readonly records = new Map<string, AirtableRecord[]>();
  readonly schema = completeSchema();
  writes = 0;

  getBaseSchema(): Promise<AirtableBaseSchema> {
    return Promise.resolve(this.schema);
  }

  listRecords<TFields extends AirtableFields>(
    tableId: string,
    options: { filterByFormula?: string } = {},
  ): Promise<AirtableRecord<TFields>[]> {
    const records = this.records.get(tableId) ?? [];
    const match = options.filterByFormula?.match(/^\{ID\} = '([^']+)'$/);
    return Promise.resolve(
      records.filter(
        (record) => !match || record.fields.ID === match[1],
      ) as AirtableRecord<TFields>[],
    );
  }

  updateRecords<TFields extends AirtableFields>(
    tableId: string,
    updates: readonly { fields: Partial<TFields>; id: string }[],
  ): Promise<AirtableRecord<TFields>[]> {
    this.writes += updates.length;
    const records = this.records.get(tableId) ?? [];
    return Promise.resolve(
      updates.map((update) => {
        const record = records.find(({ id }) => id === update.id);
        if (!record) throw new Error("Missing in-memory Airtable record");
        record.fields = { ...record.fields, ...update.fields };
        return record as AirtableRecord<TFields>;
      }),
    );
  }

  upsertRecords<TFields extends AirtableFields>(
    tableId: string,
    writes: readonly { fields: TFields }[],
  ): Promise<AirtableRecord<TFields>[]> {
    this.writes += writes.length;
    const records = this.records.get(tableId) ?? [];
    this.records.set(tableId, records);
    return Promise.resolve(
      writes.map(({ fields }) => {
        const existing = records.find(
          ({ fields: current }) => current.ID === fields.ID,
        );
        if (existing) {
          existing.fields = fields;
          return existing as AirtableRecord<TFields>;
        }
        const record: AirtableRecord<TFields> = {
          createdTime: "2026-08-10T00:00:00.000Z",
          fields,
          id: `rec${String(records.length + 1).padStart(14, "A")}`,
        };
        records.push(record);
        return record;
      }),
    );
  }
}

function asClient(client: MemoryAirtableClient): AirtableClient {
  return client as unknown as AirtableClient;
}

describe("Airtable demo root bootstrap", () => {
  it("creates an empty root once and replays the same command metadata", async () => {
    const client = new MemoryAirtableClient();

    const applied = await runAirtableDemoRootBootstrap(asClient(client));
    const writesAfterApply = client.writes;
    const replayed = await runAirtableDemoRootBootstrap(asClient(client));

    expect(applied).toMatchObject({ outcome: "applied" });
    expect(replayed).toEqual({ ...applied, outcome: "replayed" });
    expect(client.writes).toBe(writesAfterApply);
    expect(applied.organizationRecordId).toMatch(/^rec[A-Za-z0-9]{14}$/);
    expect(applied.eventRecordId).toMatch(/^rec[A-Za-z0-9]{14}$/);
  });

  it.each(["Source version", "Applied content hash", "Last command hash"])(
    "rejects an existing root with tampered %s metadata without writing",
    async (field) => {
      const client = new MemoryAirtableClient();
      await runAirtableDemoRootBootstrap(asClient(client));
      const organizationsTable = client.schema.tables.find(
        ({ name }) => name === "Organizations",
      );
      const organization = organizationsTable
        ? client.records.get(organizationsTable.id)?.[0]
        : undefined;
      if (!organization) throw new Error("Missing organization fixture");
      organization.fields[field] =
        field === "Source version" ? 2 : "0".repeat(64);
      const writesBeforeReplay = client.writes;

      await expect(
        runAirtableDemoRootBootstrap(asClient(client)),
      ).rejects.toThrow();
      expect(client.writes).toBe(writesBeforeReplay);
    },
  );

  it("refuses a foreign root before creating the canonical records", async () => {
    const client = new MemoryAirtableClient();
    const organizationsTable = client.schema.tables.find(
      ({ name }) => name === "Organizations",
    );
    if (!organizationsTable) throw new Error("Missing organization table");
    client.records.set(organizationsTable.id, [
      {
        createdTime: "2026-08-10T00:00:00.000Z",
        fields: { ID: "org_foreign" },
        id: "recFOREIGNROOT001",
      },
    ]);

    await expect(
      runAirtableDemoRootBootstrap(asClient(client)),
    ).rejects.toBeInstanceOf(AirtableSchemaDriftError);
    expect(client.writes).toBe(0);
  });
});
