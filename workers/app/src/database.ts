export type D1QueryExecutor = Pick<D1Database, "batch" | "prepare">;

export interface D1RequestContext {
  readonly env: { readonly DB: Pick<D1Database, "withSession"> };
  get(key: "requestDatabase"): D1DatabaseSession | undefined;
  set(key: "requestDatabase", value: D1DatabaseSession): void;
}

export function requestDatabase(context: D1RequestContext): D1DatabaseSession {
  const existing = context.get("requestDatabase");
  if (existing) return existing;

  const database = context.env.DB.withSession("first-primary");
  context.set("requestDatabase", database);
  return database;
}
