import { expect, test } from "@playwright/test";

test("serves the organizer shell and health endpoint", async ({
  page,
  request,
}, testInfo) => {
  const health = await request.get("/health/live");
  expect(health.ok()).toBe(true);
  await expect(health.json()).resolves.toMatchObject({ status: "ok" });

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Good afternoon, Casey.",
  );
  if (testInfo.project.name === "mobile-chromium") {
    await expect(
      page.getByRole("button", { name: "Open navigation" }),
    ).toBeVisible();
  } else {
    await expect(
      page.getByRole("navigation", { name: "Primary navigation" }),
    ).toBeVisible();
  }
});
