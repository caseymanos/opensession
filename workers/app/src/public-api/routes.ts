import {
  apiKeyCreateRequestSchema,
  publicApiIdentifierSchema,
  publicApiSubmissionPatchSchema,
  publicApiSubmissionSchema,
} from "@sessionbox-killer/contracts/public-api";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import type { AppContext } from "../app-context.js";
import { sha256Hex } from "../auth/crypto.js";
import { hasEventPermission, loadEventAccess } from "../auth/authorization.js";
import { authService, requireSameOrigin, sessionToken } from "../auth/http.js";
import { AuthError } from "../auth/service.js";
import { getBaseAuthority } from "../authority/binding.js";
import { isFeatureEnabled } from "../features.js";
import {
  OrganizerSubmissionIdempotencyConflictError,
  OrganizerSubmissionNotFoundError,
  OrganizerSubmissionValidationError,
  OrganizerSubmissionVersionConflictError,
} from "../organizer-submissions/policy.js";
import { AirtableOrganizerSubmissionCommandService } from "../organizer-submissions/service.js";
import { publicApiOperation } from "./catalog.js";
import { publicApiDocsHtml } from "./docs.js";
import {
  authenticatePublicApi,
  parsePaginationQuery,
  problemResponse,
  requireEntityVersion,
  requireIdempotencyKey,
} from "./http.js";
import {
  ApiKeyCreationPendingError,
  ApiKeyIdempotencyConflictError,
  ApiKeyManagementService,
  ApiKeyNotFoundError,
  ApiKeyPlaintextUnavailableError,
  ApiKeyValidationError,
  type ApiKeyManagementAccess,
  type AuthenticatedApiKey,
} from "./key-service.js";
import { publicOpenApiDocument } from "./openapi.js";
import {
  PublicApiCursorError,
  PublicApiRepository,
  resourceEntityTag,
} from "./repository.js";

const jsonBodyLimitBytes = 16 * 1024;
const eventKeyPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;

interface ManagementEventCandidate {
  id: string;
  organization_id: string;
}

type ManagementAccessResult =
  | { kind: "ambiguous" | "forbidden" | "not_found" }
  | { access: ApiKeyManagementAccess; kind: "resolved" };

function route(id: Parameters<typeof publicApiOperation>[0]): string {
  return publicApiOperation(id).honoPath;
}

function managementProblem(
  context: Context<AppContext>,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 503,
  code: string,
  title: string,
  detail: string,
  field?: string,
) {
  return problemResponse(
    context,
    status,
    code,
    title,
    detail,
    field ? [{ field, message: detail }] : undefined,
  );
}

