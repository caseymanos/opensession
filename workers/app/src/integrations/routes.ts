import { airtableReconcileRequestSchema } from "@sessionbox-killer/contracts";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import type { AppContext } from "../app-context.js";
import { requestDatabase } from "../database.js";
import { hasEventPermission, loadEventAccess } from "../auth/authorization.js";
import {
  authFailure,
  authService,
  requireSameOrigin,
  sessionToken,
} from "../auth/http.js";
import { getBaseAuthority } from "../authority/binding.js";
import { isFeatureEnabled } from "../features.js";
import {
  AirtableIntegrationError,
  AirtableIntegrationService,
} from "./airtable-health.js";

interface IntegrationAccess {
  actorId: string;
  eventId: string;
  eventSlug: string;
  organizationId: string;
  session: Awaited<ReturnType<ReturnType<typeof authService>["authenticate"]>>;
}

const bodyLimitBytes = 4 * 1024;
const stableKeyPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;

function problem(
  context: Context<AppContext>,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 503,
  code: string,
  detail: string,
) {
  return context.json(
    {
      code,
      detail,
      request_id: context.get("requestId"),
      status,
      title: status >= 500 ? "Integration unavailable" : "Request rejected",
      type: `https://opensession.invalid/problems/${code}`,
    },
    status,
  );
}

async function resolveAccess(
  context: Context<AppContext>,
): Promise<IntegrationAccess | null> {
  const eventKey = context.req.param("eventKey");
  if (typeof eventKey !== "string" || !stableKeyPattern.test(eventKey)) {
    return null;
  }
  const authentication = authService(context);
  const session = await authentication.authenticate(sessionToken(context));
  const database = requestDatabase(context);
  const event = await database
    .prepare(
      `SELECT event.id, event.organization_id, event.slug
     FROM p_events AS event
     JOIN tenant_registry AS tenant
       ON tenant.organization_id = event.organization_id
      AND tenant.status = 'active'
     WHERE (event.id = ? OR event.slug = ?) AND event.source_deleted_at IS NULL
     ORDER BY CASE WHEN event.id = ? THEN 0 ELSE 1 END LIMIT 1`,
    )
    .bind(eventKey, eventKey, eventKey)
    .first<{ id: string; organization_id: string; slug: string }>();
  if (!event) return null;
  const access = await loadEventAccess(
    database,
    session.user,
    event.organization_id,
    event.id,
    { requireAuthorityReady: false },
  );
  if (!hasEventPermission(access, "organization:manage")) {
    throw new AirtableIntegrationError(
      "integration_not_authorized",
      "Only an active organization owner can inspect or reconcile Airtable.",
      403,
    );
  }
  return {
    actorId: session.user.id,
    eventId: event.id,
    eventSlug: event.slug,
    organizationId: event.organization_id,
    session,
  };
}

function service(context: Context<AppContext>): AirtableIntegrationService {
  return new AirtableIntegrationService({
    authority: getBaseAuthority(context.env),
    baseId: context.env.AIRTABLE_BASE_ID,
    database: context.env.DB,
    environment: context.env.APP_ENV,
  });
}

function failure(context: Context<AppContext>, error: unknown) {
  if (
    error instanceof AirtableIntegrationError ||
    (error instanceof Error &&
      error.name === "AirtableIntegrationError" &&
      "code" in error &&
      typeof error.code === "string" &&
      "status" in error &&
      (error.status === 400 ||
        error.status === 403 ||
        error.status === 409 ||
        error.status === 503))
  ) {
    const integrationError = error as AirtableIntegrationError;
    return problem(
      context,
      integrationError.status,
      integrationError.code,
      integrationError.message,
    );
  }
  try {
    return authFailure(context, error);
  } catch {
    return problem(
      context,
      503,
      "airtable_integration_unavailable",
      "Airtable health is temporarily unavailable.",
    );
  }
}

export function registerAirtableIntegrationRoutes(app: Hono<AppContext>): void {
  app.use(
    "/api/events/:eventKey/integrations/airtable/reconcile",
    bodyLimit({
      maxSize: bodyLimitBytes,
      onError: (context) =>
        problem(
          context,
          413,
          "request_too_large",
          "The reconciliation request exceeds 4 KiB.",
        ),
    }),
  );

  app.get(
    "/api/events/:eventKey/integrations/airtable/health",
    async (context) => {
      try {
        const access = await resolveAccess(context);
        if (!access) {
          return problem(
            context,
            404,
            "integration_not_found",
            "The Airtable integration is not available for this event.",
          );
        }
        context.header("Cache-Control", "no-store");
        return context.json(
          await service(context).health(access.organizationId, access.eventId),
        );
      } catch (error) {
        return failure(context, error);
      }
    },
  );

  app.post(
    "/api/events/:eventKey/integrations/airtable/reconcile",
    async (context) => {
      if (!requireSameOrigin(context)) {
        return problem(
          context,
          403,
          "invalid_origin",
          "This request must originate from OpenSession and use JSON.",
        );
      }
      let body: unknown;
      try {
        body = await context.req.json();
      } catch {
        body = null;
      }
      const input = airtableReconcileRequestSchema.safeParse(body);
      if (!input.success) {
        return problem(
          context,
          400,
          "invalid_reconcile_request",
          input.error.issues[0]?.message ?? "The request is invalid.",
        );
      }
      if (!isFeatureEnabled(context.env.FEATURE_FLAGS, "integrations")) {
        return problem(
          context,
          503,
          "integrations_disabled",
          "Provider operations are temporarily disabled.",
        );
      }
      if (
        input.data.mode === "apply" &&
        !isFeatureEnabled(context.env.FEATURE_FLAGS, "writes")
      ) {
        return problem(
          context,
          503,
          "writes_disabled",
          "Changes are temporarily disabled in this environment.",
        );
      }
      try {
        const access = await resolveAccess(context);
        if (!access) {
          return problem(
            context,
            404,
            "integration_not_found",
            "The Airtable integration is not available for this event.",
          );
        }
        await authService(context).verifyCsrf(
          access.session,
          context.req.header("X-CSRF-Token") ?? null,
        );
        context.header("Cache-Control", "no-store");
        if (input.data.mode === "dry_run") {
          return context.json(
            await service(context).dryRun(
              access.organizationId,
              access.eventSlug,
            ),
          );
        }
        const idempotencyKey = context.req.header("Idempotency-Key") ?? "";
        if (!stableKeyPattern.test(idempotencyKey)) {
          return problem(
            context,
            400,
            "invalid_idempotency_key",
            "Apply requires a stable Idempotency-Key header.",
          );
        }
        return context.json(
          await service(context).apply({
            actorId: access.actorId,
            confirmation: input.data.confirmation,
            eventId: access.eventId,
            eventSlug: access.eventSlug,
            idempotencyKey,
            organizationId: access.organizationId,
            planId: input.data.plan_id,
            requestId: context.get("requestId"),
          }),
        );
      } catch (error) {
        return failure(context, error);
      }
    },
  );
}
