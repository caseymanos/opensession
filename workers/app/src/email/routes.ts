import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import type { AppContext } from "../app-context.js";
import { emitOperationalLog } from "../observability.js";
import {
  EmailProviderEventIdentityConflictError,
  EmailProviderEventNotReadyError,
  EmailProviderEventService,
  verifyResendWebhook,
} from "./webhook.js";

const webhookBodyLimitBytes = 256 * 1_024;

export function registerEmailWebhookRoutes(app: Hono<AppContext>): void {
  app.use(
    "/api/webhooks/resend",
    bodyLimit({
      maxSize: webhookBodyLimitBytes,
      onError: (context) => context.text("Webhook payload is too large.", 413),
    }),
  );
  app.post("/api/webhooks/resend", async (context) => {
    const payload = await context.req.text();
    let verified: ReturnType<typeof verifyResendWebhook>;
    try {
      verified = verifyResendWebhook({
        apiKey: context.env.RESEND_API_KEY,
        id: context.req.header("svix-id") ?? null,
        payload,
        secret: context.env.RESEND_WEBHOOK_SECRET,
        signature: context.req.header("svix-signature") ?? null,
        timestamp: context.req.header("svix-timestamp") ?? null,
      });
    } catch {
      emitOperationalLog("warn", context.env, {
        event: "email.webhook.rejected",
        outcome: "client_error",
        request_id: context.get("requestId"),
        route: "/api/webhooks/resend",
        status: 400,
      });
      return context.text("Invalid webhook.", 400);
    }
    try {
      const outcome = await new EmailProviderEventService({
        database: context.env.DB,
      }).apply({
        event: verified.event,
        eventId: verified.eventId,
        rawPayload: payload,
      });
      emitOperationalLog("info", context.env, {
        event: `email.webhook.${outcome}`,
        outcome: outcome === "applied" ? "success" : "accepted",
        request_id: context.get("requestId"),
        route: "/api/webhooks/resend",
        status: 200,
      });
      return context.text("OK", 200);
    } catch (error) {
      const retryable = error instanceof EmailProviderEventNotReadyError;
      const identityConflict =
        error instanceof EmailProviderEventIdentityConflictError;
      emitOperationalLog("error", context.env, {
        error_type: retryable
          ? "provider_event_not_ready"
          : identityConflict
            ? "provider_event_identity_conflict"
            : "provider_event_failed",
        event: "email.webhook.failed",
        outcome: "failure",
        request_id: context.get("requestId"),
        route: "/api/webhooks/resend",
        status: 503,
      });
      return context.text("Try again later.", 503);
    }
  });
}