async function resolveManagementAccess(
  context: Context<AppContext>,
): Promise<ManagementAccessResult> {
  const eventKey = context.req.param("eventKey") ?? "";
  if (!eventKeyPattern.test(eventKey)) return { kind: "not_found" };
  const authentication = authService(context);
  const session = await authentication.authenticate(sessionToken(context));
  const candidates = await context.env.DB.prepare(
    `SELECT event.id, event.organization_id
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
    .all<ManagementEventCandidate>();
  if (candidates.results.length === 0) return { kind: "not_found" };

  const permitted: {
    access: Awaited<ReturnType<typeof loadEventAccess>>;
    event: ManagementEventCandidate;
  }[] = [];
  for (const event of candidates.results) {
    const access = await loadEventAccess(
      context.env.DB,
      session.user,
      event.organization_id,
      event.id,
      { requireAuthorityReady: false },
    );
    if (hasEventPermission(access, "event:manage")) {
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
    access: {
      actorId: session.user.id,
      canManageOrganization:
        selected.access.organizationRole === "owner" ||
        selected.access.organizationRole === "organizer",
      eventId: selected.event.id,
      organizationId: selected.event.organization_id,
      requestId: context.get("requestId"),
    },
    kind: "resolved",
  };
}

function managementResolutionProblem(
  context: Context<AppContext>,
  resolution: Exclude<ManagementAccessResult, { kind: "resolved" }>,
) {
  if (resolution.kind === "forbidden") {
    return managementProblem(
      context,
      403,
      "api_key_management_forbidden",
      "API key management forbidden",
      "You do not have permission to manage API keys for this event.",
    );
  }
  if (resolution.kind === "ambiguous") {
    return managementProblem(
      context,
      409,
      "ambiguous_event_slug",
      "Ambiguous event slug",
      "This event slug is ambiguous; use the canonical event ID.",
    );
  }
  return managementProblem(
    context,
    404,
    "event_not_found",
    "Event not found",
    "The requested event does not exist.",
  );
}

function publicPathIdentifier(
  context: Context<AppContext>,
  name: string,
): { data: string } | { response: Response } {
  const parsed = publicApiIdentifierSchema.safeParse(context.req.param(name));
  if (parsed.success) return { data: parsed.data };
  return {
    response: problemResponse(
      context,
      400,
      "invalid_path_parameter",
      "Invalid path parameter",
      `The ${name} path parameter is invalid.`,
      [{ field: name, message: "Use the canonical resource identifier." }],
    ),
  };
}

function publicNotFound(context: Context<AppContext>, resource: string) {
  return problemResponse(
    context,
    404,
    "resource_not_found",
    "Resource not found",
    `The requested ${resource} does not exist in this API key's scope.`,
  );
}

function publicUnavailable(context: Context<AppContext>) {
  return problemResponse(
    context,
    503,
    "public_api_unavailable",
    "Public API unavailable",
    "The requested resource is temporarily unavailable.",
  );
}

function publicRepository(context: Context<AppContext>): PublicApiRepository {
  return new PublicApiRepository(context.env.DB, context.env.AUTH_HASH_PEPPER);
}

async function authenticateEventRequest(
  context: Context<AppContext>,
  scope: Parameters<typeof authenticatePublicApi>[1],
): Promise<
  { eventId: string; key: AuthenticatedApiKey } | { response: Response }
> {
  const event = publicPathIdentifier(context, "eventId");
  if ("response" in event) return event;
  const authentication = await authenticatePublicApi(
    context,
    scope,
    event.data,
  );
  return "response" in authentication
    ? authentication
    : { eventId: event.data, key: authentication.key };
}

function setEntityTag(context: Context<AppContext>, value: string): void {
  context.header("ETag", value);
}

async function handleManagementError(
  context: Context<AppContext>,
  error: unknown,
): Promise<Response> {
  if (error instanceof ApiKeyValidationError) {
    return managementProblem(
      context,
      400,
      "api_key_validation_error",
      "Invalid API key configuration",
      error.message,
      error.field,
    );
  }
  if (error instanceof ApiKeyIdempotencyConflictError) {
    return managementProblem(
      context,
      409,
      "idempotency_conflict",
      "Idempotency conflict",
      error.message,
    );
  }
  if (error instanceof ApiKeyPlaintextUnavailableError) {
    return managementProblem(
      context,
      409,
      "api_key_plaintext_unavailable",
      "API key plaintext unavailable",
      error.message,
    );
  }
  if (error instanceof ApiKeyCreationPendingError) {
    return managementProblem(
      context,
      409,
      "api_key_creation_pending",
      "API key creation pending",
      error.message,
    );
  }
  if (error instanceof ApiKeyNotFoundError) {
    return managementProblem(
      context,
      404,
      "api_key_not_found",
      "API key not found",
      error.message,
    );
  }
  if (error instanceof AuthError) {
    const status =
      error.code === "invalid_session"
        ? 401
        : error.code === "invalid_csrf"
          ? 403
          : 400;
    return managementProblem(
      context,
      status,
      error.code,
      status === 401 ? "Authentication required" : "Request not authorized",
      error.message,
    );
  }
  return managementProblem(
    context,
    503,
    "api_key_management_unavailable",
    "API key management unavailable",
    "API key management is temporarily unavailable.",
  );
}

