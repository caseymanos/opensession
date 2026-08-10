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
      body: JSON.stringify({ redirect_path: "/" }),
      contentType: "application/json",
      status: 200,
    });
  });

  await page.goto(`/auth/magic#token=${token}`);
  await expect(page).toHaveURL(/\/$/);
  expect(exchanged).toBe(true);
  expect(page.url()).not.toContain(token);
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
