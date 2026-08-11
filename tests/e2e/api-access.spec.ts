import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import type { ApiKeyMetadata } from "@sessionbox-killer/contracts/public-api";

const fixturePath = "/fixtures/api-access/default";
const csrfToken = "api-access-e2e-csrf-token-that-is-at-least-forty-characters";
const createdPlaintext =
  "osk_key_zyxwvutsrqponmlkjihgfedc.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";

const existingKey: ApiKeyMetadata = {
  created_at: "2026-08-01T18:00:00.000Z",
  expires_at: "2026-11-01T18:00:00.000Z",
  id: "key_abcdefghijklmnopqrstuvwx",
  last_used_at: "2026-08-10T19:48:00.000Z",
  name: "Program sync",
  prefix: "osk_key_abcdefghijklmnopqrstuvwx",
  revoked_at: null,
  scope: {
    event_id: "event_ai_engineer_summit",
    kind: "event",
    organization_id: "organization_open_session",
  },
  scopes: ["events:read", "sessions:read", "schedule:read"],
  state: "active",
};

async function installApiFixture(page: Page) {
  await page.context().addCookies([
    {
      httpOnly: false,
      name: "__Host-opensession-csrf",
      sameSite: "Lax",
      secure: true,
      url: "https://127.0.0.1:8787",
      value: csrfToken,
    },
  ]);
  const keys: ApiKeyMetadata[] = [existingKey];
  await page.route(
    "**/api/events/ai-engineer-summit/api-keys**",
    async (route) => {
      const request = route.request();
      if (request.method() === "GET") {
        await route.fulfill({ json: { data: keys } });
        return;
      }
      expect(request.headers()["x-csrf-token"]).toBe(csrfToken);
      expect(request.headers()["idempotency-key"]).toMatch(
        /^api-key-(create|revoke)-/,
      );
      if (request.method() === "POST") {
        expect(request.postDataJSON()).toMatchObject({
          name: "Schedule signage",
          scope: "organization",
          scopes: expect.arrayContaining(["events:read", "submissions:write"]),
        });
        const created: ApiKeyMetadata = {
          ...existingKey,
          created_at: "2026-08-10T20:00:00.000Z",
          expires_at: null,
          id: "key_zyxwvutsrqponmlkjihgfedc",
          last_used_at: null,
          name: "Schedule signage",
          prefix: "osk_key_zyxwvutsrqponmlkjihgfedc",
          scope: {
            ...existingKey.scope,
            event_id: null,
            kind: "organization",
          },
          scopes: ["events:read", "submissions:write"],
        };
        keys.unshift(created);
        await route.fulfill({
          json: {
            audit_receipt: {
              created_at: created.created_at,
              id: "audit_key_zyxwvutsrqponmlkjihgfedc",
              request_id: "request_api_access_create",
            },
            data: { ...created, plaintext: createdPlaintext },
          },
          status: 201,
        });
        return;
      }
      expect(request.method()).toBe("DELETE");
      const target = keys.find((key) => request.url().endsWith(`/${key.id}`));
      if (!target)
        throw new Error("API access fixture could not resolve revoke target.");
      const revoked: ApiKeyMetadata = {
        ...target,
        revoked_at: "2026-08-10T20:05:00.000Z",
        state: "revoked",
      };
      keys.splice(keys.indexOf(target), 1, revoked);
      await route.fulfill({
        json: {
          audit_receipt: {
            created_at: revoked.revoked_at,
            id: "audit_key_revoke_abcdefghijklmnop",
            request_id: "request_api_access_revoke",
          },
          data: revoked,
        },
      });
    },
  );
}

test("@judge @judge-e2e-06 organizer creates a scoped key and sees its plaintext exactly once", async ({
  page,
}) => {
  await installApiFixture(page);
  await page.goto(fixturePath);

  await expect(
    page.getByRole("heading", { level: 1, name: "API access" }),
  ).toBeVisible();
  await expect(page.getByText(existingKey.prefix)).toBeVisible();
  await expect(page.getByText("Secret cannot be viewed again")).toBeVisible();

  await page.getByRole("button", { name: "Create API key" }).click();
  const create = page.getByRole("dialog", { name: "Create API key" });
  await create.getByLabel("Key name").fill("Schedule signage");
  await create.getByLabel("Access boundary").selectOption("organization");
  await create.getByLabel("Expiration").selectOption("never");
  await create.getByText("Submissions · write").click();
  await create.getByRole("button", { name: "Create key" }).click();

  const secret = page.getByRole("dialog", { name: "Store this API key now" });
  await expect(secret.getByLabel("API key for Schedule signage")).toHaveValue(
    createdPlaintext,
  );
  await expect(secret).toContainText("No recovery path");
  const secretAccessibility = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .analyze();
  expect(secretAccessibility.violations).toEqual([]);
  await secret.getByRole("button", { name: "I have stored this key" }).click();
  await expect(secret).toHaveCount(0);
  await expect(
    page.getByText("osk_key_zyxwvutsrqponmlkjihgfedc"),
  ).toBeVisible();
  await expect(page.getByText(createdPlaintext)).toHaveCount(0);

  const results = await new AxeBuilder({ page })
    .include(".api-access")
    .analyze();
  expect(results.violations).toEqual([]);
});

test("destructive revocation requires the exact key name", async ({ page }) => {
  await installApiFixture(page);
  await page.goto(fixturePath);

  const card = page
    .locator(".api-key-card")
    .filter({ hasText: "Program sync" });
  await card.getByRole("button", { name: "Revoke" }).click();
  const dialog = page.getByRole("dialog", { name: "Revoke Program sync?" });
  const revoke = dialog.getByRole("button", { name: "Revoke key" });
  await expect(revoke).toBeDisabled();
  const dialogAccessibility = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .analyze();
  expect(dialogAccessibility.violations).toEqual([]);
  await dialog.getByLabel("Key name").fill("Program syn");
  await expect(revoke).toBeDisabled();
  await dialog.getByLabel("Key name").fill("Program sync");
  await expect(revoke).toBeEnabled();
  await revoke.click();

  await expect(card.getByText("revoked", { exact: true })).toBeVisible();
  await expect(card).toContainText("Revoked Aug 10, 2026");
  await expect(card.getByRole("button", { name: "Revoke" })).toHaveCount(0);
});

test("API access remains operable and accessible at 360px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await installApiFixture(page);
  await page.goto(fixturePath);

  await expect(
    page.getByRole("button", { name: "Create API key" }),
  ).toBeVisible();
  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);

  const results = await new AxeBuilder({ page })
    .include(".api-access")
    .analyze();
  expect(results.violations).toEqual([]);
});

test("human API docs are accessible and link the generated schema", async ({
  page,
}) => {
  await page.goto("/docs/api");

  await expect(
    page.getByRole("heading", { level: 1, name: "OpenSession Public API v1" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "OpenAPI 3.1 JSON" }),
  ).toHaveAttribute("href", "/openapi.json");
  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});
