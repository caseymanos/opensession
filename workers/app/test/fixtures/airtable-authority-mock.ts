import { DurableObject } from "cloudflare:workers";
import {
  expectedAirtableSchema,
  type AirtableFields,
} from "@sessionbox-killer/data/airtable/internal";

interface MockRecord {
  createdTime: string;
  fields: AirtableFields;
  id: string;
  table: string;
}

interface MockState {
  ambiguousNextWrite: boolean;
  delayAmbiguousReadback: boolean;
  delayNextReadback: boolean;
  delayNextWrite: boolean;
  hideRecords: boolean;
  mutationCount: number;
  readbackCount: number;
  records: Record<string, MockRecord>;
  webhookPages: Record<string, unknown>;
}

interface StoredState extends Record<string, SqlStorageValue> {
  state_json: string;
}

interface FixtureEnvironment {
  STATE: DurableObjectNamespace<FixtureAirtableState>;
}

interface StateEnvironment {
  readonly fixture?: never;
}

function initialState(): MockState {
  return {
    ambiguousNextWrite: false,
    delayAmbiguousReadback: false,
    delayNextReadback: false,
    delayNextWrite: false,
    hideRecords: false,
    mutationCount: 0,
    readbackCount: 0,
    records: {},
    webhookPages: {},
  };
}

function tableId(key: string): string {
  return `tbl_${key}`;
}

function recordKey(table: string, entityId: string): string {
  return `${table}\u0000${entityId}`;
}

function schemaResponse() {
  return {
    tables: expectedAirtableSchema.tables.map((table) => {
      const fields = table.fields.map((field) => ({
        description: field.description,
        id: `fld_${table.key}_${field.key}`,
        name: field.name,
        type: field.type,
        ...(field.type === "multipleRecordLinks"
          ? { options: { linkedTableId: tableId(field.linkedTable) } }
          : "options" in field
            ? { options: field.options }
            : {}),
      }));
      return {
        description: table.description,
        fields,
        id: tableId(table.key),
        name: table.name,
        primaryFieldId: fields[0]?.id,
      };
    }),
  };
}

function tableFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/v0\/appAuthorityFixture\/tbl_([a-z_]+)$/);
  return match?.[1] ?? null;
}

