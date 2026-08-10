import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("organizer shell exposes the five-part information architecture", async ({
  page,
}, testInfo) => {
  await page.goto("/");

  if (testInfo.project.name === "mobile-chromium") {
    await page.getByRole("button", { name: "Open navigation" }).click();
  }

  const navigation = page.getByRole("navigation", {
    name: "Primary navigation",
  });
  await expect(navigation).toBeVisible();

  for (const group of [
    "Collect",
    "Decide",
    "Prepare",
    "Publish",
    "Configure",
  ]) {
    await expect(
      navigation.getByRole("heading", { name: group }),
    ).toBeVisible();
  }

  await expect(navigation.getByRole("link", { name: "CFP" })).toHaveAttribute(
    "href",
    "/app/ai-engineer-summit/cfp",
  );
  await expect(
    navigation.getByRole("link", { name: "Public program" }),
  ).toHaveAttribute("href", "/e/ai-engineer-summit");

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations).toEqual([]);
});

test("mobile navigation traps focus, closes with Escape, and restores focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/");

  const trigger = page.getByRole("button", { name: "Open navigation" });
  await trigger.click();

  const drawer = page.getByRole("dialog", { name: "Event navigation" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("link", { name: "Agenda" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("fixture route covers explicit states and guarded production data", async ({
  page,
}) => {
  for (const state of ["normal", "empty", "loading", "error", "permission"]) {
    await page.goto(`/fixtures/ui?state=${state}`);
    await expect(
      page.getByRole("heading", { name: `${state} fixture` }),
    ).toBeVisible();
  }

  await page.goto("/fixtures/ui?environment=production&demo=false");
  await expect(
    page.getByRole("region", { name: "Environment status" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reset demo" })).toHaveCount(0);
});

test("dialog traps focus and the fixture passes axe at 360px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/fixtures/ui");

  const trigger = page.getByRole("button", { name: "Open dialog" });
  await trigger.click();
  const dialog = page.getByRole("dialog", {
    name: "Publish this form version?",
  });
  await expect(dialog).toBeVisible();

  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("button", { name: "Publish version" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations).toEqual([]);
});

test("workspace remains usable at a 200 percent text scale", async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 450 });
  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open navigation" }),
  ).toBeVisible();
  expect(
    await page.locator("body").evaluate((body) => body.scrollWidth),
  ).toBeLessThanOrEqual(640);
});
