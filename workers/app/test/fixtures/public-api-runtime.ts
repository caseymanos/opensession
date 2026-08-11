import { WorkerEntrypoint } from "cloudflare:workers";
import { Hono } from "hono";

import type { AppContext } from "../../src/app-context.js";
import {
  registerApiKeyManagementRoutes,
  registerPublicApiDocumentationRoutes,
  registerPublicApiRoutes,
} from "../../src/public-api/routes.js";

const app = new Hono<AppContext>();

app.use("*", async (context, next) => {
  const requestId = crypto.randomUUID();
  context.set("requestId", requestId);
  context.header("Cache-Control", "no-store");
  context.header("X-Content-Type-Options", "nosniff");
  context.header("X-Request-Id", requestId);
  await next();
});

registerPublicApiDocumentationRoutes(app);
registerApiKeyManagementRoutes(app);
registerPublicApiRoutes(app);

export default class PublicApiRuntime extends WorkerEntrypoint<Env> {
  override fetch(request: Request): Response | Promise<Response> {
    return app.fetch(request, this.env, this.ctx);
  }
}
