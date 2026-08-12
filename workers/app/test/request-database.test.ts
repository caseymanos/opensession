import { describe, expect, it, vi } from "vitest";

import { hasEventPermission, loadEventAccess } from "../src/auth/authorization";
import { AuthService, type AuthError } from "../src/auth/service";
import {
  requestDatabase,
  type D1QueryExecutor,
  type D1RequestContext,
} from "../src/database";

const now = new Date("2026-08-12T18:00:00.000Z");
const token = "primary-consistency-session-token";
const meta = {
  changed_db: false,
  changes: 0,
  duration: 0,
  last_row_id: 0,
  rows_read: 1,
  rows_written: 0,
  size_after: 0,
} satisfies D1Meta;

interface ReplicaView {
  readonly bookmark: string;
  readonly owner: boolean;
  readonly sessionActive: boolean;
}

class ReplicaStatement {
  readonly #query: string;
  readonly #view: ReplicaView;

  constructor(query: string, view: ReplicaView) {
    this.#query = query;
    this.#view = view;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    void values;
    return this;
  }

  async first<T = Record<string, unknown>>(
    columnName?: string,
  ): Promise<T | null> {
    void columnName;
    let row: Record<string, unknown> | null = null;
    if (this.#query.includes("FROM auth_sessions session")) {
      row = this.#view.sessionActive
        ? {
            csrf_token_hash: "csrf-hash",
            display_name: "Owner",
            email_normalized: "owner@example.test",
            expires_at: "2027-08-12T18:00:00.000Z",
            id: "session_owner",
            last_seen_at: now.toISOString(),
            token_hash: "token-hash",
            user_id: "usr_owner",
          }
        : null;
    } else if (this.#query.includes("FROM p_events event_scope")) {
      row = {
        event_role: null,
        organization_role: this.#view.owner ? "owner" : null,
        speaker_contact_id: null,
      };
    }
    return row as T | null;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return { meta, results: [], success: true };
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return { meta, results: [], success: true };
  }

  raw<T = unknown[]>(options: {
    columnNames: true;
  }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: {
    columnNames?: boolean;
  }): Promise<T[] | [string[], ...T[]]> {
    const withColumnNames: [string[]] = [[]];
    return options?.columnNames ? withColumnNames : [];
  }
}

class ReplicaSession {
  readonly #view: ReplicaView;

  constructor(view: ReplicaView) {
    this.#view = view;
  }

  prepare(query: string): D1PreparedStatement {
    return new ReplicaStatement(query, this.#view);
  }

  async batch<T = unknown>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]> {
    return Promise.all(statements.map((statement) => statement.run<T>()));
  }

  getBookmark(): string {
    return this.#view.bookmark;
  }
}

function authService(database: D1QueryExecutor): AuthService {
  return new AuthService({
    database,
    emailEnabled: false,
    emailQueue: {
      send: async () => ({
        metadata: {
          metrics: { backlogBytes: 0, backlogCount: 0 },
        },
      }),
    },
    hashPepper: "request-database-test-pepper-at-least-32-characters",
    now: () => now,
  });
}

function requestContext(
  createSession: () => D1DatabaseSession,
  constraints: string[],
): D1RequestContext {
  let session: D1DatabaseSession | undefined;
  return {
    env: {
      DB: {
        withSession(constraintOrBookmark) {
          constraints.push(constraintOrBookmark ?? "first-unconstrained");
          return createSession();
        },
      },
    },
    get() {
      return session;
    },
    set(_key, value) {
      session = value;
    },
  };
}

describe("primary-consistent request database", () => {
  it("prevents a valid owner from being denied by a stale authorization replica", async () => {
    const staleAuthentication = new ReplicaSession({
      bookmark: "stale-auth",
      owner: true,
      sessionActive: true,
    });
    const staleAuthorization = new ReplicaSession({
      bookmark: "stale-membership",
      owner: false,
      sessionActive: true,
    });
    const unconstrainedSession =
      await authService(staleAuthentication).authenticate(token);
    const unconstrainedAccess = await loadEventAccess(
      staleAuthorization,
      unconstrainedSession.user,
      "org_owner",
      "evt_owner",
    );
    expect(hasEventPermission(unconstrainedAccess, "organization:manage")).toBe(
      false,
    );

    const constraints: string[] = [];
    const context = requestContext(
      () =>
        new ReplicaSession({
          bookmark: "primary-owner",
          owner: true,
          sessionActive: true,
        }),
      constraints,
    );
    const database = requestDatabase(context);
    const session = await authService(database).authenticate(token);
    const access = await loadEventAccess(
      requestDatabase(context),
      session.user,
      "org_owner",
      "evt_owner",
    );

    expect(requestDatabase(context)).toBe(database);
    expect(constraints).toEqual(["first-primary"]);
    expect(hasEventPermission(access, "organization:manage")).toBe(true);
  });

  it("fails closed when the primary has revoked either the session or membership", async () => {
    const staleReplica = new ReplicaSession({
      bookmark: "stale-grant",
      owner: true,
      sessionActive: true,
    });
    const staleSession = await authService(staleReplica).authenticate(token);
    const staleAccess = await loadEventAccess(
      staleReplica,
      staleSession.user,
      "org_owner",
      "evt_owner",
    );
    expect(hasEventPermission(staleAccess, "organization:manage")).toBe(true);

    const revokedSessionContext = requestContext(
      () =>
        new ReplicaSession({
          bookmark: "primary-revoked-session",
          owner: true,
          sessionActive: false,
        }),
      [],
    );
    await expect(
      authService(requestDatabase(revokedSessionContext)).authenticate(token),
    ).rejects.toMatchObject({
      code: "invalid_session",
    } satisfies Partial<AuthError>);

    const revokedMembershipContext = requestContext(
      () =>
        new ReplicaSession({
          bookmark: "primary-revoked-membership",
          owner: false,
          sessionActive: true,
        }),
      [],
    );
    const database = requestDatabase(revokedMembershipContext);
    const session = await authService(database).authenticate(token);
    const access = await loadEventAccess(
      database,
      session.user,
      "org_owner",
      "evt_owner",
    );
    expect(hasEventPermission(access, "organization:manage")).toBe(false);
  });

  it("isolates concurrent requests while reusing one session within each request", async () => {
    const constraints: string[] = [];
    let next = 0;
    const create = () =>
      new ReplicaSession({
        bookmark: `primary-${++next}`,
        owner: true,
        sessionActive: true,
      });
    const firstContext = requestContext(create, constraints);
    const secondContext = requestContext(create, constraints);

    const [first, second] = await Promise.all([
      Promise.resolve(requestDatabase(firstContext)),
      Promise.resolve(requestDatabase(secondContext)),
    ]);

    expect(first).not.toBe(second);
    expect(requestDatabase(firstContext)).toBe(first);
    expect(requestDatabase(secondContext)).toBe(second);
    expect(first.getBookmark()).toBe("primary-1");
    expect(second.getBookmark()).toBe("primary-2");
    expect(constraints).toEqual(["first-primary", "first-primary"]);
  });

  it("does not create a primary session until a protected path asks for it", () => {
    const createSession = vi.fn(
      () =>
        new ReplicaSession({
          bookmark: "primary-lazy",
          owner: true,
          sessionActive: true,
        }),
    );
    const context = requestContext(createSession, []);
    expect(createSession).not.toHaveBeenCalled();
    requestDatabase(context);
    expect(createSession).toHaveBeenCalledOnce();
  });
});
