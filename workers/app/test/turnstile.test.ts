import { afterEach, describe, expect, it, vi } from "vitest";

import { verifyTurnstile } from "../src/security/http";
import {
  TurnstileVerificationError,
  TurnstileVerifier,
  turnstileHostnames,
} from "../src/security/turnstile";

function verifier(
  response: unknown,
  options: { hostnames?: string; ok?: boolean } = {},
) {
  const fetcher = vi.fn(async () =>
    Response.json(response, { status: options.ok === false ? 503 : 200 }),
  ) as unknown as typeof fetch;
  return {
    fetcher,
    verifier: new TurnstileVerifier({
      environment: "preview",
      fetcher,
      hostnames: options.hostnames ?? "preview.opensessionboard.com",
      secret: "test-secret",
    }),
  };
}

describe("TurnstileVerifier", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("submits the canonical Siteverify form and checks action and hostname", async () => {
    const { fetcher, verifier: service } = verifier({
      action: "cfp_submit",
      hostname: "preview.opensessionboard.com",
      success: true,
    });

    await expect(
      service.verify("valid-token", "cfp_submit", "203.0.113.9"),
    ).resolves.toEqual({
      action: "cfp_submit",
      hostname: "preview.opensessionboard.com",
    });
    const [url, init] = vi.mocked(fetcher).mock.calls[0] ?? [];
    expect(url).toBe(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    );
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      "Content-Type": "application/x-www-form-urlencoded",
    });
    const body = init?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect((body as URLSearchParams).get("response")).toBe("valid-token");
    expect((body as URLSearchParams).get("remoteip")).toBe("203.0.113.9");
    expect((body as URLSearchParams).get("idempotency_key")).toMatch(
      /^[a-f\d-]{36}$/i,
    );
  });

  it.each([
    [
      {
        action: "sign_in",
        hostname: "preview.opensessionboard.com",
        success: true,
      },
      "siteverify.action-mismatch",
    ],
    [
      { action: "cfp_submit", hostname: "evil.example", success: true },
      "siteverify.hostname-mismatch",
    ],
    [
      {
        action: "cfp_submit",
        "error-codes": ["invalid-input-secret"],
        hostname: "preview.opensessionboard.com",
        success: false,
      },
      "siteverify.invalid-input-secret",
    ],
    [
      {
        action: "cfp_submit",
        "error-codes": ["provider-value-not-on-the-allowlist"],
        hostname: "preview.opensessionboard.com",
        success: false,
      },
      "siteverify.unknown",
    ],
  ] as const)(
    "rejects failed, mismatched, or replayed challenges with a safe reason",
    async (response, failureCode) => {
      const { verifier: service } = verifier(response);
      await expect(
        service.verify("invalid-token", "cfp_submit", null),
      ).rejects.toMatchObject({ failureCode });
    },
  );

  it("rejects oversized tokens without sending them", async () => {
    const { fetcher, verifier: service } = verifier({ success: true });
    await expect(
      service.verify("x".repeat(2_049), "sign_in", null),
    ).rejects.toBeInstanceOf(TurnstileVerificationError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("emits only a correlated allowlisted failure reason", async () => {
    const writeDataPoint = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          "error-codes": ["invalid-input-secret"],
          success: false,
        }),
      ),
    );
    const context = {
      env: {
        APP_ENV: "preview",
        OBSERVABILITY: { writeDataPoint },
        TURNSTILE_HOSTNAMES: "preview.opensessionboard.com",
        TURNSTILE_SECRET: "private-secret-value",
        WORKER_VERSION: { id: "version-safe-id" },
      },
      get: () => "request-safe-id",
      req: {
        header: (name: string) =>
          name === "CF-Connecting-IP" ? "203.0.113.9" : undefined,
      },
    };

    await expect(
      verifyTurnstile(context as never, "private-challenge-token", "sign_in"),
    ).rejects.toMatchObject({
      failureCode: "siteverify.invalid-input-secret",
    });

    expect(writeDataPoint).toHaveBeenCalledOnce();
    const dataPoint = writeDataPoint.mock.calls[0]?.[0];
    expect(dataPoint?.blobs).toContain("turnstile.verification.failed");
    expect(dataPoint?.blobs).toContain("siteverify.invalid-input-secret");
    const serialized = JSON.stringify(dataPoint);
    expect(serialized).toContain("request-safe-id");
    expect(serialized).not.toContain("private-secret-value");
    expect(serialized).not.toContain("private-challenge-token");
    expect(serialized).not.toContain("203.0.113.9");
  });

  it("normalizes the explicit hostname allowlist", () => {
    expect([
      ...turnstileHostnames(" Example.COM,preview.example.com "),
    ]).toEqual(["example.com", "preview.example.com"]);
  });
});