export function registerApiKeyManagementRoutes(app: Hono<AppContext>): void {
  app.use(
    "/api/events/:eventKey/api-keys",
    bodyLimit({
      maxSize: jsonBodyLimitBytes,
      onError: (context) =>
        managementProblem(
          context,
          413,
          "request_too_large",
          "Request too large",
          "The API key request body exceeds 16 KiB.",
        ),
    }),
  );

  app.get("/api/events/:eventKey/api-keys", async (context) => {
    try {
      const resolution = await resolveManagementAccess(context);
      if (resolution.kind !== "resolved") {
        return managementResolutionProblem(context, resolution);
      }
      return context.json(
        await new ApiKeyManagementService({
          database: context.env.DB,
          hashPepper: context.env.AUTH_HASH_PEPPER,
        }).list(resolution.access),
      );
    } catch (error) {
      return handleManagementError(context, error);
    }
  });

  app.post("/api/events/:eventKey/api-keys", async (context) => {
    if (!isFeatureEnabled(context.env.FEATURE_FLAGS, "writes")) {
      return managementProblem(
        context,
        503,
        "writes_disabled",
        "Writes disabled",
        "Changes are temporarily disabled in this environment.",
      );
    }
    if (!requireSameOrigin(context)) {
      return managementProblem(
        context,
        403,
        "invalid_origin",
        "Invalid request origin",
        "This request must originate from OpenSession and use JSON.",
      );
    }
    const idempotency = requireIdempotencyKey(context);
    if ("response" in idempotency) return idempotency.response;
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      body = null;
    }
    const input = apiKeyCreateRequestSchema.safeParse(body);
    if (!input.success) {
      const issue = input.error.issues[0];
      return managementProblem(
        context,
        400,
        "api_key_validation_error",
        "Invalid API key configuration",
        issue?.message ?? "The API key configuration is invalid.",
        issue?.path.join(".") || "body",
      );
    }
    try {
      const authentication = authService(context);
      const session = await authentication.authenticate(sessionToken(context));
      await authentication.verifyCsrf(
        session,
        context.req.header("X-CSRF-Token") ?? null,
      );
      const resolution = await resolveManagementAccess(context);
      if (resolution.kind !== "resolved") {
        return managementResolutionProblem(context, resolution);
      }
      const response = await new ApiKeyManagementService({
        database: context.env.DB,
        hashPepper: context.env.AUTH_HASH_PEPPER,
      }).create(resolution.access, input.data, idempotency.data);
      context.header("Cache-Control", "no-store");
      return context.json(response, 201);
    } catch (error) {
      return handleManagementError(context, error);
    }
  });

  app.delete("/api/events/:eventKey/api-keys/:keyId", async (context) => {
    if (!isFeatureEnabled(context.env.FEATURE_FLAGS, "writes")) {
      return managementProblem(
        context,
        503,
        "writes_disabled",
        "Writes disabled",
        "Changes are temporarily disabled in this environment.",
      );
    }
    if (!requireSameOrigin(context)) {
      return managementProblem(
        context,
        403,
        "invalid_origin",
        "Invalid request origin",
        "This request must originate from OpenSession and use JSON.",
      );
    }
    const idempotency = requireIdempotencyKey(context);
    if ("response" in idempotency) return idempotency.response;
    try {
      const authentication = authService(context);
      const session = await authentication.authenticate(sessionToken(context));
      await authentication.verifyCsrf(
        session,
        context.req.header("X-CSRF-Token") ?? null,
      );
      const resolution = await resolveManagementAccess(context);
      if (resolution.kind !== "resolved") {
        return managementResolutionProblem(context, resolution);
      }
      const keyId = publicApiIdentifierSchema.safeParse(
        context.req.param("keyId"),
      );
      if (!keyId.success) throw new ApiKeyNotFoundError();
      return context.json(
        await new ApiKeyManagementService({
          database: context.env.DB,
          hashPepper: context.env.AUTH_HASH_PEPPER,
        }).revoke(resolution.access, keyId.data),
      );
    } catch (error) {
      return handleManagementError(context, error);
    }
  });
}

