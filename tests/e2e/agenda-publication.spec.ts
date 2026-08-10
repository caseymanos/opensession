import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const agendaPath = "/app/ai-engineer-summit/agenda";

test("agenda views and shareable filters stay encoded in the URL", async ({
  page,
}) => {
  await page.goto(
    "/fixtures/agenda/ready?view=week&day=wednesday&track=Evaluation&room=gallery",
  );

  await expect(
    page.getByRole("button", { name: "Week", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-view="week"]')).toBeVisible();
  await expect(page.locator(".agenda-view-context")).toContainText(
    "Both event days · Evaluation · Gallery 308",
  );

  await page.getByRole("button", { name: "Filters", exact: true }).click();
  const filters = page.getByRole("dialog", { name: "Agenda view options" });
  await expect(filters.getByLabel("Track")).toHaveValue("Evaluation");
  await expect(filters.getByLabel("Room")).toHaveValue("gallery");
  await filters.getByRole("button", { name: "Done" }).click();

  await page.getByRole("button", { name: "Track", exact: true }).click();
  await expect(page.locator('[data-view="track"]')).toBeVisible();
  const url = new URL(page.url());
  expect(url.searchParams.get("view")).toBe("track");
  expect(url.searchParams.get("day")).toBe("wednesday");
  expect(url.searchParams.get("track")).toBe("Evaluation");
  expect(url.searchParams.get("room")).toBe("gallery");
});

test("organizers can move among list, day, week, track, and room views", async ({
  page,
}) => {
  await page.goto("/fixtures/agenda/ready");

  await expect(page.locator(".agenda-grid-panel")).toBeVisible();
  for (const view of ["List", "Week", "Track", "Room"] as const) {
    await page.getByRole("button", { name: view, exact: true }).click();
    await expect(
      page.locator(`[data-view="${view.toLowerCase()}"]`),
    ).toBeVisible();
  }
  await page.getByRole("button", { name: "Day", exact: true }).click();
  await expect(page.locator(".agenda-grid-panel")).toBeVisible();
  expect(new URL(page.url()).searchParams.has("view")).toBe(false);
});

test("publish preview blocks an unsafe draft and versions a ready snapshot", async ({
  page,
}) => {
  await page.goto(agendaPath);
  await page.getByRole("button", { name: "Preview publish" }).click();
  let publish = page.getByRole("dialog", { name: "Publish agenda preview" });
  await expect(publish).toContainText("3 blocker categories need attention");
  await expect(
    publish.getByRole("button", { name: "Publish version 3" }),
  ).toBeDisabled();

  await page.goto("/fixtures/agenda/ready?view=list");
  await page.getByRole("button", { name: "Preview publish" }).click();
  publish = page.getByRole("dialog", { name: "Publish agenda preview" });
  await expect(publish).toContainText("Version 4 can go public");
  await publish.getByRole("button", { name: "Publish version 4" }).click();

  await expect(page.locator(".agenda-publication-state")).toContainText(
    "Public version 4",
  );
  await expect(page.locator(".ui-toast")).toContainText(
    "Agenda version 4 published",
  );
});

test("published session detail explains impact before rescheduling", async ({
  page,
}) => {
  await page.goto("/fixtures/agenda/published?view=list");
  await page
    .locator(".agenda-view-session")
    .filter({ hasText: "Opening & State of AI Engineering" })
    .click();

  const detail = page.getByRole("dialog", { name: "Session placement" });
  await expect(detail).toContainText("Included in public version 3");
  await detail.getByRole("button", { name: "Edit placement" }).click();

  const schedule = page.getByRole("dialog", {
    name: "Schedule “Opening & State of AI Engineering”",
  });
  await schedule.getByLabel("Start time").selectOption("9:30 AM");
  await schedule.getByRole("button", { name: "Schedule session" }).click();
  await expect(page.locator(".ui-toast")).toContainText(
    "Public version remains unchanged until you republish",
  );
  await expect(page.locator(".agenda-publication-state")).toContainText(
    "Draft changes after public version 3",
  );
});

test("placement edits preserve conflicts and await authoritative revalidation", async ({
  page,
}) => {
  await page.goto(agendaPath);
  await page
    .locator(".agenda-scheduled-card")
    .filter({ hasText: "The Agent Runtime Is the Product" })
    .click();

  const detail = page.getByRole("dialog", { name: "Session placement" });
  await detail.getByRole("button", { name: "Edit placement" }).click();
  const schedule = page.getByRole("dialog", {
    name: "Schedule “The Agent Runtime Is the Product”",
  });
  await expect(schedule).toContainText("Conflict validation runs after save");
  await schedule.getByRole("button", { name: "Schedule session" }).click();

  await expect(
    page.getByRole("button", { name: "1 hard conflict" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Preview publish" }).click();
  const publish = page.getByRole("dialog", { name: "Publish agenda preview" });
  await expect(publish).toContainText(
    "Placement conflict validation is pending",
  );
  await expect(
    publish.getByRole("button", { name: "Publish version 3" }),
  ).toBeDisabled();
});

test("empty and read-only agenda states remain clear and accessible", async ({
  page,
}) => {
  await page.goto("/fixtures/agenda/empty");
  await expect(
    page.getByRole("heading", { name: "No sessions are ready to schedule" }),
  ).toBeVisible();
  await expect(page.locator(".agenda-layout")).toHaveCount(0);

  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/fixtures/agenda/ready-readonly?view=list");
  await expect(page.getByText("Read-only preview")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Preview publish" }),
  ).toHaveCount(0);
  await expect(page.locator(".agenda-rail")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Print" })).toBeVisible();

  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);

  const results = await new AxeBuilder({ page })
    .include(".agenda-page")
    .analyze();
  expect(results.violations).toEqual([]);
});

test("production agenda URLs ignore fixture query controls", async ({
  page,
}) => {
  await page.goto(`${agendaPath}?state=empty&mode=readonly`);

  await expect(
    page.getByRole("heading", { name: "Build the room, minute by minute." }),
  ).toBeVisible();
  await expect(page.locator(".agenda-unscheduled-card")).toHaveCount(4);
  await expect(
    page.getByRole("button", { name: "Preview publish" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "No sessions are ready to schedule" }),
  ).toHaveCount(0);
});
