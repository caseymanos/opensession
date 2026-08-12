import {
  createDeterministicEmailPreviewValues,
  emailTemplateCommandResponseSchema,
  emailTemplateCommandSchema,
  emailTemplatePreviewRequestSchema,
  emailTemplatePreviewResponseSchema,
  emailTemplateWorkspaceSchema,
  EmailTemplateValidationError,
  renderEmailTemplate,
  resolvedEmailMergeFields,
  type EmailMergeValues,
} from "@sessionbox-killer/email";
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
import {
  AuthorityCommandFailedError,
  AuthorityIdempotencyConflictError,
  AuthorityOutcomeUnknownError,
} from "../authority/types.js";
import { isFeatureEnabled } from "../features";
import {
  D1EmailTemplateProjectionRepository,
  EmailTemplateProjectionError,
  ephemeralEmailTemplate,
  type EmailTemplateEventProjection,
} from "./repository.js";
import {
  AirtableEmailTemplateCommandService,
  EmailTemplateHistoricalVersionError,
  EmailTemplateNotFoundError,
  EmailTemplateVersionConflictError,
} from "./service.js";

const requestBodyLimitBytes = 64 * 1_024;

type EventResolution =
  | { kind: "ambiguous" | "forbidden" | "not_found" }
  | { event: EmailTemplateEventProjection; kind: "resolved" };

function standardError(
  context: Context<AppContext>,
  status: 400 | 403 | 404 | 409 | 413 | 503,
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

async function resolveAuthorizedEvent(
  context: Context<AppContext>,
  repository: D1EmailTemplateProjectionRepository,
  eventKey: string,
  user: { readonly email: string; readonly id: string },
): Promise<EventResolution> {
  const candidates = await repository.findEventCandidates(eventKey);
  if (candidates.length === 0) return { kind: "not_found" };

  const permitted: EmailTemplateEventProjection[] = [];
  for (const candidate of candidates) {
    const access = await loadEventAccess(
      requestDatabase(context),
      user,
      candidate.organizationId,
      candidate.id,
    );
    if (hasEventPermission(access, "event:manage")) permitted.push(candidate);
  }

  const exactId = candidates.find(({ id }) => id === eventKey);
  if (exactId) {
    const event = permitted.find(({ id }) => id === exactId.id);
    return event ? { event, kind: "resolved" } : { kind: "forbidden" };
  }
  if (permitted.length === 0) return { kind: "forbidden" };
  if (permitted.length !== 1 || candidates.length > 32) {
    return { kind: "ambiguous" };
  }
  const [event] = permitted;
  return event ? { event, kind: "resolved" } : { kind: "not_found" };
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
      "You do not have permission to manage this event's email templates.",
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
    "email_template_event_not_found",
    "The requested event workspace does not exist.",
  );
}

function organizer(session: {
  readonly user: {
    readonly displayName: string | null;
    readonly email: string;
    readonly id: string;
  };
}) {
  return {
    email: session.user.email,
    id: session.user.id,
    name: session.user.displayName ?? "OpenSession organizer",
  };
}

async function previewValues(
  context: Context<AppContext>,
  repository: D1EmailTemplateProjectionRepository,
  event: EmailTemplateEventProjection,
  session: {
    readonly user: {
      readonly displayName: string | null;
      readonly email: string;
      readonly id: string;
    };
  },
  source:
    | { readonly kind: "seed" }
    | {
        readonly kind: "recipient";
        readonly recipientId: string;
      },
): Promise<EmailMergeValues | null> {
  if (source.kind === "seed") {
    return createDeterministicEmailPreviewValues({
      eventName: event.name,
      organizerEmail: session.user.email,
      organizerName: session.user.displayName ?? "OpenSession organizer",
      eventPublicUrl: `https://events.opensession.invalid/${event.slug}`,
      ...(event.venue ? { eventLocation: event.venue } : {}),
    });
  }
  return repository.readRecipientMergeValues({
    event,
    organizer: organizer(session),
    recipientId: source.recipientId,
    requestUrl: context.req.url,
  });
}

function commandFailure(context: Context<AppContext>, error: unknown) {
  if (error instanceof EmailTemplateValidationError) {
    return context.json(
      emailTemplateCommandResponseSchema.parse({
        error: {
          code: "email_template_validation_error",
          issues: error.issues,
          message: error.message,
        },
        ok: false,
      }),
      422,
    );
  }
  if (error instanceof EmailTemplateVersionConflictError) {
    return context.json(
      emailTemplateCommandResponseSchema.parse({
        error: {
          actualSourceVersion: error.actualSourceVersion,
          code: "email_template_version_conflict",
          expectedSourceVersion: error.expectedSourceVersion,
          message: error.message,
        },
        ok: false,
      }),
      409,
    );
  }
  if (error instanceof EmailTemplateHistoricalVersionError) {
    return context.json(
      emailTemplateCommandResponseSchema.parse({
        error: {
          code: "email_template_historical_version",
          message: error.message,
        },
        ok: false,
      }),
      409,
    );
  }
  if (error instanceof EmailTemplateNotFoundError) {
    return standardError(
      context,
      404,
      "email_template_not_found",
      "The selected template version no longer exists.",
    );
  }
  if (
    error instanceof AuthorityIdempotencyConflictError ||
    (error instanceof AuthorityCommandFailedError && error.status === 409)
  ) {
    return standardError(
      context,
      409,
      "email_template_authority_conflict",
      "The template command conflicts with a newer authoritative change.",
    );
  }
  if (
    error instanceof AuthorityCommandFailedError ||
    error instanceof AuthorityOutcomeUnknownError ||
    error instanceof EmailTemplateProjectionError
  ) {
    return standardError(
      context,
      503,
      "email_template_authority_unavailable",
      "The authoritative email-template service is temporarily unavailable.",
    );
  }
  try {
    return authFailure(context, error);
  } catch {
    return standardError(
      context,
      503,
      "email_template_authority_unavailable",
      "The authoritative email-template service is temporarily unavailable.",
    );
  }
}

