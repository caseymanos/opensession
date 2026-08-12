import {
  organizerSubmissionCommandResponseSchema,
  organizerSubmissionCommandSchema,
  organizerSubmissionListQuerySchema,
} from "@sessionbox-killer/contracts";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import type { AppContext } from "../app-context";
import { requestDatabase } from "../database.js";
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
  OrganizerSubmissionIdempotencyConflictError,
  OrganizerSubmissionNotFoundError,
  OrganizerSubmissionValidationError,
  OrganizerSubmissionVersionConflictError,
} from "./policy.js";
import {
  D1OrganizerSubmissionRepository,
  OrganizerSubmissionCursorError,
  OrganizerSubmissionProjectionUnavailableError,
} from "./repository.js";
import { AirtableOrganizerSubmissionCommandService } from "./service.js";

const commandBodyLimitBytes = 16 * 1024;
const eventKeyPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const queryNames = new Set(["cursor", "page_size", "q", "status", "track"]);

interface EventCandidate {
  authority_ready_at: string | null;
  id: string;
  organization_id: string;
  slug: string;
}

type EventResolution =
  | { kind: "ambiguous" | "forbidden" | "not_found" }
  | {
      authorityReady: boolean;
      eventId: string;
      kind: "resolved";
      organizationId: string;
    };

function errorResponse(
  context: Context<AppContext>,
  status: 400 | 403 | 404 | 409 | 413 | 422 | 503,
  error: Record<string, unknown>,
) {
  return context.json(
    {
      error,
      request_id: context.get("requestId"),
    },
    status,
  );
}

function simpleError(
  context: Context<AppContext>,
  status: 403 | 404 | 409 | 413 | 503,
  code: string,
  message: string,
) {
  return errorResponse(context, status, { code, message });
}

function validationError(
  context: Context<AppContext>,
  field: string,
  message: string,
  reason:
    | "illegal_transition"
    | "invalid_command"
    | "invalid_cursor"
    | "invalid_query",
  status: 400 | 422 = 400,
) {
  return errorResponse(context, status, {
    code: "submission_validation_error",
    field,
    message,
    reason,
  });
}

function commandErrorResponse(
  context: Context<AppContext>,
  status: 400 | 409 | 422,
  error: Record<string, unknown>,
) {
  return context.json(
    organizerSubmissionCommandResponseSchema.parse({ error, ok: false }),
    status,
  );
}

function commandValidationError(
  context: Context<AppContext>,
  field: string,
  message: string,
  reason: "illegal_transition" | "invalid_command",
  status: 400 | 422 = 400,
) {
  return commandErrorResponse(context, status, {
    code: "submission_validation_error",
    field,
    message,
    reason,
  });
}

