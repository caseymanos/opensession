import {
  campaignConfirmRequestSchema,
  campaignDeliveryLogSchema,
  campaignPreviewRequestSchema,
  campaignReplayRequestSchema,
  campaignWorkspaceSchema,
  CampaignPlanError,
} from "@sessionbox-killer/email";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import type { AppContext } from "../app-context.js";
import { hasEventPermission, loadEventAccess } from "../auth/authorization.js";
import {
  authFailure,
  authService,
  requireSameOrigin,
  sessionToken,
} from "../auth/http.js";
import { getBaseAuthority } from "../authority/binding.js";
import {
  AuthorityCommandFailedError,
  AuthorityIdempotencyConflictError,
  AuthorityOutcomeUnknownError,
} from "../authority/types.js";
import { parseEmailDeliveryConfig } from "../email/config.js";
import { isFeatureEnabled } from "../features.js";
import {
  EmailTemplateProjectionError,
  type EmailTemplateEventProjection,
} from "../email-templates/repository.js";
import { CampaignProjectionError, D1CampaignRepository } from "./repository.js";
import {
  assertProviderAcceptanceWindow,
  ProviderAcceptanceUnavailableError,
  runProviderAcceptance,
  type ProviderAcceptancePhase,
} from "./provider-acceptance.js";
import {
  CampaignConfirmationConflictError,
  CampaignNotFoundError,
  CampaignPreviewChangedError,
  CampaignPreviewExpiredError,
  CampaignService,
} from "./service.js";

const requestBodyLimitBytes = 32 * 1_024;
const stableIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const providerAcceptanceCommandPattern = /^ral59_[A-Za-z0-9_]{6,48}$/;

type EventResolution =
  | { kind: "ambiguous" | "forbidden" | "not_found" }
  | { event: EmailTemplateEventProjection; kind: "resolved" };

