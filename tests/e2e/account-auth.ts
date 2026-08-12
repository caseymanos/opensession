import { expect, type Page } from "@playwright/test";

export const accountCsrfToken =
  "account-menu-e2e-csrf-token-that-is-at-least-forty-characters";

export async function mockAccountLogout(
  page: Page,
  { failures = 0 }: { failures?: number } = {},
) {
  let attempts = 0;
  await page.context().addCookies([
    {
      httpOnly: false,
      name: "__Host-opensession-csrf",
      sameSite: "Lax",
      secure: true,
      url: "https://127.0.0.1:8787",
      value: accountCsrfToken,
    },
  ]);
  await page.route("**/api/auth/logout", async (route) => {
    attempts += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe(accountCsrfToken);
    if (attempts <= failures) {
      await route.fulfill({
        json: {
          error: {
            code: "logout_failed",
            message: "Sign out could not finish.",
          },
          request_id: "request_account_logout_e2e",
        },
        status: 503,
      });
      return;
    }
    await route.fulfill({ status: 204 });
  });

  return { attempts: () => attempts };
}
