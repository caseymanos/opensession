import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const fixturePath = "/fixtures/campaigns/default";

test("organizer confirms the exact audience snapshot before queueing", async ({
  page,
}) => {
  await page.goto(fixturePath);

  await expect(
    page.getByRole("heading", {
      name: "Know exactly who receives every message.",
    }),
  ).toBeVisible();
  await expect(page.getByText("Preview allowlist mode")).toBeVisible();
  await expect(page.getByLabel("Template version")).toBeVisible();
  await page.getByRole("button", { name: "Preview exact audience" }).click();

  const dialog = page.getByRole("dialog", {
    name: "Confirm campaign snapshot",
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("18", { exact: true })).toBeVisible();
  await expect(dialog.getByText("5", { exact: true })).toBeVisible();
  await expect(
    dialog.getByText("role mismatch", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText("manual", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Mina Okafor")).toBeVisible();
  await expect(dialog.locator(".campaign-samples li")).toHaveCount(5);
  await expect(dialog).toContainText("OpenSession Program Team");

  await dialog.getByRole("button", { name: "Queue 18 messages" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "response was lost. Retry to recover the same command",
  );
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Queue 18 messages" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText(
    "18 messages are durably queued",
  );
  await expect(page.locator(".campaign-card")).toHaveCount(2);
});

test("@judge @judge-e2e-05 redacted delivery evidence replays one failure without exposing recipients", async ({
  page,
}) => {
  await page.goto(fixturePath);
  await page
    .locator(".campaign-card")
    .filter({ hasText: "Submission receipt" })
    .getByRole("button", { name: "View delivery log" })
    .click();

  const dialog = page.getByRole("dialog", { name: "Redacted delivery log" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(`email_${"2".repeat(64)}`);
  await expect(dialog).toContainText("retry_exhausted");
  await expect(dialog).not.toContainText("@allowlist.example.test");
  await dialog.getByRole("button", { name: "Replay failed message" }).click();
  await expect(
    dialog.getByRole("button", { name: "Replay failed message" }),
  ).toHaveCount(0);
  await expect(dialog).toContainText("queued");
  await expect(page.getByRole("status")).toContainText(
    "1 failed message queued",
  );
});

test("campaign workspace is accessible on desktop and mobile", async ({
  page,
}) => {
  await page.goto(fixturePath);
  await expect(page.locator(".campaign-page")).toBeVisible();
  let results = await new AxeBuilder({ page })
    .include(".campaign-page")
    .analyze();
  expect(results.violations).toEqual([]);

  await page.setViewportSize({ width: 360, height: 800 });
  await page.reload();
  await expect(page.locator(".campaign-page")).toBeVisible();
  await page.getByRole("button", { name: "Preview exact audience" }).click();
  await expect(
    page.getByRole("dialog", { name: "Confirm campaign snapshot" }),
  ).toBeVisible();
  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);
  results = await new AxeBuilder({ page }).include(".campaign-page").analyze();
  expect(results.violations).toEqual([]);
});
