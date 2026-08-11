import {
  demoBootstrapRequestSchema,
  demoBootstrapResponseSchema,
  demoResetRequestSchema,
  demoResetResponseSchema,
  type DemoBootstrapResponse,
} from "@sessionbox-killer/contracts";
import { demoEventId, demoOrganizationId } from "@sessionbox-killer/domain";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import type { AppContext } from "../app-context.js";
import { hasEventPermission, loadEventAccess } from "../auth/authorization.js";
import { fingerprint, sha256Hex } from "../auth/crypto.js";
import {
  authFailure,
  authService,
  requireSameOrigin,
  sessionToken,
} from "../auth/http.js";
import { getBaseAuthority } from "../authority/binding.js";
import { isFeatureEnabled } from "../features.js";
import { emitOperationalLog } from "../observability.js";
import { requireAbuseCapacity } from "../security/http.js";
import { DemoBootstrapError, DemoBootstrapService } from "./bootstrap.js";
import { compileDemoSeed } from "./compiler.js";
import { demoSeedSource } from "./fixture.js";
import {
  D1DemoEventGuardReader,
  DemoResetError,
  DemoResetService,
} from "./reset.js";
import type { DemoSeedAuthorityReceipt } from "./types.js";

interface BootstrapAuthorizationRow {
  base_key: string;
  completed_at: string | null;
  environment: string;
  event_id: string;
  event_source_record_id: string;
  expires_at: string;
  operation_id: string;
  organization_id: string;
  organization_source_record_id: string;
  owner_email_hash: string | null;
  result_json: string | null;
  seed_digest: string;
  seed_version: number;
  snapshot_id: string;
  status: "complete" | "failed" | "leased" | "pending";
}

const bodyLimitBytes = 4 * 1024;
const bootstrapTokenPattern = /^[A-Za-z0-9_-]{40,160}$/;
const idempotencyKeyPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const planPromise = compileDemoSeed(demoSeedSource);

function parsedJson(context: Context<AppContext>): Promise<unknown> {
  return context.req.json().catch(() => null);
}

function errorResponse(
  context: Context<AppContext>,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 503,
  code: string,
  message: string,
) {
  return context.json(
    { error: { code, message }, request_id: context.get("requestId") },
    status,
  );
}

function receiptResponse(receipt: DemoSeedAuthorityReceipt) {
  return {
    audit_event_id: receipt.auditEventId,
    digest: receipt.digest,
    operation_count: receipt.operationCount,
    outcome: receipt.outcome,
    reset_run_id: receipt.resetRunId,
    snapshot_id: receipt.snapshotId,
  } as const;
}

function bearerToken(context: Context<AppContext>): string | null {
  const authorization = context.req.header("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length);
  return bootstrapTokenPattern.test(token) ? token : null;
}

async function authorizationRow(
  context: Context<AppContext>,
  tokenHash: string,
): Promise<BootstrapAuthorizationRow | null> {
  return context.env.DB.prepare(
    `SELECT operation_id, environment, base_key, organization_id, event_id,
            organization_source_record_id, event_source_record_id,
            seed_version, snapshot_id, seed_digest, owner_email_hash,
            status, result_json, expires_at, completed_at
     FROM demo_bootstrap_authorizations WHERE token_hash = ?1 LIMIT 1`,
  )
    .bind(tokenHash)
    .first<BootstrapAuthorizationRow>();
}

async function claimAuthorization(
  context: Context<AppContext>,
  tokenHash: string,
  ownerEmailHash: string,
): Promise<BootstrapAuthorizationRow | null> {
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + 5 * 60 * 1_000).toISOString();
  return context.env.DB.prepare(
    `UPDATE demo_bootstrap_authorizations
     SET status = 'leased', owner_email_hash = COALESCE(owner_email_hash, ?2),
         attempt_count = attempt_count + 1, lease_expires_at = ?3,
         last_error_code = NULL, updated_at = ?4
     WHERE token_hash = ?1 AND expires_at > ?4
       AND (owner_email_hash IS NULL OR owner_email_hash = ?2)
       AND (status = 'pending' OR (status = 'leased' AND lease_expires_at <= ?4))
     RETURNING operation_id, environment, base_key, organization_id, event_id,
               organization_source_record_id, event_source_record_id,
               seed_version, snapshot_id, seed_digest, owner_email_hash,
               status, result_json, expires_at, completed_at`,
  )
    .bind(tokenHash, ownerEmailHash, leaseExpiresAt, now.toISOString())
    .first<BootstrapAuthorizationRow>();
}

async function releaseAuthorization(
  context: Context<AppContext>,
  tokenHash: string,
  error: unknown,
): Promise<void> {
  const permanent =
    error instanceof DemoBootstrapError &&
    error.code !== "authority_unavailable";
  await context.env.DB.prepare(
    `UPDATE demo_bootstrap_authorizations
     SET status = ?2, lease_expires_at = NULL, last_error_code = ?3,
         updated_at = ?4
     WHERE token_hash = ?1 AND status = 'leased'`,
  )
    .bind(
      tokenHash,
      permanent ? "failed" : "pending",
      error instanceof DemoBootstrapError ? error.code : "unexpected_failure",
      new Date().toISOString(),
    )
    .run();
}

