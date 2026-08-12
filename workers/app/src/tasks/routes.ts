import {
  taskReminderControlCommandSchema,
  taskReminderScheduleCommandSchema,
} from "@sessionbox-killer/contracts/lifecycle";
import {
  taskAcceptanceMaterializationCommandSchema,
  taskAssignmentReviewCommandSchema,
  taskAssignmentSubmissionCommandSchema,
  taskAssignmentTransitionCommandSchema,
  taskBackfillPreviewRequestSchema,
  taskDefinitionCommandSchema,
  taskStableIdSchema,
} from "@sessionbox-killer/contracts/tasks";
import { readinessDashboardQuerySchema } from "@sessionbox-killer/contracts/readiness";
import { TaskDomainError } from "@sessionbox-killer/domain/tasks";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import type { AppContext } from "../app-context";
import { requestDatabase } from "../database.js";
import { getBaseAuthority } from "../authority/binding.js";
import {
  hasEventPermission,
  loadEventAccess,
  type EventAccess,
} from "../auth/authorization";
import type { AuthenticatedSession } from "../auth/service";
import {
  authFailure,
  authService,
  requireSameOrigin,
  sessionToken,
} from "../auth/http";
import { isFeatureEnabled } from "../features";
import { parseEmailDeliveryConfig } from "../email/config.js";
import {
  TaskAuthorityPendingError,
  TaskAuthorityService,
  TaskIdempotencyConflictError,
  TaskNotFoundError,
  TaskPreviewConflictError,
  TaskReadService,
  TaskVersionConflictError,
  verifyTaskDownloadReceipt,
  type TaskCommandActor,
  type TaskEventScope,
} from "./service.js";
import { safeAttachmentDisposition } from "../uploads/policy.js";
import { UploadError, UploadService } from "../uploads/service.js";
import { ReadinessDashboardService } from "../readiness/service.js";
import { TaskReminderCoordinator } from "../lifecycle/task-reminders.js";
import { TaskAssignmentLifecycleService } from "../lifecycle/task-assignments.js";

const taskBodyLimitBytes = 64 * 1024;

interface EventCandidate {
  id: string;
  organization_id: string;
  slug: string;
  source_record_id: string;
  timezone: string;
}

interface TaskRouteScope {
  access: EventAccess;
  event: TaskEventScope;
  session: AuthenticatedSession;
}

type TaskScopeResolution =
  | { kind: "ambiguous" | "forbidden" | "not_found" }
  | ({ kind: "resolved" } & TaskRouteScope);

async function resolveTaskScope(
  context: Context<AppContext>,
  eventKey: string,
  options: { requireAuthorityReady?: boolean } = {},
): Promise<TaskScopeResolution> {
  const session = await authService(context).authenticate(
    sessionToken(context),
  );
  const database = requestDatabase(context);
  const candidates = await database
    .prepare(
      `SELECT event.id, event.organization_id, event.slug, event.timezone,
            event.source_record_id
     FROM p_events event
     JOIN tenant_registry tenant
       ON tenant.organization_id = event.organization_id
      AND tenant.status = 'active'
      AND (?2 = 0 OR tenant.authority_ready_at IS NOT NULL)
     WHERE (event.id = ?1 OR event.slug = ?1)
       AND event.source_deleted_at IS NULL
     ORDER BY CASE WHEN event.id = ?1 THEN 0 ELSE 1 END,
              event.organization_id LIMIT 33`,
    )
    .bind(eventKey, options.requireAuthorityReady === false ? 0 : 1)
    .all<EventCandidate>();
  if (candidates.results.length === 0) return { kind: "not_found" };
  const permitted: { access: EventAccess; candidate: EventCandidate }[] = [];
  for (const candidate of candidates.results) {
    const access = await loadEventAccess(
      database,
      session.user,
      candidate.organization_id,
      candidate.id,
      options.requireAuthorityReady === undefined
        ? {}
        : { requireAuthorityReady: options.requireAuthorityReady },
    );
    if (
      hasEventPermission(access, "event:manage") ||
      hasEventPermission(access, "portal:write:self")
    ) {
      permitted.push({ access, candidate });
    }
  }
  const exact = candidates.results.find(({ id }) => id === eventKey);
  const selected = exact
    ? permitted.find(({ candidate }) => candidate.id === exact.id)
    : permitted.length === 1 && candidates.results.length <= 32
      ? permitted[0]
      : null;
  if (!selected) {
    if (!exact && (permitted.length > 1 || candidates.results.length > 32)) {
      return { kind: "ambiguous" };
    }
    return { kind: "forbidden" };
  }
  return {
    access: selected.access,
    event: {
      eventId: selected.candidate.id,
      eventRecordId: selected.candidate.source_record_id,
      organizationId: selected.candidate.organization_id,
      slug: selected.candidate.slug,
      timezone: selected.candidate.timezone,
    },
    kind: "resolved",
    session,
  };
}

