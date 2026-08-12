import {
  cfpFormEntityTag,
  cfpFormVersionFromEntityTag,
  organizerCfpFormCloseRequestSchema,
  organizerCfpFormMutationResponseSchema,
  organizerCfpFormPublishRequestSchema,
  organizerCfpFormReadResponseSchema,
  organizerCfpFormSaveRequestSchema,
} from "@sessionbox-killer/contracts";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import type { AppContext } from "../app-context";
import { requestDatabase } from "../database.js";
import { getBaseAuthority } from "../authority/binding.js";
import {
  AuthorityCommandFailedError,
  AuthorityIdempotencyConflictError,
  AuthorityOutcomeUnknownError,
} from "../authority/types.js";
import { hasEventPermission, loadEventAccess } from "../auth/authorization";
import {
  authFailure,
  authService,
  requireSameOrigin,
  sessionToken,
} from "../auth/http";
import { isFeatureEnabled } from "../features";
import type { AuthenticatedSession } from "../auth/service";
import {
  CfpFormPlanIdempotencyConflictError,
  CfpFormPlanInProgressError,
  CfpFormPlanPreconditionError,
} from "./form-authority.js";
import {
  CfpFormNotFoundError,
  CfpFormProjectionError,
  CfpFormService,
  CfpFormStateError,
  CfpFormValidationError,
  CfpFormVersionConflictError,
} from "./form-service.js";

const bodyLimitBytes = 1024 * 1_024;

interface EventCandidate {
  id: string;
  organization_id: string;
}

type EventResolution =
  | { eventId: string; kind: "resolved" }
  | { kind: "ambiguous" | "forbidden" | "not_found" };

type CfpFormServiceContext =
  | {
      kind: "failure";
      resolution: Exclude<EventResolution, { kind: "resolved" }>;
    }
  | {
      authentication: ReturnType<typeof authService>;
      eventId: string;
      kind: "ready";
      service: CfpFormService;
      session: AuthenticatedSession;
    };

