import {
  scheduleConflictReportSchema,
  scheduleCommandResponseSchema,
  scheduleCommandSchema,
  scheduleEntityTag,
  scheduleSnapshotSchema,
  scheduleVersionFromEntityTag,
  ScheduleAuthorityPendingError,
  ScheduleIdempotencyConflictError,
  ScheduleValidationError,
  ScheduleVersionConflictError,
  type ScheduleCommandResponse,
} from "@sessionbox-killer/contracts";
import {
  evaluateScheduleConflicts,
  ScheduleHardConflictError,
} from "@sessionbox-killer/domain";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import type { AppContext } from "../app-context";
import {
  hasEventPermission,
  loadEventAccess,
  type EventPermission,
} from "../auth/authorization";
import {
  authFailure,
  authService,
  requireSameOrigin,
  sessionToken,
} from "../auth/http";
import { isFeatureEnabled } from "../features";
import { getAgendaCoordinator } from "./binding.js";
import { D1ScheduleProjectionRepository } from "./d1-repository.js";
import { ScheduleNotFoundError } from "./service.js";

const scheduleCommandBodyLimitBytes = 8 * 1024;

interface EventCandidate {
  id: string;
  organization_id: string;
  slug: string;
}

type EventResolution =
  | { kind: "ambiguous" | "forbidden" | "not_found" }
  | { eventId: string; kind: "resolved" };

