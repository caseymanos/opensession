import { fingerprint } from "../auth/crypto";

export type AbuseOperation =
  "account" | "autosave" | "submit" | "upload_intent";
export type AbuseDimension = "email" | "event" | "identity" | "ip";

interface AbusePolicy {
  blockSeconds: number;
  limit: number;
  windowSeconds: number;
}

const policies: Record<
  AbuseOperation,
  Partial<Record<AbuseDimension, AbusePolicy>>
> = {
  account: {
    event: { blockSeconds: 1_800, limit: 200, windowSeconds: 900 },
    ip: { blockSeconds: 1_800, limit: 20, windowSeconds: 900 },
  },
  autosave: {
    event: { blockSeconds: 300, limit: 1_200, windowSeconds: 60 },
    identity: { blockSeconds: 120, limit: 120, windowSeconds: 60 },
    ip: { blockSeconds: 300, limit: 240, windowSeconds: 60 },
  },
  submit: {
    event: { blockSeconds: 900, limit: 300, windowSeconds: 900 },
    identity: { blockSeconds: 900, limit: 10, windowSeconds: 900 },
    ip: { blockSeconds: 900, limit: 30, windowSeconds: 900 },
  },
  upload_intent: {
    event: { blockSeconds: 900, limit: 120, windowSeconds: 900 },
    identity: { blockSeconds: 900, limit: 30, windowSeconds: 900 },
    ip: { blockSeconds: 900, limit: 60, windowSeconds: 900 },
  },
};

interface LimitRow {
  blocked_until: number;
  request_count: number;
  window_started_at: number;
}

export interface AbuseLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface AbuseProtectionOptions {
  database: D1Database;
  hashPepper: string;
  now?: () => Date;
}

export class AbuseProtectionService {
  readonly #database: D1Database;
  readonly #hashPepper: string;
  readonly #now: () => Date;

  constructor(options: AbuseProtectionOptions) {
    this.#database = options.database;
    this.#hashPepper = options.hashPepper;
    this.#now = options.now ?? (() => new Date());
  }

  async consume(
    operation: AbuseOperation,
    dimensions: Partial<Record<AbuseDimension, string | null>>,
  ): Promise<AbuseLimitResult> {
    const now = this.#now();
    const nowSeconds = Math.floor(now.getTime() / 1_000);
    const statements: D1PreparedStatement[] = [];

    for (const [dimension, rawValue] of Object.entries(dimensions) as [
      AbuseDimension,
      string | null | undefined,
    ][]) {
      const policy = policies[operation][dimension];
      const value = rawValue?.trim();
      if (!policy || !value) continue;

      const scope = `${operation}:${dimension}`;
      const keyHash = await fingerprint(value, this.#hashPepper, scope);
      statements.push(
        this.#database
          .prepare(
            `INSERT INTO abuse_rate_limits
              (scope, key_hash, window_started_at, request_count, blocked_until, updated_at)
             VALUES (?1, ?2, ?3, 1, 0, ?4)
             ON CONFLICT(scope, key_hash) DO UPDATE SET
               window_started_at = CASE
                 WHEN ?3 >= window_started_at + ?5 THEN ?3
                 ELSE window_started_at
               END,
               request_count = CASE
                 WHEN ?3 >= window_started_at + ?5 THEN 1
                 ELSE request_count + 1
               END,
               blocked_until = CASE
                 WHEN blocked_until > ?3 THEN blocked_until
                 WHEN (
                   CASE
                     WHEN ?3 >= window_started_at + ?5 THEN 1
                     ELSE request_count + 1
                   END
                 ) > ?6 THEN ?3 + ?7
                 ELSE 0
               END,
               updated_at = ?4
             RETURNING window_started_at, request_count, blocked_until`,
          )
          .bind(
            scope,
            keyHash,
            nowSeconds,
            now.toISOString(),
            policy.windowSeconds,
            policy.limit,
            policy.blockSeconds,
          ),
      );
    }

    if (statements.length === 0) {
      return { allowed: true, retryAfterSeconds: 0 };
    }

    const results = await this.#database.batch<LimitRow>(statements);
    const retryAfterSeconds = results.reduce((longest, result) => {
      const row = result.results[0];
      return row ? Math.max(longest, row.blocked_until - nowSeconds) : longest;
    }, 0);
    return {
      allowed: retryAfterSeconds <= 0,
      retryAfterSeconds: Math.max(0, retryAfterSeconds),
    };
  }
}

export function pruneExpiredAbuseLimits(
  database: D1Database,
): Promise<D1Result> {
  const cutoff = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000).toISOString();
  return database
    .prepare("DELETE FROM abuse_rate_limits WHERE updated_at < ?1")
    .bind(cutoff)
    .run();
}
