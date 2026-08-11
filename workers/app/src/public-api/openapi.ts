import { publicApiProblemSchema } from "@sessionbox-killer/contracts/public-api";
import { z } from "zod";

import { publicApiOperations, type PublicApiOperation } from "./catalog.js";

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const openApiDocumentSchema = z
  .object({
    components: z
      .object({
        schemas: z.record(z.string(), jsonValueSchema),
        securitySchemes: z.record(z.string(), jsonValueSchema),
      })
      .strict(),
    info: z
      .object({
        description: z.string().min(1),
        title: z.string().min(1),
        version: z.string().min(1),
      })
      .strict(),
    openapi: z.literal("3.1.0"),
    paths: z.record(z.string().startsWith("/"), jsonValueSchema),
    security: z.array(jsonValueSchema),
    servers: z.array(
      z
        .object({
          description: z.string().min(1),
          url: z.string().startsWith("/"),
        })
        .strict(),
    ),
    tags: z.array(z.object({ name: z.string().min(1) }).strict()),
  })
  .strict();

function componentName(
  operation: PublicApiOperation,
  kind: "Request" | "Response",
) {
  return `${operation.id[0]?.toUpperCase() ?? ""}${operation.id.slice(1)}${kind}`;
}

function jsonSchema(schema: z.ZodType): unknown {
  const generated = z.toJSONSchema(schema);
  if (generated && typeof generated === "object" && "$schema" in generated) {
    const withoutDialect = { ...generated };
    delete withoutDialect.$schema;
    return withoutDialect;
  }
  return generated;
}

function pathParameters(path: string) {
  return [...path.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((match) => ({
    in: "path",
    name: match[1],
    required: true,
    schema: {
      maxLength: 128,
      minLength: 3,
      pattern: "^[A-Za-z0-9][A-Za-z0-9_-]+$",
      type: "string",
    },
  }));
}

function rateLimitHeaders() {
  return {
    "RateLimit-Limit": {
      description: "Requests allowed in the current 60-second window.",
      schema: { minimum: 1, type: "integer" },
    },
    "RateLimit-Remaining": {
      description: "Requests remaining in the current window.",
      schema: { minimum: 0, type: "integer" },
    },
    "RateLimit-Reset": {
      description: "Unix timestamp when the current window resets.",
      schema: { minimum: 0, type: "integer" },
    },
    "X-Request-Id": {
      description: "Request identifier for support and audit correlation.",
      schema: { type: "string" },
    },
  };
}

function problemResponse(description: string) {
  return {
    content: {
      "application/problem+json": {
        schema: { $ref: "#/components/schemas/Problem" },
      },
    },
    description,
    headers: {
      "X-Request-Id": rateLimitHeaders()["X-Request-Id"],
    },
  };
}

function rateLimitedProblemResponse() {
  const response = problemResponse("The API key exceeded its rate limit.");
  return {
    ...response,
    headers: {
      ...rateLimitHeaders(),
      "Retry-After": {
        description: "Seconds until this API key may retry.",
        schema: { minimum: 1, type: "integer" },
      },
    },
  };
}

function operationDocument(operation: PublicApiOperation) {
  const parameters: unknown[] = pathParameters(operation.openApiPath);
  if (operation.paginated) {
    parameters.push(
      {
        description: "Opaque cursor returned by the preceding page.",
        in: "query",
        name: "cursor",
        required: false,
        schema: { maxLength: 1024, minLength: 1, type: "string" },
      },
      {
        description: "Page size. Defaults to 25 and cannot exceed 100.",
        in: "query",
        name: "limit",
        required: false,
        schema: { default: 25, maximum: 100, minimum: 1, type: "integer" },
      },
    );
  }
  if (operation.method === "patch") {
    parameters.push(
      {
        description: "A unique 16–128 character mutation key.",
        in: "header",
        name: "Idempotency-Key",
        required: true,
        schema: { maxLength: 128, minLength: 16, type: "string" },
      },
      {
        description:
          "The strong ETag returned by the latest singular resource read.",
        in: "header",
        name: "If-Match",
        required: true,
        schema: {
          pattern: '^"opensession-[a-z-]+-v[1-9][0-9]*"$',
          type: "string",
        },
      },
    );
  }
  const successHeaders: Record<string, unknown> = rateLimitHeaders();
  if (operation.versioned || operation.id === "getPublishedSchedule") {
    successHeaders.ETag = {
      description:
        "Strong entity tag for conditional mutation or cache validation.",
      schema: { type: "string" },
    };
  }
  return {
    description: operation.description,
    operationId: operation.id,
    parameters,
    ...(operation.requestSchema
      ? {
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  $ref: `#/components/schemas/${componentName(operation, "Request")}`,
                },
              },
            },
            required: true,
          },
        }
      : {}),
    responses: {
      "200": {
        content: {
          "application/json": {
            schema: {
              $ref: `#/components/schemas/${componentName(operation, "Response")}`,
            },
          },
        },
        description: "Successful response.",
        headers: successHeaders,
      },
      "400": problemResponse("The request is malformed."),
      "401": problemResponse("The API key is missing or invalid."),
      "403": problemResponse("The API key does not grant the required scope."),
      "404": problemResponse(
        "The resource does not exist in the authenticated scope.",
      ),
      ...(operation.method === "patch"
        ? {
            "409": problemResponse(
              "The mutation conflicts with current resource state.",
            ),
            "412": problemResponse("The supplied entity version is stale."),
            "413": problemResponse("The request body is too large."),
            "428": problemResponse("If-Match is required."),
          }
        : {}),
      "429": rateLimitedProblemResponse(),
      "503": problemResponse(
        "The authoritative service is temporarily unavailable.",
      ),
    },
    security: [{ apiKey: [] }],
    summary: operation.summary,
    tags: [operation.tag],
    "x-required-scope": operation.scope,
  };
}