async function resolveAuthorizedEvent(
  context: Context<AppContext>,
  eventKey: string,
  user: { email: string; id: string },
  permission: EventPermission,
): Promise<EventResolution> {
  const candidates = await context.env.DB.prepare(
    `SELECT event.id, event.organization_id, event.slug
     FROM p_events AS event
     JOIN tenant_registry AS tenant
       ON tenant.organization_id = event.organization_id
      AND tenant.status = 'active'
      AND tenant.authority_ready_at IS NOT NULL
     WHERE (event.id = ?1 OR event.slug = ?1)
       AND event.source_deleted_at IS NULL
     ORDER BY CASE WHEN event.id = ?1 THEN 0 ELSE 1 END,
              event.organization_id
     LIMIT 33`,
  )
    .bind(eventKey)
    .all<EventCandidate>();
  if (candidates.results.length === 0) return { kind: "not_found" };

  const permitted: EventCandidate[] = [];
  for (const candidate of candidates.results) {
    const access = await loadEventAccess(
      context.env.DB,
      user,
      candidate.organization_id,
      candidate.id,
    );
    if (hasEventPermission(access, permission)) permitted.push(candidate);
  }

  const exactId = candidates.results.find(({ id }) => id === eventKey);
  if (exactId) {
    const resolved = permitted.find(({ id }) => id === exactId.id);
    return resolved
      ? {
          eventId: resolved.id,
          kind: "resolved",
        }
      : { kind: "forbidden" };
  }
  if (permitted.length === 0) return { kind: "forbidden" };
  if (permitted.length !== 1 || candidates.results.length > 32) {
    return { kind: "ambiguous" };
  }
  const [resolved] = permitted;
  if (!resolved) return { kind: "not_found" };
  return {
    eventId: resolved.id,
    kind: "resolved",
  };
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
  status: 400 | 412 | 422 | 428,
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
  if (error instanceof ScheduleAuthorityPendingError) {
    return context.json(
      scheduleCommandResponseSchema.parse({
        error: {
          code: error.code,
          commandId: error.commandId,
          message: error.message,
          retryable: error.retryable,
          state: error.state,
        },
        ok: false,
      }),
      202,
    );
  }
  if (error instanceof ScheduleHardConflictError) {
    return context.json(
      scheduleCommandResponseSchema.parse({
        error: {
          code: error.code,
          conflicts: error.conflicts,
          message: error.message,
        },
        ok: false,
      }),
      409,
    );
  }
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
      412,
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

function coordinatorResponse(
  context: Context<AppContext>,
  response: ScheduleCommandResponse,
) {
  if (response.ok) {
    context.header(
      "ETag",
      scheduleEntityTag(response.result.snapshot.event.version),
    );
    context.header(
      "Schedule-Version",
      String(response.result.snapshot.event.version),
    );
    return context.json(response);
  }
  const status =
    response.error.code === "schedule_authority_pending"
      ? 202
      : response.error.code === "schedule_version_conflict"
        ? 412
        : response.error.code === "schedule_validation_error"
          ? 422
          : 409;
  return context.json(response, status);
}

function scheduleSnapshotResponse(
  context: Context<AppContext>,
  snapshot: ReturnType<typeof scheduleSnapshotSchema.parse>,
) {
  context.header("ETag", scheduleEntityTag(snapshot.event.version));
  context.header("Schedule-Version", String(snapshot.event.version));
  return context.json(snapshot);
}

function eventResolutionFailure(
  context: Context<AppContext>,
  resolution: Exclude<EventResolution, { kind: "resolved" }>,
) {
  if (resolution.kind === "forbidden") {
    return standardError(
      context,
      403,
      "forbidden",
      "You do not have access to this event schedule.",
    );
  }
  if (resolution.kind === "ambiguous") {
    return context.json(
      {
        error: {
          code: "ambiguous_event_slug",
          message: "This event slug is ambiguous; use the canonical event ID.",
        },
        request_id: context.get("requestId"),
      },
      409,
    );
  }
  return standardError(
    context,
    404,
    "schedule_not_found",
    "The requested event schedule does not exist.",
  );
}

export function registerScheduleRoutes(app: Hono<AppContext>): void {
  app.use(
    "/api/events/:eventKey/schedule/commands",
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

  app.get("/api/events/:eventKey/schedule/conflicts", async (context) => {
    const eventKey = context.req.param("eventKey");
    try {
      const authentication = authService(context);
      const session = await authentication.authenticate(sessionToken(context));
      const resolution = await resolveAuthorizedEvent(
        context,
        eventKey,
        session.user,
        "session:read:any",
      );
      if (resolution.kind !== "resolved") {
        return eventResolutionFailure(context, resolution);
      }
      const snapshot = await new D1ScheduleProjectionRepository(
        context.env.DB,
      ).read(resolution.eventId);
      if (!snapshot) {
        return standardError(
          context,
          404,
          "schedule_not_found",
          "The requested event schedule does not exist.",
        );
      }
      return context.json(
        scheduleConflictReportSchema.parse(evaluateScheduleConflicts(snapshot)),
      );
    } catch (error) {
      try {
        return authFailure(context, error);
      } catch {
        return standardError(
          context,
          503,
          "schedule_projection_unavailable",
          "The event schedule conflict report is temporarily unavailable.",
        );
      }
    }
  });

  app.get("/api/events/:eventKey/schedule", async (context) => {
    const eventKey = context.req.param("eventKey");
    try {
      const authentication = authService(context);
      const session = await authentication.authenticate(sessionToken(context));
      const resolution = await resolveAuthorizedEvent(
        context,
        eventKey,
        session.user,
        "session:read:any",
      );
      if (resolution.kind !== "resolved") {
        return eventResolutionFailure(context, resolution);
      }
      const snapshot = await new D1ScheduleProjectionRepository(
        context.env.DB,
      ).read(resolution.eventId);
      if (!snapshot) {
        return standardError(
          context,
          404,
          "schedule_not_found",
          "The requested event schedule does not exist.",
        );
      }
      return scheduleSnapshotResponse(
        context,
        scheduleSnapshotSchema.parse(snapshot),
      );
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

  app.get("/api/events/:eventKey/schedule/stream", async (context) => {
    const eventKey = context.req.param("eventKey");
    try {
      const authentication = authService(context);
      const session = await authentication.authenticate(sessionToken(context));
      const resolution = await resolveAuthorizedEvent(
        context,
        eventKey,
        session.user,
        "session:read:any",
      );
      if (resolution.kind !== "resolved") {
        return eventResolutionFailure(context, resolution);
      }
      const target = new URL("https://agenda-coordinator.invalid/stream");
      target.searchParams.set("eventId", resolution.eventId);
      return getAgendaCoordinator(context.env, resolution.eventId).fetch(
        new Request(target, {
          headers: { Upgrade: context.req.header("Upgrade") ?? "" },
        }),
      );
    } catch (error) {
      try {
        return authFailure(context, error);
      } catch {
        return standardError(
          context,
          503,
          "schedule_coordinator_unavailable",
          "Live schedule updates are temporarily unavailable.",
        );
      }
    }
  });

  app.post("/api/events/:eventKey/schedule/commands", async (context) => {
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
    const ifMatch = context.req.header("If-Match");
    if (ifMatch === undefined) {
      return validationResponse(
        context,
        "If-Match",
        "Schedule commands require the ETag returned by the latest schedule read.",
        428,
        "invalid_version",
      );
    }
    const matchedVersion = scheduleVersionFromEntityTag(ifMatch);
    if (matchedVersion === null) {
      return validationResponse(
        context,
        "If-Match",
        "If-Match must contain one strong OpenSession schedule ETag.",
        400,
        "invalid_version",
      );
    }
    if (matchedVersion !== input.data.expectedVersion) {
      return validationResponse(
        context,
        "If-Match",
        "If-Match and expectedVersion must identify the same schedule version.",
        400,
        "invalid_version",
      );
    }
    const eventKey = context.req.param("eventKey");

    try {
      const authentication = authService(context);
      const session = await authentication.authenticate(sessionToken(context));
      await authentication.verifyCsrf(
        session,
        context.req.header("X-CSRF-Token") ?? null,
      );
      const resolution = await resolveAuthorizedEvent(
        context,
        eventKey,
        session.user,
        "event:manage",
      );
      if (resolution.kind !== "resolved") {
        return eventResolutionFailure(context, resolution);
      }
      if (input.data.eventId !== resolution.eventId) {
        return validationResponse(
          context,
          "eventId",
          "The schedule command must use the canonical event ID returned by the schedule snapshot.",
          422,
        );
      }
      const response = await getAgendaCoordinator(
        context.env,
        resolution.eventId,
      ).execute({
        actorId: session.user.id,
        command: input.data,
        requestId: context.get("requestId"),
      });
      return coordinatorResponse(
        context,
        scheduleCommandResponseSchema.parse(response),
      );
    } catch (error) {
      return commandFailure(context, error);
    }
  });
}
