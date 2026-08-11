import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { AppContext } from "../src/app-context";
import { publicApiOperations } from "../src/public-api/catalog";
import {
  createApiKeyMaterial,
  parseApiKey,
  verifyApiKeyVerifier,
} from "../src/public-api/crypto";
import { publicApiDocsHtml } from "../src/public-api/docs";
import {
  buildPublicOpenApiDocument,
  publicOpenApiDocument,
} from "../src/public-api/openapi";
import {
  registerPublicApiDocumentationRoutes,
  registerPublicApiRoutes,
} from "../src/public-api/routes";

describe("public API schema and implementation catalog", () => {
  it("generates a validated OpenAPI 3.1 document from runtime schemas", () => {
    expect(publicOpenApiDocument).toEqual(buildPublicOpenApiDocument());
    expect(publicOpenApiDocument).toMatchObject({
      info: { title: "OpenSession Public API", version: "1.0.0" },
      openapi: "3.1.0",
      security: [{ apiKey: [] }],
      servers: [{ url: "/api/v1" }],
    });
    const paths = publicOpenApiDocument.paths as Record<
      string,
      Record<string, { operationId: string; "x-required-scope": string }>
    >;
    expect(
      Object.values(paths).flatMap((path) =>
        Object.values(path).map(({ operationId }) => operationId),
      ),
    ).toHaveLength(publicApiOperations.length);
    expect(paths["/events/{eventId}/tasks"]?.get?.["x-required-scope"]).toBe(
      "tasks:read",
    );
    expect(JSON.stringify(publicOpenApiDocument)).not.toContain("tasks:write");
  });

  it("fails schema/implementation drift when a catalog route is not registered", () => {
    const app = new Hono<AppContext>();
    registerPublicApiRoutes(app);
    registerPublicApiDocumentationRoutes(app);
    const registered = new Set(
      app.routes.map(({ method, path }) => `${method.toLowerCase()} ${path}`),
    );
    const implementedPublicOperations = new Set(
      app.routes
        .filter(
          ({ method, path }) =>
            path.startsWith("/api/v1/") &&
            (method === "GET" || method === "PATCH"),
        )
        .map(({ method, path }) => `${method.toLowerCase()} ${path}`),
    );
    const documentedPublicOperations = new Set(
      publicApiOperations.map(
        ({ honoPath, method }) => `${method} ${honoPath}`,
      ),
    );

    for (const operation of publicApiOperations) {
      expect(registered).toContain(`${operation.method} ${operation.honoPath}`);
    }
    expect(registered).toContain("get /openapi.json");
    expect(registered).toContain("get /docs/api");
    expect([...implementedPublicOperations].sort()).toEqual(
      [...documentedPublicOperations].sort(),
    );
  });

  it("renders accessible, secret-safe human documentation", () => {
    const html = publicApiDocsHtml();
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("OpenAPI 3.1 JSON");
    expect(html).toContain("Plaintext is never recoverable");
    expect(html).toContain("application/problem+json");
    expect(html).toContain("prefers-reduced-motion");
    expect(html.match(/<pre aria-label=.* tabindex="0">/g)).toHaveLength(3);
    expect(html).not.toContain("<script");
  });

  it("documents the complete rate-limit response contract", () => {
    const paths = publicOpenApiDocument.paths as Record<
      string,
      Record<string, { responses?: Record<string, unknown> }>
    >;
    const rateLimited = paths["/events"]?.get?.responses?.["429"] as
      { headers?: Record<string, unknown> } | undefined;
    expect(rateLimited?.headers).toEqual(
      expect.objectContaining({
        "RateLimit-Limit": expect.any(Object),
        "RateLimit-Remaining": expect.any(Object),
        "RateLimit-Reset": expect.any(Object),
        "Retry-After": expect.any(Object),
        "X-Request-Id": expect.any(Object),
      }),
    );
  });
});

describe("public API key cryptography", () => {
  it("creates a salted one-time credential and verifies it in constant-time code", async () => {
    const pepper = "p".repeat(32);
    const material = await createApiKeyMaterial(pepper);
    const parsed = parseApiKey(material.plaintext);

    expect(parsed).toEqual({
      id: material.id,
      plaintext: material.plaintext,
      prefix: material.prefix,
    });
    expect(material.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(material.verifier).toMatch(/^[0-9a-f]{64}$/);
    expect(material.verifier).not.toContain(material.plaintext);
    await expect(
      verifyApiKeyVerifier(
        material.plaintext,
        material.salt,
        pepper,
        material.verifier,
      ),
    ).resolves.toBe(true);
    await expect(
      verifyApiKeyVerifier(
        `${material.plaintext}x`,
        material.salt,
        pepper,
        material.verifier,
      ),
    ).resolves.toBe(false);
  });

  it("rejects malformed and provider-like tokens", () => {
    expect(parseApiKey("pat_secret_provider_token")).toBeNull();
    expect(parseApiKey("osk_key_short.secret")).toBeNull();
    expect(parseApiKey("")).toBeNull();
  });
});
