import {
  healthResponseSchema,
  turnstileConfigResponseSchema,
} from "@sessionbox-killer/contracts";
import { Hono, type Context } from "hono";
import { routePath } from "hono/route";

import type { AppContext } from "./app-context";
import { registerAuthRoutes } from "./auth/routes";
import { getBaseAuthority } from "./authority/binding.js";
import { registerPublicCfpRoutes } from "./cfp/routes";
import { inspectFeatureFlags, isFeatureEnabled } from "./features";
import { parseEmailDeliveryConfig } from "./email/config.js";
import { EmailQueueDeliveryService } from "./email/delivery.js";
import { ResendEmailDeliveryProvider } from "./email/provider.js";
import { registerEmailWebhookRoutes } from "./email/routes.js";
import {
  elapsedMilliseconds,
  emitOperationalLog,
  pruneExpiredOperationalEvents,
  requestOutcome,
  roundedDuration,
} from "./observability";
import {
  isPublicScheduleCacheInvalidationMessage,
  processPublicScheduleCacheInvalidation,
  publicScheduleResponse,
} from "./public-schedule/cache.js";
import { D1PublicScheduleProjectionReader } from "./public-schedule/projection.js";
import { registerUploadRoutes } from "./uploads/routes";
import { UploadService } from "./uploads/service";
import { pruneExpiredAbuseLimits } from "./security/abuse";
import { validTurnstileConfiguration } from "./security/turnstile";

export const app = new Hono<AppContext>();
const airtableBasePattern = /^app[A-Za-z0-9]{8,}$/;
const publicSlugPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export { BaseAuthority } from "./authority/base-authority.js";

function operationalRoute(context: Context<AppContext>): string {
  const matchedRoute = routePath(context, -1);
  return matchedRoute && matchedRoute !== "*" && matchedRoute !== "/*"
    ? matchedRoute
    : "unmatched";
}

app.use("*", async (context, next) => {
  const requestId = crypto.randomUUID();
  const startedAt = performance.now();
  let failed = false;

  context.set("requestId", requestId);
  context.header("Cache-Control", "no-store");
  context.header("Referrer-Policy", "no-referrer");
  context.header("X-Request-Id", requestId);
  context.header("X-Content-Type-Options", "nosniff");

  try {
    await next();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    const status = failed ? 500 : context.res.status;
    emitOperationalLog(
      status >= 500 ? "error" : status >= 400 ? "warn" : "info",
      context.env,
      {
        duration_ms: roundedDuration(startedAt, performance.now()),
        event: "request.completed",
        method: context.req.method,
        outcome: requestOutcome(status),
        request_id: requestId,
        route: operationalRoute(context),
        status,
        ...(context.env.WORKER_VERSION?.id
          ? { version_id: context.env.WORKER_VERSION.id }
          : {}),
      },
    );
  }
});

app.get("/health/live", (context) => {
  return context.json(
    healthResponseSchema.parse({
      environment: context.env.APP_ENV,
      service: "sessionbox-killer",
      status: "ok",
      timestamp: new Date().toISOString(),
    }),
  );
});