async function resolveAuthorizedEvent(
  context: Context<AppContext>,
  eventKey: string,
  user: { email: string; id: string },
): Promise<EventResolution> {
  if (!eventKeyPattern.test(eventKey)) return { kind: "not_found" };
  const database = requestDatabase(context);
  const candidates = await database
    .prepare(
      `SELECT event.id, event.organization_id, event.slug,
            tenant.authority_ready_at
     FROM p_events AS event
     JOIN tenant_registry AS tenant
       ON tenant.organization_id = event.organization_id
      AND tenant.status = 'active'
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
      database,
      user,
      candidate.organization_id,
      candidate.id,
      { requireAuthorityReady: false },
    );
    if (hasEventPermission(access, "event:manage")) permitted.push(candidate);
  }
  const exact = candidates.results.find(({ id }) => id === eventKey);
  if (exact) {
    const allowed = permitted.find(({ id }) => id === exact.id);
    return allowed
      ? {
          authorityReady: allowed.authority_ready_at !== null,
          eventId: allowed.id,
          kind: "resolved",
          organizationId: allowed.organization_id,
        }
      : { kind: "forbidden" };
  }
  if (permitted.length === 0) return { kind: "forbidden" };
  if (permitted.length !== 1 || candidates.results.length > 32) {
    return { kind: "ambiguous" };
  }
  const [allowed] = permitted;
  if (!allowed) return { kind: "not_found" };
  return {
    authorityReady: allowed.authority_ready_at !== null,
    eventId: allowed.id,
    kind: "resolved",
    organizationId: allowed.organization_id,
  };
}

function resolutionError(
  context: Context<AppContext>,
  resolution: Exclude<EventResolution, { kind: "resolved" }>,
) {
  if (resolution.kind === "forbidden") {
    return simpleError(
      context,
      403,
      "forbidden",
      "You do not have permission to manage submissions for this event.",
    );
  }
  if (resolution.kind === "ambiguous") {
    return simpleError(
      context,
      409,
      "ambiguous_event_slug",
      "This event slug is ambiguous; use the canonical event ID.",
    );
  }
  return simpleError(
    context,
    404,
    "submission_not_found",
    "The requested organizer submission resource does not exist.",
  );
}

function parseListQuery(context: Context<AppContext>) {
  const url = new URL(context.req.url);
  for (const name of url.searchParams.keys()) {
    if (!queryNames.has(name) || url.searchParams.getAll(name).length !== 1) {
      return {
        error: validationError(
          context,
          name || "query",
          "The submission query contains an unknown or repeated filter.",
          "invalid_query",
        ),
      } as const;
    }
  }
  const rawPageSize = url.searchParams.get("page_size");
  const pageSize =
    rawPageSize === null || !/^\d{1,3}$/u.test(rawPageSize)
      ? rawPageSize === null
        ? undefined
        : Number.NaN
      : Number(rawPageSize);
  const result = organizerSubmissionListQuerySchema.safeParse({
    ...(url.searchParams.has("cursor")
      ? { cursor: url.searchParams.get("cursor") }
      : {}),
    ...(pageSize === undefined ? {} : { pageSize }),
    ...(url.searchParams.has("q") ? { search: url.searchParams.get("q") } : {}),
    ...(url.searchParams.has("status")
      ? { status: url.searchParams.get("status") }
      : {}),
    ...(url.searchParams.has("track")
      ? { track: url.searchParams.get("track") }
      : {}),
  });
  if (!result.success) {
    const issue = result.error.issues[0];
    return {
      error: validationError(
        context,
        issue?.path.join(".") || "query",
        issue?.message ?? "The submission query is invalid.",
        "invalid_query",
      ),
    } as const;
  }
  return { data: result.data } as const;
}

async function authenticateOrganizer(context: Context<AppContext>) {
  const authentication = authService(context);
  const session = await authentication.authenticate(sessionToken(context));
  const resolution = await resolveAuthorizedEvent(
    context,
    context.req.param("eventKey") ?? "",
    session.user,
  );
  return { authentication, resolution, session };
}

export function registerOrganizerSubmissionRoutes(app: Hono<AppContext>): void {
  app.use(
    "/api/events/:eventKey/submissions/commands",
    bodyLimit({
      maxSize: commandBodyLimitBytes,
      onError: (context) =>
        simpleError(
          context,
          413,
          "request_too_large",
          "The submission command body is too large.",
        ),
    }),
  );

  app.get("/api/events/:eventKey/submissions", async (context) => {
    const query = parseListQuery(context);
    if ("error" in query) return query.error;
    try {
      const { resolution } = await authenticateOrganizer(context);
      if (resolution.kind !== "resolved") {
        return resolutionError(context, resolution);
      }
      return context.json(
        await new D1OrganizerSubmissionRepository(context.env.DB).list(
          {
            eventId: resolution.eventId,
            organizationId: resolution.organizationId,
          },
          query.data,
        ),
      );
    } catch (error) {
      if (error instanceof OrganizerSubmissionCursorError) {
        return validationError(
          context,
          "cursor",
          error.message,
          "invalid_cursor",
        );
      }
      try {
        return authFailure(context, error);
      } catch {
        return simpleError(
          context,
          503,
          "submission_projection_unavailable",
          "The organizer submission projection is temporarily unavailable.",
        );
      }
    }
  });

  app.get(
    "/api/events/:eventKey/submissions/:submissionId",
    async (context) => {
      try {
        const { resolution } = await authenticateOrganizer(context);
        if (resolution.kind !== "resolved") {
          return resolutionError(context, resolution);
        }
        const detail = await new D1OrganizerSubmissionRepository(
          context.env.DB,
        ).detail(
          {
            eventId: resolution.eventId,
            organizationId: resolution.organizationId,
          },
          context.req.param("submissionId"),
        );
        if (!detail) {
          return simpleError(
            context,
            404,
            "submission_not_found",
            "The requested submission does not exist.",
          );
        }
        return context.json(detail);
      } catch (error) {
        try {
          return authFailure(context, error);
        } catch {
          return simpleError(
            context,
            503,
            "submission_projection_unavailable",
            "The organizer submission projection is temporarily unavailable.",
          );
        }
      }
    },
  );

  app.post("/api/events/:eventKey/submissions/commands", async (context) => {
    if (!isFeatureEnabled(context.env.FEATURE_FLAGS, "writes")) {
      return simpleError(
        context,
        503,
        "writes_disabled",
        "Changes are temporarily disabled in this environment.",
      );
    }
    if (!requireSameOrigin(context)) {
      return simpleError(
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
    const input = organizerSubmissionCommandSchema.safeParse(body);
    if (!input.success) {
      const issue = input.error.issues[0];
      return commandValidationError(
        context,
        issue?.path.join(".") || "command",
        issue?.message ?? "The submission command is invalid.",
        "invalid_command",
      );
    }
    try {
      const { authentication, resolution, session } =
        await authenticateOrganizer(context);
      await authentication.verifyCsrf(
        session,
        context.req.header("X-CSRF-Token") ?? null,
      );
      if (resolution.kind !== "resolved") {
        return resolutionError(context, resolution);
      }
      if (!resolution.authorityReady) {
        return simpleError(
          context,
          503,
          "submission_authority_unavailable",
          "Authoritative submission changes are temporarily unavailable.",
        );
      }
      const result = await new AirtableOrganizerSubmissionCommandService({
        actorDisplayName:
          session.user.displayName ??
          session.user.email.split("@")[0] ??
          "Organizer",
        actorId: session.user.id,
        authority: getBaseAuthority(context.env),
        database: context.env.DB,
        eventId: resolution.eventId,
        organizationId: resolution.organizationId,
        requestId: context.get("requestId"),
      }).execute(input.data);
      return context.json(
        organizerSubmissionCommandResponseSchema.parse({ ok: true, result }),
      );
    } catch (error) {
      if (error instanceof OrganizerSubmissionValidationError) {
        return commandValidationError(
          context,
          error.field,
          error.message,
          error.reason,
          422,
        );
      }
      if (error instanceof OrganizerSubmissionVersionConflictError) {
        return commandErrorResponse(context, 409, {
          actualVersion: error.actualVersion,
          code: "submission_version_conflict",
          expectedVersion: error.expectedVersion,
          message: error.message,
        });
      }
      if (error instanceof OrganizerSubmissionIdempotencyConflictError) {
        return commandErrorResponse(context, 409, {
          code: "submission_idempotency_conflict",
          commandId: error.commandId,
          message: error.message,
        });
      }
      if (error instanceof OrganizerSubmissionNotFoundError) {
        return simpleError(context, 404, "submission_not_found", error.message);
      }
      if (error instanceof OrganizerSubmissionProjectionUnavailableError) {
        return simpleError(
          context,
          503,
          "submission_projection_unavailable",
          error.message,
        );
      }
      try {
        return authFailure(context, error);
      } catch {
        return simpleError(
          context,
          503,
          "submission_authority_unavailable",
          "The authoritative submission command is temporarily unavailable.",
        );
      }
    }
  });
}
