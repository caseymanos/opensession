import {
  authSessionResponseSchema,
  magicLinkAcceptedResponseSchema,
  magicLinkExchangeSchema,
  magicLinkRequestSchema,
  protectedMagicLinkRequestSchema,
} from "@sessionbox-killer/contracts";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";

import type { AppContext } from "../app-context";
import {
  D1PublicCfpPolicyReader,
  PublicCfpConfigurationError,
} from "../cfp/policy";
import { isFeatureEnabled } from "../features";
import { emitOperationalLog } from "../observability";
import { requireAbuseCapacity, verifyTurnstile } from "../security/http";
import { TurnstileVerificationError } from "../security/turnstile";
import { createOpaqueToken } from "./crypto";
import {
  authFailure,
  authService,
  publicAuthService,
  requestMetadata,
  requireSameOrigin,
  sessionCookieName,
  sessionToken,
} from "./http";
import type { CreatedSession } from "./service";

const csrfCookieName = "opensession-csrf";
export const authAttemptCookieName = "opensession-auth-init";
const genericMagicLinkMessage =
  "If that address can sign in, a private link is on its way.";
const authBodyLimitBytes = 8 * 1024;
async function waitForMagicLinkResponseFloor(
  startedAt: number,
  environment: Env["APP_ENV"],
): Promise<void> {
  const floorMs = environment === "local" ? 0 : 750;
  const remaining = floorMs - (Date.now() - startedAt);
  if (remaining > 0) {
    await scheduler.wait(remaining);
  }
}

export function setAuthAttemptCookie(
  context: Context<AppContext>,
  token: string,
  maxAge = 15 * 60,
): void {
  setCookie(context, authAttemptCookieName, token, {
    httpOnly: true,
    maxAge,
    path: "/",
    prefix: "host",
    priority: "High",
    sameSite: "Lax",
    secure: true,
  });
}

function setSessionCookies(
  context: Context<AppContext>,
  session: CreatedSession,
): void {
  const maxAge = Math.max(
    0,
    Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1000),
  );
  setCookie(context, sessionCookieName, session.sessionToken, {
    httpOnly: true,
    maxAge,
    path: "/",
    prefix: "host",
    priority: "High",
    sameSite: "Lax",
    secure: true,
  });
  setCookie(context, csrfCookieName, session.csrfToken, {
    httpOnly: false,
    maxAge,
    path: "/",
    prefix: "host",
    priority: "Medium",
    sameSite: "Lax",
    secure: true,
  });
}

function clearSessionCookies(context: Context<AppContext>): void {
  for (const [name, httpOnly] of [
    [sessionCookieName, true],
    [csrfCookieName, false],
  ] as const) {
    setCookie(context, name, "", {
      httpOnly,
      maxAge: 0,
      path: "/",
      prefix: "host",
      priority: httpOnly ? "High" : "Medium",
      sameSite: "Lax",
      secure: true,
    });
  }
}

async function parsedJson(context: Context<AppContext>) {
  try {
    return await context.req.json();
  } catch {
    return null;
  }
}

