import {
  uploadFinalizeResponseSchema,
  uploadIntentRequestSchema,
  uploadIntentResponseSchema,
} from "@sessionbox-killer/contracts";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import type { AppContext } from "../app-context";
import {
  authFailure,
  authService,
  requireSameOrigin,
  sessionToken,
} from "../auth/http";
import { emitOperationalLog } from "../observability";
import { isFeatureEnabled } from "../features";
import { requireAbuseCapacity } from "../security/http";
import { safeAttachmentDisposition } from "./policy";
import { UploadError, UploadService } from "./service";

const uploadJsonBodyLimitBytes = 8 * 1024;
const fileIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function service(context: Context<AppContext>): UploadService {
  return new UploadService({
    bucket: context.env.UPLOADS,
    database: context.env.DB,
  });
}

async function parsedJson(context: Context<AppContext>) {
  try {
    return await context.req.json();
  } catch {
    return null;
  }
}

function uploadFailure(context: Context<AppContext>, error: unknown) {
  if (!(error instanceof UploadError)) {
    return authFailure(context, error);
  }

  const status =
    error.code === "forbidden"
      ? 403
      : error.code === "file_not_found"
        ? 404
        : error.code === "upload_expired"
          ? 410
          : error.code === "mime_mismatch" ||
              error.code === "upload_rejected" ||
              error.code === "invalid_file"
            ? 422
            : error.code === "quota_exceeded" ||
                error.code === "replacement_conflict" ||
                error.code === "upload_in_progress" ||
                error.code === "file_not_uploaded"
              ? 409
              : 400;
  return context.json(
    {
      error: { code: error.code, message: error.message },
      request_id: context.get("requestId"),
    },
    status,
  );
}

function validFileId(context: Context<AppContext>): string | null {
  const fileId = context.req.param("fileId") ?? "";
  return fileIdPattern.test(fileId) ? fileId : null;
}

function requireCapabilityOrigin(context: Context<AppContext>): boolean {
  const origin = context.req.header("Origin");
  const fetchSite = context.req.header("Sec-Fetch-Site");
  return (
    (!origin || origin === new URL(context.req.url).origin) &&
    (!fetchSite || fetchSite === "same-origin")
  );
}

