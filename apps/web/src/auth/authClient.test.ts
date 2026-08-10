import { describe, expect, it, vi } from "vitest";

import {
  AuthApiError,
  exchangeMagicLink,
  logoutAuthSession,
  readAuthSession,
  readCsrfToken,
  requestMagicLink,
  safeAuthRedirectPath,
} from "./authClient";

function response(body: unknown, status = 200) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    ...(body === null
      ? {}
      : { headers: { "Content-Type": "application/json" } }),
  });
}

const user = {
  display_name: "Mina Okafor",
  email: "mina@example.com",
  id: "user_mina",
};

describe("auth HTTP client", () => {
  it("keeps only validated local return paths", () => {
    expect(safeAuthRedirectPath("/portal/ai-engineer-summit")).toBe(
      "/portal/ai-engineer-summit",
    );
    expect(safeAuthRedirectPath("https://attacker.example/portal")).toBe("/");
    expect(safeAuthRedirectPath("//attacker.example/portal")).toBe("/");
    expect(safeAuthRedirectPath(null)).toBe("/");
  });

  it("requests and validates an enumeration-safe magic link response", async () => {
    const fetcher = vi.fn(async () =>
      response(
        {
          accepted: true,
          message: "If that address can sign in, a private link is on its way.",
        },
        202,
      ),
    );

    await expect(
      requestMagicLink(
        {
          email: "mina@example.com",
          purpose: "sign_in",
          redirect_path: "/portal/ai-engineer-summit",
          turnstile_action: "sign_in",
          turnstile_token: "verified-turnstile-token",
        },
        fetcher,
      ),
    ).resolves.toMatchObject({ accepted: true });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/auth/magic-links",
      expect.objectContaining({
        credentials: "same-origin",
        method: "POST",
      }),
    );
  });

  it("validates the complete magic-link exchange contract", async () => {
    const token = `portal-${"t".repeat(40)}`;
    const fetcher =
      vi.fn<
        (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
      >();
    fetcher.mockResolvedValue(
      response({
        csrf_token: "c".repeat(40),
        expires_at: "2026-08-11T00:00:00.000Z",
        redirect_path: "/portal/ai-engineer-summit",
        user,
      }),
    );

    await expect(exchangeMagicLink(token, fetcher)).resolves.toMatchObject({
      redirect_path: "/portal/ai-engineer-summit",
      user,
    });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      token,
    });
  });

  it("accepts the server session identity without inventing a CSRF field", async () => {
    const fetcher = vi.fn(async () =>
      response({
        expires_at: "2026-08-11T00:00:00.000Z",
        scope: null,
        user,
      }),
    );

    await expect(readAuthSession(fetcher)).resolves.toEqual({
      expires_at: "2026-08-11T00:00:00.000Z",
      user,
    });
  });

  it("reads the host CSRF cookie and sends a verified logout", async () => {
    const token = "csrf token with spaces";
    const cookie = `theme=dark; __Host-opensession-csrf=${encodeURIComponent(token)}`;
    const fetcher = vi.fn(async () => response(null, 204));

    expect(readCsrfToken(cookie)).toBe(token);
    await expect(logoutAuthSession(cookie, fetcher)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith(
      "/api/auth/logout",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-CSRF-Token": token }),
        method: "POST",
      }),
    );
  });

  it("fails closed when logout has no CSRF cookie", async () => {
    const error = await logoutAuthSession("theme=dark", vi.fn()).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(AuthApiError);
    expect(error).toMatchObject({ code: "missing_csrf", status: 0 });
  });
});
