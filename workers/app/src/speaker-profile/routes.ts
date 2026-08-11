import {
  speakerProfilePublicationCommandSchema,
  speakerProfileSaveCommandSchema,
  apiErrorResponseSchema,
} from "@sessionbox-killer/contracts";
import { speakerPortalSlugSchema } from "@sessionbox-killer/contracts/portal";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import type { AppContext } from "../app-context.js";
import {
  authFailure,
  authService,
  requireSameOrigin,
  sessionToken,
} from "../auth/http.js";
import { isFeatureEnabled } from "../features.js";
import { SpeakerProfileError, SpeakerProfileService } from "./service.js";

const profileBodyLimitBytes = 32 * 1024;
const profileIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;

function service(context: Context<AppContext>): SpeakerProfileService {
  return new SpeakerProfileService({
    bucket: context.env.UPLOADS,
    database: context.env.DB,
    environment: context.env,
  });
}

async function jsonBody(context: Context<AppContext>): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    return null;
  }
}

function profileFailure(
  context: Context<AppContext>,
  error: unknown,
): Response {
  if (!(error instanceof SpeakerProfileError)) {
    if (error instanceof Error && error.name === "ZodError") {
      return context.json(
        apiErrorResponseSchema.parse({
          error: {
            code: "profile_projection_unavailable",
            message:
              "The speaker profile projection is temporarily unavailable.",
          },
          request_id: context.get("requestId"),
        }),
        503,
      );
    }
    return authFailure(context, error);
  }
  const status =
    error.code === "profile_forbidden"
      ? 403
      : error.code === "profile_not_found"
        ? 404
        : error.code === "profile_version_conflict"
          ? 412
          : error.code === "profile_idempotency_conflict"
            ? 409
            : error.code === "profile_outcome_unknown"
              ? 202
              : error.code === "profile_projection_invalid"
                ? 503
                : 422;
  return context.json(
    apiErrorResponseSchema.parse({
      error: {
        code: error.code,
        message: error.message,
        ...(error.actualVersion === null
          ? {}
          : { actual_version: error.actualVersion }),
        ...(error.expectedVersion === null
          ? {}
          : { expected_version: error.expectedVersion }),
        ...(error.code === "profile_outcome_unknown"
          ? { retryable: true }
          : {}),
      },
      request_id: context.get("requestId"),
    }),
    status,
  );
}

