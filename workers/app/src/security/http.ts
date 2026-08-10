import type { TurnstileAction } from "@sessionbox-killer/contracts";
import type { Context } from "hono";

import type { AppContext } from "../app-context";
import { AbuseProtectionService, type AbuseOperation } from "./abuse";
import { TurnstileVerifier } from "./turnstile";

export function abuseProtection(context: Context<AppContext>) {
  return new AbuseProtectionService({
    database: context.env.DB,
    hashPepper: context.env.AUTH_HASH_PEPPER,
  });
}

export async function requireAbuseCapacity(
  context: Context<AppContext>,
  operation: AbuseOperation,
  dimensions: Parameters<AbuseProtectionService["consume"]>[1],
): Promise<Response | null> {
  const result = await abuseProtection(context).consume(operation, dimensions);
  if (result.allowed) return null;

  context.header("Retry-After", String(Math.max(1, result.retryAfterSeconds)));
  return context.json(
    {
      error: {
        code: "rate_limited",
        message: "Too many attempts. Wait before trying again.",
      },
      request_id: context.get("requestId"),
    },
    429,
  );
}

export async function verifyTurnstile(
  context: Context<AppContext>,
  token: string,
  action: TurnstileAction,
): Promise<void> {
  if (context.env.APP_ENV === "local" && !context.env.TURNSTILE_SECRET) {
    return;
  }
  await new TurnstileVerifier({
    environment: context.env.APP_ENV,
    hostnames: context.env.TURNSTILE_HOSTNAMES,
    secret: context.env.TURNSTILE_SECRET,
  }).verify(token, action, context.req.header("CF-Connecting-IP") ?? null);
}
