import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const remoteBaseURL = process.env.E2E_BASE_URL?.trim();
const eventSlug = process.env.E2E_EVENT_SLUG?.trim() || "ai-engineer-summit";

if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(eventSlug)) {
  throw new Error("E2E_EVENT_SLUG is invalid.");
}

test.describe(
  "credential-free deployed smoke",
  { tag: "@production-smoke" },
  () => {
    test.skip(!remoteBaseURL, "E2E_BASE_URL selects a deployed environment.");

    test("live, ready, and public contracts are healthy", async ({
      request,
    }) => {
      for (const path of [
        "/health/live",
        "/health/ready",
        `/api/v1/public/events/${eventSlug}/cfp`,
        `/api/v1/public/events/${eventSlug}/schedule`,
        `/api/v1/public/events/${eventSlug}/speakers`,
        "/openapi.json",
      ]) {
        const response = await request.get(path);
        expect(response.status(), `${path} did not return HTTP 200`).toBe(200);
        expect(response.headers()["cache-control"]).toBeTruthy();
      }
    });

    test("public judge pages render without critical accessibility defects", async ({
      page,
    }) => {
      for (const path of [
        `/e/${eventSlug}/cfp`,
        `/e/${eventSlug}`,
        `/e/${eventSlug}/speakers`,
        "/docs/api",
      ]) {
        const response = await page.goto(path, {
          waitUntil: "domcontentloaded",
        });
        expect(response?.status(), `${path} did not return HTTP 200`).toBe(200);
        await expect(page.locator("main")).toBeVisible();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth + 1,
          ),
          `${path} overflows the viewport`,
        ).toBe(true);
        const accessibility = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze();
        expect(accessibility.violations, `${path} has axe violations`).toEqual(
          [],
        );
      }
    });
  },
);
