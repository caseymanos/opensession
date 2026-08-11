import {
  speakerPortalInvitationRequestSchema,
  speakerPortalSlugSchema,
} from "@sessionbox-killer/contracts/portal";
import { magicLinkAcceptedResponseSchema } from "@sessionbox-killer/contracts";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";

import type { AppContext } from "../app-context";
import { createOpaqueToken } from "../auth/crypto";
import {
  authFailure,
  authService,
  requestMetadata,
  requireSameOrigin,
  sessionToken,
} from "../auth/http";
import { authAttemptCookieName, setAuthAttemptCookie } from "../auth/routes";
import { isFeatureEnabled } from "../features";
import { emitOperationalLog } from "../observability";
import { requireAbuseCapacity, verifyTurnstile } from "../security/http";
import { TurnstileVerificationError } from "../security/turnstile";
import {
  D1SpeakerPortalEventResolver,
  D1SpeakerPortalService,
  SpeakerPortalAccessError,
} from "./service";

const portalBodyLimitBytes = 8 * 1024;
const genericInvitationMessage =
  "If that address can access this event, a private link is on its way.";

async function parsedJson(context: Parameters<typeof requireSameOrigin>[0]) {
  try {
    return await context.req.json();
  } catch {
    return null;
  }
}

async function waitForResponseFloor(
  startedAt: number,
  environment: Env["APP_ENV"],
): Promise<void> {
  const floorMs = environment === "local" ? 0 : 750;
  const remaining = floorMs - (Date.now() - startedAt);
  if (remaining > 0) await scheduler.wait(remaining);
}

function publicInvitationResponse() {
  return magicLinkAcceptedResponseSchema.parse({
    accepted: true,
    message: genericInvitationMessage,
  });
}

export function registerSpeakerPortalRoutes(app: Hono<AppContext>): void {
  app.use(
    "/api/portal/*",
    bodyLimit({
      maxSize: portalBodyLimitBytes,
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

  app.post("/api/portal/:eventSlug/invitations", async (context) => {
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

    const slug = speakerPortalSlugSchema.safeParse(
      context.req.param("eventSlug"),
    );
    const input = speakerPortalInvitationRequestSchema.safeParse(
      await parsedJson(context),
    );
    if (!slug.success || !input.success) {
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

    const ipAddress = context.req.header("CF-Connecting-IP") ?? null;
    const limited = await requireAbuseCapacity(context, "account", {
      ip: ipAddress,
    });
    if (limited) return limited;
    try {
      await verifyTurnstile(context, input.data.turnstile_token, "sign_in");
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
      event: slug.data,
    });
    if (eventLimited) return eventLimited;

    const startedAt = Date.now();
    const browserBindingToken =
      getCookie(context, authAttemptCookieName, "host") ?? createOpaqueToken();
    setAuthAttemptCookie(context, browserBindingToken);
    let deliveryId: string | null = null;
    let outcome = "suppressed";
    try {
      const event = await new D1SpeakerPortalEventResolver(
        context.env.DB,
      ).resolve(slug.data);
      if (event) {
        const result = await authService(context).requestMagicLink(
          {
            email: input.data.email,
            event_id: event.eventId,
            organization_id: event.organizationId,
            purpose: "portal",
            redirect_path: `/portal/${event.slug}`,
          },
          requestMetadata(context),
          browserBindingToken,
          new URL(context.req.url).origin,
          context.get("requestId"),
        );
        deliveryId = result.deliveryId;
        outcome = result.outcome;
      }
    } catch (error) {
      if (!(error instanceof SpeakerPortalAccessError)) throw error;
      emitOperationalLog("error", context.env, {
        event: "portal.invitation.configuration.invalid",
        outcome: "failure",
        request_id: context.get("requestId"),
      });
    } finally {
      await waitForResponseFloor(startedAt, context.env.APP_ENV);
    }
    if (outcome !== "queued" && outcome !== "suppressed") {
      emitOperationalLog("error", context.env, {
        ...(deliveryId ? { delivery_id: deliveryId } : {}),
        event: "portal.invitation.delivery_failed",
        outcome: "failure",
        queue: "email_send",
        request_id: context.get("requestId"),
      });
    }
    return context.json(publicInvitationResponse(), 202);
  });

  app.get("/api/portal/:eventSlug/bootstrap", async (context) => {
    context.header("Cache-Control", "private, no-store");
    const slug = speakerPortalSlugSchema.safeParse(
      context.req.param("eventSlug"),
    );
    if (!slug.success) {
      return context.json(
        {
          error: {
            code: "portal_event_not_found",
            message: "The requested speaker portal does not exist.",
          },
          request_id: context.get("requestId"),
        },
        404,
      );
    }
    try {
      const session = await authService(context).authenticate(
        sessionToken(context),
      );
      const result = await new D1SpeakerPortalService({
        database: context.env.DB,
      }).bootstrap(session, slug.data, context.get("requestId"));
      return context.json(result);
    } catch (error) {
      if (!(error instanceof SpeakerPortalAccessError)) {
        return authFailure(context, error);
      }
      const status =
        error.code === "portal_event_not_found"
          ? 404
          : error.code === "portal_access_denied"
            ? 403
            : 503;
      return context.json(
        {
          error: { code: error.code, message: error.message },
          request_id: context.get("requestId"),
        },
        status,
      );
    }
  });
}
