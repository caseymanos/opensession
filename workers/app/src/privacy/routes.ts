import {
  coordinatedDeletionResponseSchema,
  privacyExportRequestSchema,
  privacyPolicyResponseSchema,
} from "@sessionbox-killer/contracts";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import type { AppContext } from "../app-context";
import { requestDatabase } from "../database.js";
import {
  authFailure,
  authService,
  requireSameOrigin,
  sessionToken,
} from "../auth/http";
import {
  PrivacyExportService,
  PrivacyExportTooLargeError,
  PrivacyProjectionUnavailableError,
  privacyPolicy,
} from "./service";

const organizationIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const privacyRequestBodyLimitBytes = 2 * 1024;

interface MembershipRow {
  role: "organizer" | "owner" | "viewer";
}

function problem(
  context: Context<AppContext>,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 503,
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

async function requireOwner(
  context: Context<AppContext>,
  organizationId: string,
  userId: string,
): Promise<Response | null> {
  const membership = await requestDatabase(context)
    .prepare(
      `SELECT membership.role
     FROM organization_memberships membership
     JOIN tenant_registry tenant
       ON tenant.organization_id = membership.organization_id
      AND tenant.status = 'active'
     WHERE membership.organization_id = ?1
       AND membership.user_id = ?2
       AND membership.revoked_at IS NULL
     LIMIT 1`,
    )
    .bind(organizationId, userId)
    .first<MembershipRow>();
  if (!membership) {
    return problem(
      context,
      404,
      "privacy_scope_unavailable",
      "The requested privacy scope is unavailable.",
    );
  }
  if (membership.role !== "owner") {
    return problem(
      context,
      403,
      "organization_owner_required",
      "An active organization owner must perform this privacy operation.",
    );
  }
  return null;
}

async function parseProtectedRequest(context: Context<AppContext>) {
  if (!requireSameOrigin(context)) {
    return {
      response: problem(
        context,
        403,
        "invalid_origin",
        "This request must originate from OpenSession and use JSON.",
      ),
    } as const;
  }
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    body = null;
  }
  const input = privacyExportRequestSchema.safeParse(body);
  if (!input.success) {
    return {
      response: problem(
        context,
        400,
        "privacy_request_invalid",
        "Enter one valid email address.",
      ),
    } as const;
  }
  const organizationId = context.req.param("organizationId") ?? "";
  if (!organizationIdPattern.test(organizationId)) {
    return {
      response: problem(
        context,
        404,
        "privacy_scope_unavailable",
        "The requested privacy scope is unavailable.",
      ),
    } as const;
  }
  try {
    const authentication = authService(context);
    const session = await authentication.authenticate(sessionToken(context));
    await authentication.verifyCsrf(
      session,
      context.req.header("X-CSRF-Token") ?? null,
    );
    const denied = await requireOwner(context, organizationId, session.user.id);
    if (denied) return { response: denied } as const;
    return { email: input.data.email, organizationId } as const;
  } catch (error) {
    return { response: authFailure(context, error) } as const;
  }
}

export function registerPrivacyRoutes(app: Hono<AppContext>): void {
  app.get("/api/v1/privacy/policy", (context) =>
    context.json(privacyPolicyResponseSchema.parse(privacyPolicy)),
  );

  app.use(
    "/api/organizations/:organizationId/privacy/*",
    bodyLimit({
      maxSize: privacyRequestBodyLimitBytes,
      onError: (context) =>
        problem(
          context,
          413,
          "privacy_request_too_large",
          "The privacy request body is too large.",
        ),
    }),
  );

  app.post(
    "/api/organizations/:organizationId/privacy/exports",
    async (context) => {
      const request = await parseProtectedRequest(context);
      if ("response" in request) return request.response;
      try {
        const result = await new PrivacyExportService({
          database: context.env.DB,
        }).exportByEmail(request.organizationId, request.email);
        context.header(
          "Content-Disposition",
          `attachment; filename="opensession-privacy-${request.organizationId}.json"`,
        );
        context.header("Content-Type", "application/json; charset=UTF-8");
        return context.body(result.body, 200);
      } catch (error) {
        if (error instanceof PrivacyExportTooLargeError) {
          return problem(
            context,
            413,
            "privacy_export_too_large",
            "This export is too large for the online response. Use the coordinated operator runbook.",
          );
        }
        if (error instanceof PrivacyProjectionUnavailableError) {
          return problem(
            context,
            503,
            "privacy_projection_unavailable",
            "The privacy export is temporarily unavailable.",
          );
        }
        throw error;
      }
    },
  );

  app.post(
    "/api/organizations/:organizationId/privacy/deletions",
    async (context) => {
      const request = await parseProtectedRequest(context);
      if ("response" in request) return request.response;
      return context.json(
        coordinatedDeletionResponseSchema.parse({
          accepted: false,
          code: "coordinated_deletion_required",
          message:
            "No partial deletion was performed. Follow the identity-verified operator runbook to remove authoritative, object-storage, provider, and projection copies together.",
          policy_url: "/api/v1/privacy/policy",
        }),
        409,
      );
    },
  );
}
