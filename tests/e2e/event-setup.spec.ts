import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const settingsPath = "/app/ai-engineer-summit/settings";

async function openSettings(page: Page, state?: "new") {
  await page.goto(state ? `${settingsPath}?state=${state}` : settingsPath);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: state ? "New event" : "AI Engineer Summit",
    }),
  ).toBeVisible();
}

test("seed event is visibly ready with categorized, deep-linked prerequisites", async ({
  page,
}) => {
  await openSettings(page);

  await expect(page.getByText("Ready", { exact: true }).first()).toBeVisible();
  const checklist = page.getByRole("complementary", {
    name: "Ready to open",
  });
  await expect(
    checklist.getByRole("heading", { name: "Blocking" }),
  ).toBeVisible();
  await expect(
    checklist.getByRole("heading", { name: "Recommended" }),
  ).toBeVisible();
  await expect(
    checklist.getByRole("heading", { name: "Stretch" }),
  ).toBeVisible();
  await expect(
    checklist.getByRole("link", { name: /Event details/ }),
  ).toHaveAttribute("href", "#event-details");
  await expect(
    checklist.getByRole("link", { name: /Program structure/ }),
  ).toHaveAttribute("href", "#program-structure");
  await expect(
    page.getByText("August 12, 2026 at 11:59 PM PDT · America/Los_Angeles"),
  ).toBeVisible();

  const accessibilityScanResults = await new AxeBuilder({ page })
    .include(".event-setup-page")
    .analyze();
  expect(accessibilityScanResults.violations).toEqual([]);
});

test("organizer can reorder structure and invalid windows or durations are rejected", async ({
  page,
}) => {
  await openSettings(page);

  const trackNames = page.locator("#tracks-settings").getByLabel("Track name");
  await expect(trackNames).toHaveCount(4);
  await page.getByRole("button", { name: "Move Product up" }).click();
  await expect(trackNames.nth(2)).toHaveValue("Product");
  await expect(trackNames.nth(3)).toHaveValue("Infrastructure");

  await page.getByLabel("Default session duration").fill("32");
  await page.getByLabel("CFP closes").fill("2026-08-18T10:00");
  await page.getByRole("button", { name: "Save setup" }).click();
  const summary = page.getByRole("heading", {
    name: /setup problems need attention/,
  });
  await expect(summary).toBeVisible();
  await expect(page.locator("#default-duration-error")).toHaveText(
    "Default duration must be 5–480 minutes in 5-minute increments.",
  );
  await expect(page.locator("#cfp-closes-error")).toHaveText(
    "CFP must close before the event begins.",
  );

  await page.getByLabel("Default session duration").fill("35");
  await page.getByLabel("CFP closes").fill("2026-08-12T23:59");
  await page.getByLabel("Event timezone").fill("UTC");
  await expect(
    page.getByText("August 12, 2026 at 11:59 PM UTC · UTC"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save setup" }).click();
  await expect(page.locator(".ui-toast")).toContainText("Event setup saved");
});

test("new event explains each missing blocking prerequisite", async ({
  page,
}) => {
  await openSettings(page, "new");

  await expect(page.getByText("5 blockers", { exact: true })).toBeVisible();
  const checklist = page.getByRole("complementary", {
    name: "Setup checklist",
  });
  for (const failure of [
    "Add a valid name, slug, timezone, start, and end.",
    "Set an opening time and a later closing time before the event starts.",
    "Add at least one uniquely named track, room with capacity, and valid format.",
    "Set a 5-minute-aligned default duration and a submission limit from 1 to 20.",
    "Add the monitored inbox applicants should reply to.",
  ]) {
    await expect(checklist.getByText(failure)).toBeVisible();
  }

  await page.getByRole("button", { name: "Save setup" }).click();
  await expect(
    page.getByRole("heading", { name: /setup problems need attention/ }),
  ).toBeVisible();
  await expect(page.getByLabel("Event name")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
});

test("clone produces a configuration-only draft and names every excluded data class", async ({
  page,
}) => {
  await openSettings(page);
  await page.getByRole("button", { name: "Clone event" }).click();

  const dialog = page.getByRole("dialog", {
    name: "Clone event configuration",
  });
  await expect(dialog).toContainText("Submissions or participants");
  await expect(dialog).toContainText("Users, roles, or invitations");
  await expect(dialog).toContainText("Secrets or external mappings");
  await dialog.getByLabel("New event name").fill("Open Models Europe");
  await dialog.getByLabel("New public slug").fill("open-models-europe");
  await dialog.getByRole("button", { name: "Create clone draft" }).click();

  await expect(
    page.getByRole("heading", { level: 1, name: "Open Models Europe" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Clone status" }),
  ).toContainText(
    "Submissions, users, secrets, and external mappings were not included.",
  );
  await expect(
    page.locator("#tracks-settings").getByLabel("Track name"),
  ).toHaveCount(4);
  await expect(
    page.locator("#rooms-settings").getByLabel("Room name"),
  ).toHaveCount(3);
  await expect(
    page.locator("#formats-settings").getByLabel("Format name"),
  ).toHaveCount(3);
});

test("setup remains usable and free of horizontal overflow at 360px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await openSettings(page);

  await expect(page.getByRole("button", { name: "Save setup" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Program structure" }),
  ).toBeVisible();
  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);

  const accessibilityScanResults = await new AxeBuilder({ page })
    .include(".event-setup-page")
    .analyze();
  expect(accessibilityScanResults.violations).toEqual([]);
});
