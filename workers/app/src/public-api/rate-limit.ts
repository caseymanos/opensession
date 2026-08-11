import { fingerprint } from "../auth/crypto.js";

export type PublicApiRateLimitKind = "read" | "write";

const policies: Record<
  PublicApiRateLimitKind,
  { limit: number; windowSeconds: number }
> = {
  read: { limit: 120, windowSeconds: 60 },
  write: { limit: 30, windowSeconds: 60 },
};

interface RateLimitRow {
  blocked_until: number;
  request_count: number;
  window_started_at: number;
}

export interface PublicApiRateLimitResult {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAtSeconds: number;
  readonly retryAfterSeconds: number;
}

export class PublicApiRateLimiter {
  readonly #database: D1Database;
  readonly #hashPepper: string;
  readonly #now: () => Date;

  constructor(options: {
    database: D1Database;
    hashPepper: string;
    now?: () => Date;
  }) {
    if (options.hashPepper.length < 32) {
      throw new Error("AUTH_HASH_PEPPER must contain at least 32 characters.");
    }
    this.#database = options.database;
    this.#hashPepper = options.hashPepper;
    this.#now = options.now ?? (() => new Date());
  }

  async consume(
    keyId: string,
    kind: PublicApiRateLimitKind,
  ): Promise<PublicApiRateLimitResult> {
    const policy = policies[kind];
    const now = this.#now();
    const nowSeconds = Math.floor(now.getTime() / 1_000);
    const windowStartedAt =
      Math.floor(nowSeconds / policy.windowSeconds) * policy.windowSeconds;
    const resetAtSeconds = windowStartedAt + policy.windowSeconds;
    const scope = `public_api:${kind}`;
    const keyHash = await fingerprint(keyId, this.#hashPepper, scope);
    const result = await this.#database
      .prepare(
        `INSERT INTO abuse_rate_limits (
           scope, key_hash, window_started_at, request_count,
           blocked_until, updated_at
         ) VALUES (?1, ?2, ?3, 1, 0, ?4)
         ON CONFLICT(scope, key_hash) DO UPDATE SET
           window_started_at = CASE
             WHEN abuse_rate_limits.window_started_at != ?3 THEN ?3
             ELSE abuse_rate_limits.window_started_at
           END,
           request_count = CASE
             WHEN abuse_rate_limits.window_started_at != ?3 THEN 1
             ELSE abuse_rate_limits.request_count + 1
           END,
           blocked_until = CASE
             WHEN abuse_rate_limits.window_started_at != ?3 THEN 0
             WHEN abuse_rate_limits.request_count + 1 > ?5 THEN ?6
             ELSE 0
           END,
           updated_at = ?4
         RETURNING window_started_at, request_count, blocked_until`,
      )
      .bind(
        scope,
        keyHash,
        windowStartedAt,
        now.toISOString(),
        policy.limit,
        resetAtSeconds,
      )
      .first<RateLimitRow>();
    if (!result)
      throw new Error("Public API rate-limit state was not returned.");
    const allowed =
      result.request_count <= policy.limit &&
      result.blocked_until <= nowSeconds;
    return {
      allowed,
      limit: policy.limit,
      remaining: Math.max(0, policy.limit - result.request_count),
      resetAtSeconds,
      retryAfterSeconds: allowed
        ? 0
        : Math.max(1, result.blocked_until - nowSeconds),
    };
  }
}
