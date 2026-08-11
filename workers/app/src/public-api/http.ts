import {
  publicApiPaginationQuerySchema,
  publicApiProblemSchema,
  type ApiKeyScope,
  type PublicApiPaginationQuery,
} from "@sessionbox-killer/contracts/public-api";
import type { Context } from "hono";

import type { AppContext } from "../app-context.js";
import { emitOperationalLog } from "../observability.js";
import {
  ApiKeyAuthenticator,
  type AuthenticatedApiKey,
} from "./key-service.js";
import {
  PublicApiRateLimiter,
  type PublicApiRateLimitResult,
} from "./rate-limit.js";

const idempotencyKeyPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$/;
const strongEntityTagPattern = /^"opensession-([a-z-]+)-v(\d+)"$/;
const allowedPaginationQueryNames = new Set(["cursor", "limit"]);

export type PublicApiHttpStatus =
  400 | 401 | 403 | 404 | 409 | 412 | 413 | 428 | 429 | 503;

export function problemResponse(
  context: Context<AppContext>,
  status: PublicApiHttpStatus,
  code: string,
  title: string,
  detail: string,
  errors?: readonly { field: string; message: string }[],
): Response {
  context.header("Cache-Control", "no-store");
  const response = context.json(
    publicApiProblemSchema.parse({
      code,
      detail,
      ...(errors ? { errors } : {}),
      request_id: context.get("requestId"),
      status,
      title,
      type: `https://opensessionboard.com/problems/${code}`,
    }),
    status,
  );
  response.headers.set(
    "Content-Type",
    "application/problem+json; charset=UTF-8",
  );
  return response;
}

function bearerToken(context: Context<AppContext>): string | null {
  const authorization = context.req.header("Authorization");
  if (!authorization || authorization.length > 320) return null;
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  return match?.[1] ?? null;
}

function rateLimitHeaders(
  context: Context<AppContext>,
  result: PublicApiRateLimitResult,
): void {
  context.header("RateLimit-Limit", String(result.limit));
  context.header("RateLimit-Remaining", String(result.remaining));
  context.header("RateLimit-Reset", String(result.resetAtSeconds));
  if (!result.allowed) {
    context.header("Retry-After", String(result.retryAfterSeconds));
  }
}

export async function authenticatePublicApi(
  context: Context<AppContext>,
  scope: ApiKeyScope,
  eventId?: string,
): Promise<{ key: AuthenticatedApiKey } | { response: Response }> {
  const token = bearerToken(context);
  if (!token) {
    context.header(
      "WWW-Authenticate",
      'Bearer realm="OpenSession API", error="invalid_token"',
    );
    return {
      response: problemResponse(
        context,
        401,
        "invalid_api_key",
        "Authentication required",
        "Provide a valid OpenSession API key in the Authorization header.",
      ),
    };
  }
  const key = await new ApiKeyAuthenticator({
    database: context.env.DB,
    hashPepper: context.env.AUTH_HASH_PEPPER,
    onLastUsedFailure: () => {
      emitOperationalLog("warn", context.env, {
        event: "public_api.last_used_update_failed",
        outcome: "failure",
        request_id: context.get("requestId"),
      });
    },
  }).authenticate(token);
  if (!key) {
    context.header(
      "WWW-Authenticate",
      'Bearer realm="OpenSession API", error="invalid_token"',
    );
    return {
      response: problemResponse(
        context,
        401,
        "invalid_api_key",
        "Invalid API key",
        "The API key is invalid, expired, or revoked.",
      ),
    };
  }
  const kind = context.req.method === "GET" ? "read" : "write";
  const rateLimit = await new PublicApiRateLimiter({
    database: context.env.DB,
    hashPepper: context.env.AUTH_HASH_PEPPER,
  }).consume(key.id, kind);
  rateLimitHeaders(context, rateLimit);
  if (!rateLimit.allowed) {
    return {
      response: problemResponse(
        context,
        429,
        "rate_limited",
        "Rate limit exceeded",
        "This API key has exceeded its current request allowance.",
      ),
    };
  }
  if (!key.scopes.includes(scope)) {
    return {
      response: problemResponse(
        context,
        403,
        "insufficient_scope",
        "Insufficient scope",
        `This request requires the ${scope} scope.`,
      ),
    };
  }
  if (eventId && key.eventId !== null && key.eventId !== eventId) {
    return {
      response: problemResponse(
        context,
        403,
        "event_scope_mismatch",
        "Event scope mismatch",
        "This API key cannot access the requested event.",
      ),
    };
  }
  return { key };
}

