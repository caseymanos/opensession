import { describe, expect, it, vi } from "vitest";

import type { ApiKeyMetadata } from "@sessionbox-killer/contracts/public-api";

import { ApiKeyClientError, createApiKeyPort } from "./apiKeyClient";

const metadata: ApiKeyMetadata = {
  created_at: "2026-08-10T20:00:00.000Z",
  expires_at: null,
  id: "key_abcdefghijklmnopqrstuvwx",
  last_used_at: null,
  name: "Schedule signage",
  prefix: "osk_key_abcdefghijklmnopqrstuvwx",
  revoked_at: null,
  scope: {
    event_id: "event_summit",
    kind: "event",
    organization_id: "organization_alpha",
  },
  scopes: ["events:read", "schedule:read"],
  state: "active",
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

describe("API key client", () => {
  it("lists only validated safe metadata", async () => {
    const fetcher = vi.fn(async () => response({ data: [metadata] }));
    const port = createApiKeyPort("event/summit", fetcher, () => "csrf-token");

    await expect(port.list()).resolves.toEqual([metadata]);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/events/event%2Fsummit/api-keys",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("sends CSRF, JSON, and a fresh idempotency key for creation", async () => {
    const plaintext =
      "osk_key_abcdefghijklmnopqrstuvwx.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
    const fetcher = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () =>
      response(
        {
          audit_receipt: {
            created_at: metadata.created_at,
            id: "audit_key_abcdefghijklmnopqrstuvwx",
            request_id: "request_abcdefghijklmnop",
          },
          data: { ...metadata, plaintext },
        },
        201,
      ),
    );
    const port = createApiKeyPort("event_summit", fetcher, () => "csrf-token");

    await expect(
      port.create({
        expires_at: null,
        name: metadata.name,
        scope: "event",
        scopes: metadata.scopes,
      }),
    ).resolves.toMatchObject({ data: { plaintext } });
    const request = fetcher.mock.calls[0]?.[1];
    expect(request).toEqual(
      expect.objectContaining({ method: "POST", credentials: "same-origin" }),
    );
    expect(request?.headers).toEqual(
      expect.objectContaining({
        "Content-Type": "application/json",
        "X-CSRF-Token": "csrf-token",
      }),
    );
    expect(
      (request?.headers as Record<string, string>)["Idempotency-Key"],
    ).toMatch(/^api-key-create-/);
  });

  it("reuses the creation idempotency key after a lost response", async () => {
    const plaintext =
      "osk_key_abcdefghijklmnopqrstuvwx.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
    const fetcher = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError("Network connection lost"))
      .mockResolvedValueOnce(
        response(
          {
            audit_receipt: {
              created_at: metadata.created_at,
              id: "audit_key_abcdefghijklmnopqrstuvwx",
              request_id: "request_abcdefghijklmnop",
            },
            data: { ...metadata, plaintext },
          },
          201,
        ),
      );
    const port = createApiKeyPort("event_summit", fetcher, () => "csrf-token");
    const input = {
      expires_at: null,
      name: metadata.name,
      scope: "event" as const,
      scopes: metadata.scopes,
    };

    await expect(port.create(input)).rejects.toThrow("Network connection lost");
    await expect(port.create(input)).resolves.toMatchObject({
      data: { plaintext },
    });
    const firstHeaders = fetcher.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    const secondHeaders = fetcher.mock.calls[1]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(firstHeaders["Idempotency-Key"]).toBe(
      secondHeaders["Idempotency-Key"],
    );
  });

  it("fails closed before a destructive request when CSRF is absent", async () => {
    const fetcher = vi.fn();
    const port = createApiKeyPort("event_summit", fetcher, () => null);
    const error = await port
      .revoke(metadata.id)
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApiKeyClientError);
    expect(error).toMatchObject({ code: "missing_csrf", status: 0 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns problem detail and request ID without exposing arbitrary bodies", async () => {
    const fetcher = vi.fn(async () =>
      response(
        {
          code: "api_key_management_forbidden",
          detail: "You do not have permission to manage these keys.",
          request_id: "request_abcdefghijklmnop",
          status: 403,
          title: "API key management forbidden",
          type: "https://opensessionboard.com/problems/api_key_management_forbidden",
        },
        403,
      ),
    );
    const port = createApiKeyPort("event_summit", fetcher, () => "csrf-token");

    await expect(port.list()).rejects.toMatchObject({
      code: "api_key_management_forbidden",
      message: "You do not have permission to manage these keys.",
      requestId: "request_abcdefghijklmnop",
      status: 403,
    });
  });
});
