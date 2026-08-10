import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const readinessPath = "/app/ai-engineer-summit/people";

test("readiness route exposes drillable metrics and explicit speaker policy", async ({
  page,
}) => {
  await page.goto(readinessPath);

  await expect(
    page.getByRole("heading", { name: "Readiness you can act on." }),
  ).toBeVisible();
  await expect(page.locator(".readiness-metric")).toHaveCount(6);
  await expect(
    page.locator(".readiness-metric").filter({ hasText: "Speakers ready" }),
  ).toContainText("3 / 8");
  await expect(
    page.getByText("Speakers with zero required tasks stay not configured"),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Contact Mina Okafor" }),
  ).toHaveAttribute("href", /mailto:mina@example\.com/);

  const mobileMenu = page.getByRole("button", { name: "Open navigation" });
  if (await mobileMenu.isVisible()) {
    await mobileMenu.click();
  }
  await expect(page.getByRole("link", { name: "People" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  if (await mobileMenu.isVisible()) {
    await page.getByRole("button", { name: "Close Event navigation" }).click();
  }

  const results = await new AxeBuilder({ page })
    .include(".readiness-page")
    .analyze();
  expect(results.violations).toEqual([]);
});

test("readiness filters persist in the URL and narrow the speaker table", async ({
  page,
}) => {
  await page.goto(
    `${readinessPath}?filter=overdue&track=AI%20Engineering&portal=active&q=mina`,
  );

  await expect(page.getByLabel("Readiness", { exact: true })).toHaveValue(
    "overdue",
  );
  await expect(page.getByLabel("Track")).toHaveValue("AI Engineering");
  await expect(page.getByLabel("Portal")).toHaveValue("active");
  await expect(page.getByRole("textbox", { name: "Search" })).toHaveValue(
    "mina",
  );
  await expect(page.locator(".ui-table tbody tr")).toHaveCount(1);
  await expect(page.locator(".ui-table")).toContainText("Mina Okafor");

  await page.getByLabel("Track").selectOption("all");
  await page.getByLabel("Portal").selectOption("all");
  await page.getByRole("textbox", { name: "Search" }).fill("");
  await page.getByLabel("Readiness", { exact: true }).selectOption("ready");
  await expect(page).toHaveURL(/filter=ready/);
  await expect(page).not.toHaveURL(/(?:track|portal|q)=/);
  await expect(page.locator(".ui-table tbody tr")).toHaveCount(3);
  await expect(page.locator(".ui-table")).not.toContainText("Alex Chen");

  await page
    .getByLabel("Readiness", { exact: true })
    .selectOption("not_configured");
  await expect(page.locator(".ui-table tbody tr")).toHaveCount(1);
  await expect(page.locator(".ui-table")).toContainText("Alex Chen");
  await expect(page.locator(".ui-table")).toContainText(
    "No required tasks assigned",
  );
});

test("priority action updates exact metrics and the filtered projection immediately", async ({
  page,
}) => {
  await page.goto(`${readinessPath}?filter=overdue`);

  await page.getByRole("button", { name: "Mark received" }).click();
  await expect(page.locator(".ui-toast")).toContainText("Headshot approved");
  await expect(
    page.locator(".readiness-metric").filter({ hasText: "Speakers ready" }),
  ).toContainText("4 / 8");
  await expect(
    page.locator(".readiness-metric").filter({
      hasText: "Overdue assignments",
    }),
  ).toContainText("2");
  await expect(page.locator(".ui-table tbody tr")).toHaveCount(1);
  await expect(page.getByText("Approved just now")).toBeVisible();
});

test("fixture-only projection lag and narrow layouts remain legible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/fixtures/readiness/lag");

  await expect(page.getByText("Read model is catching up")).toBeVisible();
  await expect(page.locator(".readiness-metric")).toHaveCount(6);

  const pageWidths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(pageWidths.scroll).toBeLessThanOrEqual(pageWidths.client + 1);

  const results = await new AxeBuilder({ page })
    .include(".readiness-page")
    .analyze();
  expect(results.violations).toEqual([]);
});

test("partial projection state retains last complete data with an explicit warning", async ({
  page,
}) => {
  await page.goto("/fixtures/readiness/partial");

  await expect(
    page.getByText("Some readiness sources are unavailable"),
  ).toBeVisible();
  await expect(page.getByText("Counts are not live")).toBeVisible();
  await expect(page.locator(".readiness-metric")).toHaveCount(6);
});

test("production readiness URLs ignore fixture query state", async ({
  page,
}) => {
  for (const state of ["lag", "partial"]) {
    await page.goto(`${readinessPath}?state=${state}`);
    await expect(page.getByText("Metrics are current")).toBeVisible();
    await expect(page.getByText("Read model is catching up")).toHaveCount(0);
    await expect(
      page.getByText("Some readiness sources are unavailable"),
    ).toHaveCount(0);
  }
});