function registerPublicApiReadRoutes(app: Hono<AppContext>): void {
  app.get(route("listEvents"), async (context) => {
    const pagination = parsePaginationQuery(context);
    if ("response" in pagination) return pagination.response;
    try {
      const authentication = await authenticatePublicApi(
        context,
        publicApiOperation("listEvents").scope,
      );
      if ("response" in authentication) return authentication.response;
      return context.json(
        await publicRepository(context).listEvents(
          authentication.key,
          pagination.data,
        ),
      );
    } catch (error) {
      return error instanceof PublicApiCursorError
        ? problemResponse(
            context,
            400,
            "invalid_cursor",
            "Invalid cursor",
            error.message,
          )
        : publicUnavailable(context);
    }
  });

  app.get(route("getEvent"), async (context) => {
    try {
      const authentication = await authenticateEventRequest(
        context,
        publicApiOperation("getEvent").scope,
      );
      if ("response" in authentication) return authentication.response;
      const resource = await publicRepository(context).event(
        authentication.key,
        authentication.eventId,
      );
      if (!resource) return publicNotFound(context, "event");
      setEntityTag(context, resourceEntityTag("event", resource.version));
      return context.json(resource);
    } catch {
      return publicUnavailable(context);
    }
  });

  const collectionRoutes = [
    {
      id: "listSubmissions" as const,
      load: (
        repository: PublicApiRepository,
        key: AuthenticatedApiKey,
        eventId: string,
        query: Parameters<PublicApiRepository["listSubmissions"]>[2],
      ) => repository.listSubmissions(key, eventId, query),
    },
    {
      id: "listSessions" as const,
      load: (
        repository: PublicApiRepository,
        key: AuthenticatedApiKey,
        eventId: string,
        query: Parameters<PublicApiRepository["listSessions"]>[2],
      ) => repository.listSessions(key, eventId, query),
    },
    {
      id: "listSpeakers" as const,
      load: (
        repository: PublicApiRepository,
        key: AuthenticatedApiKey,
        eventId: string,
        query: Parameters<PublicApiRepository["listSpeakers"]>[2],
      ) => repository.listSpeakers(key, eventId, query),
    },
    {
      id: "listTasks" as const,
      load: (
        repository: PublicApiRepository,
        key: AuthenticatedApiKey,
        eventId: string,
        query: Parameters<PublicApiRepository["listTasks"]>[2],
      ) => repository.listTasks(key, eventId, query),
    },
    {
      id: "listExportRuns" as const,
      load: (
        repository: PublicApiRepository,
        key: AuthenticatedApiKey,
        eventId: string,
        query: Parameters<PublicApiRepository["listExportRuns"]>[2],
      ) => repository.listExportRuns(key, eventId, query),
    },
  ];
  for (const collection of collectionRoutes) {
    app.get(route(collection.id), async (context) => {
      const pagination = parsePaginationQuery(context);
      if ("response" in pagination) return pagination.response;
      try {
        const authentication = await authenticateEventRequest(
          context,
          publicApiOperation(collection.id).scope,
        );
        if ("response" in authentication) return authentication.response;
        return context.json(
          await collection.load(
            publicRepository(context),
            authentication.key,
            authentication.eventId,
            pagination.data,
          ),
        );
      } catch (error) {
        return error instanceof PublicApiCursorError
          ? problemResponse(
              context,
              400,
              "invalid_cursor",
              "Invalid cursor",
              error.message,
            )
          : publicUnavailable(context);
      }
    });
  }

  const detailRoutes = [
    {
      entityTag: (version: number) => resourceEntityTag("submission", version),
      id: "getSubmission" as const,
      load: (
        repository: PublicApiRepository,
        key: AuthenticatedApiKey,
        eventId: string,
        resourceId: string,
      ) => repository.submission(key, eventId, resourceId),
      parameter: "submissionId",
      resource: "submission",
    },
    {
      entityTag: (version: number) => resourceEntityTag("session", version),
      id: "getSession" as const,
      load: (
        repository: PublicApiRepository,
        key: AuthenticatedApiKey,
        eventId: string,
        resourceId: string,
      ) => repository.session(key, eventId, resourceId),
      parameter: "sessionId",
      resource: "session",
    },
    {
      id: "getSpeaker" as const,
      load: (
        repository: PublicApiRepository,
        key: AuthenticatedApiKey,
        eventId: string,
        resourceId: string,
      ) => repository.speaker(key, eventId, resourceId),
      parameter: "speakerId",
      resource: "speaker",
    },
    {
      entityTag: (version: number) => resourceEntityTag("task", version),
      id: "getTask" as const,
      load: (
        repository: PublicApiRepository,
        key: AuthenticatedApiKey,
        eventId: string,
        resourceId: string,
      ) => repository.task(key, eventId, resourceId),
      parameter: "taskId",
      resource: "task",
    },
    {
      id: "getExportRun" as const,
      load: (
        repository: PublicApiRepository,
        key: AuthenticatedApiKey,
        eventId: string,
        resourceId: string,
      ) => repository.exportRun(key, eventId, resourceId),
      parameter: "runId",
      resource: "export run",
    },
  ];
  for (const detail of detailRoutes) {
    app.get(route(detail.id), async (context) => {
      try {
        const authentication = await authenticateEventRequest(
          context,
          publicApiOperation(detail.id).scope,
        );
        if ("response" in authentication) return authentication.response;
        const identifier = publicPathIdentifier(context, detail.parameter);
        if ("response" in identifier) return identifier.response;
        const resource = await detail.load(
          publicRepository(context),
          authentication.key,
          authentication.eventId,
          identifier.data,
        );
        if (!resource) return publicNotFound(context, detail.resource);
        if (detail.entityTag && "version" in resource) {
          setEntityTag(context, detail.entityTag(resource.version));
        }
        return context.json(resource);
      } catch {
        return publicUnavailable(context);
      }
    });
  }

  app.get(route("getPublishedSchedule"), async (context) => {
    try {
      const authentication = await authenticateEventRequest(
        context,
        publicApiOperation("getPublishedSchedule").scope,
      );
      if ("response" in authentication) return authentication.response;
      const schedule = await publicRepository(context).schedule(
        authentication.key,
        authentication.eventId,
      );
      if (!schedule) return publicNotFound(context, "published schedule");
      setEntityTag(context, schedule.etag);
      context.header("Cache-Control", "private, max-age=30");
      return context.json(schedule.data);
    } catch {
      return publicUnavailable(context);
    }
  });
}