function standardError(
  context: Context<AppContext>,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 503,
  code: string,
  message: string,
) {
  return context.json(
    { error: { code, message }, request_id: context.get("requestId") },
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
  repository: D1CampaignRepository,
  eventKey: string,
  user: { readonly email: string; readonly id: string },
): Promise<EventResolution> {
  const candidates = await repository.findEventCandidates(eventKey);
  if (candidates.length === 0) return { kind: "not_found" };
  const permitted: EmailTemplateEventProjection[] = [];
  for (const candidate of candidates) {
    const access = await loadEventAccess(
      context.env.DB,
      user,
      candidate.organizationId,
      candidate.id,
    );
    if (hasEventPermission(access, "event:manage")) permitted.push(candidate);
  }
  const exact = candidates.find(({ id }) => id === eventKey);
  if (exact) {
    const event = permitted.find(({ id }) => id === exact.id);
    return event ? { event, kind: "resolved" } : { kind: "forbidden" };
  }
  if (permitted.length === 0) return { kind: "forbidden" };
  if (permitted.length !== 1 || candidates.length > 32) {
    return { kind: "ambiguous" };
  }
  const [event] = permitted;
  return event ? { event, kind: "resolved" } : { kind: "not_found" };
}

function eventFailure(
  context: Context<AppContext>,
  resolution: Exclude<EventResolution, { kind: "resolved" }>,
) {
  if (resolution.kind === "forbidden") {
    return standardError(
      context,
      403,
      "forbidden",
      "You do not have permission to manage this event's campaigns.",
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
    "campaign_event_not_found",
    "The requested campaign workspace does not exist.",
  );
}

function actor(session: {
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

function service(
  context: Context<AppContext>,
  repository: D1CampaignRepository,
  session: Parameters<typeof actor>[0],
) {
  return new CampaignService({
    actor: actor(session),
    authority: getBaseAuthority(context.env),
    config: parseEmailDeliveryConfig(
      context.env.EMAIL_DELIVERY_CONFIG,
      context.env.APP_ENV,
    ),
    database: context.env.DB,
    queue: context.env.EMAIL_QUEUE,
    repository,
    requestUrl: context.req.url,
  });
}

function campaignFailure(context: Context<AppContext>, error: unknown) {
  if (error instanceof CampaignNotFoundError) {
    return standardError(
      context,
      404,
      "campaign_not_found",
      "The campaign or template was not found in this event.",
    );
  }
  if (
    error instanceof CampaignConfirmationConflictError ||
    error instanceof AuthorityIdempotencyConflictError ||
    (error instanceof AuthorityCommandFailedError && error.status === 409)
  ) {
    return standardError(
      context,
      409,
      "campaign_command_conflict",
      "The campaign command conflicts with an existing confirmation.",
    );
  }
  if (error instanceof CampaignPreviewChangedError) {
    return standardError(
      context,
      409,
      "campaign_preview_changed",
      error.message,
    );
  }
  if (error instanceof CampaignPreviewExpiredError) {
    return standardError(
      context,
      409,
      "campaign_preview_expired",
      error.message,
    );
  }
  if (error instanceof CampaignPlanError) {
    return standardError(context, 422, "campaign_plan_invalid", error.message);
  }
  if (
    error instanceof CampaignProjectionError ||
    error instanceof EmailTemplateProjectionError ||
    error instanceof AuthorityCommandFailedError ||
    error instanceof AuthorityOutcomeUnknownError
  ) {
    return standardError(
      context,
      503,
      "campaign_service_unavailable",
      "The campaign service is temporarily unavailable.",
    );
  }
  try {
    return authFailure(context, error);
  } catch {
    return standardError(
      context,
      503,
      "campaign_service_unavailable",
      "The campaign service is temporarily unavailable.",
    );
  }
}

async function authenticatedEvent(
  context: Context<AppContext>,
  repository: D1CampaignRepository,
) {
  const session = await authService(context).authenticate(
    sessionToken(context),
  );
  const resolution = await resolveAuthorizedEvent(
    context,
    repository,
    context.req.param("eventKey") ?? "",
    session.user,
  );
  return { resolution, session };
}

async function verifyMutation(
  context: Context<AppContext>,
  session: Awaited<ReturnType<typeof authenticatedEvent>>["session"],
): Promise<boolean> {
  if (!requireSameOrigin(context)) return false;
  await authService(context).verifyCsrf(
    session,
    context.req.header("X-CSRF-Token") ?? null,
  );
  return true;
}

export function registerCampaignRoutes(app: Hono<AppContext>): void {
  for (const path of [
    "/api/events/:eventKey/campaigns/preview",
    "/api/events/:eventKey/campaigns/confirm",
    "/api/events/:eventKey/campaigns/provider-acceptance",
    "/api/events/:eventKey/campaigns/:campaignId/replay",
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
            "The campaign request body is too large.",
          ),
      }),
    );
  }

  app.get("/api/events/:eventKey/campaigns", async (context) => {
    const repository = new D1CampaignRepository(context.env.DB);
    try {
      const { resolution } = await authenticatedEvent(context, repository);
      if (resolution.kind !== "resolved") {
        return eventFailure(context, resolution);
      }
      const config = parseEmailDeliveryConfig(
        context.env.EMAIL_DELIVERY_CONFIG,
        context.env.APP_ENV,
      );
      return context.json(
        campaignWorkspaceSchema.parse(
          await repository.readWorkspace(resolution.event, config.mode),
        ),
      );
    } catch (error) {
      return campaignFailure(context, error);
    }
  });

  app.post("/api/events/:eventKey/campaigns/preview", async (context) => {
    if (!isFeatureEnabled(context.env.FEATURE_FLAGS, "email")) {
      return standardError(
        context,
        503,
        "email_disabled",
        "Email delivery is temporarily disabled.",
      );
    }
    const input = campaignPreviewRequestSchema.safeParse(
      await parsedJson(context),
    );
    if (!input.success) {
      return standardError(
        context,
        400,
        "invalid_campaign_preview",
        input.error.issues[0]?.message ?? "The preview request is invalid.",
      );
    }
    const repository = new D1CampaignRepository(context.env.DB);
    try {
      const { resolution, session } = await authenticatedEvent(
        context,
        repository,
      );
      if (resolution.kind !== "resolved") {
        return eventFailure(context, resolution);
      }
      return context.json(
        await service(context, repository, session).preview(
          resolution.event,
          input.data,
        ),
      );
    } catch (error) {
      return campaignFailure(context, error);
    }
  });

  app.post("/api/events/:eventKey/campaigns/confirm", async (context) => {
    if (
      !isFeatureEnabled(context.env.FEATURE_FLAGS, "email") ||
      !isFeatureEnabled(context.env.FEATURE_FLAGS, "writes")
    ) {
      return standardError(
        context,
        503,
        "campaign_writes_disabled",
        "Campaign confirmation is temporarily disabled.",
      );
    }
    const input = campaignConfirmRequestSchema.safeParse(
      await parsedJson(context),
    );
    if (!input.success) {
      return standardError(
        context,
        400,
        "invalid_campaign_confirmation",
        input.error.issues[0]?.message ?? "The confirmation is invalid.",
      );
    }
    const repository = new D1CampaignRepository(context.env.DB);
    try {
      const { resolution, session } = await authenticatedEvent(
        context,
        repository,
      );
      if (resolution.kind !== "resolved") {
        return eventFailure(context, resolution);
      }
      if (!(await verifyMutation(context, session))) {
        return standardError(
          context,
          403,
          "invalid_origin",
          "This request must originate from OpenSession.",
        );
      }
      return context.json(
        await service(context, repository, session).confirm(
          resolution.event,
          input.data,
        ),
      );
    } catch (error) {
      return campaignFailure(context, error);
    }
  });

  app.post(
    "/api/events/:eventKey/campaigns/provider-acceptance",
    async (context) => {
      const input = await parsedJson(context);
      const candidate =
        input && typeof input === "object" && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : null;
      if (
        !candidate ||
        (candidate.phase !== "initial" && candidate.phase !== "subsequent") ||
        typeof candidate.commandId !== "string" ||
        !providerAcceptanceCommandPattern.test(candidate.commandId) ||
        Object.keys(candidate).some(
          (key) => key !== "commandId" && key !== "phase",
        )
      ) {
        return standardError(
          context,
          400,
          "invalid_provider_acceptance",
          "The provider acceptance command is invalid.",
        );
      }
      const repository = new D1CampaignRepository(context.env.DB);
      try {
        const config = parseEmailDeliveryConfig(
          context.env.EMAIL_DELIVERY_CONFIG,
          context.env.APP_ENV,
        );
        assertProviderAcceptanceWindow({
          config,
          environment: context.env.APP_ENV,
          featureFlags: context.env.FEATURE_FLAGS,
        });
        const { resolution, session } = await authenticatedEvent(
          context,
          repository,
        );
        if (resolution.kind !== "resolved") {
          return eventFailure(context, resolution);
        }
        const access = await loadEventAccess(
          context.env.DB,
          session.user,
          resolution.event.organizationId,
          resolution.event.id,
        );
        if (!hasEventPermission(access, "organization:manage")) {
          return standardError(
            context,
            403,
            "forbidden",
            "Organization owner access is required for provider acceptance.",
          );
        }
        if (!(await verifyMutation(context, session))) {
          return standardError(
            context,
            403,
            "invalid_origin",
            "This request must originate from OpenSession.",
          );
        }
        return context.json(
          await runProviderAcceptance({
            commandId: candidate.commandId,
            config,
            database: context.env.DB,
            event: resolution.event,
            phase: candidate.phase as ProviderAcceptancePhase,
            queue: context.env.EMAIL_QUEUE,
          }),
        );
      } catch (error) {
        if (error instanceof ProviderAcceptanceUnavailableError) {
          return standardError(
            context,
            503,
            "provider_acceptance_unavailable",
            error.message,
          );
        }
        return campaignFailure(context, error);
      }
    },
  );

  app.get(
    "/api/events/:eventKey/campaigns/:campaignId/delivery",
    async (context) => {
      const campaignId = context.req.param("campaignId");
      if (!stableIdPattern.test(campaignId)) {
        return standardError(
          context,
          404,
          "campaign_not_found",
          "The campaign was not found in this event.",
        );
      }
      const repository = new D1CampaignRepository(context.env.DB);
      try {
        const { resolution } = await authenticatedEvent(context, repository);
        if (resolution.kind !== "resolved") {
          return eventFailure(context, resolution);
        }
        const log = await repository.readDeliveryLog(
          resolution.event,
          campaignId,
        );
        if (!log) throw new CampaignNotFoundError();
        return context.json(campaignDeliveryLogSchema.parse(log));
      } catch (error) {
        return campaignFailure(context, error);
      }
    },
  );

  app.post(
    "/api/events/:eventKey/campaigns/:campaignId/replay",
    async (context) => {
      if (
        !isFeatureEnabled(context.env.FEATURE_FLAGS, "email") ||
        !isFeatureEnabled(context.env.FEATURE_FLAGS, "writes")
      ) {
        return standardError(
          context,
          503,
          "campaign_writes_disabled",
          "Campaign replay is temporarily disabled.",
        );
      }
      const campaignId = context.req.param("campaignId");
      const input = campaignReplayRequestSchema.safeParse(
        await parsedJson(context),
      );
      if (!stableIdPattern.test(campaignId) || !input.success) {
        return standardError(
          context,
          400,
          "invalid_campaign_replay",
          input.success
            ? "The campaign identifier is invalid."
            : (input.error.issues[0]?.message ?? "The replay is invalid."),
        );
      }
      const repository = new D1CampaignRepository(context.env.DB);
      try {
        const { resolution, session } = await authenticatedEvent(
          context,
          repository,
        );
        if (resolution.kind !== "resolved") {
          return eventFailure(context, resolution);
        }
        if (!(await verifyMutation(context, session))) {
          return standardError(
            context,
            403,
            "invalid_origin",
            "This request must originate from OpenSession.",
          );
        }
        return context.json(
          await service(context, repository, session).replay({
            campaignId,
            event: resolution.event,
            ...(input.data.messageId
              ? { messageId: input.data.messageId }
              : {}),
          }),
        );
      } catch (error) {
        return campaignFailure(context, error);
      }
    },
  );
}