function authorizationMatches(
  row: BootstrapAuthorizationRow,
  context: Context<AppContext>,
  plan: Awaited<typeof planPromise>,
): boolean {
  return (
    row.environment === context.env.APP_ENV &&
    row.base_key === `${context.env.APP_ENV}:${context.env.AIRTABLE_BASE_ID}` &&
    row.organization_id === plan.organizationId &&
    row.event_id === plan.eventId &&
    row.seed_version === plan.seedVersion &&
    row.snapshot_id === plan.snapshotId &&
    row.seed_digest === plan.digest
  );
}

function bootstrapFailure(context: Context<AppContext>, error: unknown) {
  if (error instanceof DemoBootstrapError) {
    if (error.code === "authority_unavailable") {
      return errorResponse(
        context,
        503,
        error.code,
        "The demo authority is temporarily unavailable.",
      );
    }
    return errorResponse(
      context,
      409,
      error.code,
      "The demo bootstrap conflicts with authoritative state.",
    );
  }
  return errorResponse(
    context,
    503,
    "bootstrap_unavailable",
    "The demo bootstrap is temporarily unavailable.",
  );
}

function resetFailure(context: Context<AppContext>, error: unknown) {
  if (error instanceof DemoResetError) {
    const status =
      error.code === "invalid_confirmation" ||
      error.code === "invalid_audit_context"
        ? 400
        : error.code === "not_privileged"
          ? 403
          : error.code === "invalid_target" || error.code === "not_demo"
            ? 404
            : error.code === "receipt_mismatch"
              ? 409
              : error.code === "idempotency_conflict"
                ? 409
                : 503;
    return errorResponse(
      context,
      status,
      error.code,
      status === 503
        ? "The demo reset is temporarily unavailable."
        : error.message,
    );
  }
  try {
    return authFailure(context, error);
  } catch {
    return errorResponse(
      context,
      503,
      "reset_unavailable",
      "The demo reset is temporarily unavailable.",
    );
  }
}

