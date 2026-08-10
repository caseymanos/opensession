import {
  protectedPublicCfpSubmissionRequestSchema,
  publicCfpConfigurationResponseSchema,
  publicCfpSubmissionResponseSchema,
} from "@sessionbox-killer/contracts";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import type { AppContext } from "../app-context";
import { getBaseAuthority } from "../authority/binding.js";
import {
  authFailure,
  authService,
  requireSameOrigin,
  sessionToken,
} from "../auth/http.js";
import { isFeatureEnabled } from "../features.js";
import { emitOperationalLog } from "../observability";
import { requireAbuseCapacity, verifyTurnstile } from "../security/http.js";
import { TurnstileVerificationError } from "../security/turnstile.js";
import {
  CfpSubmissionPlanIdempotencyConflictError,
  type CfpSubmissionPlanReceipt,
} from "./submission-authority.js";
import {
  cfpSubmissionCoordinates,
  CfpSubmissionError,
  D1CfpSubmissionCompiler,
} from "./submission-compiler.js";
import { D1PublicCfpPolicyReader, PublicCfpConfigurationError } from "./policy";

const publicSlugPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const cfpSubmissionBodyLimitBytes = 512 * 1_024;
const authorityConflictNames = new Set([
  "AirtableIdempotencyConflictError",
  "AirtableManualEditError",
  "AirtableVersionConflictError",
  "AuthorityIdempotencyConflictError",
]);
const authorityUnavailableNames = new Set([
  "airtable_rate_limited",
  "AirtableAmbiguousWriteError",
  "AirtableError",
  "AirtablePartialWriteError",
  "AirtableResponseError",
  "AirtableSchemaDriftError",
  "AuthorityOutcomeUnknownError",
]);

async function parsedJson(context: Context<AppContext>) {
  try {
    return await context.req.json();
  } catch {
    return null;
  }
}

function submissionFailure(context: Context<AppContext>, error: unknown) {
  if (error instanceof CfpSubmissionError) {
    return context.json(
      {
        error: { code: error.code, message: error.message },
        request_id: context.get("requestId"),
      },
      error.status,
    );
  }
  if (
    error instanceof CfpSubmissionPlanIdempotencyConflictError ||
    (error instanceof Error &&
      error.name === "CfpSubmissionPlanIdempotencyConflictError")
  ) {
    return context.json(
      {
        error: {
          code: "idempotency_conflict",
          message: "This save key was already used for a different version.",
        },
        request_id: context.get("requestId"),
      },
      409,
    );
  }
  if (error instanceof TurnstileVerificationError) {
    return context.json(
      {
        error: {
          code: "security_check_failed",
          message: "Complete the security check and try again.",
        },
        request_id: context.get("requestId"),
      },
      400,
    );
  }
  if (error instanceof Error && authorityConflictNames.has(error.name)) {
    return context.json(
      {
        error: {
          code: "save_conflict",
          message:
            "This proposal changed elsewhere. Refresh before saving again.",
        },
        request_id: context.get("requestId"),
      },
      409,
    );
  }
  if (
    error instanceof Error &&
    (authorityUnavailableNames.has(error.name) ||
      ("status" in error && error.status === 503))
  ) {
    return context.json(
      {
        error: {
          code: "service_unavailable",
          message:
            "The proposal could not be saved yet. Retry this same version.",
        },
        request_id: context.get("requestId"),
      },
      503,
    );
  }
  return authFailure(context, error);
}

function submissionResponse(
  receipt: CfpSubmissionPlanReceipt,
  friendlyId: string,
) {
  return publicCfpSubmissionResponseSchema.parse({
    friendly_id: friendlyId,
    outcome: receipt.outcome,
    source_version: receipt.sourceVersion,
    status: receipt.mode === "submit" ? "submitted" : "draft",
    submission_id: receipt.submissionId,
  });
}