function requireWritesEnabled(context: Context<AppContext>): Response | null {
  if (isFeatureEnabled(context.env.FEATURE_FLAGS, "writes")) {
    return null;
  }
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

export function registerUploadRoutes(app: Hono<AppContext>): void {
  app.use(
    "/api/uploads/intents",
    bodyLimit({
      maxSize: uploadJsonBodyLimitBytes,
      onError: (context) =>
        context.json(
          {
            error: {
              code: "request_too_large",
              message: "The request body is too large.",
            },
            request_id: context.get("requestId"),
          },
          413,
        ),
    }),
  );

  app.post("/api/uploads/intents", async (context) => {
    const writesDisabled = requireWritesEnabled(context);
    if (writesDisabled) {
      return writesDisabled;
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

    const input = uploadIntentRequestSchema.safeParse(
      await parsedJson(context),
    );
    if (!input.success) {
      return context.json(
        {
          error: {
            code: "invalid_upload",
            message: "Check the filename, type, size, and checksum.",
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
      const limited = await requireAbuseCapacity(context, "upload_intent", {
        identity: session.user.id,
        ip: context.req.header("CF-Connecting-IP") ?? null,
      });
      if (limited) return limited;
      const eventLimited = await requireAbuseCapacity(
        context,
        "upload_intent",
        { event: input.data.event_id },
      );
      if (eventLimited) return eventLimited;
      const created = await service(context).createIntent(session, input.data);
      const response = uploadIntentResponseSchema.parse({
        file: {
          id: created.fileId,
          lineage_id: created.lineageId,
          status: "pending",
          version: created.version,
        },
        upload: {
          expires_at: created.expiresAt,
          headers: {
            "Content-Type": input.data.content_type,
            "X-Content-SHA256": input.data.checksum_sha256,
            "X-Upload-Token": created.token,
          },
          method: "PUT",
          url: `/api/uploads/${created.fileId}/content`,
        },
      });
      emitOperationalLog("info", context.env, {
        event: "upload.intent_created",
        event_id: input.data.event_id,
        outcome: "accepted",
        request_id: context.get("requestId"),
      });
      return context.json(response, 201);
    } catch (error) {
      return uploadFailure(context, error);
    }
  });

  app.put("/api/uploads/:fileId/content", async (context) => {
    const writesDisabled = requireWritesEnabled(context);
    if (writesDisabled) {
      return writesDisabled;
    }
    const fileId = validFileId(context);
    if (!fileId || !requireCapabilityOrigin(context)) {
      return context.json(
        {
          error: {
            code: "invalid_upload",
            message: "The upload capability is invalid.",
          },
          request_id: context.get("requestId"),
        },
        400,
      );
    }

    try {
      const stored = await service(context).store(
        fileId,
        context.req.header("X-Upload-Token") ?? null,
        context.req.raw.headers,
        context.req.raw.body,
      );
      emitOperationalLog("info", context.env, {
        event: "upload.stored",
        outcome: "success",
        request_id: context.get("requestId"),
      });
      return context.json(
        { etag: stored.etag, file_id: stored.fileId, stored: true },
        201,
      );
    } catch (error) {
      emitOperationalLog("warn", context.env, {
        error_type: error instanceof UploadError ? error.code : "UploadError",
        event: "upload.rejected",
        outcome: "client_error",
        request_id: context.get("requestId"),
      });
      return uploadFailure(context, error);
    }
  });

  app.post("/api/uploads/:fileId/finalize", async (context) => {
    const writesDisabled = requireWritesEnabled(context);
    if (writesDisabled) {
      return writesDisabled;
    }
    const fileId = validFileId(context);
    if (!fileId || !requireSameOrigin(context)) {
      return context.json(
        {
          error: {
            code: "invalid_upload",
            message: "The upload request is invalid.",
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
      const finalized = await service(context).finalize(session, fileId);
      emitOperationalLog("info", context.env, {
        event: "upload.finalized",
        outcome: "success",
        request_id: context.get("requestId"),
      });
      return context.json(
        uploadFinalizeResponseSchema.parse({
          byte_size: finalized.byteSize,
          checksum_sha256: finalized.checksumSha256,
          content_type: finalized.contentType,
          detected_content_type: finalized.detectedContentType,
          id: finalized.id,
          status: "ready",
          version: finalized.version,
        }),
      );
    } catch (error) {
      if (error instanceof UploadError && error.code === "mime_mismatch") {
        emitOperationalLog("warn", context.env, {
          error_type: error.code,
          event: "upload.quarantined",
          outcome: "client_error",
          request_id: context.get("requestId"),
        });
      }
      return uploadFailure(context, error);
    }
  });

  app.get("/api/uploads/:fileId", async (context) => {
    const fileId = validFileId(context);
    if (!fileId) {
      return context.json(
        {
          error: {
            code: "file_not_found",
            message: "The file does not exist.",
          },
          request_id: context.get("requestId"),
        },
        404,
      );
    }

    try {
      const authentication = authService(context);
      const session = await authentication.authenticate(sessionToken(context));
      const download = await service(context).download(session, fileId);
      const headers = new Headers({
        "Cache-Control": "private, no-store",
        "Content-Disposition": safeAttachmentDisposition(download.filename),
        "Content-Length": String(download.size),
        "Content-Security-Policy": "sandbox",
        "Content-Type": download.contentType,
        "Cross-Origin-Resource-Policy": "same-origin",
        ETag: download.etag,
        "X-Content-Type-Options": "nosniff",
      });
      return new Response(download.body, { headers });
    } catch (error) {
      return uploadFailure(context, error);
    }
  });
}