export function registerDemoRoutes(app: Hono<AppContext>): void {
  app.use(
    "/api/internal/demo/bootstrap",
    bodyLimit({
      maxSize: bodyLimitBytes,
      onError: (context) =>
        errorResponse(
          context,
          413,
          "request_too_large",
          "The request body is too large.",
        ),
    }),
  );
  app.use(
    "/api/events/:eventKey/demo/reset",
    bodyLimit({
      maxSize: bodyLimitBytes,
      onError: (context) =>
        errorResponse(
          context,
          413,
          "request_too_large",
          "The request body is too large.",
        ),
    }),
  );

  app.post("/api/internal/demo/bootstrap", async (context) => {
    if (!isFeatureEnabled(context.env.FEATURE_FLAGS, "writes")) {
      return errorResponse(
        context,
        503,
        "writes_disabled",
        "Changes are temporarily disabled in this environment.",
      );
    }
    const token = bearerToken(context);
    const input = demoBootstrapRequestSchema.safeParse(
      await parsedJson(context),
    );
    if (!token || !input.success) {
      return errorResponse(
        context,
        403,
        "invalid_bootstrap_authorization",
        "The demo bootstrap authorization is invalid.",
      );
    }
    const normalizedEmail = input.data.owner_email.toLowerCase();
    const [tokenHash, ownerEmailHash, plan] = await Promise.all([
      sha256Hex(token),
      fingerprint(
        normalizedEmail,
        context.env.AUTH_HASH_PEPPER,
        "demo-bootstrap-owner",
      ),
      planPromise,
    ]);
    let row = await authorizationRow(context, tokenHash);
    if (
      !row ||
      !authorizationMatches(row, context, plan) ||
      (row.owner_email_hash !== null && row.owner_email_hash !== ownerEmailHash)
    ) {
      return errorResponse(
        context,
        403,
        "invalid_bootstrap_authorization",
        "The demo bootstrap authorization is invalid.",
      );
    }
    if (row.status === "complete" && row.result_json) {
      const stored = demoBootstrapResponseSchema.parse(
        JSON.parse(row.result_json),
      );
      return context.json({
        ...stored,
        receipt: { ...stored.receipt, outcome: "replayed" as const },
      });
    }
    row = await claimAuthorization(context, tokenHash, ownerEmailHash);
    if (!row || !authorizationMatches(row, context, plan)) {
      return errorResponse(
        context,
        409,
        "bootstrap_not_claimable",
        "The demo bootstrap is already running, expired, or failed.",
      );
    }

    try {
      const result = await new DemoBootstrapService({
        authority: getBaseAuthority(context.env),
        baseKey: row.base_key,
        bucket: context.env.UPLOADS,
        database: context.env.DB,
        plan,
      }).bootstrap({
        eventSourceRecordId: row.event_source_record_id,
        operationId: row.operation_id,
        organizationSourceRecordId: row.organization_source_record_id,
        ownerEmail: normalizedEmail,
      });
      const response = demoBootstrapResponseSchema.parse({
        asset_count: result.assetCount,
        authority_ready: result.authorityReady,
        receipt: receiptResponse(result.receipt),
        root_lineage_verified: result.rootLineageVerified,
      } satisfies DemoBootstrapResponse);
      const completedAt = new Date().toISOString();
      const completed = await context.env.DB.prepare(
        `UPDATE demo_bootstrap_authorizations
         SET status = 'complete', lease_expires_at = NULL, result_json = ?2,
             completed_at = ?3, updated_at = ?3
         WHERE token_hash = ?1 AND operation_id = ?4 AND status = 'leased'
         RETURNING operation_id`,
      )
        .bind(
          tokenHash,
          JSON.stringify(response),
          completedAt,
          row.operation_id,
        )
        .first<{ operation_id: string }>();
      if (completed?.operation_id !== row.operation_id) {
        throw new Error("Demo bootstrap authorization completion was lost.");
      }
      emitOperationalLog("info", context.env, {
        event: "demo.bootstrap.completed",
        event_id: plan.eventId,
        job_id: row.operation_id,
        organization_id: plan.organizationId,
        outcome: "success",
        request_id: context.get("requestId"),
      });
      return context.json(response);
    } catch (error) {
      await releaseAuthorization(context, tokenHash, error);
      emitOperationalLog("error", context.env, {
        error_type:
          error instanceof DemoBootstrapError
            ? error.code
            : "unexpected_failure",
        event: "demo.bootstrap.failed",
        event_id: plan.eventId,
        job_id: row.operation_id,
        organization_id: plan.organizationId,
        outcome: "failure",
        request_id: context.get("requestId"),
      });
      return bootstrapFailure(context, error);
    }
  });

  app.post("/api/events/:eventKey/demo/reset", async (context) => {
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
    const input = demoResetRequestSchema.safeParse(await parsedJson(context));
    const idempotencyKey = context.req.header("Idempotency-Key") ?? "";
    if (!input.success || !idempotencyKeyPattern.test(idempotencyKey)) {
      return errorResponse(
        context,
        400,
        "invalid_request",
        "A valid reset confirmation and idempotency key are required.",
      );
    }

    try {
      const authentication = authService(context);
      const session = await authentication.authenticate(sessionToken(context));
      await authentication.verifyCsrf(
        session,
        context.req.header("X-CSRF-Token") ?? null,
      );
      const eventKey = context.req.param("eventKey");
      const event = await context.env.DB.prepare(
        `SELECT id, organization_id FROM p_events
         WHERE organization_id = ?1 AND id = ?2
           AND (id = ?3 OR slug = ?3) AND is_demo = 1
           AND source_deleted_at IS NULL
         LIMIT 1`,
      )
        .bind(demoOrganizationId, demoEventId, eventKey)
        .first<{ id: string; organization_id: string }>();
      if (!event) {
        return errorResponse(
          context,
          404,
          "not_demo",
          "The requested demo event does not exist.",
        );
      }
      const access = await loadEventAccess(
        context.env.DB,
        session.user,
        event.organization_id,
        event.id,
      );
      if (!hasEventPermission(access, "organization:manage")) {
        return errorResponse(
          context,
          403,
          "not_privileged",
          "Demo reset requires an organization owner.",
        );
      }
      const limited = await requireAbuseCapacity(context, "demo_reset", {
        event: event.id,
        identity: session.user.id,
        ip: context.req.header("CF-Connecting-IP") ?? null,
      });
      if (limited) return limited;
      const plan = await planPromise;
      if (input.data.confirmation !== plan.resetPhrase) {
        return errorResponse(
          context,
          400,
          "invalid_confirmation",
          "Demo reset confirmation did not match.",
        );
      }
      const receipt = await new DemoResetService({
        authority: getBaseAuthority(context.env),
        eventReader: new D1DemoEventGuardReader(
          context.env.DB,
          `${context.env.APP_ENV}:${context.env.AIRTABLE_BASE_ID}`,
        ),
        plan,
      }).reset({
        actor: {
          id: session.user.id,
          organizationId: event.organization_id,
          permissions: access.permissions,
        },
        confirmation: input.data.confirmation,
        eventId: event.id,
        organizationId: event.organization_id,
        requestId: idempotencyKey,
      });
      emitOperationalLog("info", context.env, {
        event: "demo.reset.completed",
        event_id: event.id,
        job_id: idempotencyKey,
        organization_id: event.organization_id,
        outcome: "success",
        request_id: context.get("requestId"),
      });
      return context.json(
        demoResetResponseSchema.parse({ receipt: receiptResponse(receipt) }),
      );
    } catch (error) {
      emitOperationalLog("error", context.env, {
        error_type:
          error instanceof DemoResetError ? error.code : "unexpected_failure",
        event: "demo.reset.failed",
        event_id: demoEventId,
        outcome: "failure",
        request_id: context.get("requestId"),
      });
      return resetFailure(context, error);
    }
  });
}
