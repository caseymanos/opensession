import { expect, type Page } from "@playwright/test";

export const portalCsrfToken =
  "portal-e2e-csrf-token-that-is-at-least-forty-characters";

export async function mockPortalAuth(page: Page) {
  await page.context().addCookies([
    {
      httpOnly: false,
      name: "__Host-opensession-csrf",
      sameSite: "Lax",
      secure: true,
      url: "https://127.0.0.1:8787",
      value: portalCsrfToken,
    },
  ]);
  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({
      json: {
        expires_at: "2026-08-11T00:00:00.000Z",
        scope: null,
        user: {
          display_name: "Mina Okafor",
          email: "mina@example.com",
          id: "user_mina",
        },
      },
      status: 200,
    });
  });
  await page.route("**/api/auth/logout", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe(portalCsrfToken);
    await route.fulfill({ status: 204 });
  });
}
