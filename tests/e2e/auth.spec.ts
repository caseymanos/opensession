import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { mockTurnstile } from "./turnstile";

test.beforeEach(async ({ page }) => mockTurnstile(page));

test("passwordless sign-in is clear and enumeration-safe", async ({ page }) => {
  await page.route("**/api/auth/magic-links", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({
      email: "organizer@example.com",
      purpose: "sign_in",
      redirect_path: "/",
      turnstile_action: "sign_in",
      turnstile_token: "test-token-1",
    });
    await route.fulfill({
      body: JSON.stringify({
        accepted: true,
        message: "If that address can sign in, a private link is on its way.",
      }),
      contentType: "application/json",
      status: 202,
    });
  });

  await page.goto("/auth/sign-in");
  await expect(
    page.getByRole("heading", { name: "Sign in to your program" }),
  ).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  await page.getByLabel("Email address").fill("organizer@example.com");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();

  await expect(
    page.getByRole("heading", { name: "Check your inbox." }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "If organizer@example.com can sign in",
  );
  await expect(page.getByRole("status")).toContainText("works once");
});

test("magic token leaves the address bar before the exchange request", async ({
  page,
}) => {
  const token = `browser-magic-${"t".repeat(40)}`;
  let exchanged = false;

  await page.route("**/api/auth/magic-links/exchange", async (route) => {
    exchanged = true;
    expect(route.request().url()).not.toContain(token);
    expect(route.request().postDataJSON()).toEqual({ token });
    expect(page.url()).not.toContain(token);
    await route.fulfill({
      body: JSON.stringify({
        csrf_token: "browser-csrf-token-that-is-at-least-forty-characters",
        expires_at: "2026-08-11T00:00:00.000Z",
        redirect_path: "/",
        user: {
          display_name: "Casey Manos",
          email: "casey@example.com",
          id: "person_casey",
        },
      }),
      contentType: "application/json",
      status: 200,
    });
  });

  await page.goto(`/auth/magic#token=${token}`);
  await expect(page).toHaveURL(/\/$/);
  expect(exchanged).toBe(true);
  expect(page.url()).not.toContain(token);
});

test("sign-in preserves a validated portal return path", async ({ page }) => {
  await page.route("**/api/auth/magic-links", async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      redirect_path: "/portal/ai-engineer-summit/profile",
    });
    await route.fulfill({
      body: JSON.stringify({
        accepted: true,
        message: "If that address can sign in, a private link is on its way.",
      }),
      contentType: "application/json",
      status: 202,
    });
  });

  await page.goto(
    "/auth/sign-in?return_to=%2Fportal%2Fai-engineer-summit%2Fprofile",
  );
  await page.getByLabel("Email address").fill("speaker@example.com");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(
    page.getByRole("heading", { name: "Check your inbox." }),
  ).toBeVisible();
});

test("used or malformed links recover without a dead end", async ({ page }) => {
  await page.goto("/auth/magic");

  await expect(
    page.getByRole("heading", {
      name: "This link has expired or was already used.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Request a new link" }),
  ).toHaveAttribute("href", "/auth/sign-in");
});

test("expired speaker invitation preserves only safe recovery context", async ({
  page,
}) => {
  const token = `expired-portal-${"e".repeat(40)}`;
  await page.route("**/api/auth/magic-links/exchange", async (route) => {
    await route.fulfill({
      json: {
        error: {
          code: "invalid_magic_link",
          message: "This speaker invitation is no longer available.",
          recovery: {
            email_hint: "m***@example.com",
            event: {
              brand: {
                accent: "#cde878",
                background: "#f5f2ea",
                ink: "#10201d",
              },
              name: "AI Engineer Summit",
              slug: "ai-engineer-summit",
            },
            reason: "expired",
          },
        },
      },
      status: 400,
    });
  });

  await page.goto(`/auth/magic#token=${token}`);
  await expect(page.getByText("AI Engineer Summit")).toBeVisible();
  await expect(page.getByText("Invitation for m***@example.com")).toBeVisible();
  await expect(page.getByText("mina@example.com")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Request a new link" }),
  ).toHaveAttribute("href", "/portal/ai-engineer-summit");
  await expect(page).not.toHaveURL(new RegExp(token));
});
