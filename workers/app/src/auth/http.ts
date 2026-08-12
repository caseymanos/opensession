import type { Context } from "hono";
import { getCookie } from "hono/cookie";

import type { AppContext } from "../app-context";
import { requestDatabase, type D1QueryExecutor } from "../database.js";
import { isFeatureEnabled } from "../features";
import { AuthError, AuthService } from "./service";

export const sessionCookieName = "opensession-session";

export function requestMetadata(context: Context<AppContext>) {
  return {
    ipAddress: context.req.header("CF-Connecting-IP") ?? null,
    userAgent: context.req.header("User-Agent") ?? null,
  };
}

function createAuthService(
  context: Context<AppContext>,
  database: D1QueryExecutor,
) {
  return new AuthService({
    database,
    emailEnabled: isFeatureEnabled(context.env.FEATURE_FLAGS, "email"),
    emailQueue: context.env.EMAIL_QUEUE,
    hashPepper: context.env.AUTH_HASH_PEPPER,
  });
}

export function authService(context: Context<AppContext>) {
  return createAuthService(context, requestDatabase(context));
}

export function publicAuthService(context: Context<AppContext>) {
  return createAuthService(context, context.env.DB);
}

export function sessionToken(context: Context<AppContext>) {
  return getCookie(context, sessionCookieName, "host") ?? null;
}

export function requireSameOrigin(context: Context<AppContext>): boolean {
  const origin = context.req.header("Origin");
  const fetchSite = context.req.header("Sec-Fetch-Site");
  const contentType = context.req.header("Content-Type") ?? "";

  return (
    origin === new URL(context.req.url).origin &&
    (!fetchSite || fetchSite === "same-origin") &&
    contentType.toLowerCase().startsWith("application/json")
  );
}

export function authFailure(context: Context<AppContext>, error: unknown) {
  if (!(error instanceof AuthError)) {
    throw error;
  }

  const status =
    error.code === "invalid_session"
      ? 401
      : error.code === "invalid_csrf"
        ? 403
        : 400;
  return context.json(
    {
      error: {
        code: error.code,
        message: error.message,
        ...(error.recovery ? { recovery: error.recovery } : {}),
      },
      request_id: context.get("requestId"),
    },
    status,
  );
}
