import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const readinessPath = "/app/ai-engineer-summit/people";
const readinessFixturePath = "/fixtures/readiness/default";

async function mockProductionReadiness(page: Page) {
  await page.route("**/api/events/*/readiness?**", async (route) => {
    const url = new URL(route.request().url());
    const hidden =
      url.searchParams.get("portal") === "invited" ||
      url.searchParams.get("task") === "task_agreement";
    const speaker = {
      company: "Daybreak Labs",
      contact_id: "speaker_mina",
      display_name: "Mina Okafor",
      email: "mina@example.com",
      portal_state: "active",
      readiness: {
        configuration: "configured",
        explanation:
          "Three of four required tasks are complete; one overdue task remains.",
        next_due: {
          at: "2026-08-10T19:00:00.000Z",
          local_date: "2026-08-10",
          local_time: "12:00",
          timezone: "America/Los_Angeles",
        },
        outstanding_count: 1,
        overdue_count: 1,
        ratio: { complete: 3, percent: 75, total: 4 },
        status: "overdue",
      },
      sessions: [
        {
          id: "session_reliability",
          title: "The Reliability Gap in Production Agents",
          track: { id: "track_ai", name: "AI Engineering" },
        },
      ],
      task_definition_ids: ["task_headshot"],
    } as const;
    await route.fulfill({
      body: JSON.stringify({
        attention: [speaker],
        event: {
          id: "event_summit",
          name: "AI Engineer Summit",
          slug: "ai-engineer-summit",
          timezone: "America/Los_Angeles",
        },
        filters: {
          tasks: [
            { id: "task_headshot", name: "Headshot" },
            { id: "task_agreement", name: "Agreement" },
          ],
          tracks: [{ id: "track_ai", name: "AI Engineering" }],
        },
        generated_at: "2026-08-11T14:00:00.000Z",
        metrics: {
          accepted_unscheduled: 2,
          hard_conflicts: 1,
          new_submissions: 4,
          overdue_assignments: 1,
          reviews_remaining: 8,
          speakers_ready: 3,
          speakers_total: 8,
        },
        page: {
          number: Number(url.searchParams.get("page") ?? "1"),
          size: 25,
          total: hidden ? 0 : 1,
          total_pages: hidden ? 0 : 1,
        },
        projection: {
          as_of: "2026-08-11T13:59:42.000Z",
          pending_repairs: 0,
          reasons: [],
          state: "current",
        },
        speakers: hidden ? [] : [speaker],
      }),
      contentType: "application/json",
      status: 200,
    });
  });
}

test("readiness route exposes drillable metrics and explicit speaker policy", async ({
  page,
}) => {
  await page.goto(readinessFixturePath);

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

  const results = await new AxeBuilder({ page })
    .include(".readiness-page")
    .analyze();
  expect(results.violations).toEqual([]);
});

test("readiness filters persist in the URL and narrow the speaker table", async ({
  page,
}) => {
  await page.goto(
    `${readinessFixturePath}?filter=overdue&track=AI%20Engineering&portal=active&q=mina`,
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
  await expect(page).toHaveURL(/readiness=ready/);
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

test("submission stays outstanding until the final required approval", async ({
  page,
}) => {
  await page.goto(`${readinessFixturePath}?filter=overdue`);

  await page.getByRole("button", { name: "Submit as speaker" }).click();
  await expect(page.locator(".ui-toast")).toContainText("Headshot submitted");
  await expect(page.getByText("awaiting required approval")).toBeVisible();
  await expect(
    page.locator(".readiness-metric").filter({ hasText: "Speakers ready" }),
  ).toContainText("3 / 8");
  await expect(
    page.locator(".readiness-metric").filter({
      hasText: "Overdue assignments",
    }),
  ).toContainText("3");
  await expect(page.locator(".ui-table tbody tr")).toHaveCount(2);

  await page.getByRole("button", { name: "Approve as organizer" }).click();
  await expect(page.locator(".ui-toast")).toContainText(
    "Final approval recorded",
  );
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
  await mockProductionReadiness(page);
  for (const state of ["lag", "partial"]) {
    await page.goto(`${readinessPath}?state=${state}`);
    await expect(page.getByText("Metrics are current")).toBeVisible();
    await expect(page.getByText("Read model is catching up")).toHaveCount(0);
    await expect(
      page.getByText("Some readiness sources are unavailable"),
    ).toHaveCount(0);
  }
});

test("production readiness consumes server filters and indexed page results", async ({
  page,
}) => {
  await mockProductionReadiness(page);
  await page.goto(readinessPath);

  await expect(
    page.getByRole("heading", { name: "Readiness you can act on." }),
  ).toBeVisible();
  await expect(page.locator(".ui-table tbody tr")).toHaveCount(1);
  await expect(page.getByLabel("Track")).toHaveValue("all");
  await expect(page.getByLabel("Task")).toHaveValue("all");
  await expect(page.getByText("Projected Aug 11, 2026")).toBeVisible();

  await page.getByLabel("Task").selectOption("task_agreement");
  await expect(page).toHaveURL(/task=task_agreement/);
  await expect(page.locator(".ui-table tbody tr")).toHaveCount(0);

  await page.getByLabel("Task").selectOption("all");
  await page.getByLabel("Portal").selectOption("invited");
  await expect(page).toHaveURL(/portal=invited/);
  await expect(page.locator(".ui-table tbody tr")).toHaveCount(0);
});