export class FixtureAirtableState extends DurableObject<StateEnvironment> {
  constructor(ctx: DurableObjectState, env: StateEnvironment) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS mock_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        state_json TEXT NOT NULL CHECK (json_valid(state_json))
      ) STRICT
    `);
    ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO mock_state (singleton, state_json) VALUES (1, ?)",
      JSON.stringify(initialState()),
    );
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/test/reset") {
      this.writeState(initialState());
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/test/seed") {
      const body = (await request.json()) as {
        fields: AirtableFields;
        recordId?: string;
        table: string;
      };
      const state = this.readState();
      const id = String(body.fields.ID ?? "");
      state.records[recordKey(body.table, id)] = {
        createdTime: new Date().toISOString(),
        fields: body.fields,
        id: body.recordId ?? `rec_${body.table}_${id}`,
        table: body.table,
      };
      this.writeState(state);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/test/mutate") {
      const mutated = await this.mutateForTest(await request.json());
      return new Response(null, { status: mutated ? 204 : 404 });
    }
    if (url.pathname === "/test/remove") {
      const body = (await request.json()) as { id: string; table: string };
      const state = this.readState();
      Reflect.deleteProperty(state.records, recordKey(body.table, body.id));
      this.writeState(state);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/test/records") {
      const table = url.searchParams.get("table");
      return Response.json(
        Object.values(this.readState().records).filter(
          (record) => !table || record.table === table,
        ),
      );
    }
    if (url.pathname === "/test/webhook-page") {
      const body = (await request.json()) as { cursor: number; page: unknown };
      const state = this.readState();
      state.webhookPages[String(body.cursor)] = body.page;
      this.writeState(state);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/test/ambiguous-next") {
      const state = this.readState();
      state.ambiguousNextWrite = true;
      this.writeState(state);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/test/ambiguous-delayed-next") {
      const state = this.readState();
      state.ambiguousNextWrite = true;
      state.delayAmbiguousReadback = true;
      this.writeState(state);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/test/delay-next-write") {
      const state = this.readState();
      state.delayNextWrite = true;
      this.writeState(state);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/test/hide-records") {
      const state = this.readState();
      state.hideRecords = true;
      this.writeState(state);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/test/reveal-records") {
      const state = this.readState();
      state.hideRecords = false;
      this.writeState(state);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/test/readback-count") {
      return Response.json({ readbackCount: this.readState().readbackCount });
    }
    if (url.pathname === "/test/stats") {
      const state = this.readState();
      return Response.json({
        mutationCount: state.mutationCount,
        recordCount: Object.keys(state.records).length,
      });
    }
    if (url.pathname.endsWith("/meta/bases/appAuthorityFixture/tables")) {
      return Response.json(schemaResponse());
    }
    if (
      /^\/v0\/bases\/appAuthorityFixture\/webhooks\/[^/]+\/payloads$/.test(
        url.pathname,
      )
    ) {
      const cursor = Number(url.searchParams.get("cursor"));
      return Response.json(
        this.readState().webhookPages[String(cursor)] ?? {
          cursor: cursor + 1,
          mightHaveMore: false,
          payloads: [],
        },
      );
    }
    const table = tableFromPath(url.pathname);
    if (table) {
      if (request.method === "PATCH") return this.writeRecords(request, table);
      if (request.method === "DELETE") return this.deleteRecords(url, table);
      return this.listRecords(url, table);
    }
    return Response.json(
      { error: { type: "FIXTURE_NOT_FOUND" } },
      { status: 404 },
    );
  }

  async mutateForTest(value: unknown): Promise<boolean> {
    const body = value as {
      fields: AirtableFields;
      id: string;
      table: string;
    };
    const state = this.readState();
    const key = recordKey(body.table, body.id);
    const record = state.records[key];
    if (!record) return false;
    state.records[key] = {
      ...record,
      fields: { ...record.fields, ...body.fields },
    };
    this.writeState(state);
    return true;
  }

  private readState(): MockState {
    const row = this.ctx.storage.sql
      .exec<StoredState>(
        "SELECT state_json FROM mock_state WHERE singleton = 1",
      )
      .one();
    return JSON.parse(row.state_json) as MockState;
  }

  private writeState(state: MockState): void {
    this.ctx.storage.sql.exec(
      "UPDATE mock_state SET state_json = ? WHERE singleton = 1",
      JSON.stringify(state),
    );
  }

  private async writeRecords(
    request: Request,
    table: string,
  ): Promise<Response> {
    const body = (await request.json()) as {
      records: { fields: AirtableFields; id?: string }[];
    };
    const state = this.readState();
    state.mutationCount += 1;
    const written = body.records.map((entry) => {
      const entityId = String(entry.fields.ID ?? "");
      const existingEntry = entry.id
        ? Object.entries(state.records).find(
            ([, record]) => record.table === table && record.id === entry.id,
          )
        : undefined;
      const existing =
        existingEntry?.[1] ?? state.records[recordKey(table, entityId)];
      const stableId = String(entry.fields.ID ?? existing?.fields.ID ?? "");
      const key = recordKey(table, stableId);
      const record: MockRecord = {
        createdTime: existing?.createdTime ?? new Date().toISOString(),
        fields: { ...existing?.fields, ...entry.fields },
        id: existing?.id ?? `rec_${table}_${stableId}`,
        table,
      };
      if (existingEntry && existingEntry[0] !== key) {
        Reflect.deleteProperty(state.records, existingEntry[0]);
      }
      state.records[key] = record;
      return record;
    });
    const delayed = state.delayNextWrite;
    state.delayNextWrite = false;
    const ambiguous = state.ambiguousNextWrite;
    state.ambiguousNextWrite = false;
    if (ambiguous) {
      state.delayNextReadback = state.delayAmbiguousReadback;
      state.delayAmbiguousReadback = false;
    }
    this.writeState(state);
    if (delayed) await new Promise((resolve) => setTimeout(resolve, 750));
    return ambiguous
      ? Response.json({}, { status: 200 })
      : Response.json({ records: written });
  }

  private deleteRecords(url: URL, table: string): Response {
    const state = this.readState();
    state.mutationCount += 1;
    const deleted = url.searchParams.getAll("records[]").map((id) => {
      const entry = Object.entries(state.records).find(
        ([, record]) => record.table === table && record.id === id,
      );
      if (entry) Reflect.deleteProperty(state.records, entry[0]);
      return { deleted: true as const, id };
    });
    this.writeState(state);
    return Response.json({ records: deleted });
  }

  private async listRecords(url: URL, table: string): Promise<Response> {
    const state = this.readState();
    state.readbackCount += 1;
    const delayed = state.delayNextReadback;
    state.delayNextReadback = false;
    this.writeState(state);
    if (delayed) await new Promise((resolve) => setTimeout(resolve, 500));
    const current = this.readState();
    const entityId = url.searchParams
      .get("filterByFormula")
      ?.match(/\{ID\} = '([^']+)'/)?.[1];
    const visible = current.hideRecords
      ? []
      : Object.values(current.records).filter(
          (record) =>
            record.table === table &&
            (entityId === undefined || record.fields.ID === entityId),
        );
    return Response.json({ records: visible });
  }
}

export default {
  fetch(request, env): Promise<Response> {
    return env.STATE.getByName("singleton").fetch(request);
  },
} satisfies ExportedHandler<FixtureEnvironment>;
