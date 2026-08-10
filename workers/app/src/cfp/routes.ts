import { publicCfpConfigurationResponseSchema } from "@sessionbox-killer/contracts";
import type { Hono } from "hono";

import type { AppContext } from "../app-context";
import { emitOperationalLog } from "../observability";
import { D1PublicCfpPolicyReader, PublicCfpConfigurationError } from "./policy";

const publicSlugPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function registerPublicCfpRoutes(app: Hono<AppContext>): void {
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
}
