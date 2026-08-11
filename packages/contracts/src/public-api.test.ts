import { describe, expect, it } from "vitest";

import {
  apiKeyCreateRequestSchema,
  apiKeyCreateResponseSchema,
  apiKeyMetadataSchema,
  publicApiPaginationQuerySchema,
  publicApiProblemSchema,
  publicApiScopeSchema,
  publicApiSubmissionPatchSchema,
} from "./public-api";

const metadata = {
  created_at: "2026-08-10T20:00:00.000Z",
  expires_at: null,
  id: "key_abcdefghijklmnopqrstuvwx",
  last_used_at: null,
  name: "Schedule signage",
  prefix: "osk_key_abcdefghijklmnopqrstuvwx",
  revoked_at: null,
  scope: {
    event_id: "event_summit",
    kind: "event" as const,
    organization_id: "organization_alpha",
  },
  scopes: ["events:read" as const, "schedule:read" as const],
  state: "active" as const,
};

describe("public API contracts", () => {
  it("defaults pagination to 25 and caps it at 100", () => {
    expect(publicApiPaginationQuerySchema.parse({})).toEqual({ limit: 25 });
    expect(publicApiPaginationQuerySchema.parse({ limit: 100 })).toEqual({
      limit: 100,
    });
    expect(
      publicApiPaginationQuerySchema.safeParse({ limit: 101 }).success,
    ).toBe(false);
  });

  it("has no task mutation scope", () => {
    expect(publicApiScopeSchema.options).toContain("tasks:read");
    expect(publicApiScopeSchema.safeParse("tasks:write").success).toBe(false);
  });

  it("requires least one unique scope and a coherent access boundary", () => {
    expect(
      apiKeyCreateRequestSchema.parse({
        expires_at: null,
        name: "Program sync",
        scope: "event",
        scopes: ["events:read"],
      }),
    ).toBeTruthy();
    expect(
      apiKeyCreateRequestSchema.safeParse({
        expires_at: null,
        name: "Duplicate scopes",
        scope: "organization",
        scopes: ["events:read", "events:read"],
      }).success,
    ).toBe(false);
    expect(
      apiKeyMetadataSchema.safeParse({
        ...metadata,
        scope: { ...metadata.scope, event_id: null },
      }).success,
    ).toBe(false);
  });

  it("models plaintext only on the one-time creation response", () => {
    expect(apiKeyMetadataSchema.safeParse(metadata).success).toBe(true);
    expect(
      apiKeyMetadataSchema.safeParse({
        ...metadata,
        plaintext: "osk_key_secret.secret",
      }).success,
    ).toBe(false);
    expect(
      apiKeyCreateResponseSchema.parse({
        audit_receipt: {
          created_at: metadata.created_at,
          id: "audit_key_abcdefghijklmnopqrstuvwx",
          request_id: "request_abcdefghijklmnop",
        },
        data: {
          ...metadata,
          plaintext:
            "osk_key_abcdefghijklmnopqrstuvwx.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
        },
      }),
    ).toBeTruthy();
  });

  it("keeps public mutations narrow and strict", () => {
    expect(
      publicApiSubmissionPatchSchema.parse({
        reason: "Ready for committee review.",
        status: "in_review",
      }),
    ).toBeTruthy();
    expect(
      publicApiSubmissionPatchSchema.safeParse({
        reason: "Accept it",
        status: "accepted",
      }).success,
    ).toBe(false);
  });

  it("requires stable RFC-style problem details and request correlation", () => {
    expect(
      publicApiProblemSchema.parse({
        code: "event_scope_mismatch",
        detail: "This API key cannot access the requested event.",
        request_id: "request_abcdefghijklmnop",
        status: 403,
        title: "Event scope mismatch",
        type: "https://opensessionboard.com/problems/event_scope_mismatch",
      }),
    ).toBeTruthy();
  });
});
