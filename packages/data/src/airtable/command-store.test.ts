import { describe, expect, it } from "vitest";

import {
  AirtableCommandStore,
  hashAirtableCommand,
  hashAirtableContent,
  hashAirtableValue,
  type AirtableCommandStoreOptions,
} from "./command-store.js";
import {
  AirtableIdempotencyConflictError,
  AirtableManualEditError,
  AirtableSchemaDriftError,
  AirtableVersionConflictError,
} from "./errors.js";
import type { AirtableSchemaIndex } from "./schema-manager.js";
import { getExpectedTable } from "./schema-definition.js";
import type { AirtableFields, AirtableRecord } from "./types.js";

const eventSpec = getExpectedTable("events");

const schema: AirtableSchemaIndex = {
  tables: new Map([
    [
      "events",
      {
        fieldSpecsByName: new Map(
          eventSpec.fields.map((field) => [field.name.toLowerCase(), field]),
        ),
        fieldsByName: new Map(
          eventSpec.fields.map((field, index) => [
            field.name.toLowerCase(),
            { id: `fld_${index}`, name: field.name, type: field.type },
          ]),
        ),
        id: "tbl_events",
        key: "events",
        name: "Events",
      },
    ],
  ]),
  version: 1,
};

function airtableRecord(
  fields: AirtableFields,
  id = "rec_event",
): AirtableRecord {
  return {
    createdTime: "2026-08-08T00:00:00.000Z",
    fields,
    id,
  };
}

function clientWith(
  options: {
    existing?: AirtableRecord[];
    onUpdate?: (fields: AirtableFields) => void;
    onUpsert?: (fields: AirtableFields) => void;
  } = {},
): AirtableCommandStoreOptions["client"] {
  return {
    listRecords: async <TFields extends AirtableFields>() =>
      (options.existing ?? []) as AirtableRecord<TFields>[],
    updateRecords: async <TFields extends AirtableFields>(
      _table: string,
      records: readonly { fields: Partial<TFields>; id: string }[],
    ) => {
      const fields = records[0]?.fields as TFields;
      options.onUpdate?.(fields);
      return [airtableRecord(fields)] as AirtableRecord<TFields>[];
    },
    upsertRecords: async <TFields extends AirtableFields>(
      _table: string,
      records: readonly { fields: TFields }[],
    ) => {
      const fields = records[0]?.fields as TFields;
      options.onUpsert?.(fields);
      return [airtableRecord(fields)] as AirtableRecord<TFields>[];
    },
  };
}