function standardError(
  context: Context<AppContext>,
  status: 400 | 403 | 404 | 409 | 410 | 413 | 503,
  code: string,
  message: string,
) {
  return context.json(
    { error: { code, message }, request_id: context.get("requestId") },
    status,
  );
}

function scopeFailure(
  context: Context<AppContext>,
  resolution: Exclude<TaskScopeResolution, { kind: "resolved" }>,
) {
  if (resolution.kind === "forbidden") {
    return standardError(
      context,
      403,
      "forbidden",
      "You do not have access to tasks for this event.",
    );
  }
  if (resolution.kind === "ambiguous") {
    return standardError(
      context,
      409,
      "ambiguous_event_slug",
      "This event slug is ambiguous; use the canonical event ID.",
    );
  }
  return standardError(
    context,
    404,
    "task_event_not_found",
    "The requested event does not exist.",
  );
}

async function parsedJson(context: Context<AppContext>): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    return null;
  }
}

function taskError(context: Context<AppContext>, error: unknown) {
  if (error instanceof TaskAuthorityPendingError) {
    return context.json(
      {
        error: {
          code: "task_authority_pending",
          message: error.message,
          retryable: true,
        },
        ok: false,
      },
      202,
    );
  }
  if (error instanceof TaskVersionConflictError) {
    return context.json(
      {
        error: {
          code: "task_version_conflict",
          message: error.message,
          retryable: false,
        },
        ok: false,
      },
      412,
    );
  }
  if (error instanceof TaskIdempotencyConflictError) {
    return context.json(
      {
        error: {
          code: "task_idempotency_conflict",
          message: error.message,
          retryable: false,
        },
        ok: false,
      },
      409,
    );
  }
  if (error instanceof TaskPreviewConflictError) {
    return context.json(
      {
        error: {
          code: "task_preview_conflict",
          message: error.message,
          retryable: false,
        },
        ok: false,
      },
      409,
    );
  }
  if (error instanceof TaskNotFoundError) {
    return context.json(
      {
        error: {
          code: "task_not_found",
          message: error.message,
          retryable: false,
        },
        ok: false,
      },
      404,
    );
  }
  if (error instanceof TaskDomainError) {
    const invalidRequestCodes = new Set([
      "ambiguous_local_due",
      "assignment_limit_exceeded",
      "invalid_local_due",
      "invalid_response",
      "invalid_timezone",
    ]);
    return context.json(
      {
        error: {
          code:
            error.code === "version_conflict"
              ? "task_version_conflict"
              : invalidRequestCodes.has(error.code)
                ? "task_invalid_request"
                : "task_illegal_transition",
          message: error.message,
          retryable: false,
        },
        ok: false,
      },
      error.code === "version_conflict" ? 412 : 422,
    );
  }
  try {
    return authFailure(context, error);
  } catch {
    return context.json(
      {
        error: {
          code: "task_authority_unavailable",
          message: "Task authority is temporarily unavailable.",
          retryable: true,
        },
        ok: false,
      },
      503,
    );
  }
}

function organizerActor(scope: TaskRouteScope): TaskCommandActor {
  return {
    actorId: scope.session.user.id,
    auditActorType: "user",
    domainActorType: "organizer",
  };
}

function writeUnavailable(context: Context<AppContext>) {
  return context.json(
    {
      error: {
        code: "task_authority_unavailable",
        message: "Task writes are disabled in this environment.",
        retryable: true,
      },
      ok: false,
    },
    503,
  );
}

