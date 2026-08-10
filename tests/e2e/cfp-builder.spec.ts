import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const builderPath = "/app/ai-engineer-summit/cfp";
const storageKey = "opensession.cfp-builder.visual-draft";

async function openFreshBuilder(page: Page) {
  await page.goto(builderPath);
  await page.evaluate((key) => {
    window.localStorage.removeItem(key);
  }, storageKey);
  await page.reload();
}

test("CFP route exposes the complete visual builder", async ({ page }) => {
  await openFreshBuilder(page);

  await expect(
    page.getByRole("heading", { name: "Call for proposals", level: 1 }),
  ).toBeVisible();
  const mobileMenu = page.getByRole("button", { name: "Open navigation" });
  if (await mobileMenu.isVisible()) {
    await mobileMenu.click();
  }
  await expect(page.getByRole("link", { name: "CFP" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  if (await mobileMenu.isVisible()) {
    await page.getByRole("button", { name: "Close Event navigation" }).click();
  }
  await expect(page.locator(".cfp-palette-list > button")).toHaveCount(7);
  await expect(page.locator(".cfp-canvas-block")).toHaveCount(6);
  await expect(page.getByLabel("Label")).toHaveValue("Session title");

  const accessibilityScanResults = await new AxeBuilder({ page })
    .include(".cfp-builder-page")
    .analyze();
  expect(accessibilityScanResults.violations).toEqual([]);
});

test("field edits, insertion, reorder, and local recovery work", async ({
  page,
}) => {
  await openFreshBuilder(page);

  await page.getByLabel("Label").fill("A title people remember");
  await page.getByRole("button", { name: "File upload" }).click();
  await expect(page.locator(".cfp-canvas-block")).toHaveCount(7);
  await expect(page.getByLabel("Stable key")).toHaveValue("file_7");

  await page.getByRole("button", { name: "Move File upload up" }).click();
  await expect(page.getByRole("status")).toContainText(/Unsaved|Saving|Saved/);
  await expect(page.getByText("Saved locally")).toBeVisible();

  await page.reload();
  await expect(
    page.getByRole("button", { name: "Edit A title people remember" }),
  ).toBeVisible();
  await expect(page.locator(".cfp-canvas-block")).toHaveCount(7);

  await page.evaluate((key) => {
    window.localStorage.setItem(
      key,
      JSON.stringify([{ rules: "invalid-untrusted-shape" }]),
    );
  }, storageKey);
  await page.reload();
  await expect(page.locator(".cfp-canvas-block")).toHaveCount(6);
  await expect(
    page.getByRole("button", { name: "Edit Session title" }),
  ).toBeVisible();
});

test("preview and publishing explain version impact", async ({ page }) => {
  await openFreshBuilder(page);

  await page.getByRole("button", { name: "Preview" }).click();
  const preview = page.getByRole("dialog", { name: "Preview application" });
  await expect(preview).toBeVisible();
  await preview.getByRole("button", { name: "Mobile" }).click();
  await expect(preview.locator(".cfp-public-preview")).toHaveClass(/is-mobile/);
  await preview
    .getByRole("button", { name: "Close Preview application" })
    .click();

  await page.getByLabel("Label").fill("Release-safe session title");
  await expect(page.getByRole("status")).toContainText("Unsaved changes");
  await page.getByRole("button", { name: "Publish changes" }).click();
  const publish = page.getByRole("dialog", { name: "Publish version 2?" });
  await expect(publish).toContainText("Existing version 1 drafts");
  await expect(publish).toContainText(
    "opensession.dev/e/ai-engineer-summit/cfp",
  );
  await publish
    .getByRole("button", { name: "Publish version 2", exact: true })
    .click();
  await expect(page.locator(".ui-toast")).toContainText("CFP published");
  await expect(page.getByText("Published", { exact: true })).toBeVisible();

  await page.reload();
  await expect(
    page.getByRole("button", { name: "Edit Release-safe session title" }),
  ).toBeVisible();
});

test("conditional rule builder and preview share Workshop evaluation", async ({
  page,
}) => {
  await openFreshBuilder(page);

  await page
    .getByRole("button", { name: "Edit Workshop prerequisites" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Conditional logic" }),
  ).toBeVisible();
  await expect(page.getByText("Rule 1", { exact: true })).toBeVisible();
  await expect(page.getByText("Rule 2", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Action").nth(0)).toHaveValue("show");
  await expect(page.getByLabel("Action").nth(1)).toHaveValue("require");
  await expect(page.getByLabel("Earlier choice field").nth(0)).toHaveValue(
    "session_format",
  );

  await page.getByRole("button", { name: "Preview" }).click();
  const preview = page.getByRole("dialog", { name: "Preview application" });
  await expect(preview.getByLabel("Workshop prerequisites")).toHaveCount(0);
  await preview.getByLabel("Session format").selectOption("Workshop");
  await expect(preview.getByLabel("Workshop prerequisites")).toBeVisible();
  await expect(preview.getByLabel("Workshop prerequisites")).toHaveAttribute(
    "required",
  );
  await preview
    .getByLabel("Workshop prerequisites")
    .fill("Install Node.js and clone the exercise repository.");
  await preview.getByLabel("Session format").selectOption("Talk");
  await expect(preview.getByLabel("Workshop prerequisites")).toHaveCount(0);
  await preview.getByLabel("Session format").selectOption("Workshop");
  await expect(preview.getByLabel("Workshop prerequisites")).toHaveValue("");
});

test("deleted conditional references block publication with a precise repair", async ({
  page,
}) => {
  await openFreshBuilder(page);

  await page.getByRole("button", { name: "Delete Session format" }).click();
  await page.getByRole("button", { name: "Publish changes" }).click();
  const publish = page.getByRole("dialog", { name: "Publish version 2?" });
  await expect(publish).toContainText(
    "references deleted field “session_format”",
  );
  await expect(
    publish.getByRole("button", { name: "Publish version 2", exact: true }),
  ).toBeDisabled();
});

test("builder remains operable without horizontal page overflow at 360px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await openFreshBuilder(page);

  await expect(
    page.getByRole("heading", { name: "Field palette" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Application canvas" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Edit field" })).toBeVisible();

  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);

  const accessibilityScanResults = await new AxeBuilder({ page })
    .include(".cfp-builder-page")
    .analyze();
  expect(accessibilityScanResults.violations).toEqual([]);
});
