import { describe, expect, it, vi } from "vitest";

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
    ],
    [{ action: "cfp_submit", hostname: "evil.example", success: true }],
    [
      {
        action: "cfp_submit",
        hostname: "preview.opensessionboard.com",
        success: false,
      },
    ],
  ])("rejects failed, mismatched, or replayed challenges", async (response) => {
    const { verifier: service } = verifier(response);
    await expect(
      service.verify("invalid-token", "cfp_submit", null),
    ).rejects.toBeInstanceOf(TurnstileVerificationError);
  });

  it("rejects oversized tokens without sending them", async () => {
    const { fetcher, verifier: service } = verifier({ success: true });
    await expect(
      service.verify("x".repeat(2_049), "sign_in", null),
    ).rejects.toBeInstanceOf(TurnstileVerificationError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("normalizes the explicit hostname allowlist", () => {
    expect([
      ...turnstileHostnames(" Example.COM,preview.example.com "),
    ]).toEqual(["example.com", "preview.example.com"]);
  });
});