function invalidRequest(context: Context<AppContext>, message: string) {
  return context.json(
    {
      error: {
        code: "task_invalid_request",
        message,
        retryable: false,
      },
      ok: false,
    },
    400,
  );
}

function authorityService(context: Context<AppContext>) {
  return new TaskAuthorityService({
    authority: () => getBaseAuthority(context.env),
    database: context.env.DB,
    downloadReceiptSecret: context.env.AUTH_HASH_PEPPER,
  });
}

export function registerTaskRoutes(app: Hono<AppContext>): void {
  for (const path of [
    "/api/events/:eventKey/task-definitions/backfill-preview",
    "/api/events/:eventKey/task-definitions/commands",
    "/api/events/:eventKey/task-materializations/commands",
    "/api/events/:eventKey/task-reminders/commands",
    "/api/events/:eventKey/task-reminders/:workflowId/commands",
    "/api/events/:eventKey/task-assignments/:assignmentId/reviews",
    "/api/events/:eventKey/task-assignments/:assignmentId/submissions",
    "/api/events/:eventKey/task-assignments/:assignmentId/transitions",
  ]) {
    app.use(
      path,
      bodyLimit({
        maxSize: taskBodyLimitBytes,
        onError: (context) =>
          standardError(
            context,
            413,
            "request_too_large",
            "The task request body is too large.",
          ),
      }),
    );
  }

  app.get("/api/events/:eventKey/task-definitions", async (context) => {
    try {
      const resolution = await resolveTaskScope(
        context,
        context.req.param("eventKey"),
      );
      if (resolution.kind !== "resolved") {
        return scopeFailure(context, resolution);
      }
      if (!hasEventPermission(resolution.access, "event:manage")) {
        return standardError(
          context,
          403,
          "forbidden",
          "Organizer access is required to manage task definitions.",
        );
      }
      return context.json(
        await new TaskReadService(context.env.DB).definitions(resolution.event),
      );
    } catch (error) {
      try {
        return authFailure(context, error);
      } catch {
        return standardError(
          context,
          503,
          "task_projection_unavailable",
          "Task definitions are temporarily unavailable.",
        );
      }
    }
  });

  app.get("/api/events/:eventKey/readiness", async (context) => {
    try {
      const query = readinessDashboardQuerySchema.safeParse(
        context.req.query(),
      );
      if (!query.success) {
        return standardError(
          context,
          400,
          "invalid_readiness_query",
          "Readiness filters or pagination are invalid.",
        );
      }
      const resolution = await resolveTaskScope(
        context,
        context.req.param("eventKey"),
        { requireAuthorityReady: false },
      );
      if (resolution.kind !== "resolved") {
        return scopeFailure(context, resolution);
      }
      if (!hasEventPermission(resolution.access, "event:manage")) {
        return standardError(
          context,
          403,
          "forbidden",
          "Organizer access is required to read event readiness.",
        );
      }
      return context.json(
        await new ReadinessDashboardService(context.env.DB).read(
          resolution.event,
          query.data,
        ),
      );
    } catch (error) {
      try {
        return authFailure(context, error);
      } catch {
        return standardError(
          context,
          503,
          "readiness_projection_unavailable",
          "Event readiness is temporarily unavailable.",
        );
      }
    }
  });

  app.post("/api/events/:eventKey/task-reminders/commands", async (context) => {
    if (!requireSameOrigin(context)) {
      return invalidRequest(
        context,
        "Task reminder commands require same-origin JSON requests.",
      );
    }
    if (!isFeatureEnabled(context.env.FEATURE_FLAGS, "writes")) {
      return writeUnavailable(context);
    }
    try {
      const resolution = await resolveTaskScope(
        context,
        context.req.param("eventKey"),
      );
      if (resolution.kind !== "resolved") {
        return scopeFailure(context, resolution);
      }
      if (!hasEventPermission(resolution.access, "event:manage")) {
        return standardError(
          context,
          403,
          "forbidden",
          "Organizer access is required to schedule task reminders.",
        );
      }
      const command = taskReminderScheduleCommandSchema.safeParse(
        await parsedJson(context),
      );
      if (!command.success) {
        return invalidRequest(context, "The task reminder command is invalid.");
      }
      const definition = await context.env.DB.prepare(
        `SELECT 1 AS found FROM p_task_definitions
           WHERE organization_id = ?1 AND event_id = ?2 AND id = ?3
             AND source_deleted_at IS NULL LIMIT 1`,
      )
        .bind(
          resolution.event.organizationId,
          resolution.event.eventId,
          command.data.definition_id,
        )
        .first();
      if (!definition) {
        return standardError(
          context,
          404,
          "task_not_found",
          "The task definition does not exist.",
        );
      }
      return context.json(
        await new TaskReminderCoordinator(context.env).schedule(
          {
            id: resolution.event.eventId,
            organization_id: resolution.event.organizationId,
            timezone: resolution.event.timezone,
          },
          command.data,
          context.get("requestId"),
        ),
      );
    } catch (error) {
      return taskError(context, error);
    }
  });

  app.get(
    "/api/events/:eventKey/task-reminders/:workflowId",
    async (context) => {
      const workflowId = taskStableIdSchema.safeParse(
        context.req.param("workflowId"),
      );
      if (!workflowId.success) {
        return standardError(
          context,
          404,
          "task_not_found",
          "The task reminder does not exist.",
        );
      }
      try {
        const resolution = await resolveTaskScope(
          context,
          context.req.param("eventKey"),
        );
        if (resolution.kind !== "resolved") {
          return scopeFailure(context, resolution);
        }
        if (!hasEventPermission(resolution.access, "event:manage")) {
          return standardError(
            context,
            403,
            "forbidden",
            "Organizer access is required to inspect task reminders.",
          );
        }
        return context.json(
          await new TaskReminderCoordinator(context.env).read(
            resolution.event.organizationId,
            resolution.event.eventId,
            workflowId.data,
          ),
        );
      } catch (error) {
        return taskError(context, error);
      }
    },
  );

  app.post(
    "/api/events/:eventKey/task-reminders/:workflowId/commands",
    async (context) => {
      if (!requireSameOrigin(context)) {
        return invalidRequest(
          context,
          "Task reminder commands require same-origin JSON requests.",
        );
      }
      if (!isFeatureEnabled(context.env.FEATURE_FLAGS, "writes")) {
        return writeUnavailable(context);
      }
      const workflowId = taskStableIdSchema.safeParse(
        context.req.param("workflowId"),
      );
      const command = taskReminderControlCommandSchema.safeParse(
        await parsedJson(context),
      );
      if (!workflowId.success || !command.success) {
        return invalidRequest(context, "The task reminder command is invalid.");
      }
      try {
        const resolution = await resolveTaskScope(
          context,
          context.req.param("eventKey"),
        );
        if (resolution.kind !== "resolved") {
          return scopeFailure(context, resolution);
        }
        if (!hasEventPermission(resolution.access, "event:manage")) {
          return standardError(
            context,
            403,
            "forbidden",
            "Organizer access is required to control task reminders.",
          );
        }
        return context.json(
          await new TaskReminderCoordinator(context.env).control(
            resolution.event.organizationId,
            resolution.event.eventId,
            workflowId.data,
            command.data,
          ),
        );
      } catch (error) {
        return taskError(context, error);
      }
    },
  );

  app.get(
    "/api/events/:eventKey/task-assignments/:assignmentId",
    async (context) => {
      const assignmentId = taskStableIdSchema.safeParse(
        context.req.param("assignmentId"),
      );
      if (!assignmentId.success) {
        return standardError(
          context,
          404,
          "task_not_found",
          "The task assignment does not exist.",
        );
      }
      try {
        const resolution = await resolveTaskScope(
          context,
          context.req.param("eventKey"),
        );
        if (resolution.kind !== "resolved") {
          return scopeFailure(context, resolution);
        }
        const service = authorityService(context);
        const canReview = hasEventPermission(resolution.access, "event:manage");
        const canSubmit =
          !canReview &&
          Boolean(resolution.access.speakerContactId) &&
          hasEventPermission(resolution.access, "portal:write:self") &&
          (await service.assignmentBelongsToContact(
            resolution.event,
            assignmentId.data,
            resolution.access.speakerContactId ?? "",
          ));
        if (!canReview && !canSubmit) {
          return standardError(
            context,
            403,
            "forbidden",
            "You cannot read this task assignment.",
          );
        }
        const response = context.json(
          await service.reads().detail(resolution.event, assignmentId.data, {
            canReview,
            canSubmit,
          }),
        );
        response.headers.set("Cache-Control", "private, no-store");
        return response;
      } catch (error) {
        return taskError(context, error);
      }
    },
  );

  app.post(
    "/api/events/:eventKey/task-definitions/backfill-preview",
    async (context) => {
      if (!requireSameOrigin(context)) {
        return invalidRequest(
          context,
          "Task previews require same-origin JSON requests.",
        );
      }
      try {
        const resolution = await resolveTaskScope(
          context,
          context.req.param("eventKey"),
        );
        if (resolution.kind !== "resolved") {
          return scopeFailure(context, resolution);
        }
        if (!hasEventPermission(resolution.access, "event:manage")) {
          return standardError(
            context,
            403,
            "forbidden",
            "Organizer access is required to preview task targeting.",
          );
        }
        const input = taskBackfillPreviewRequestSchema.safeParse(
          await parsedJson(context),
        );
        if (!input.success) {
          return invalidRequest(
            context,
            "The task backfill preview is invalid.",
          );
        }
        return context.json(
          await authorityService(context).previewBackfill(
            resolution.event,
            input.data,
          ),
        );
      } catch (error) {
        return taskError(context, error);
      }
    },
  );

  app.post(
    "/api/events/:eventKey/task-definitions/commands",
    async (context) => {
      if (!requireSameOrigin(context)) {
        return invalidRequest(
          context,
          "Task commands require same-origin JSON requests.",
        );
      }
      if (!isFeatureEnabled(context.env.FEATURE_FLAGS, "writes")) {
        return writeUnavailable(context);
      }
      try {
        const resolution = await resolveTaskScope(
          context,
          context.req.param("eventKey"),
        );
        if (resolution.kind !== "resolved") {
          return scopeFailure(context, resolution);
        }
        if (!hasEventPermission(resolution.access, "event:manage")) {
          return standardError(
            context,
            403,
            "forbidden",
            "Organizer access is required to manage task definitions.",
          );
        }
        const input = taskDefinitionCommandSchema.safeParse(
          await parsedJson(context),
        );
        if (!input.success) {
          return invalidRequest(
            context,
            "The task definition command is invalid.",
          );
        }
        const response = await authorityService(context).upsertDefinition(
          resolution.event,
          input.data,
          organizerActor(resolution),
          context.get("requestId"),
        );
        return context.json(
          response,
          response.ok && response.repair_pending ? 202 : 200,
        );
      } catch (error) {
        return taskError(context, error);
      }
    },
  );

  app.post(
    "/api/events/:eventKey/task-materializations/commands",
    async (context) => {
      if (!requireSameOrigin(context)) {
        return invalidRequest(
          context,
          "Task commands require same-origin JSON requests.",
        );
      }
      if (!isFeatureEnabled(context.env.FEATURE_FLAGS, "writes")) {
        return writeUnavailable(context);
      }
      try {
        const resolution = await resolveTaskScope(
          context,
          context.req.param("eventKey"),
        );
        if (resolution.kind !== "resolved") {
          return scopeFailure(context, resolution);
        }
        if (!hasEventPermission(resolution.access, "event:manage")) {
          return standardError(
            context,
            403,
            "forbidden",
            "Organizer access is required to materialize task assignments.",
          );
        }
        const input = taskAcceptanceMaterializationCommandSchema.safeParse(
          await parsedJson(context),
        );
        if (!input.success) {
          return invalidRequest(
            context,
            "The acceptance materialization command is invalid.",
          );
        }
        const response = await authorityService(context).materializeAcceptance(
          resolution.event,
          input.data,
          organizerActor(resolution),
          context.get("requestId"),
        );
        if (
          response.ok &&
          "assignment_ids" in response.result &&
          response.result.created_count > 0
        ) {
          await new TaskAssignmentLifecycleService({
            database: context.env.DB,
            emailConfig: parseEmailDeliveryConfig(
              context.env.EMAIL_DELIVERY_CONFIG,
              context.env.APP_ENV,
            ),
            emailQueue: context.env.EMAIL_QUEUE,
          }).notify(
            resolution.event,
            response.result.assignment_ids,
            context.get("requestId"),
            context.req.url,
          );
        }
        return context.json(
          response,
          response.ok && response.repair_pending ? 202 : 200,
        );
      } catch (error) {
        return taskError(context, error);
      }
    },
  );

  app.get(
    "/api/events/:eventKey/task-assignments/:assignmentId/files/:fileId",
    async (context) => {
      const assignmentId = taskStableIdSchema.safeParse(
        context.req.param("assignmentId"),
      );
      const fileId = taskStableIdSchema.safeParse(context.req.param("fileId"));
      const receipt = context.req.query("receipt") ?? "";
      if (!assignmentId.success || !fileId.success || receipt.length > 256) {
        return standardError(
          context,
          404,
          "task_file_not_found",
          "The task file does not exist.",
        );
      }
      try {
        const resolution = await resolveTaskScope(
          context,
          context.req.param("eventKey"),
        );
        if (resolution.kind !== "resolved") {
          return scopeFailure(context, resolution);
        }
        const service = authorityService(context);
        const manages = hasEventPermission(resolution.access, "event:manage");
        const owns =
          Boolean(resolution.access.speakerContactId) &&
          hasEventPermission(resolution.access, "portal:write:self") &&
          (await service.assignmentBelongsToContact(
            resolution.event,
            assignmentId.data,
            resolution.access.speakerContactId ?? "",
          ));
        if (!manages && !owns) {
          return standardError(
            context,
            403,
            "forbidden",
            "You cannot download this task file.",
          );
        }
        const receiptState = await verifyTaskDownloadReceipt(
          context.env.AUTH_HASH_PEPPER,
          resolution.event,
          assignmentId.data,
          fileId.data,
          receipt,
          new Date(),
        );
        if (receiptState === "expired") {
          return standardError(
            context,
            410,
            "task_file_link_expired",
            "This task file link has expired. Refresh the task to continue.",
          );
        }
        if (
          receiptState !== "valid" ||
          !(await service
            .reads()
            .fileIsCurrent(resolution.event, assignmentId.data, fileId.data))
        ) {
          return standardError(
            context,
            404,
            "task_file_not_found",
            "The task file does not exist.",
          );
        }
        const download = await new UploadService({
          bucket: context.env.UPLOADS,
          database: requestDatabase(context),
        }).download(resolution.session, fileId.data);
        return new Response(download.body, {
          headers: {
            "Cache-Control": "private, no-store",
            "Content-Disposition": safeAttachmentDisposition(download.filename),
            "Content-Length": String(download.size),
            "Content-Security-Policy": "sandbox",
            "Content-Type": download.contentType,
            "Cross-Origin-Resource-Policy": "same-origin",
            ETag: download.etag,
            "X-Content-Type-Options": "nosniff",
          },
        });
      } catch (error) {
        if (error instanceof UploadError) {
          return standardError(
            context,
            error.code === "file_not_found" ? 404 : 409,
            "task_file_unavailable",
            "The task file is no longer available. Refresh the task to continue.",
          );
        }
        return taskError(context, error);
      }
    },
  );

  app.post(
    "/api/events/:eventKey/task-assignments/:assignmentId/submissions",
    async (context) => {
      if (!requireSameOrigin(context)) {
        return invalidRequest(
          context,
          "Task submissions require same-origin JSON requests.",
        );
      }
      if (!isFeatureEnabled(context.env.FEATURE_FLAGS, "writes")) {
        return writeUnavailable(context);
      }
      const assignmentId = taskStableIdSchema.safeParse(
        context.req.param("assignmentId"),
      );
      const input = taskAssignmentSubmissionCommandSchema.safeParse(
        await parsedJson(context),
      );
      if (!assignmentId.success || !input.success) {
        return invalidRequest(context, "The task submission is invalid.");
      }
      try {
        const resolution = await resolveTaskScope(
          context,
          context.req.param("eventKey"),
        );
        if (resolution.kind !== "resolved") {
          return scopeFailure(context, resolution);
        }
        await authService(context).verifyCsrf(
          resolution.session,
          context.req.header("X-CSRF-Token") ?? null,
        );
        const contactId = resolution.access.speakerContactId;
        const service = authorityService(context);
        if (
          !contactId ||
          !hasEventPermission(resolution.access, "portal:write:self") ||
          !(await service.assignmentBelongsToContact(
            resolution.event,
            assignmentId.data,
            contactId,
          ))
        ) {
          return standardError(
            context,
            403,
            "forbidden",
            "Only the assigned speaker can submit this task response.",
          );
        }
        const response = await service.submitAssignment(
          resolution.event,
          assignmentId.data,
          input.data,
          {
            actorId: contactId,
            auditActorType: "portal",
            domainActorType: "speaker",
          },
          context.get("requestId"),
        );
        return context.json(
          response,
          response.ok && response.repair_pending ? 202 : 200,
        );
      } catch (error) {
        return taskError(context, error);
      }
    },
  );

  app.post(
    "/api/events/:eventKey/task-assignments/:assignmentId/reviews",
    async (context) => {
      if (!requireSameOrigin(context)) {
        return invalidRequest(
          context,
          "Task reviews require same-origin JSON requests.",
        );
      }
      if (!isFeatureEnabled(context.env.FEATURE_FLAGS, "writes")) {
        return writeUnavailable(context);
      }
      const assignmentId = taskStableIdSchema.safeParse(
        context.req.param("assignmentId"),
      );
      const input = taskAssignmentReviewCommandSchema.safeParse(
        await parsedJson(context),
      );
      if (!assignmentId.success || !input.success) {
        return invalidRequest(context, "The task review is invalid.");
      }
      try {
        const resolution = await resolveTaskScope(
          context,
          context.req.param("eventKey"),
        );
        if (resolution.kind !== "resolved") {
          return scopeFailure(context, resolution);
        }
        await authService(context).verifyCsrf(
          resolution.session,
          context.req.header("X-CSRF-Token") ?? null,
        );
        if (!hasEventPermission(resolution.access, "event:manage")) {
          return standardError(
            context,
            403,
            "forbidden",
            "Organizer access is required to review task responses.",
          );
        }
        const response = await authorityService(context).reviewAssignment(
          resolution.event,
          assignmentId.data,
          input.data,
          organizerActor(resolution),
          context.get("requestId"),
        );
        return context.json(
          response,
          response.ok && response.repair_pending ? 202 : 200,
        );
      } catch (error) {
        return taskError(context, error);
      }
    },
  );

  app.post(
    "/api/events/:eventKey/task-assignments/:assignmentId/transitions",
    async (context) => {
      if (!requireSameOrigin(context)) {
        return invalidRequest(
          context,
          "Task commands require same-origin JSON requests.",
        );
      }
      if (!isFeatureEnabled(context.env.FEATURE_FLAGS, "writes")) {
        return writeUnavailable(context);
      }
      const assignmentId = taskStableIdSchema.safeParse(
        context.req.param("assignmentId"),
      );
      const input = taskAssignmentTransitionCommandSchema.safeParse(
        await parsedJson(context),
      );
      if (!assignmentId.success || !input.success) {
        return invalidRequest(
          context,
          "The task transition command is invalid.",
        );
      }
      try {
        const resolution = await resolveTaskScope(
          context,
          context.req.param("eventKey"),
        );
        if (resolution.kind !== "resolved") {
          return scopeFailure(context, resolution);
        }
        await authService(context).verifyCsrf(
          resolution.session,
          context.req.header("X-CSRF-Token") ?? null,
        );
        const service = authorityService(context);
        if (!hasEventPermission(resolution.access, "event:manage")) {
          return standardError(
            context,
            403,
            "forbidden",
            "Speaker task responses must use the submission route.",
          );
        }
        if (
          input.data.to === "submitted" ||
          input.data.to === "approved" ||
          input.data.to === "rejected"
        ) {
          return taskError(
            context,
            new TaskDomainError(
              "illegal_transition",
              "Submissions and review decisions must use their typed task routes.",
            ),
          );
        }
        const response = await service.transitionAssignment(
          resolution.event,
          assignmentId.data,
          input.data,
          organizerActor(resolution),
          context.get("requestId"),
        );
        return context.json(
          response,
          response.ok && response.repair_pending ? 202 : 200,
        );
      } catch (error) {
        return taskError(context, error);
      }
    },
  );
}