export function registerAuthRoutes(app: Hono<AppContext>): void {
  app.use(
    "/api/auth/*",
    bodyLimit({
      maxSize: authBodyLimitBytes,
      onError: (context) =>
        context.json(
          {
            error: {
              code: "request_too_large",
              message: "The request body is too large.",
            },
            request_id: context.get("requestId"),
          },
          413,
        ),
    }),
  );

  app.post("/api/auth/magic-links", async (context) => {
    if (!requireSameOrigin(context)) {
      return context.json(
        {
          error: {
            code: "invalid_origin",
            message: "This request must originate from OpenSession.",
          },
          request_id: context.get("requestId"),
        },
        403,
      );
    }

    if (!isFeatureEnabled(context.env.FEATURE_FLAGS, "email")) {
      return context.json(
        {
          error: {
            code: "email_delivery_unavailable",
            message: "Email sign-in is not available in this environment.",
          },
          request_id: context.get("requestId"),
        },
        503,
      );
    }

    const input = protectedMagicLinkRequestSchema.safeParse(
      await parsedJson(context),
    );
    if (!input.success) {
      return context.json(
        {
          error: {
            code: "invalid_request",
            message: "Enter a valid email address and try again.",
          },
          request_id: context.get("requestId"),
        },
        400,
      );
    }

    const expectedAction = input.data.event_slug ? "cfp_account" : "sign_in";
    if (input.data.turnstile_action !== expectedAction) {
      return context.json(
        {
          error: {
            code: "invalid_request",
            message: "Complete the security check and try again.",
          },
          request_id: context.get("requestId"),
        },
        400,
      );
    }

    const limited = await requireAbuseCapacity(context, "account", {
      ip: context.req.header("CF-Connecting-IP") ?? null,
    });
    if (limited) return limited;

    try {
      await verifyTurnstile(
        context,
        input.data.turnstile_token,
        expectedAction,
      );
    } catch (error) {
      if (!(error instanceof TurnstileVerificationError)) throw error;
      return context.json(
        {
          error: {
            code: "security_check_failed",
            message: "Complete the security check and try again.",
          },
          request_id: context.get("requestId"),
        },
        400,
      );
    }

    const eventLimited = await requireAbuseCapacity(context, "account", {
      event: input.data.event_slug ?? null,
    });
    if (eventLimited) return eventLimited;

    const startedAt = Date.now();
    const browserBindingToken =
      getCookie(context, authAttemptCookieName, "host") ?? createOpaqueToken();
    setAuthAttemptCookie(context, browserBindingToken);
    let result;
    try {
      const magicLinkInput = magicLinkRequestSchema.parse(input.data);
      let registerUnprivilegedUser = false;
      if (input.data.event_slug) {
        try {
          const policy = await new D1PublicCfpPolicyReader(
            context.env.DB,
          ).readBySlug(input.data.event_slug);
          registerUnprivilegedUser = policy?.acceptingSubmissions ?? false;
        } catch (error) {
          if (!(error instanceof PublicCfpConfigurationError)) throw error;
          emitOperationalLog("error", context.env, {
            event: "cfp.account_configuration.invalid",
            outcome: "failure",
            request_id: context.get("requestId"),
          });
        }
      }
      result =
        !input.data.event_slug || registerUnprivilegedUser
          ? await publicAuthService(context).requestMagicLink(
              magicLinkInput,
              requestMetadata(context),
              browserBindingToken,
              new URL(context.req.url).origin,
              context.get("requestId"),
              { registerUnprivilegedUser },
            )
          : { deliveryId: null, outcome: "suppressed" as const };
    } finally {
      await waitForMagicLinkResponseFloor(startedAt, context.env.APP_ENV);
    }

    if (result.outcome !== "queued" && result.outcome !== "suppressed") {
      const event =
        result.outcome === "delivery_failed"
          ? "auth.magic_link.enqueue_failed"
          : result.outcome === "delivery_cleanup_failed"
            ? "auth.magic_link.failure_cleanup_failed"
            : "auth.magic_link.finalization_failed";
      emitOperationalLog("error", context.env, {
        ...(result.deliveryId ? { delivery_id: result.deliveryId } : {}),
        event,
        outcome: "failure",
        queue: "email_send",
        request_id: context.get("requestId"),
      });
    } else if (result.outcome === "queued" && result.deliveryId) {
      emitOperationalLog("info", context.env, {
        attempt: 1,
        delivery_id: result.deliveryId,
        event: "auth.magic_link.queued",
        outcome: "accepted",
        queue: "email_send",
        request_id: context.get("requestId"),
      });
    }

    return context.json(
      magicLinkAcceptedResponseSchema.parse({
        accepted: true,
        message: genericMagicLinkMessage,
      }),
      202,
    );
  });

  app.post("/api/auth/magic-links/exchange", async (context) => {
    if (!requireSameOrigin(context)) {
      return context.json(
        {
          error: {
            code: "invalid_origin",
            message: "This request must originate from OpenSession.",
          },
          request_id: context.get("requestId"),
        },
        403,
      );
    }

    const input = magicLinkExchangeSchema.safeParse(await parsedJson(context));
    if (!input.success) {
      return context.json(
        {
          error: {
            code: "invalid_magic_link",
            message: "This sign-in link is invalid or has expired.",
          },
          request_id: context.get("requestId"),
        },
        400,
      );
    }

    try {
      const result = await publicAuthService(context).exchangeMagicLink(
        input.data.token,
        getCookie(context, authAttemptCookieName, "host") ?? null,
        requestMetadata(context),
        sessionToken(context),
      );
      setSessionCookies(context, result);
      setAuthAttemptCookie(context, "", 0);
      return context.json(
        authSessionResponseSchema.parse({
          csrf_token: result.csrfToken,
          expires_at: result.expiresAt,
          redirect_path: result.redirectPath,
          user: {
            display_name: result.user.displayName,
            email: result.user.email,
            id: result.user.id,
          },
        }),
      );
    } catch (error) {
      return authFailure(context, error);
    }
  });

  app.get("/api/auth/session", async (context) => {
    try {
      const service = authService(context);
      const session = await service.authenticate(sessionToken(context));
      const organizationId = context.req.query("organization_id") ?? null;
      const eventId = context.req.query("event_id") ?? null;
      const requestedSessionId = context.req.query("session_id") ?? null;

      if (
        (organizationId === null) !== (eventId === null) ||
        (requestedSessionId !== null && !eventId) ||
        [organizationId, eventId, requestedSessionId].some(
          (value) =>
            value !== null && (value.length === 0 || value.length > 128),
        )
      ) {
        return context.json(
          {
            error: {
              code: "invalid_scope",
              message:
                "Organization and event scope must be supplied together.",
            },
            request_id: context.get("requestId"),
          },
          400,
        );
      }

      const scope =
        organizationId && eventId
          ? await service.scopedAccess(session, {
              eventId,
              organizationId,
              sessionId: requestedSessionId,
            })
          : null;

      return context.json({
        expires_at: session.expiresAt,
        scope: scope
          ? {
              can_read_session: scope.canReadSession,
              event_role: scope.access.eventRole,
              organization_role: scope.access.organizationRole,
              permissions: scope.access.permissions,
              speaker_contact_id: scope.access.speakerContactId,
            }
          : null,
        user: {
          display_name: session.user.displayName,
          email: session.user.email,
          id: session.user.id,
        },
      });
    } catch (error) {
      return authFailure(context, error);
    }
  });

  app.post("/api/auth/session/rotate", async (context) => {
    if (!requireSameOrigin(context)) {
      return context.json(
        {
          error: {
            code: "invalid_origin",
            message: "This request must originate from OpenSession.",
          },
          request_id: context.get("requestId"),
        },
        403,
      );
    }

    try {
      const service = authService(context);
      const rawSessionToken = sessionToken(context);
      const session = await service.authenticate(rawSessionToken);
      await service.verifyCsrf(
        session,
        context.req.header("X-CSRF-Token") ?? null,
      );
      const rotated = await service.rotateSession(
        session,
        requestMetadata(context),
        rawSessionToken ?? "",
      );
      setSessionCookies(context, rotated);
      return context.json({
        csrf_token: rotated.csrfToken,
        expires_at: rotated.expiresAt,
      });
    } catch (error) {
      return authFailure(context, error);
    }
  });

  app.post("/api/auth/logout", async (context) => {
    if (!requireSameOrigin(context)) {
      return context.json(
        {
          error: {
            code: "invalid_origin",
            message: "This request must originate from OpenSession.",
          },
          request_id: context.get("requestId"),
        },
        403,
      );
    }

    try {
      const service = authService(context);
      const session = await service.authenticate(sessionToken(context));
      await service.verifyCsrf(
        session,
        context.req.header("X-CSRF-Token") ?? null,
      );
      await service.logout(session);
      clearSessionCookies(context);
      return context.body(null, 204);
    } catch (error) {
      return authFailure(context, error);
    }
  });
}