export function parsePaginationQuery(
  context: Context<AppContext>,
): { data: PublicApiPaginationQuery } | { response: Response } {
  const url = new URL(context.req.url);
  for (const name of url.searchParams.keys()) {
    if (
      !allowedPaginationQueryNames.has(name) ||
      url.searchParams.getAll(name).length !== 1
    ) {
      return {
        response: problemResponse(
          context,
          400,
          "invalid_pagination",
          "Invalid pagination",
          "Pagination accepts one cursor and one limit parameter only.",
          [
            {
              field: name || "query",
              message: "Unknown or repeated query parameter.",
            },
          ],
        ),
      };
    }
  }
  const rawLimit = url.searchParams.get("limit");
  const limit =
    rawLimit === null
      ? undefined
      : /^\d{1,3}$/.test(rawLimit)
        ? Number(rawLimit)
        : Number.NaN;
  const parsed = publicApiPaginationQuerySchema.safeParse({
    ...(url.searchParams.has("cursor")
      ? { cursor: url.searchParams.get("cursor") }
      : {}),
    ...(limit === undefined ? {} : { limit }),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      response: problemResponse(
        context,
        400,
        "invalid_pagination",
        "Invalid pagination",
        "Use a limit from 1 to 100 and a cursor returned by this collection.",
        [
          {
            field: issue?.path.join(".") || "query",
            message: issue?.message ?? "The pagination query is invalid.",
          },
        ],
      ),
    };
  }
  return { data: parsed.data };
}

export function requireIdempotencyKey(
  context: Context<AppContext>,
): { data: string } | { response: Response } {
  const value = context.req.header("Idempotency-Key")?.trim() ?? "";
  if (!idempotencyKeyPattern.test(value)) {
    return {
      response: problemResponse(
        context,
        400,
        "invalid_idempotency_key",
        "Invalid idempotency key",
        "Mutations require a 16–128 character Idempotency-Key using safe ASCII characters.",
        [{ field: "Idempotency-Key", message: "Missing or invalid header." }],
      ),
    };
  }
  return { data: value };
}

export function requireEntityVersion(
  context: Context<AppContext>,
  resource: string,
): { data: number } | { response: Response } {
  const value = context.req.header("If-Match");
  if (!value) {
    return {
      response: problemResponse(
        context,
        428,
        "precondition_required",
        "Precondition required",
        "Send the strong ETag from the latest singular resource response in If-Match.",
        [{ field: "If-Match", message: "This header is required." }],
      ),
    };
  }
  const match = strongEntityTagPattern.exec(value);
  if (match?.[1] !== resource || !match[2]) {
    return {
      response: problemResponse(
        context,
        400,
        "invalid_precondition",
        "Invalid precondition",
        "If-Match must contain one strong ETag for this resource.",
        [
          {
            field: "If-Match",
            message: "The ETag is malformed or belongs to another resource.",
          },
        ],
      ),
    };
  }
  const version = Number(match[2]);
  return Number.isSafeInteger(version) && version > 0
    ? { data: version }
    : {
        response: problemResponse(
          context,
          400,
          "invalid_precondition",
          "Invalid precondition",
          "If-Match contains an invalid resource version.",
        ),
      };
}
