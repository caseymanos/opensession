import {
  scheduleCommandResponseSchema,
  scheduleCommandSchema,
  scheduleSnapshotSchema,
  ScheduleIdempotencyConflictError,
  ScheduleValidationError,
  ScheduleVersionConflictError,
} from "@sessionbox-killer/contracts";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import type { AppContext } from "../app-context";
import { hasEventPermission, loadEventAccess } from "../auth/authorization";
import {
  authFailure,
  authService,
  requireSameOrigin,
  sessionToken,
} from "../auth/http";
import { getBaseAuthority } from "../authority/binding.js";
import { isFeatureEnabled } from "../features";
import {
  AirtableScheduleCommandService,
  ScheduleNotFoundError,
} from "./service.js";

const scheduleCommandBodyLimitBytes = 8 * 1024;

async function eventOrganizationId(
  context: Context<AppContext>,
  eventId: string,
): Promise<string | null> {
  const row = await context.env.DB.prepare(
    `SELECT event.organization_id
     FROM p_events AS event
     JOIN tenant_registry AS tenant
       ON tenant.organization_id = event.organization_id
      AND tenant.status = 'active'
      AND tenant.authority_ready_at IS NOT NULL
     WHERE event.id = ?1 AND event.source_deleted_at IS NULL
     LIMIT 1`,
  )
    .bind(eventId)
    .first<{ organization_id: string }>();
  return row?.organization_id ?? null;
}

function standardError(
  context: Context<AppContext>,
  status: 403 | 404 | 413 | 503,
  code: string,
  message: string,
) {
  return context.json(
    {
      error: { code, message },
      request_id: context.get("requestId"),
    },
    status,
  );
}

async function parsedJson(context: Context<AppContext>): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    return null;
  }
}

function validationResponse(
  context: Context<AppContext>,
  field: string,
  message: string,
  status: 400 | 422,
  reason: ScheduleValidationError["reason"] = "invalid_command",
) {
  return context.json(
    scheduleCommandResponseSchema.parse({
      error: {
        code: "schedule_validation_error",
        field,
        message,
        reason,
      },
      ok: false,
    }),
    status,
  );
}

function commandFailure(context: Context<AppContext>, error: unknown) {
  if (error instanceof ScheduleValidationError) {
    return validationResponse(
      context,
      error.field,
      error.message,
      422,
      error.reason,
    );
  }
  if (error instanceof ScheduleVersionConflictError) {
    return context.json(
      scheduleCommandResponseSchema.parse({
        error: {
          actualVersion: error.actualVersion,
          code: error.code,
          expectedVersion: error.expectedVersion,
          message: error.message,
        },
        ok: false,
      }),
      409,
    );
  }
  if (error instanceof ScheduleIdempotencyConflictError) {
    return context.json(
      scheduleCommandResponseSchema.parse({
        error: {
          code: error.code,
          commandId: error.commandId,
          message: error.message,
        },
        ok: false,
      }),
      409,
    );
  }
  if (error instanceof ScheduleNotFoundError) {
    return standardError(
      context,
      404,
      "schedule_not_found",
      "The requested event schedule does not exist.",
    );
  }
  try {
    return authFailure(context, error);
  } catch {
    return standardError(
      context,
      503,
      "schedule_authority_unavailable",
      "The authoritative schedule is temporarily unavailable.",
    );
  }
}

export function registerScheduleRoutes(app: Hono<AppContext>): void {
  app.use(
    "/api/events/:eventId/schedule/commands",
    bodyLimit({
      maxSize: scheduleCommandBodyLimitBytes,
      onError: (context) =>
        standardError(
          context,
          413,
          "request_too_large",
          "The request body is too large.",
        ),
    }),
  );

  app.get("/api/events/:eventId/schedule", async (context) => {
    const eventId = context.req.param("eventId");
    try {
      const organizationId = await eventOrganizationId(context, eventId);
      if (!organizationId) {
        return standardError(
          context,
          404,
          "schedule_not_found",
          "The requested event schedule does not exist.",
        );
      }
      const authentication = authService(context);
      const session = await authentication.authenticate(sessionToken(context));
      const access = await loadEventAccess(
        context.env.DB,
        session.user,
        organizationId,
        eventId,
      );
      if (!hasEventPermission(access, "session:read:any")) {
        return standardError(
          context,
          403,
          "forbidden",
          "You do not have access to this event schedule.",
        );
      }
      const snapshot = await new AirtableScheduleCommandService({
        actorId: session.user.id,
        authority: getBaseAuthority(context.env),
        database: context.env.DB,
        requestId: context.get("requestId"),
      }).read(eventId);
      if (!snapshot) {
        return standardError(
          context,
          404,
          "schedule_not_found",
          "The requested event schedule does not exist.",
        );
      }
      return context.json(scheduleSnapshotSchema.parse(snapshot));
    } catch (error) {
      try {
        return authFailure(context, error);
      } catch {
        return standardError(
          context,
          503,
          "schedule_projection_unavailable",
          "The event schedule is temporarily unavailable.",
        );
      }
    }
  });

  app.post("/api/events/:eventId/schedule/commands", async (context) => {
    if (!isFeatureEnabled(context.env.FEATURE_FLAGS, "writes")) {
      return standardError(
        context,
        503,
        "writes_disabled",
        "Changes are temporarily disabled in this environment.",
      );
    }
    if (!requireSameOrigin(context)) {
      return standardError(
        context,
        403,
        "invalid_origin",
        "This request must originate from OpenSession.",
      );
    }

    const input = scheduleCommandSchema.safeParse(await parsedJson(context));
    if (!input.success) {
      const issue = input.error.issues[0];
      return validationResponse(
        context,
        issue?.path.join(".") || "command",
        issue?.message ?? "The schedule command is invalid.",
        400,
      );
    }
    const eventId = context.req.param("eventId");
    if (input.data.eventId !== eventId) {
      return validationResponse(
        context,
        "eventId",
        "The schedule command must target the event in the route.",
        422,
      );
    }

    try {
      const organizationId = await eventOrganizationId(context, eventId);
      if (!organizationId) throw new ScheduleNotFoundError(eventId);
      const authentication = authService(context);
      const session = await authentication.authenticate(sessionToken(context));
      await authentication.verifyCsrf(
        session,
        context.req.header("X-CSRF-Token") ?? null,
      );
      const access = await loadEventAccess(
        context.env.DB,
        session.user,
        organizationId,
        eventId,
      );
      if (!hasEventPermission(access, "event:manage")) {
        return standardError(
          context,
          403,
          "forbidden",
          "You do not have permission to change this event schedule.",
        );
      }
      const result = await new AirtableScheduleCommandService({
        actorId: session.user.id,
        authority: getBaseAuthority(context.env),
        database: context.env.DB,
        requestId: context.get("requestId"),
      }).execute(input.data);
      return context.json(
        scheduleCommandResponseSchema.parse({ ok: true, result }),
      );
    } catch (error) {
      return commandFailure(context, error);
    }
  });
}