async function resolveManagedEvent(
  context: Context<AppContext>,
  eventKey: string,
  user: { email: string; id: string },
): Promise<EventResolution> {
  const database = requestDatabase(context);
  const candidates = await database
    .prepare(
      `SELECT event.id, event.organization_id
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
      database,
      user,
      candidate.organization_id,
      candidate.id,
    );
    if (hasEventPermission(access, "event:manage")) permitted.push(candidate);
  }
  const exact = candidates.results.find(({ id }) => id === eventKey);
  if (exact) {
    return permitted.some(({ id }) => id === exact.id)
      ? { eventId: exact.id, kind: "resolved" }
      : { kind: "forbidden" };
  }
  if (permitted.length === 0) return { kind: "forbidden" };
  if (permitted.length !== 1 || candidates.results.length > 32) {
    return { kind: "ambiguous" };
  }
  const event = permitted[0];
  return event
    ? { eventId: event.id, kind: "resolved" }
    : { kind: "not_found" };
}

function errorResponse(
  context: Context<AppContext>,
  status: 400 | 403 | 404 | 409 | 412 | 413 | 422 | 428 | 503,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
) {
  return context.json(
    {
      error: { code, message, ...details },
      request_id: context.get("requestId"),
    },
    status,
  );
}

function resolutionFailure(
  context: Context<AppContext>,
  resolution: Exclude<EventResolution, { kind: "resolved" }>,
) {
  if (resolution.kind === "forbidden") {
    return errorResponse(
      context,
      403,
      "forbidden",
      "You do not have access to manage this CFP form.",
    );
  }
  if (resolution.kind === "ambiguous") {
    return errorResponse(
      context,
      409,
      "ambiguous_event_slug",
      "This event slug is ambiguous; use the canonical event ID.",
    );
  }
  return errorResponse(
    context,
    404,
    "cfp_form_not_found",
    "The requested CFP form does not exist.",
  );
}

function formResponse(
  context: Context<AppContext>,
  value: ReturnType<typeof organizerCfpFormReadResponseSchema.parse>,
) {
  context.header("Cache-Control", "private, no-store");
  context.header("ETag", cfpFormEntityTag(value.form));
  return context.json(value);
}

function mutationResponse(
  context: Context<AppContext>,
  value: ReturnType<typeof organizerCfpFormMutationResponseSchema.parse>,
) {
  context.header("Cache-Control", "private, no-store");
  context.header("ETag", cfpFormEntityTag(value.result.form));
  return context.json(value);
}

async function json(context: Context<AppContext>): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    return null;
  }
}

function mutationPrecondition(
  context: Context<AppContext>,
  request: {
    commandId: string;
    expectedFormId: string;
    expectedSourceVersion: number;
  },
) {
  const idempotencyKey = context.req.header("Idempotency-Key");
  if (!idempotencyKey) {
    return errorResponse(
      context,
      428,
      "idempotency_key_required",
      "CFP form changes require an Idempotency-Key header.",
    );
  }
  if (idempotencyKey !== request.commandId) {
    return errorResponse(
      context,
      400,
      "idempotency_key_mismatch",
      "Idempotency-Key must match the command identifier.",
    );
  }
  const entityTag = context.req.header("If-Match");
  if (!entityTag) {
    return errorResponse(
      context,
      428,
      "form_version_required",
      "CFP form changes require the ETag from the latest read.",
    );
  }
  const version = cfpFormVersionFromEntityTag(entityTag);
  if (
    !version ||
    version.formId !== request.expectedFormId ||
    version.sourceVersion !== request.expectedSourceVersion
  ) {
    return errorResponse(
      context,
      400,
      "form_version_mismatch",
      "If-Match must identify the same form revision as the request.",
    );
  }
  return null;
}

function failure(context: Context<AppContext>, error: unknown) {
  if (error instanceof CfpFormValidationError) {
    return errorResponse(context, 422, "cfp_form_validation", error.message, {
      diagnostics: error.diagnostics,
    });
  }
  if (error instanceof CfpFormVersionConflictError) {
    context.header(
      "ETag",
      cfpFormEntityTag({
        id: error.actualFormId,
        sourceVersion: error.actualSourceVersion,
      }),
    );
    return errorResponse(
      context,
      412,
      "cfp_form_version_conflict",
      error.message,
      {
        actualFormId: error.actualFormId,
        actualSourceVersion: error.actualSourceVersion,
      },
    );
  }
  if (error instanceof CfpFormPlanPreconditionError) {
    context.header(
      "ETag",
      cfpFormEntityTag({
        id: error.actualFormId,
        sourceVersion: error.actualSourceVersion,
      }),
    );
    return errorResponse(
      context,
      412,
      "cfp_form_version_conflict",
      error.message,
      {
        actualFormId: error.actualFormId,
        actualSourceVersion: error.actualSourceVersion,
      },
    );
  }
  if (
    error instanceof CfpFormStateError ||
    error instanceof CfpFormPlanInProgressError ||
    error instanceof CfpFormPlanIdempotencyConflictError ||
    error instanceof AuthorityIdempotencyConflictError
  ) {
    return errorResponse(context, 409, error.name, error.message);
  }
  if (error instanceof CfpFormNotFoundError) {
    return errorResponse(context, 404, "cfp_form_not_found", error.message);
  }
  if (error instanceof AuthorityCommandFailedError) {
    return errorResponse(
      context,
      error.status === 409 ? 409 : 503,
      error.name,
      error.message,
    );
  }
  if (
    error instanceof AuthorityOutcomeUnknownError ||
    error instanceof CfpFormProjectionError
  ) {
    return errorResponse(
      context,
      503,
      "cfp_form_authority_unavailable",
      "The authoritative CFP form is temporarily unavailable.",
    );
  }
  try {
    return authFailure(context, error);
  } catch {
    return errorResponse(
      context,
      503,
      "cfp_form_authority_unavailable",
      "The authoritative CFP form is temporarily unavailable.",
    );
  }
}

async function serviceContext(
  context: Context<AppContext>,
  eventKey: string,
): Promise<CfpFormServiceContext> {
  const authentication = authService(context);
  const session = await authentication.authenticate(sessionToken(context));
  const resolution = await resolveManagedEvent(context, eventKey, session.user);
  if (resolution.kind !== "resolved") {
    return { kind: "failure", resolution };
  }
  return {
    authentication,
    eventId: resolution.eventId,
    kind: "ready",
    service: new CfpFormService({
      actorId: session.user.id,
      authority: getBaseAuthority(context.env),
      database: context.env.DB,
    }),
    session,
  };
}

export function registerOrganizerCfpFormRoutes(app: Hono<AppContext>): void {
  for (const path of [
    "/api/events/:eventKey/cfp/form",
    "/api/events/:eventKey/cfp/form/publish",
    "/api/events/:eventKey/cfp/form/close",
  ]) {
    app.use(
      path,
      bodyLimit({
        maxSize: bodyLimitBytes,
        onError: (context) =>
          errorResponse(
            context,
            413,
            "request_too_large",
            "The CFP form request is too large.",
          ),
      }),
    );
  }

  app.get("/api/events/:eventKey/cfp/form", async (context) => {
    try {
      const resolved = await serviceContext(
        context,
        context.req.param("eventKey") ?? "",
      );
      if (resolved.kind !== "ready") {
        return resolutionFailure(context, resolved.resolution);
      }
      return formResponse(
        context,
        organizerCfpFormReadResponseSchema.parse(
          await resolved.service.read(resolved.eventId),
        ),
      );
    } catch (error) {
      return failure(context, error);
    }
  });

  const mutate = async (
    context: Context<AppContext>,
    mode: "close" | "publish" | "save",
  ) => {
    if (!isFeatureEnabled(context.env.FEATURE_FLAGS, "writes")) {
      return errorResponse(
        context,
        503,
        "writes_disabled",
        "Changes are temporarily disabled in this environment.",
      );
    }
    if (!requireSameOrigin(context)) {
      return errorResponse(
        context,
        403,
        "invalid_origin",
        "This request must originate from OpenSession.",
      );
    }
    const schema =
      mode === "save"
        ? organizerCfpFormSaveRequestSchema
        : mode === "publish"
          ? organizerCfpFormPublishRequestSchema
          : organizerCfpFormCloseRequestSchema;
    const parsed = schema.safeParse(await json(context));
    if (!parsed.success) {
      return errorResponse(
        context,
        400,
        "invalid_cfp_form_request",
        "The CFP form request is invalid.",
        {
          issues: parsed.error.issues.slice(0, 32).map((issue) => ({
            message: issue.message,
            path: issue.path.join("."),
          })),
        },
      );
    }
    const precondition = mutationPrecondition(context, parsed.data);
    if (precondition) return precondition;
    try {
      const resolved = await serviceContext(
        context,
        context.req.param("eventKey") ?? "",
      );
      if (resolved.kind !== "ready") {
        return resolutionFailure(context, resolved.resolution);
      }
      await resolved.authentication.verifyCsrf(
        resolved.session,
        context.req.header("X-CSRF-Token") ?? null,
      );
      const result =
        mode === "save"
          ? await resolved.service.save(
              resolved.eventId,
              organizerCfpFormSaveRequestSchema.parse(parsed.data),
            )
          : mode === "publish"
            ? await resolved.service.publish(
                resolved.eventId,
                organizerCfpFormPublishRequestSchema.parse(parsed.data),
              )
            : await resolved.service.close(
                resolved.eventId,
                organizerCfpFormCloseRequestSchema.parse(parsed.data),
              );
      return mutationResponse(
        context,
        organizerCfpFormMutationResponseSchema.parse(result),
      );
    } catch (error) {
      return failure(context, error);
    }
  };

  app.put("/api/events/:eventKey/cfp/form", (context) =>
    mutate(context, "save"),
  );
  app.post("/api/events/:eventKey/cfp/form/publish", (context) =>
    mutate(context, "publish"),
  );
  app.post("/api/events/:eventKey/cfp/form/close", (context) =>
    mutate(context, "close"),
  );
}