describe("AirtableCommandStore", () => {
  it("creates by stable ID with source version and command identity", async () => {
    let written: AirtableFields | undefined;
    const store = new AirtableCommandStore({
      client: clientWith({ onUpsert: (fields) => (written = fields) }),
      now: () => new Date("2026-08-08T12:00:00.000Z"),
      schema,
    });

    const result = await store.execute({
      commandId: "cmd_create_event",
      entityId: "evt_summit_2026",
      expectedVersion: 0,
      fields: { Name: "AI Engineer Summit 2026" },
      table: "events",
    });

    expect(written).toMatchObject({
      ID: "evt_summit_2026",
      "Last command ID": "cmd_create_event",
      "Last command hash": expect.stringMatching(/^[a-f0-9]{64}$/),
      Name: "AI Engineer Summit 2026",
      "Source version": 1,
      "Created at": "2026-08-08T12:00:00.000Z",
      "Updated at": "2026-08-08T12:00:00.000Z",
    });
    expect(result).toMatchObject({ replayed: false, sourceVersion: 1 });
  });

  it("returns the original record for an idempotent command replay", async () => {
    const command = {
      commandId: "cmd_create_event",
      entityId: "evt_summit_2026",
      expectedVersion: 0,
      fields: { Name: "AI Engineer Summit 2026" },
      table: "events" as const,
    };
    const existing = airtableRecord({
      ID: "evt_summit_2026",
      "Last command ID": "cmd_create_event",
      "Last command hash": await hashAirtableCommand(command),
      Name: "AI Engineer Summit 2026",
      "Source version": 1,
    });
    const store = new AirtableCommandStore({
      client: clientWith({ existing: [existing] }),
      schema,
    });

    await expect(store.execute(command)).resolves.toMatchObject({
      replayed: true,
      sourceVersion: 1,
    });
  });

  it("rejects an idempotency key reused with a different payload", async () => {
    const original = {
      commandId: "cmd_create_event",
      entityId: "evt_summit_2026",
      expectedVersion: 0,
      fields: { Name: "Original name" },
      table: "events" as const,
    };
    const store = new AirtableCommandStore({
      client: clientWith({
        existing: [
          airtableRecord({
            ID: original.entityId,
            "Last command ID": original.commandId,
            "Last command hash": await hashAirtableCommand(original),
            "Source version": 1,
          }),
        ],
      }),
      schema,
    });

    await expect(
      store.execute({
        ...original,
        fields: { Name: "Different name" },
      }),
    ).rejects.toBeInstanceOf(AirtableIdempotencyConflictError);
  });

  it("rejects stale expected versions", async () => {
    const store = new AirtableCommandStore({
      client: clientWith({
        existing: [
          airtableRecord({
            ID: "evt_summit_2026",
            "Last command ID": "cmd_previous",
            "Source version": 2,
          }),
        ],
      }),
      schema,
    });

    await expect(
      store.execute({
        commandId: "cmd_update_event",
        entityId: "evt_summit_2026",
        expectedVersion: 1,
        fields: { Name: "New name" },
        table: "events",
      }),
    ).rejects.toBeInstanceOf(AirtableVersionConflictError);
  });

  it("increments the source version without replacing created time", async () => {
    let written: AirtableFields | undefined;
    const store = new AirtableCommandStore({
      client: clientWith({
        existing: [
          airtableRecord({
            ID: "evt_summit_2026",
            "Last command ID": "cmd_previous",
            "Source version": 1,
          }),
        ],
        onUpdate: (fields) => (written = fields),
      }),
      schema,
    });

    await store.execute({
      commandId: "cmd_update_event",
      entityId: "evt_summit_2026",
      expectedVersion: 1,
      fields: { Name: "Renamed summit" },
      table: "events",
    });

    expect(written?.["Source version"]).toBe(2);
    expect(written).not.toHaveProperty("Created at");
  });

  it("fails closed on duplicate stable IDs", async () => {
    const existing = airtableRecord({
      ID: "evt_summit_2026",
      "Last command ID": "cmd_previous",
      "Source version": 1,
    });
    const store = new AirtableCommandStore({
      client: clientWith({
        existing: [existing, { ...existing, id: "rec_duplicate" }],
      }),
      schema,
    });

    await expect(
      store.execute({
        commandId: "cmd_update_event",
        entityId: "evt_summit_2026",
        expectedVersion: 1,
        fields: { Name: "Renamed summit" },
        table: "events",
      }),
    ).rejects.toBeInstanceOf(AirtableSchemaDriftError);
  });

  it("prevents callers from overriding command metadata", async () => {
    const store = new AirtableCommandStore({ client: clientWith(), schema });

    await expect(
      store.execute({
        commandId: "cmd_create_event",
        entityId: "evt_summit_2026",
        expectedVersion: 0,
        fields: { "Source version": 99 },
        table: "events",
      }),
    ).rejects.toThrow("managed by the Airtable command store");
  });

  it("rejects non-JSON command values before generating an idempotency hash", async () => {
    await expect(
      hashAirtableValue(new Date("2026-10-15T16:00:00.000Z")),
    ).rejects.toThrow("only JSON objects and arrays");
  });

  it("rejects unknown and type-invalid fields before provider I/O", async () => {
    let reads = 0;
    const client = clientWith();
    const store = new AirtableCommandStore({
      client: {
        ...client,
        listRecords: async () => {
          reads += 1;
          return [];
        },
      },
      schema,
    });

    await expect(
      store.execute({
        commandId: "cmd_unknown_field",
        entityId: "evt_summit_2026",
        expectedVersion: 0,
        fields: { "Reviewer note": "wrong table" },
        table: "events",
      }),
    ).rejects.toThrow("not a managed field on Events");
    await expect(
      store.execute({
        commandId: "cmd_invalid_link",
        entityId: "evt_summit_2026",
        expectedVersion: 0,
        fields: { Organization: "rec_organization" },
        table: "events",
      }),
    ).rejects.toThrow("invalid value for multipleRecordLinks");
    expect(reads).toBe(0);
  });

  it("detects organizer edits made after the last applied command", async () => {
    const originalContent: AirtableFields = {
      ID: "evt_summit_2026",
      Name: "Original name",
    };
    const existing = airtableRecord({
      ...originalContent,
      "Applied content hash": await hashAirtableContent(originalContent, 1),
      "Last command ID": "cmd_create_event",
      "Last command hash": "prior_hash",
      "Source version": 1,
    });
    existing.fields.Name = "Edited directly in Airtable";
    const store = new AirtableCommandStore({
      client: clientWith({ existing: [existing] }),
      schema,
    });

    await expect(
      store.execute({
        commandId: "cmd_update_after_manual_edit",
        entityId: "evt_summit_2026",
        expectedVersion: 1,
        fields: { Name: "App rename" },
        table: "events",
      }),
    ).rejects.toBeInstanceOf(AirtableManualEditError);
  });

  it("detects source-version edits before trusting optimistic concurrency", async () => {
    const originalContent: AirtableFields = {
      ID: "evt_summit_2026",
      Name: "Original name",
    };
    const existing = airtableRecord({
      ...originalContent,
      "Applied content hash": await hashAirtableContent(originalContent, 1),
      "Last command ID": "cmd_create_event",
      "Last command hash": "prior_hash",
      "Source version": 1,
    });
    existing.fields["Source version"] = 2;
    let updates = 0;
    const store = new AirtableCommandStore({
      client: clientWith({
        existing: [existing],
        onUpdate: () => {
          updates += 1;
        },
      }),
      schema,
    });

    await expect(
      store.execute({
        commandId: "cmd_update_after_version_edit",
        entityId: "evt_summit_2026",
        expectedVersion: 2,
        fields: { Name: "App rename" },
        table: "events",
      }),
    ).rejects.toBeInstanceOf(AirtableManualEditError);
    expect(updates).toBe(0);
  });

  it("rejects content-only hashes that do not bind source version", async () => {
    const originalContent: AirtableFields = {
      ID: "evt_summit_2026",
      Name: "Original name",
    };
    let updates = 0;
    const store = new AirtableCommandStore({
      client: clientWith({
        existing: [
          airtableRecord({
            ...originalContent,
            "Applied content hash": await hashAirtableValue(originalContent),
            "Last command ID": "cmd_create_event",
            "Last command hash": "prior_hash",
            "Source version": 2,
          }),
        ],
        onUpdate: () => {
          updates += 1;
        },
      }),
      schema,
    });

    await expect(
      store.execute({
        commandId: "cmd_update_unversioned_hash",
        entityId: "evt_summit_2026",
        expectedVersion: 2,
        fields: { Name: "App rename" },
        table: "events",
      }),
    ).rejects.toBeInstanceOf(AirtableManualEditError);
    expect(updates).toBe(0);
  });

  it("normalizes Airtable's omitted empty cells in content hashes", async () => {
    let written: AirtableFields | undefined;
    const store = new AirtableCommandStore({
      client: clientWith({ onUpsert: (fields) => (written = fields) }),
      schema,
    });

    await store.execute({
      commandId: "cmd_create_empty_values",
      entityId: "evt_empty_values",
      expectedVersion: 0,
      fields: { "Is demo": false, Venue: "" },
      table: "events",
    });
    const omittedContent = { ID: "evt_empty_values" };

    expect(written?.["Applied content hash"]).toBe(
      await hashAirtableContent(omittedContent, 1),
    );
  });

  it("serializes concurrent version checks within one authority instance", async () => {
    const operations: string[] = [];
    let current = airtableRecord({
      ID: "evt_summit_2026",
      "Last command ID": "cmd_previous",
      "Source version": 1,
    });
    const store = new AirtableCommandStore({
      client: {
        listRecords: async <TFields extends AirtableFields>() => {
          operations.push(`read:${current.fields["Source version"]}`);
          return [current] as AirtableRecord<TFields>[];
        },
        updateRecords: async <TFields extends AirtableFields>(
          _table: string,
          records: readonly { fields: Partial<TFields>; id: string }[],
        ) => {
          const fields = records[0]?.fields as TFields;
          operations.push(`write:${fields["Source version"]}`);
          current = airtableRecord(fields);
          return [current] as AirtableRecord<TFields>[];
        },
        upsertRecords: async <TFields extends AirtableFields>() =>
          [] as AirtableRecord<TFields>[],
      },
      schema,
    });

    const first = store.execute({
      commandId: "cmd_update_first",
      entityId: "evt_summit_2026",
      expectedVersion: 1,
      fields: { Name: "First rename" },
      table: "events",
    });
    const second = store.execute({
      commandId: "cmd_update_second",
      entityId: "evt_summit_2026",
      expectedVersion: 1,
      fields: { Name: "Second rename" },
      table: "events",
    });

    await expect(first).resolves.toMatchObject({ sourceVersion: 2 });
    await expect(second).rejects.toBeInstanceOf(AirtableVersionConflictError);
    expect(operations).toEqual(["read:1", "write:2", "read:2"]);
  });
});
