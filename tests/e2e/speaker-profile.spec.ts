import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { mockPortalAuth } from "./portal-auth";

const profilePath = "/fixtures/portal/profile";

test.beforeEach(async ({ page }) => mockPortalAuth(page));

test("speaker profile exposes reusable fields and an unpublished public preview", async ({
  page,
}) => {
  await page.goto(profilePath);

  await expect(
    page.getByRole("heading", {
      name: "Shape how the audience meets you.",
      level: 1,
    }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Profile" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByText("Unpublished draft")).toBeVisible();

  const preview = page.locator(".public-speaker-preview");
  await expect(preview).toContainText("Mina Okafor");
  await expect(preview).toContainText("VP, AI Reliability · Northstar Labs");
  await expect(preview).not.toContainText("readiness");
  await expect(preview).not.toContainText("tasks");

  await page.getByRole("button", { name: "Full profile" }).click();
  await expect(preview).toContainText("Mina builds reliability systems");
  await expect(preview.getByRole("link", { name: /LinkedIn/ })).toBeVisible();

  const results = await new AxeBuilder({ page })
    .include(".speaker-profile-main")
    .analyze();
  expect(results.violations).toEqual([]);
});

test("invalid social URLs are rejected and never enter the public preview", async ({
  page,
}) => {
  await page.goto(profilePath);
  await page.getByRole("button", { name: "Full profile" }).click();

  await page.getByLabel("LinkedIn URL").fill("https://example.com/mina");
  await expect(page.getByText("Use a linkedin.com profile URL.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save now" })).toBeDisabled();
  await expect(
    page.locator(".public-speaker-preview").getByRole("link", {
      name: /LinkedIn/,
    }),
  ).toHaveCount(0);

  await page.getByLabel("Website URL").fill("javascript:alert(1)");
  await expect(
    page.getByText("Enter a complete http:// or https:// URL."),
  ).toBeVisible();
  await expect(
    page.locator(".public-speaker-preview").getByRole("link", {
      name: /Website/,
    }),
  ).toHaveCount(0);
});

test("autosave makes pending and saved states explicit and records an audit entry", async ({
  page,
}) => {
  await page.goto(profilePath);

  await page.getByLabel("Display name").fill("Mina N. Okafor");
  await expect(page.getByRole("status")).toContainText("Unsaved changes");
  await expect(
    page.locator(".public-speaker-preview").getByRole("heading", {
      name: "Mina N. Okafor",
    }),
  ).toBeVisible();

  await expect(page.getByRole("status")).toContainText("All changes saved", {
    timeout: 3_000,
  });
  await expect(page.getByRole("status")).toContainText("Saved just now");
  await expect(
    page.getByText("Profile autosaved · Mina Okafor · Just now"),
  ).toBeVisible();
});

test("manual save remains available when autosave is disabled", async ({
  page,
}) => {
  await page.goto(profilePath);

  await page.getByRole("switch", { name: "Autosave profile" }).click();
  await page.getByLabel("Company or organization").fill("Northstar Research");
  await expect(page.getByRole("status")).toContainText("Unsaved changes");
  await page.waitForTimeout(1_100);
  await expect(page.getByRole("status")).toContainText("Unsaved changes");

  await page.getByRole("button", { name: "Save now" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Profile saved" }),
  ).toContainText("attendee preview remains unpublished");
  await expect(
    page.getByText("Profile saved · Mina Okafor · Just now"),
  ).toBeVisible();
});

test("headshot replacement validates files, processes a private preview, and keeps alt semantics", async ({
  page,
}) => {
  await page.goto(profilePath);
  const input = page.getByLabel("Replace headshot");

  await input.setInputFiles({
    buffer: Buffer.from("not an image"),
    mimeType: "text/plain",
    name: "notes.txt",
  });
  await expect(page.locator(".profile-headshot-error")).toHaveText(
    "Choose a JPG, PNG, or WebP image.",
  );

  const pngBase64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 1200;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable");
    context.fillStyle = "#d97859";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#15201c";
    context.font = "bold 320px sans-serif";
    context.fillText("MO", 330, 720);
    return canvas.toDataURL("image/png").split(",")[1] ?? "";
  });

  await input.setInputFiles({
    buffer: Buffer.from(pngBase64, "base64"),
    mimeType: "image/png",
    name: "mina-updated.png",
  });
  await expect(page.getByText("mina-updated.png")).toBeVisible();
  await expect(
    page.locator(".profile-headshot-copy").getByText("Ready"),
  ).toBeVisible({ timeout: 2_000 });

  await page
    .getByLabel("Headshot alt text")
    .fill("Mina Okafor in front of a coral background");
  await expect(page.locator(".public-speaker-preview img")).toHaveAttribute(
    "alt",
    "Mina Okafor in front of a coral background",
  );
});

test("speaker profile remains accessible and contained at 360px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(profilePath);

  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);
  await expect(
    page.getByRole("switch", { name: "Autosave profile" }),
  ).toBeVisible();
  await expect(
    page.getByText("Reusable identity, event-private operations"),
  ).toBeVisible();

  const results = await new AxeBuilder({ page })
    .include(".speaker-profile-main")
    .analyze();
  expect(results.violations).toEqual([]);
});
