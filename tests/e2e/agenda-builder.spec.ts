import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const agendaPath = "/app/ai-engineer-summit/agenda";

test("agenda route exposes searchable rail and room grid", async ({ page }) => {
  await page.goto(agendaPath);

  await expect(
    page.getByRole("heading", { name: "Build the room, minute by minute." }),
  ).toBeVisible();
  await expect(page.locator(".agenda-unscheduled-card")).toHaveCount(4);
  await expect(page.locator(".agenda-scheduled-card")).toHaveCount(4);
  const mobileMenu = page.getByRole("button", { name: "Open navigation" });
  if (await mobileMenu.isVisible()) {
    await mobileMenu.click();
  }
  await expect(page.getByRole("link", { name: "Agenda" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  if (await mobileMenu.isVisible()) {
    await page.getByRole("button", { name: "Close Event navigation" }).click();
  }
  await expect(page.getByText("Speaker conflict")).toBeVisible();

  const results = await new AxeBuilder({ page })
    .include(".agenda-page")
    .analyze();
  expect(results.violations).toEqual([]);
});

test("keyboard schedule form places a session with equivalent details", async ({
  page,
}) => {
  await page.goto(agendaPath);
  const session = page
    .locator(".agenda-unscheduled-card")
    .filter({ hasText: "Your Eval Suite Is Lying to You" });
  await session.getByRole("button", { name: "Schedule…" }).click();

  const dialog = page.getByRole("dialog", {
    name: "Schedule “Your Eval Suite Is Lying to You”",
  });
  await expect(dialog.getByLabel("Day")).toBeVisible();
  await dialog.getByLabel("Start time").selectOption("11:30 AM");
  await dialog.getByLabel("Room").selectOption("gallery");
  await dialog.getByRole("button", { name: "Schedule session" }).click();

  await expect(page.locator(".agenda-unscheduled-card")).toHaveCount(3);
  await expect(page.locator(".ui-toast")).toContainText("Session scheduled");
  await expect(
    page.locator(".agenda-room-track[data-room='gallery']"),
  ).toContainText("Your Eval Suite Is Lying to You");
});

test("drag placement exposes room and time feedback before the same save dialog", async ({
  page,
}) => {
  await page.goto(agendaPath);
  const session = page
    .locator(".agenda-unscheduled-card")
    .filter({ hasText: "Your Eval Suite Is Lying to You" });
  const target = page.locator(
    '.agenda-drop-slot[data-room="gallery"][data-slot="8"]',
  );

  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await session.dispatchEvent("dragstart", { dataTransfer });
  await target.dispatchEvent("dragenter", { dataTransfer });
  await target.dispatchEvent("dragover", { dataTransfer });
  await target.dispatchEvent("drop", { dataTransfer });
  await session.dispatchEvent("dragend", { dataTransfer });

  const dialog = page.getByRole("dialog", {
    name: "Schedule “Your Eval Suite Is Lying to You”",
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Start time")).toHaveValue("12:30 PM");
  await expect(dialog.getByLabel("Room")).toHaveValue("gallery");
  await dialog.getByRole("button", { name: "Schedule session" }).click();
  await expect(
    page.locator(".agenda-room-track[data-room='gallery']"),
  ).toContainText("Your Eval Suite Is Lying to You");
});

test("Escape cancels an active drag target", async ({ page }) => {
  await page.goto(agendaPath);
  const session = page
    .locator(".agenda-unscheduled-card")
    .filter({ hasText: "Your Eval Suite Is Lying to You" });
  const target = page.locator(
    '.agenda-drop-slot[data-room="gallery"][data-slot="8"]',
  );

  await session.evaluate((element, targetSelector) => {
    const dataTransfer = new DataTransfer();
    element.dispatchEvent(
      new DragEvent("dragstart", { bubbles: true, dataTransfer }),
    );
    document
      .querySelector(targetSelector)
      ?.dispatchEvent(
        new DragEvent("dragenter", { bubbles: true, dataTransfer }),
      );
  }, '.agenda-drop-slot[data-room="gallery"][data-slot="8"]');
  await expect(target).toHaveClass(/is-active/);
  await page.keyboard.press("Escape");
  await expect(target).not.toHaveClass(/is-active/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("failed placement restores the attempted values and focus", async ({
  page,
}) => {
  await page.goto("/fixtures/agenda/placement-failed");
  const session = page
    .locator(".agenda-unscheduled-card")
    .filter({ hasText: "Your Eval Suite Is Lying to You" });
  await session.getByRole("button", { name: "Schedule…" }).click();

  const dialog = page.getByRole("dialog", {
    name: "Schedule “Your Eval Suite Is Lying to You”",
  });
  await dialog.getByLabel("Day").selectOption("wednesday");
  await dialog.getByLabel("Start time").selectOption("12:30 PM");
  await dialog.getByLabel("Room").selectOption("firehouse");
  await dialog.getByRole("button", { name: "Schedule session" }).click();

  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("alert")).toContainText(
    "Your day, time, room, and duration are preserved",
  );
  await expect(dialog.getByLabel("Day")).toHaveValue("wednesday");
  await expect(dialog.getByLabel("Start time")).toHaveValue("12:30 PM");
  await expect(dialog.getByLabel("Room")).toHaveValue("firehouse");
  await expect(page.locator(".agenda-unscheduled-card")).toHaveCount(4);
  expect(
    await dialog.evaluate((element) =>
      element.contains(document.activeElement),
    ),
  ).toBe(true);
});

test("selected agenda day controls where a placement appears", async ({
  page,
}) => {
  await page.goto(agendaPath);
  const session = page
    .locator(".agenda-unscheduled-card")
    .filter({ hasText: "Your Eval Suite Is Lying to You" });
  await session.getByRole("button", { name: "Schedule…" }).click();

  const dialog = page.getByRole("dialog", {
    name: "Schedule “Your Eval Suite Is Lying to You”",
  });
  await dialog.getByLabel("Day").selectOption("wednesday");
  await dialog.getByRole("button", { name: "Schedule session" }).click();

  await expect(
    page.getByText("Wednesday, August 19", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".agenda-scheduled-card")).toHaveCount(1);
  await expect(page.locator(".agenda-grid-panel")).toContainText(
    "Your Eval Suite Is Lying to You",
  );

  await page
    .locator(".agenda-days")
    .getByRole("button", { name: /Tue Aug 18/ })
    .click();
  await expect(page.locator(".agenda-scheduled-card")).toHaveCount(4);
  await expect(page.locator(".agenda-grid-panel")).not.toContainText(
    "Your Eval Suite Is Lying to You",
  );
});

test("conflict and publish previews explain blockers", async ({ page }) => {
  await page.goto(agendaPath);
  await page.getByRole("button", { name: "1 hard conflict" }).click();
  const conflicts = page.getByRole("dialog", { name: "Agenda conflicts" });
  await expect(conflicts).toContainText("Ren Ito is scheduled twice");
  await conflicts
    .getByRole("button", { name: "Close Agenda conflicts" })
    .click();

  await page.getByRole("button", { name: "Preview publish" }).click();
  const publish = page.getByRole("dialog", { name: "Publish agenda preview" });
  await expect(publish).toContainText("Not ready");
  await expect(
    publish.getByRole("button", { name: "Publish version 3" }),
  ).toBeDisabled();
});

test("narrow agenda freezes page width while grid scrolls independently", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(agendaPath);

  await expect(
    page.getByRole("heading", { name: "Unscheduled" }),
  ).toBeVisible();
  const pageWidths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(pageWidths.scroll).toBeLessThanOrEqual(pageWidths.client + 1);

  const gridWidths = await page
    .locator(".agenda-grid-scroll")
    .evaluate((element) => ({
      client: element.clientWidth,
      scroll: element.scrollWidth,
    }));
  expect(gridWidths.scroll).toBeGreaterThan(gridWidths.client);

  const results = await new AxeBuilder({ page })
    .include(".agenda-page")
    .analyze();
  expect(results.violations).toEqual([]);
});