export function buildPublicOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const schemas: Record<string, unknown> = {
    Problem: jsonSchema(publicApiProblemSchema),
  };
  for (const operation of publicApiOperations as readonly PublicApiOperation[]) {
    const path = paths[operation.openApiPath] ?? {};
    if (path[operation.method]) {
      throw new Error(
        `Duplicate public API operation for ${operation.method.toUpperCase()} ${operation.openApiPath}.`,
      );
    }
    path[operation.method] = operationDocument(operation);
    paths[operation.openApiPath] = path;
    schemas[componentName(operation, "Response")] = jsonSchema(
      operation.responseSchema,
    );
    if (operation.requestSchema) {
      schemas[componentName(operation, "Request")] = jsonSchema(
        operation.requestSchema,
      );
    }
  }
  const operationIds = publicApiOperations.map(({ id }) => id);
  if (new Set(operationIds).size !== operationIds.length) {
    throw new Error("Public API operation IDs must be unique.");
  }
  return openApiDocumentSchema.parse({
    components: {
      schemas,
      securitySchemes: {
        apiKey: {
          bearerFormat: "OpenSession API key",
          description:
            "Send the API key once as `Authorization: Bearer <key>`. Keys are scoped and revocable.",
          scheme: "bearer",
          type: "http",
        },
      },
    },
    info: {
      description:
        "Provider-neutral, scoped access to OpenSession event operations. All times use RFC 3339 and all errors use application/problem+json.",
      title: "OpenSession Public API",
      version: "1.0.0",
    },
    openapi: "3.1.0",
    paths,
    security: [{ apiKey: [] }],
    servers: [{ description: "Current OpenSession origin", url: "/api/v1" }],
    tags: [...new Set(publicApiOperations.map(({ tag }) => tag))].map(
      (name) => ({
        name,
      }),
    ),
  }) as Record<string, unknown>;
}

export const publicOpenApiDocument = buildPublicOpenApiDocument();