app.get("/health/ready", async (context) => {
  const requiredBindings = [
    context.env.DB,
    context.env.UPLOADS,
    context.env.EMAIL_QUEUE,
    context.env.PROJECTION_REPAIR_QUEUE,
    context.env.WEBHOOK_DELIVERY_QUEUE,
    context.env.INTEGRATION_EXPORT_QUEUE,
    context.env.BASE_AUTHORITY,
    context.env.AIRTABLE_PAT,
    context.env.AUTH_HASH_PEPPER,
    context.env.OBSERVABILITY,
  ];
  const featureFlags = inspectFeatureFlags(context.env.FEATURE_FLAGS);
  let emailConfigReady: boolean;
  try {
    const emailConfig = parseEmailDeliveryConfig(
      context.env.EMAIL_DELIVERY_CONFIG,
      context.env.APP_ENV,
    );
    emailConfigReady =
      !isFeatureEnabled(context.env.FEATURE_FLAGS, "email") ||
      emailConfig.mode === "sink" ||
      (context.env.RESEND_API_KEY.startsWith("re_") &&
        context.env.RESEND_WEBHOOK_SECRET.startsWith("whsec_"));
  } catch {
    emailConfigReady = false;
  }

  if (
    requiredBindings.some((binding) => !binding) ||
    context.env.AUTH_HASH_PEPPER.length < 32 ||
    !airtableBasePattern.test(context.env.AIRTABLE_BASE_ID) ||
    !featureFlags.valid ||
    !emailConfigReady ||
    (context.env.APP_ENV !== "local" &&
      !validTurnstileConfiguration(context.env))
  ) {
    return context.json(
      {
        error: {
          code: "service_unavailable",
          message: "One or more required service dependencies are unavailable.",
        },
        request_id: context.get("requestId"),
      },
      503,
    );
  }

  try {
    const [authority] = await Promise.all([
      getBaseAuthority(context.env).ready(),
      context.env.DB.prepare(
        "SELECT COUNT(*) AS count FROM tenant_registry",
      ).first(),
    ]);
    if (authority.schemaVersion !== 3) {
      throw new Error("Unsupported authority schema version.");
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        environment: context.env.APP_ENV,
        errorType: error instanceof Error ? error.name : "UnknownError",
        event: "readiness.failed",
      }),
    );
    return context.json(
      {
        error: {
          code: "service_unavailable",
          message: "One or more required service dependencies are unavailable.",
        },
        request_id: context.get("requestId"),
      },
      503,
    );
  }

  return context.json(
    healthResponseSchema.parse({
      environment: context.env.APP_ENV,
      service: "sessionbox-killer",
      status: "ready",
      timestamp: new Date().toISOString(),
    }),
  );
});

app.get("/api/v1", (context) => {
  return context.json({
    documentation: "/docs/api",
    name: "OpenSession API",
    version: "v1",
  });
});

registerPublicCfpRoutes(app);

app.get("/api/v1/public/security/turnstile", (context) => {
  if (
    !context.env.TURNSTILE_SITE_KEY ||
    context.env.TURNSTILE_SITE_KEY.startsWith("CONFIGURE_")
  ) {
    return context.json(
      {
        error: {
          code: "service_unavailable",
          message: "The security check is temporarily unavailable.",
        },
        request_id: context.get("requestId"),
      },
      503,
    );
  }
  return context.json(
    turnstileConfigResponseSchema.parse({
      site_key: context.env.TURNSTILE_SITE_KEY,
    }),
  );
});

app.get("/api/v1/public/events/:slug/schedule", async (context) => {
  const startedAt = performance.now();
  const slug = context.req.param("slug");
  if (!publicSlugPattern.test(slug)) {
    return context.json(
      {
        error: {
          code: "not_found",
          message: "The published schedule does not exist.",
        },
        request_id: context.get("requestId"),
      },
      404,
    );
  }

  try {
    const result = await new D1PublicScheduleProjectionReader(
      context.env.DB,
    ).readBySlug(slug);
    if (!result) {
      return context.json(
        {
          error: {
            code: "not_found",
            message: "The published schedule does not exist.",
          },
          request_id: context.get("requestId"),
        },
        404,
      );
    }
    const response = await publicScheduleResponse(context.req.raw, result);
    emitOperationalLog("info", context.env, {
      cache_status: "miss",
      duration_ms: roundedDuration(startedAt, performance.now()),
      event: "public_projection.read",
      event_id: result.eventId,
      outcome: requestOutcome(response.status),
      projection_lag_ms: elapsedMilliseconds(result.projection.generatedAt),
      request_id: context.get("requestId"),
      route: "/api/v1/public/events/:slug/schedule",
      status: response.status,
    });
    return response;
  } catch (error) {
    emitOperationalLog("error", context.env, {
      duration_ms: roundedDuration(startedAt, performance.now()),
      error_type: error instanceof Error ? error.name : "UnknownError",
      event: "public_projection.failed",
      outcome: "failure",
      request_id: context.get("requestId"),
      route: "/api/v1/public/events/:slug/schedule",
      status: 503,
    });
    context.header("Retry-After", "30");
    return context.json(
      {
        error: {
          code: "public_projection_unavailable",
          message: "The published schedule is temporarily unavailable.",
        },
        request_id: context.get("requestId"),
      },
      503,
    );
  }
});

registerAuthRoutes(app);
registerUploadRoutes(app);
registerEmailWebhookRoutes(app);