function requireWrites(context: Context<AppContext>): Response | null {
  return isFeatureEnabled(context.env.FEATURE_FLAGS, "writes")
    ? null
    : context.json(
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

export function registerSpeakerProfileRoutes(app: Hono<AppContext>): void {
  app.use(
    "/api/portal/*/profile/commands",
    bodyLimit({
      maxSize: profileBodyLimitBytes,
      onError: (context) =>
        context.json(
          {
            error: {
              code: "request_too_large",
              message: "The profile request is too large.",
            },
            request_id: context.get("requestId"),
          },
          413,
        ),
    }),
  );
  app.use(
    "/api/events/*/speaker-profiles/*/publication",
    bodyLimit({
      maxSize: profileBodyLimitBytes,
      onError: (context) =>
        context.json(
          {
            error: {
              code: "request_too_large",
              message: "The profile request is too large.",
            },
            request_id: context.get("requestId"),
          },
          413,
        ),
    }),
  );

  app.get("/api/portal/:eventSlug/profile", async (context) => {
    const slug = speakerPortalSlugSchema.safeParse(
      context.req.param("eventSlug"),
    );
    if (!slug.success)
      return context.json(
        {
          error: {
            code: "profile_not_found",
            message: "The speaker profile does not exist.",
          },
          request_id: context.get("requestId"),
        },
        404,
      );
    try {
      const session = await authService(context).authenticate(
        sessionToken(context),
      );
      const event = await service(context).resolveEvent(slug.data);
      if (!event)
        return context.json(
          {
            error: {
              code: "profile_not_found",
              message: "The speaker profile does not exist.",
            },
            request_id: context.get("requestId"),
          },
          404,
        );
      context.header("Cache-Control", "private, no-store");
      return context.json(await service(context).readForPortal(session, event));
    } catch (error) {
      return profileFailure(context, error);
    }
  });

  app.get("/api/portal/:eventSlug/profile/headshot", async (context) => {
    const slug = speakerPortalSlugSchema.safeParse(
      context.req.param("eventSlug"),
    );
    if (!slug.success) return context.notFound();
    try {
      const session = await authService(context).authenticate(
        sessionToken(context),
      );
      const event = await service(context).resolveEvent(slug.data);
      if (!event) return context.notFound();
      const headshot = await service(context).portalHeadshot(session, event);
      if (!headshot) return context.notFound();
      const headers = new Headers({
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "sandbox",
        "Content-Type": headshot.contentType,
        "Cross-Origin-Resource-Policy": "same-origin",
        "X-Content-Type-Options": "nosniff",
      });
      if (headshot.etag) headers.set("ETag", headshot.etag);
      return new Response(headshot.body, { headers });
    } catch (error) {
      return profileFailure(context, error);
    }
  });

  app.put("/api/portal/:eventSlug/profile/commands", async (context) => {
    const writesDisabled = requireWrites(context);
    if (writesDisabled) return writesDisabled;
    if (!requireSameOrigin(context))
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
    const input = speakerProfileSaveCommandSchema.safeParse(
      await jsonBody(context),
    );
    if (!input.success)
      return context.json(
        {
          error: {
            code: "invalid_profile",
            message: "The speaker profile command is invalid.",
          },
          request_id: context.get("requestId"),
        },
        422,
      );
    try {
      const authentication = authService(context);
      const session = await authentication.authenticate(sessionToken(context));
      await authentication.verifyCsrf(
        session,
        context.req.header("X-CSRF-Token") ?? null,
      );
      const slug = speakerPortalSlugSchema.parse(
        context.req.param("eventSlug"),
      );
      const event = await service(context).resolveEvent(slug);
      if (!event)
        return context.json(
          {
            error: {
              code: "profile_not_found",
              message: "The speaker profile does not exist.",
            },
            request_id: context.get("requestId"),
          },
          404,
        );
      const command = {
        ...input.data,
        ...(input.data.headshot_file_id === undefined
          ? {}
          : { headshot_file_id: input.data.headshot_file_id }),
      };
      return context.json(
        await service(context).saveForPortal(
          session,
          event,
          command,
          context.get("requestId"),
        ),
      );
    } catch (error) {
      return profileFailure(context, error);
    }
  });

  app.get(
    "/api/events/:eventKey/speaker-profiles/:profileId",
    async (context) => {
      if (!profileIdPattern.test(context.req.param("profileId")))
        return context.notFound();
      try {
        const session = await authService(context).authenticate(
          sessionToken(context),
        );
        const event = await service(context).resolveEventKey(
          context.req.param("eventKey"),
        );
        if (!event)
          return context.json(
            {
              error: {
                code: "profile_not_found",
                message: "The speaker profile does not exist.",
              },
              request_id: context.get("requestId"),
            },
            404,
          );
        context.header("Cache-Control", "private, no-store");
        return context.json(
          await service(context).readForOrganizer(
            session,
            event,
            context.req.param("profileId"),
          ),
        );
      } catch (error) {
        return profileFailure(context, error);
      }
    },
  );

  app.put(
    "/api/events/:eventKey/speaker-profiles/:profileId/publication",
    async (context) => {
      const writesDisabled = requireWrites(context);
      if (writesDisabled) return writesDisabled;
      if (!requireSameOrigin(context))
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
      const input = speakerProfilePublicationCommandSchema.safeParse(
        await jsonBody(context),
      );
      if (!input.success)
        return context.json(
          {
            error: {
              code: "invalid_profile",
              message: "The publication command is invalid.",
            },
            request_id: context.get("requestId"),
          },
          422,
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
        const event = await service(context).resolveEventKey(
          context.req.param("eventKey"),
        );
        if (!event)
          return context.json(
            {
              error: {
                code: "profile_not_found",
                message: "The speaker profile does not exist.",
              },
              request_id: context.get("requestId"),
            },
            404,
          );
        return context.json(
          await service(context).publishForOrganizer(
            session,
            event,
            context.req.param("profileId"),
            input.data,
            context.get("requestId"),
          ),
        );
      } catch (error) {
        return profileFailure(context, error);
      }
    },
  );

  app.get("/api/v1/public/events/:slug/speakers", async (context) => {
    const slug = speakerPortalSlugSchema.safeParse(context.req.param("slug"));
    if (!slug.success)
      return context.json(
        {
          error: {
            code: "not_found",
            message: "The published speakers do not exist.",
          },
          request_id: context.get("requestId"),
        },
        404,
      );
    try {
      const projection = await service(context).publicProjection(slug.data);
      if (!projection)
        return context.json(
          {
            error: {
              code: "not_found",
              message: "The published speakers do not exist.",
            },
            request_id: context.get("requestId"),
          },
          404,
        );
      const body = JSON.stringify(projection);
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(body),
      );
      const etag = `"${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}"`;
      const headers = new Headers({
        "Cache-Control": "public, max-age=0, must-revalidate",
        "Cache-Tag": `public-speakers,event-${projection.event.slug}`,
        "Cloudflare-CDN-Cache-Control":
          "public, max-age=60, stale-while-revalidate=300, stale-if-error=900",
        "Content-Type": "application/json; charset=utf-8",
        ETag: etag,
      });
      if (context.req.header("If-None-Match") === etag)
        return new Response(null, { headers, status: 304 });
      return new Response(body, { headers });
    } catch (error) {
      return profileFailure(context, error);
    }
  });

  app.get(
    "/api/v1/public/events/:slug/speakers/:speakerSlug/headshot",
    async (context) => {
      const slug = speakerPortalSlugSchema.safeParse(context.req.param("slug"));
      if (!slug.success) return context.notFound();
      try {
        const headshot = await service(context).publicHeadshot(
          slug.data,
          context.req.param("speakerSlug"),
        );
        if (!headshot) return context.notFound();
        const headers = new Headers({
          "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
          "Content-Type": headshot.contentType,
          "Cross-Origin-Resource-Policy": "cross-origin",
          "X-Content-Type-Options": "nosniff",
        });
        if (headshot.etag) headers.set("ETag", headshot.etag);
        return new Response(headshot.body, { headers });
      } catch (error) {
        return profileFailure(context, error);
      }
    },
  );
}
