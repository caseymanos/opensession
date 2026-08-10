import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const decisionsPath = "/app/ai-engineer-summit/decisions";

test("decision workspace exposes transparent aggregate and queue state", async ({
  page,
}) => {
  await page.goto(decisionsPath);

  await expect(
    page.getByRole("heading", {
      name: "Make the call. Keep the evidence.",
      level: 1,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Missing scores are never zero-filled"),
  ).toBeVisible();
  await expect(page.getByRole("table")).toContainText("4.38");
  await expect(page.getByRole("table")).toContainText("2 of 3 applicable");
  await expect(page.getByRole("table")).toContainText("1 missing · excluded");
  await expect(page.getByRole("table")).toContainText("1 conflict removed");

  const results = await new AxeBuilder({ page })
    .include(".decision-workspace")
    .analyze();
  expect(results.violations).toEqual([]);
});

test("evidence detail shows correct math, range, raw reviews, missing work, and conflict", async ({
  page,
}) => {
  await page.goto(decisionsPath);
  await page
    .getByRole("button", { name: "Inspect review evidence for AES-1042" })
    .click();

  const drawer = page.getByRole("dialog", {
    name: "Evidence and decision history",
  });
  await expect(drawer).toContainText("4.38");
  await expect(drawer).toContainText("2 submitted / 3 applicable");
  await expect(drawer.getByLabel("Aggregate equation")).toContainText(
    "(4.40 + 4.35) ÷ 2",
  );
  await expect(drawer).toContainText("Range 4.35–4.40");
  await expect(drawer).toContainText("Maya Singh");
  await expect(drawer).toContainText("Theo Martin");
  await expect(drawer).toContainText(
    "Review missing · excluded from aggregate",
  );
  await expect(drawer).toContainText(
    "Conflict removed · Prior advisory relationship with the speaker",
  );
  await expect(drawer).toContainText(
    "Missing reviews and conflicts are excluded",
  );
});

test("acceptance previews consequences, records without sending, and retries idempotently", async ({
  page,
}) => {
  await page.goto(decisionsPath);
  await page.getByRole("button", { name: "Accept AES-1042" }).click();

  const dialog = page.getByRole("dialog", {
    name: "Accept this proposal?",
  });
  await expect(dialog).toContainText("Consequence preview");
  await expect(dialog).toContainText("Primary speaker + 1 co-speaker");
  await expect(dialog).toContainText("Accept · AI Engineer Summit");
  await expect(dialog).toContainText("cannot add history or messages twice");
  await dialog.getByLabel("Decision reason").selectOption("Strong program fit");
  await dialog
    .getByLabel("Private program note")
    .fill("Anchor the reliability block with this session.");
  await dialog.getByLabel("Record without sending").check();
  await dialog.getByRole("button", { name: "Record accept" }).click();

  const drawer = page.getByRole("dialog", {
    name: "Evidence and decision history",
  });
  await expect(drawer).toContainText("Accepted");
  await expect(drawer).toContainText("Strong program fit");
  await expect(drawer).toContainText("Recorded without sending");
  await expect(drawer).toContainText(
    "Anchor the reliability block with this session.",
  );
  await expect(drawer.locator(".decision-history-card")).toHaveCount(1);

  await page.getByRole("button", { name: "Dismiss Decision recorded" }).click();
  await drawer
    .getByRole("button", { name: "Retry same command safely" })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "No duplicate created" }),
  ).toContainText("history and message side effects remain unchanged");
  await expect(drawer.locator(".decision-history-card")).toHaveCount(1);
});

test("filters narrow the queue and proposals without submitted reviews cannot be decided", async ({
  page,
}) => {
  await page.goto(decisionsPath);

  await page.getByLabel("Search proposals").fill("Beyond the Agent Demo");
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("No submitted score");
  await expect(
    page.getByRole("button", { name: "Accept AES-1192" }),
  ).toHaveCount(0);

  await page.getByLabel("Search proposals").fill("");
  await page.getByLabel("Decision", { exact: true }).selectOption("accepted");
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Designing Human Checkpoints That Scale");

  await page.getByLabel("Track").selectOption("Infrastructure");
  await expect(
    page.getByRole("heading", { name: "No proposals match" }),
  ).toBeVisible();
});

test("decision workspace remains usable at 360px without document overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(decisionsPath);

  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);
  await expect(
    page.getByText(
      "Scroll the table to compare aggregate, progress, and status.",
    ),
  ).toBeVisible();

  const tableWidths = await page
    .locator(".decision-table-wrap")
    .evaluate((element) => ({
      client: element.clientWidth,
      scroll: element.scrollWidth,
    }));
  expect(tableWidths.scroll).toBeGreaterThan(tableWidths.client);

  const results = await new AxeBuilder({ page })
    .include(".decision-workspace")
    .analyze();
  expect(results.violations).toEqual([]);
});