app.notFound((context) => {
  return context.json(
    {
      error: {
        code: "not_found",
        message: "The requested API route does not exist.",
      },
      request_id: context.get("requestId"),
    },
    404,
  );
});

app.onError((error, context) => {
  const requestId = context.get("requestId");

  emitOperationalLog("error", context.env, {
    error_type: error.name,
    event: "request.failed",
    method: context.req.method,
    outcome: "failure",
    request_id: requestId,
    route: operationalRoute(context),
    status: 500,
    ...(context.env.WORKER_VERSION?.id
      ? { version_id: context.env.WORKER_VERSION.id }
      : {}),
  });

  return context.json(
    {
      error: {
        code: "internal_error",
        message: "The request could not be completed.",
      },
      request_id: requestId,
    },
    500,
  );
});

const worker = {
  fetch: app.fetch,
  async queue(
    batch: MessageBatch<unknown>,
    environment: Env,
    executionContext: ExecutionContext,
  ): Promise<void> {
    if (batch.queue.includes("projection-repair")) {
      const repairMessages = [];
      for (const message of batch.messages) {
        if (!isPublicScheduleCacheInvalidationMessage(message.body)) {
          repairMessages.push(message);
          continue;
        }
        try {
          await processPublicScheduleCacheInvalidation(
            executionContext,
            environment,
            message.body,
          );
          message.ack();
          emitOperationalLog("info", environment, {
            event: "public_schedule.cache_invalidated",
            event_id: message.body.event_id,
            outcome: "success",
            queue: "projection_repair",
          });
        } catch (error) {
          message.retry({ delaySeconds: 30 });
          emitOperationalLog("error", environment, {
            error_type: error instanceof Error ? error.name : "UnknownError",
            event: "public_schedule.cache_invalidation_failed",
            event_id: message.body.event_id,
            outcome: "failure",
            queue: "projection_repair",
          });
        }
      }
      if (repairMessages.length > 0) {
        try {
          await getBaseAuthority(environment).recoverPending();
          repairMessages.forEach((message) => message.ack());
          emitOperationalLog("info", environment, {
            attempt: repairMessages.length,
            event: "authority.repair_queue.drained",
            outcome: "success",
            queue: "projection_repair",
          });
        } catch (error) {
          repairMessages.forEach((message) =>
            message.retry({ delaySeconds: 30 }),
          );
          emitOperationalLog("error", environment, {
            error_type: error instanceof Error ? error.name : "UnknownError",
            event: "authority.repair_queue.failed",
            outcome: "failure",
            queue: "projection_repair",
          });
        }
      }
      return;
    }
    const emailMessages = [...batch.messages];
    if (!isFeatureEnabled(environment.FEATURE_FLAGS, "email")) {
      for (const message of emailMessages) {
        message.retry({ delaySeconds: 1_800 });
      }
      emitOperationalLog("warn", environment, {
        event: "email.queue.paused",
        outcome: "accepted",
        queue: "email_send",
      });
      return;
    }
    let config;
    try {
      config = parseEmailDeliveryConfig(
        environment.EMAIL_DELIVERY_CONFIG,
        environment.APP_ENV,
      );
    } catch {
      for (const message of emailMessages) {
        message.retry({ delaySeconds: 1_800 });
      }
      emitOperationalLog("error", environment, {
        error_type: "delivery_config_invalid",
        event: "email.queue.failed",
        outcome: "failure",
        queue: "email_send",
      });
      return;
    }
    const provider =
      config.mode === "sink" || !environment.RESEND_API_KEY
        ? undefined
        : new ResendEmailDeliveryProvider(environment.RESEND_API_KEY);
    const service = new EmailQueueDeliveryService({
      config,
      database: environment.DB,
      ...(provider ? { provider } : {}),
    });
    for (const message of emailMessages) {
      try {
        const result = await service.process(message.body, message.attempts);
        if (result.action === "retry") {
          message.retry({ delaySeconds: result.delaySeconds });
        } else {
          message.ack();
        }
      } catch (error) {
        if (error instanceof TypeError) {
          message.ack();
          emitOperationalLog("error", environment, {
            error_type: "invalid_queue_message",
            event: "email.queue.rejected",
            outcome: "failure",
            queue: "email_send",
          });
        } else {
          message.retry({ delaySeconds: 120 });
          emitOperationalLog("error", environment, {
            error_type: "delivery_processing_failed",
            event: "email.queue.failed",
            outcome: "failure",
            queue: "email_send",
          });
        }
      }
    }
  },
  scheduled(
    controller: ScheduledController,
    environment: Env,
    executionContext: ExecutionContext,
  ): void {
    const scheduledAt = new Date(controller.scheduledTime);
    if (controller.cron === "17 3 * * *") {
      const retentionStartedAt = performance.now();
      const retentionJobId = `retention_${scheduledAt
        .toISOString()
        .slice(0, 10)
        .replaceAll("-", "")}`;
      executionContext.waitUntil(
        Promise.all([
          pruneExpiredOperationalEvents(environment.DB),
          pruneExpiredAbuseLimits(environment.DB),
        ])
          .then(() => {
            emitOperationalLog("info", environment, {
              duration_ms: roundedDuration(
                retentionStartedAt,
                performance.now(),
              ),
              event: "operational.retention.completed",
              job_id: retentionJobId,
              outcome: "success",
            });
          })
          .catch((error: unknown) => {
            emitOperationalLog("error", environment, {
              duration_ms: roundedDuration(
                retentionStartedAt,
                performance.now(),
              ),
              error_type: error instanceof Error ? error.name : "UnknownError",
              event: "operational.retention.failed",
              job_id: retentionJobId,
              outcome: "failure",
            });
            throw error;
          }),
      );
    }

    if (controller.cron === "17 * * * *") {
      const uploadStartedAt = performance.now();
      const uploadJobId = `upload_cleanup_${scheduledAt
        .toISOString()
        .slice(0, 13)
        .replaceAll(/[-T]/g, "")}`;
      executionContext.waitUntil(
        new UploadService({
          bucket: environment.UPLOADS,
          database: environment.DB,
        })
          .cleanupExpired()
          .then((cleaned) => {
            emitOperationalLog("info", environment, {
              attempt: cleaned,
              duration_ms: roundedDuration(uploadStartedAt, performance.now()),
              event: "upload.cleanup.completed",
              job_id: uploadJobId,
              outcome: "success",
            });
          })
          .catch((error: unknown) => {
            emitOperationalLog("error", environment, {
              duration_ms: roundedDuration(uploadStartedAt, performance.now()),
              error_type: error instanceof Error ? error.name : "UnknownError",
              event: "upload.cleanup.failed",
              job_id: uploadJobId,
              outcome: "failure",
            });
            throw error;
          }),
      );
      if (isFeatureEnabled(environment.FEATURE_FLAGS, "writes")) {
        executionContext.waitUntil(
          environment.DB.prepare(
            `SELECT organization_id FROM tenant_registry
             WHERE base_key = ? AND status = 'active' ORDER BY organization_id`,
          )
            .bind(`${environment.APP_ENV}:${environment.AIRTABLE_BASE_ID}`)
            .all<{ organization_id: string }>()
            .then(async ({ results }) => {
              const webhook = await environment.DB.prepare(
                `SELECT webhook_id, committed_cursor FROM airtable_webhooks
                 WHERE base_key = ? AND status IN ('active', 'refreshing')
                   AND expiration_time > ?`,
              )
                .bind(
                  `${environment.APP_ENV}:${environment.AIRTABLE_BASE_ID}`,
                  new Date().toISOString(),
                )
                .first<{ committed_cursor: number; webhook_id: string }>();
              const authority = getBaseAuthority(environment);
              if (webhook) {
                await authority.configureWebhook(
                  webhook.webhook_id,
                  webhook.committed_cursor,
                );
              }
              if (results.length > 0) {
                await authority.synchronize(
                  results.map(({ organization_id }) => organization_id),
                );
              }
              emitOperationalLog("info", environment, {
                attempt: results.length,
                event: "authority.full_scan.completed",
                outcome: "success",
              });
            })
            .catch((error: unknown) => {
              emitOperationalLog("error", environment, {
                error_type:
                  error instanceof Error ? error.name : "UnknownError",
                event: "authority.full_scan.failed",
                outcome: "failure",
              });
              throw error;
            }),
        );
      }
    }
  },
} satisfies ExportedHandler<Env>;

export default worker;
