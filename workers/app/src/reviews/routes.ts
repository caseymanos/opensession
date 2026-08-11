import {
  reviewOperationsCommandResponseSchema,
  reviewOperationsCommandSchema,
  reviewScoringCommandSchema,
  recordDecisionCommandSchema,
} from "@sessionbox-killer/contracts";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import type { AppContext } from "../app-context.js";
import {
  AcceptanceOrchestrationPendingError,
  AcceptanceOrchestrationService,
} from "../acceptance/service.js";
import {
  hasEventPermission,
  loadEventAccess,
  type EventAccess,
} from "../auth/authorization.js";
import {
  authFailure,
  authService,
  requireSameOrigin,
  sessionToken,
} from "../auth/http.js";
import { getBaseAuthority } from "../authority/binding.js";
import { parseEmailDeliveryConfig } from "../email/config.js";
import { isFeatureEnabled } from "../features.js";
import { D1DecisionRepository } from "../decisions/repository.js";
import {
  ReviewOperationsIdempotencyConflictError,
  ReviewOperationsNotFoundError,
  ReviewOperationsValidationError,
  ReviewOperationsVersionConflictError,
} from "./policy.js";
import {
  D1ReviewOperationsRepository,
  ReviewOperationsProjectionUnavailableError,
} from "./repository.js";
import { AirtableReviewOperationsCommandService } from "./service.js";

const eventKeyPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const commandBodyLimitBytes = 32 * 1024;

interface EventCandidate {
  authority_ready_at: string | null;
  id: string;
  name: string;
  organization_id: string;
}

type ReviewAccessResolution =
  | { kind: "ambiguous" | "forbidden" | "not_found" }
  | {
      access: EventAccess;
      authorityReady: boolean;
      eventId: string;
      eventName: string;
      kind: "resolved";
      organizationId: string;
    };

function simpleError(
  context: Context<AppContext>,
  status: 400 | 403 | 404 | 409 | 413 | 422 | 503,
  code: string,
  message: string,
) {
  return context.json(
    { error: { code, message }, request_id: context.get("requestId") },
    status,
  );
}

function commandError(
  context: Context<AppContext>,
  status: 400 | 404 | 409 | 422,
  error: {
    actualVersion?: number;
    code: string;
    commandId?: string;
    expectedVersion?: number;
    field?: string;
    message: string;
  },
) {
  return context.json(
    reviewOperationsCommandResponseSchema.parse({ error, ok: false }),
    status,
  );
}

async function resolveReviewAccess(
  context: Context<AppContext>,
  user: { email: string; id: string },
): Promise<ReviewAccessResolution> {
  const eventKey = context.req.param("eventKey") ?? "";
  if (!eventKeyPattern.test(eventKey)) return { kind: "not_found" };
  const candidates = await context.env.DB.prepare(
    `SELECT event.id, event.name, event.organization_id, tenant.authority_ready_at
     FROM p_events AS event
     JOIN tenant_registry AS tenant
       ON tenant.organization_id = event.organization_id
      AND tenant.status = 'active'
     WHERE (event.id = ?1 OR event.slug = ?1)
       AND event.source_deleted_at IS NULL
     ORDER BY CASE WHEN event.id = ?1 THEN 0 ELSE 1 END,
              event.organization_id LIMIT 33`,
  )
    .bind(eventKey)
    .all<EventCandidate>();
  if (candidates.results.length === 0) return { kind: "not_found" };
  const permitted: { access: EventAccess; event: EventCandidate }[] = [];
  for (const event of candidates.results) {
    const access = await loadEventAccess(
      context.env.DB,
      user,
      event.organization_id,
      event.id,
      { requireAuthorityReady: false },
    );
    if (
      hasEventPermission(access, "event:manage") ||
      hasEventPermission(access, "review:read")
    ) {
      permitted.push({ access, event });
    }
  }
  const exact = candidates.results.find(({ id }) => id === eventKey);
  const selected = exact
    ? permitted.find(({ event }) => event.id === exact.id)
    : permitted.length === 1 && candidates.results.length <= 32
      ? permitted[0]
      : undefined;
  if (!selected) {
    if (exact || permitted.length === 0) return { kind: "forbidden" };
    return { kind: "ambiguous" };
  }
  return {
    access: selected.access,
    authorityReady: selected.event.authority_ready_at !== null,
    eventId: selected.event.id,
    eventName: selected.event.name,
    kind: "resolved",
    organizationId: selected.event.organization_id,
  };
}