export function registerEmailTemplateRoutes(app: Hono<AppContext>): void {
  for (const path of [
    "/api/events/:eventKey/email-templates/preview",
    "/api/events/:eventKey/email-templates/commands",
  ]) {
    app.use(
      path,
      bodyLimit({
        maxSize: requestBodyLimitBytes,
        onError: (context) =>
          standardError(
            context,
            413,
            "request_too_large",
            "The email-template request body is too large.",
          ),
      }),
    );
  }

  app.get("/api/events/:eventKey/email-templates", async (context) => {
    const repository = new D1EmailTemplateProjectionRepository(
      requestDatabase(context),
    );
    try {
      const session = await authService(context).authenticate(
        sessionToken(context),
      );
      const resolution = await resolveAuthorizedEvent(
        context,
        repository,
        context.req.param("eventKey"),
        session.user,
      );
      if (resolution.kind !== "resolved") {
        return eventResolutionFailure(context, resolution);
      }
      return context.json(
        emailTemplateWorkspaceSchema.parse(
          await repository.readWorkspace(resolution.event),
        ),
      );
    } catch (error) {
      return commandFailure(context, error);
    }
  });

  app.post("/api/events/:eventKey/email-templates/preview", async (context) => {
    const input = emailTemplatePreviewRequestSchema.safeParse(
      await parsedJson(context),
    );
    if (!input.success) {
      return standardError(
        context,
        400,
        "invalid_email_template_preview",
        input.error.issues[0]?.message ?? "The preview request is invalid.",
      );
    }
    const repository = new D1EmailTemplateProjectionRepository(
      requestDatabase(context),
    );
    try {
      const session = await authService(context).authenticate(
        sessionToken(context),
      );
      const resolution = await resolveAuthorizedEvent(
        context,
        repository,
        context.req.param("eventKey"),
        session.user,
      );
      if (resolution.kind !== "resolved") {
        return eventResolutionFailure(context, resolution);
      }
      const base = await repository.readTemplate(
        resolution.event,
        input.data.baseTemplateId,
      );
      if (!base) {
        return standardError(
          context,
          404,
          "email_template_not_found",
          "The selected template version no longer exists.",
        );
      }
      const template = ephemeralEmailTemplate(
        base.template,
        input.data.template,
      );
      const values = await previewValues(
        context,
        repository,
        resolution.event,
        session,
        input.data.source,
      );
      if (!values) {
        return standardError(
          context,
          404,
          "email_preview_recipient_not_found",
          "The selected preview recipient is unavailable.",
        );
      }
      const resolvedFields = resolvedEmailMergeFields(template, values);
      try {
        const preview = renderEmailTemplate(template, values);
        return context.json(
          emailTemplatePreviewResponseSchema.parse({
            ok: true,
            preview,
            resolvedFields,
            source: input.data.source,
          }),
        );
      } catch (error) {
        if (!(error instanceof EmailTemplateValidationError)) throw error;
        return context.json(
          emailTemplatePreviewResponseSchema.parse({
            issues: error.issues,
            ok: false,
            resolvedFields,
            source: input.data.source,
          }),
          422,
        );
      }
    } catch (error) {
      return commandFailure(context, error);
    }
  });

  app.post(
    "/api/events/:eventKey/email-templates/commands",
    async (context) => {
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
      const input = emailTemplateCommandSchema.safeParse(
        await parsedJson(context),
      );
      if (!input.success) {
        return standardError(
          context,
          400,
          "invalid_email_template_command",
          input.error.issues[0]?.message ?? "The template command is invalid.",
        );
      }
      const repository = new D1EmailTemplateProjectionRepository(
        requestDatabase(context),
      );
      try {
        const authentication = authService(context);
        const session = await authentication.authenticate(
          sessionToken(context),
        );
        await authentication.verifyCsrf(
          session,
          context.req.header("X-CSRF-Token") ?? null,
        );
        const resolution = await resolveAuthorizedEvent(
          context,
          repository,
          context.req.param("eventKey"),
          session.user,
        );
        if (resolution.kind !== "resolved") {
          return eventResolutionFailure(context, resolution);
        }
        const activationValues =
          input.data.type === "activate_version"
            ? await previewValues(
                context,
                repository,
                resolution.event,
                session,
                input.data.source,
              )
            : undefined;
        if (input.data.type === "activate_version" && !activationValues) {
          return standardError(
            context,
            404,
            "email_preview_recipient_not_found",
            "The selected preview recipient is unavailable.",
          );
        }
        const result = await new AirtableEmailTemplateCommandService({
          actor: organizer(session),
          authority: getBaseAuthority(context.env),
          projection: repository,
          requestId: context.get("requestId"),
        }).execute(resolution.event, input.data, activationValues ?? undefined);
        return context.json(
          emailTemplateCommandResponseSchema.parse({ ok: true, result }),
        );
      } catch (error) {
        return commandFailure(context, error);
      }
    },
  );
}