export function registerPublicCfpRoutes(app: Hono<AppContext>): void {
  app.use(
    "/api/v1/public/events/:slug/submissions",
    bodyLimit({
      maxSize: cfpSubmissionBodyLimitBytes,
      onError: (context) =>
        context.json(
          {
            error: {
              code: "request_too_large",
              message: "The submission is too large.",
            },
            request_id: context.get("requestId"),
          },
          413,
        ),
    }),
  );

  app.get("/api/v1/public/events/:slug/cfp", async (context) => {
    const slug = context.req.param("slug");
    if (!publicSlugPattern.test(slug)) {
      return context.json(
        {
          error: {
            code: "not_found",
            message: "The public CFP does not exist.",
          },
          request_id: context.get("requestId"),
        },
        404,
      );
    }

    try {
      const policy = await new D1PublicCfpPolicyReader(
        context.env.DB,
      ).readBySlug(slug);
      if (!policy) {
        return context.json(
          {
            error: {
              code: "not_found",
              message: "The public CFP does not exist.",
            },
            request_id: context.get("requestId"),
          },
          404,
        );
      }
      return context.json(
        publicCfpConfigurationResponseSchema.parse(policy.publicConfiguration),
      );
    } catch (error) {
      if (!(error instanceof PublicCfpConfigurationError)) throw error;
      emitOperationalLog("error", context.env, {
        event: "cfp.public_configuration.invalid",
        outcome: "failure",
        request_id: context.get("requestId"),
      });
      return context.json(
        {
          error: {
            code: "service_unavailable",
            message: "The public CFP is temporarily unavailable.",
          },
          request_id: context.get("requestId"),
        },
        503,
      );
    }
  });

  app.post("/api/v1/public/events/:slug/submissions", async (context) => {
    if (!isFeatureEnabled(context.env.FEATURE_FLAGS, "writes")) {
      return context.json(
        {
          error: {
            code: "writes_disabled",
            message: "Changes are temporarily disabled in this environment.",
          },
          request_id: context.get("requestId"),
        },
        503,
      );
    }
    const slug = context.req.param("slug");
    if (!publicSlugPattern.test(slug)) {
      return context.json(
        {
          error: {
            code: "not_found",
            message: "The public CFP does not exist.",
          },
          request_id: context.get("requestId"),
        },
        404,
      );
    }
    if (!requireSameOrigin(context)) {
      return context.json(
        {
          error: {
            code: "invalid_origin",
            message: "This request must originate from OpenSession.",
          },
          request_id: context.get("requestId"),
        },
        403,
      );
    }
    const request = protectedPublicCfpSubmissionRequestSchema.safeParse(
      await parsedJson(context),
    );
    if (!request.success) {
      return context.json(
        {
          error: {
            code: "invalid_submission",
            message: "Review the proposal fields and try again.",
          },
          request_id: context.get("requestId"),
        },
        400,
      );
    }

    try {
      const authentication = authService(context);
      const session = await authentication.authenticate(sessionToken(context));
      await authentication.verifyCsrf(
        session,
        context.req.header("X-CSRF-Token") ?? null,
      );
      const policy = await new D1PublicCfpPolicyReader(
        context.env.DB,
      ).readBySlug(slug);
      if (!policy) {
        return context.json(
          {
            error: {
              code: "not_found",
              message: "The public CFP does not exist.",
            },
            request_id: context.get("requestId"),
          },
          404,
        );
      }

      const coordinates = await cfpSubmissionCoordinates(
        policy,
        session,
        context.req.header("Idempotency-Key") ?? "",
        request.data,
      );
      const authority = getBaseAuthority(context.env);
      const replay = await authority.resumeCfpSubmissionPlan(
        policy.organizationId,
        coordinates.planId,
        coordinates.requestHash,
      );
      if (replay) {
        return context.json(
          submissionResponse(replay, coordinates.friendlyId),
          200,
        );
      }

      const operation = request.data.mode === "submit" ? "submit" : "autosave";
      const limited = await requireAbuseCapacity(context, operation, {
        identity: session.user.id,
        ip: context.req.header("CF-Connecting-IP") ?? null,
      });
      if (limited) return limited;
      const eventLimited = await requireAbuseCapacity(context, operation, {
        event: policy.eventId,
      });
      if (eventLimited) return eventLimited;
      if (request.data.mode === "submit") {
        await verifyTurnstile(
          context,
          request.data.turnstile_token,
          request.data.turnstile_action,
        );
      }

      const plan = await new D1CfpSubmissionCompiler(context.env.DB).compile(
        policy,
        session,
        request.data,
        coordinates,
      );
      const receipt = await authority.executeCfpSubmissionPlan(plan);
      emitOperationalLog("info", context.env, {
        event: `cfp.submission.${request.data.mode}`,
        event_id: policy.eventId,
        organization_id: policy.organizationId,
        outcome: receipt.outcome === "replayed" ? "accepted" : "success",
        request_id: context.get("requestId"),
      });
      return context.json(
        submissionResponse(receipt, coordinates.friendlyId),
        receipt.outcome === "applied" ? 201 : 200,
      );
    } catch (error) {
      if (error instanceof PublicCfpConfigurationError) {
        emitOperationalLog("error", context.env, {
          event: "cfp.submission_configuration.invalid",
          outcome: "failure",
          request_id: context.get("requestId"),
        });
        return context.json(
          {
            error: {
              code: "service_unavailable",
              message: "The public CFP is temporarily unavailable.",
            },
            request_id: context.get("requestId"),
          },
          503,
        );
      }
      return submissionFailure(context, error);
    }
  });
}