function resolutionError(
  context: Context<AppContext>,
  resolution: Exclude<ReviewAccessResolution, { kind: "resolved" }>,
) {
  if (resolution.kind === "forbidden") {
    return simpleError(
      context,
      403,
      "review_operations_forbidden",
      "You do not have permission to access review operations for this event.",
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
    "event_not_found",
    "The event does not exist.",
  );
}

async function authenticate(context: Context<AppContext>) {
  const authentication = authService(context);
  const session = await authentication.authenticate(sessionToken(context));
  const resolution = await resolveReviewAccess(context, session.user);
  return { authentication, resolution, session };
}

function projectionUnavailable(context: Context<AppContext>) {
  return simpleError(
    context,
    503,
    "review_operations_projection_unavailable",
    "Review operations are temporarily unavailable while authoritative data converges.",
  );
}

export function registerReviewOperationsRoutes(app: Hono<AppContext>): void {
  app.use(
    "/api/events/:eventKey/review-operations/commands",
    bodyLimit({
      maxSize: commandBodyLimitBytes,
      onError: (context) =>
        simpleError(
          context,
          413,
          "request_too_large",
          "The review operation command exceeds 32 KiB.",
        ),
    }),
  );
  for (const path of [
    "/api/events/:eventKey/reviewer-assignments/:assignmentId/commands",
    "/api/events/:eventKey/review-operations/reviews/:assignmentId/commands",
    "/api/events/:eventKey/decisions/:submissionId/commands",
  ]) {
    app.use(
      path,
      bodyLimit({
        maxSize: commandBodyLimitBytes,
        onError: (context) =>
          simpleError(
            context,
            413,
            "request_too_large",
            "The review command exceeds 32 KiB.",
          ),
      }),
    );
  }

  app.get("/api/events/:eventKey/review-operations", async (context) => {
    try {
      const { resolution } = await authenticate(context);
      if (resolution.kind !== "resolved")
        return resolutionError(context, resolution);
      if (!hasEventPermission(resolution.access, "event:manage")) {
        return simpleError(
          context,
          403,
          "review_operations_forbidden",
          "Organizer access is required to manage review operations.",
        );
      }
      return context.json(
        await new D1ReviewOperationsRepository(context.env.DB).operations({
          eventId: resolution.eventId,
          organizationId: resolution.organizationId,
        }),
      );
    } catch (error) {
      if (error instanceof ReviewOperationsProjectionUnavailableError) {
        return projectionUnavailable(context);
      }
      try {
        return authFailure(context, error);
      } catch {
        return projectionUnavailable(context);
      }
    }
  });

  app.get("/api/events/:eventKey/decisions", async (context) => {
    try {
      const { resolution, session } = await authenticate(context);
      if (resolution.kind !== "resolved")
        return resolutionError(context, resolution);
      if (!hasEventPermission(resolution.access, "event:manage")) {
        return simpleError(
          context,
          403,
          "decisions_forbidden",
          "Organizer access is required to review decisions.",
        );
      }
      return context.json(
        await new D1DecisionRepository(context.env.DB).workspace({
          actor: session.user.displayName ?? "OpenSession organizer",
          eventId: resolution.eventId,
          eventName: resolution.eventName,
          organizationId: resolution.organizationId,
        }),
      );
    } catch (error) {
      try {
        return authFailure(context, error);
      } catch {
        return projectionUnavailable(context);
      }
    }
  });

  app.get("/api/events/:eventKey/reviewer-assignments", async (context) => {
    try {
      const { resolution, session } = await authenticate(context);
      if (resolution.kind !== "resolved")
        return resolutionError(context, resolution);
      if (!hasEventPermission(resolution.access, "review:read")) {
        return simpleError(
          context,
          403,
          "review_assignments_forbidden",
          "Reviewer access is required to view review assignments.",
        );
      }
      const repository = new D1ReviewOperationsRepository(context.env.DB);
      const reviewerId = await repository.reviewerIdForEmail(
        {
          eventId: resolution.eventId,
          organizationId: resolution.organizationId,
        },
        session.user.email,
      );
      if (!reviewerId) {
        return simpleError(
          context,
          403,
          "reviewer_identity_unavailable",
          "Your account is not an active reviewer for this event.",
        );
      }
      return context.json(
        await repository.reviewerAssignments(
          {
            eventId: resolution.eventId,
            organizationId: resolution.organizationId,
          },
          reviewerId,
        ),
      );
    } catch (error) {
      if (error instanceof ReviewOperationsProjectionUnavailableError) {
        return projectionUnavailable(context);
      }
      try {
        return authFailure(context, error);
      } catch {
        return projectionUnavailable(context);
      }
    }
  });

  app.post(
    "/api/events/:eventKey/reviewer-assignments/:assignmentId/commands",
    async (context) => {
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
          "Review changes require a same-origin JSON request.",
        );
      }
      let body: unknown;
      try {
        body = await context.req.json();
      } catch {
        body = null;
      }
      const input = reviewScoringCommandSchema.safeParse(body);
      if (
        !input.success ||
        input.data.type === "reopen_review" ||
        input.data.assignmentId !== context.req.param("assignmentId")
      ) {
        const issue = input.success ? undefined : input.error.issues[0];
        return commandError(context, 400, {
          code: "review_validation_error",
          field: issue?.path.join(".") || "command",
          message: issue?.message ?? "The reviewer scoring command is invalid.",
        });
      }
      try {
        const { authentication, resolution, session } =
          await authenticate(context);
        await authentication.verifyCsrf(
          session,
          context.req.header("X-CSRF-Token") ?? null,
        );
        if (resolution.kind !== "resolved")
          return resolutionError(context, resolution);
        if (!hasEventPermission(resolution.access, "review:read")) {
          return simpleError(
            context,
            403,
            "review_assignments_forbidden",
            "Reviewer access is required to score an assignment.",
          );
        }
        const reviewerId = await new D1ReviewOperationsRepository(
          context.env.DB,
        ).reviewerIdForEmail(
          {
            eventId: resolution.eventId,
            organizationId: resolution.organizationId,
          },
          session.user.email,
        );
        if (!reviewerId) {
          return simpleError(
            context,
            403,
            "reviewer_identity_unavailable",
            "Your account is not an active reviewer for this event.",
          );
        }
        if (!resolution.authorityReady) {
          return simpleError(
            context,
            503,
            "review_operations_authority_unavailable",
            "Authoritative review changes are temporarily unavailable.",
          );
        }
        const result = await new AirtableReviewOperationsCommandService({
          actorId: session.user.id,
          authority: getBaseAuthority(context.env),
          database: context.env.DB,
          eventId: resolution.eventId,
          organizationId: resolution.organizationId,
          permittedReviewerId: reviewerId,
          requestId: context.get("requestId"),
        }).execute(input.data);
        return context.json(
          reviewOperationsCommandResponseSchema.parse({ ok: true, result }),
        );
      } catch (error) {
        if (error instanceof ReviewOperationsValidationError) {
          return commandError(context, 422, {
            code: "review_validation_error",
            field: error.field,
            message: error.message,
          });
        }
        if (error instanceof ReviewOperationsVersionConflictError) {
          return commandError(context, 409, {
            actualVersion: error.actualVersion,
            code: "review_version_conflict",
            expectedVersion: error.expectedVersion,
            message: error.message,
          });
        }
        if (error instanceof ReviewOperationsIdempotencyConflictError) {
          return commandError(context, 409, {
            code: "review_idempotency_conflict",
            commandId: error.commandId,
            message: error.message,
          });
        }
        if (error instanceof ReviewOperationsNotFoundError) {
          return commandError(context, 404, {
            code: "review_not_found",
            message: error.message,
          });
        }
        try {
          return authFailure(context, error);
        } catch {
          return simpleError(
            context,
            503,
            "review_operations_authority_unavailable",
            "The authoritative review command is temporarily unavailable.",
          );
        }
      }
    },
  );

  app.post(
    "/api/events/:eventKey/decisions/:submissionId/commands",
    async (context) => {
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
          "Decision changes require a same-origin JSON request.",
        );
      }
      let body: unknown;
      try {
        body = await context.req.json();
      } catch {
        body = null;
      }
      const input = recordDecisionCommandSchema.safeParse(body);
      if (
        !input.success ||
        input.data.submissionId !== context.req.param("submissionId")
      ) {
        const issue = input.success ? undefined : input.error.issues[0];
        return commandError(context, 400, {
          code: "decision_validation_error",
          field: issue?.path.join(".") || "command",
          message: issue?.message ?? "The decision command is invalid.",
        });
      }
      try {
        const { authentication, resolution, session } =
          await authenticate(context);
        await authentication.verifyCsrf(
          session,
          context.req.header("X-CSRF-Token") ?? null,
        );
        if (resolution.kind !== "resolved")
          return resolutionError(context, resolution);
        if (!hasEventPermission(resolution.access, "event:manage")) {
          return simpleError(
            context,
            403,
            "decisions_forbidden",
            "Organizer access is required to record a decision.",
          );
        }
        if (!resolution.authorityReady) {
          return simpleError(
            context,
            503,
            "decisions_authority_unavailable",
            "Authoritative decision changes are temporarily unavailable.",
          );
        }
        const authority = getBaseAuthority(context.env);
        const result = await new AirtableReviewOperationsCommandService({
          actorId: session.user.id,
          authority,
          database: context.env.DB,
          eventId: resolution.eventId,
          organizationId: resolution.organizationId,
          requestId: context.get("requestId"),
        }).execute(input.data);
        await new AcceptanceOrchestrationService({
          actor: {
            email: session.user.email,
            id: session.user.id,
            name: session.user.displayName ?? "OpenSession organizer",
          },
          authority,
          database: context.env.DB,
          emailConfig: parseEmailDeliveryConfig(
            context.env.EMAIL_DELIVERY_CONFIG,
            context.env.APP_ENV,
          ),
          emailQueue: context.env.EMAIL_QUEUE,
          requestId: context.get("requestId"),
          requestUrl: context.req.url,
        }).execute(resolution.eventId, resolution.organizationId, input.data);
        return context.json(
          reviewOperationsCommandResponseSchema.parse({ ok: true, result }),
        );
      } catch (error) {
        if (error instanceof AcceptanceOrchestrationPendingError) {
          return simpleError(
            context,
            503,
            "acceptance_orchestration_pending",
            error.message,
          );
        }
        if (error instanceof ReviewOperationsValidationError) {
          return commandError(context, 422, {
            code: "decision_validation_error",
            field: error.field,
            message: error.message,
          });
        }
        if (error instanceof ReviewOperationsVersionConflictError) {
          return commandError(context, 409, {
            actualVersion: error.actualVersion,
            code: "decision_version_conflict",
            expectedVersion: error.expectedVersion,
            message: error.message,
          });
        }
        if (error instanceof ReviewOperationsIdempotencyConflictError) {
          return commandError(context, 409, {
            code: "decision_idempotency_conflict",
            commandId: error.commandId,
            message: error.message,
          });
        }
        if (error instanceof ReviewOperationsNotFoundError) {
          return commandError(context, 404, {
            code: "decision_not_found",
            message: error.message,
          });
        }
        try {
          return authFailure(context, error);
        } catch {
          return simpleError(
            context,
            503,
            "decisions_authority_unavailable",
            "The authoritative decision command is temporarily unavailable.",
          );
        }
      }
    },
  );

  app.post(
    "/api/events/:eventKey/review-operations/reviews/:assignmentId/commands",
    async (context) => {
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
          "Review changes require a same-origin JSON request.",
        );
      }
      let body: unknown;
      try {
        body = await context.req.json();
      } catch {
        body = null;
      }
      const input = reviewScoringCommandSchema.safeParse(body);
      if (
        !input.success ||
        input.data.type !== "reopen_review" ||
        input.data.assignmentId !== context.req.param("assignmentId")
      ) {
        const issue = input.success ? undefined : input.error.issues[0];
        return commandError(context, 400, {
          code: "review_validation_error",
          field: issue?.path.join(".") || "command",
          message: issue?.message ?? "The review reopen command is invalid.",
        });
      }
      try {
        const { authentication, resolution, session } =
          await authenticate(context);
        await authentication.verifyCsrf(
          session,
          context.req.header("X-CSRF-Token") ?? null,
        );
        if (resolution.kind !== "resolved")
          return resolutionError(context, resolution);
        if (!hasEventPermission(resolution.access, "event:manage")) {
          return simpleError(
            context,
            403,
            "review_operations_forbidden",
            "Organizer access is required to reopen a review.",
          );
        }
        if (!resolution.authorityReady) {
          return simpleError(
            context,
            503,
            "review_operations_authority_unavailable",
            "Authoritative review changes are temporarily unavailable.",
          );
        }
        const result = await new AirtableReviewOperationsCommandService({
          actorId: session.user.id,
          authority: getBaseAuthority(context.env),
          database: context.env.DB,
          eventId: resolution.eventId,
          organizationId: resolution.organizationId,
          requestId: context.get("requestId"),
        }).execute(input.data);
        return context.json(
          reviewOperationsCommandResponseSchema.parse({ ok: true, result }),
        );
      } catch (error) {
        if (error instanceof ReviewOperationsValidationError) {
          return commandError(context, 422, {
            code: "review_validation_error",
            field: error.field,
            message: error.message,
          });
        }
        if (error instanceof ReviewOperationsVersionConflictError) {
          return commandError(context, 409, {
            actualVersion: error.actualVersion,
            code: "review_version_conflict",
            expectedVersion: error.expectedVersion,
            message: error.message,
          });
        }
        if (error instanceof ReviewOperationsIdempotencyConflictError) {
          return commandError(context, 409, {
            code: "review_idempotency_conflict",
            commandId: error.commandId,
            message: error.message,
          });
        }
        if (error instanceof ReviewOperationsNotFoundError) {
          return commandError(context, 404, {
            code: "review_not_found",
            message: error.message,
          });
        }
        try {
          return authFailure(context, error);
        } catch {
          return simpleError(
            context,
            503,
            "review_operations_authority_unavailable",
            "The authoritative review command is temporarily unavailable.",
          );
        }
      }
    },
  );

  app.post(
    "/api/events/:eventKey/review-operations/commands",
    async (context) => {
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
      const input = reviewOperationsCommandSchema.safeParse(body);
      if (!input.success) {
        const issue = input.error.issues[0];
        return commandError(context, 400, {
          code: "review_operations_validation_error",
          field: issue?.path.join(".") || "command",
          message: issue?.message ?? "The review operation command is invalid.",
        });
      }
      try {
        const { authentication, resolution, session } =
          await authenticate(context);
        await authentication.verifyCsrf(
          session,
          context.req.header("X-CSRF-Token") ?? null,
        );
        if (resolution.kind !== "resolved")
          return resolutionError(context, resolution);
        const organizer = hasEventPermission(resolution.access, "event:manage");
        let permittedReviewerId: string | undefined;
        if (!organizer) {
          if (
            input.data.type !== "disclose_conflict" ||
            !hasEventPermission(resolution.access, "review:read")
          ) {
            return simpleError(
              context,
              403,
              "review_operations_forbidden",
              "Organizer access is required for this review operation.",
            );
          }
          const reviewerId = await new D1ReviewOperationsRepository(
            context.env.DB,
          ).reviewerIdForEmail(
            {
              eventId: resolution.eventId,
              organizationId: resolution.organizationId,
            },
            session.user.email,
          );
          if (!reviewerId) {
            return simpleError(
              context,
              403,
              "reviewer_identity_unavailable",
              "Your account is not an active reviewer for this event.",
            );
          }
          permittedReviewerId = reviewerId;
        }
        if (!resolution.authorityReady) {
          return simpleError(
            context,
            503,
            "review_operations_authority_unavailable",
            "Authoritative review changes are temporarily unavailable.",
          );
        }
        const result = await new AirtableReviewOperationsCommandService({
          actorId: session.user.id,
          authority: getBaseAuthority(context.env),
          database: context.env.DB,
          eventId: resolution.eventId,
          organizationId: resolution.organizationId,
          ...(permittedReviewerId ? { permittedReviewerId } : {}),
          requestId: context.get("requestId"),
        }).execute(input.data);
        return context.json(
          reviewOperationsCommandResponseSchema.parse({ ok: true, result }),
        );
      } catch (error) {
        if (error instanceof ReviewOperationsValidationError) {
          return commandError(context, 422, {
            code: "review_operations_validation_error",
            field: error.field,
            message: error.message,
          });
        }
        if (error instanceof ReviewOperationsVersionConflictError) {
          return commandError(context, 409, {
            actualVersion: error.actualVersion,
            code: "review_operations_version_conflict",
            expectedVersion: error.expectedVersion,
            message: error.message,
          });
        }
        if (error instanceof ReviewOperationsIdempotencyConflictError) {
          return commandError(context, 409, {
            code: "review_operations_idempotency_conflict",
            commandId: error.commandId,
            message: error.message,
          });
        }
        if (error instanceof ReviewOperationsNotFoundError) {
          return commandError(context, 404, {
            code: "review_operations_not_found",
            message: error.message,
          });
        }
        try {
          return authFailure(context, error);
        } catch {
          return simpleError(
            context,
            503,
            "review_operations_authority_unavailable",
            "The authoritative review command is temporarily unavailable.",
          );
        }
      }
    },
  );
}