function registerPublicApiMutationRoutes(app: Hono<AppContext>): void {
  app.use(
    route("updateSubmission"),
    bodyLimit({
      maxSize: jsonBodyLimitBytes,
      onError: (context) =>
        problemResponse(
          context,
          413,
          "request_too_large",
          "Request too large",
          "The request body exceeds 16 KiB.",
        ),
    }),
  );
  app.patch(route("updateSubmission"), async (context) => {
    if (!isFeatureEnabled(context.env.FEATURE_FLAGS, "writes")) {
      return problemResponse(
        context,
        503,
        "writes_disabled",
        "Writes disabled",
        "Changes are temporarily disabled in this environment.",
      );
    }
    let authentication: Awaited<ReturnType<typeof authenticateEventRequest>>;
    try {
      authentication = await authenticateEventRequest(
        context,
        publicApiOperation("updateSubmission").scope,
      );
    } catch {
      return publicUnavailable(context);
    }
    if ("response" in authentication) return authentication.response;
    const submissionId = publicPathIdentifier(context, "submissionId");
    if ("response" in submissionId) return submissionId.response;
    const idempotency = requireIdempotencyKey(context);
    if ("response" in idempotency) return idempotency.response;
    const precondition = requireEntityVersion(context, "submission");
    if ("response" in precondition) return precondition.response;
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      body = null;
    }
    const input = publicApiSubmissionPatchSchema.safeParse(body);
    if (!input.success) {
      const issue = input.error.issues[0];
      return problemResponse(
        context,
        400,
        "invalid_request_body",
        "Invalid request body",
        issue?.message ?? "The submission update is invalid.",
        [
          {
            field: issue?.path.join(".") || "body",
            message: issue?.message ?? "The submission update is invalid.",
          },
        ],
      );
    }
    try {
      const repository = publicRepository(context);
      const current = await repository.submission(
        authentication.key,
        authentication.eventId,
        submissionId.data,
      );
      if (!current) return publicNotFound(context, "submission");
      if (current.version !== precondition.data) {
        return problemResponse(
          context,
          412,
          "etag_mismatch",
          "Entity tag mismatch",
          "The submission changed after it was read. Fetch it again before retrying.",
        );
      }
      const commandId = `cmd_${(
        await sha256Hex(
          `${authentication.key.organizationId}\u0000${idempotency.data}`,
        )
      ).slice(0, 48)}`;
      const commandType =
        input.data.status === "in_review"
          ? "start_review"
          : input.data.status === "submitted"
            ? "reopen"
            : "withdraw";
      const result = await new AirtableOrganizerSubmissionCommandService({
        actorDisplayName: authentication.key.name,
        actorId: authentication.key.id,
        actorType: "api_key",
        authority: getBaseAuthority(context.env),
        database: context.env.DB,
        eventId: authentication.eventId,
        organizationId: authentication.key.organizationId,
        requestId: context.get("requestId"),
      }).execute({
        commandId,
        expectedVersion: precondition.data,
        reason: input.data.reason,
        submissionId: submissionId.data,
        type: commandType,
      });
      const resource = publicApiSubmissionSchema.parse({
        ...current,
        status: result.status,
        updated_at: result.appliedAt,
        version: result.version,
      });
      setEntityTag(context, resourceEntityTag("submission", resource.version));
      return context.json(resource);
    } catch (error) {
      if (error instanceof OrganizerSubmissionVersionConflictError) {
        return problemResponse(
          context,
          412,
          "etag_mismatch",
          "Entity tag mismatch",
          error.message,
        );
      }
      if (error instanceof OrganizerSubmissionIdempotencyConflictError) {
        return problemResponse(
          context,
          409,
          "idempotency_conflict",
          "Idempotency conflict",
          "This Idempotency-Key was already used for a different submission update.",
        );
      }
      if (error instanceof OrganizerSubmissionValidationError) {
        return problemResponse(
          context,
          409,
          "illegal_submission_transition",
          "Illegal submission transition",
          error.message,
          [{ field: error.field, message: error.message }],
        );
      }
      if (error instanceof OrganizerSubmissionNotFoundError) {
        return publicNotFound(context, "submission");
      }
      return publicUnavailable(context);
    }
  });
}

export function registerPublicApiRoutes(app: Hono<AppContext>): void {
  registerPublicApiReadRoutes(app);
  registerPublicApiMutationRoutes(app);
  app.all("/api/v1/*", (context) =>
    problemResponse(
      context,
      404,
      "public_api_route_not_found",
      "Public API route not found",
      "The requested public API v1 route does not exist.",
    ),
  );
}

export function registerPublicApiDocumentationRoutes(
  app: Hono<AppContext>,
): void {
  app.get("/openapi.json", (context) => {
    context.header("Cache-Control", "public, max-age=300");
    return context.json(publicOpenApiDocument);
  });
  for (const path of ["/docs/api", "/docs/api/"] as const) {
    app.get(path, (context) => {
      context.header("Cache-Control", "public, max-age=300");
      context.header(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      );
      return context.html(publicApiDocsHtml());
    });
  }
}
