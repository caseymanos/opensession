import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const submissionsPath = "/app/ai-engineer-summit/submissions";
const detailPath = `${submissionsPath}/AI-1042`;

test("organizer can search and filter the submission queue with URL persistence", async ({
  page,
}) => {
  await page.goto(submissionsPath);

  await expect(
    page.getByRole("heading", { name: "Every proposal, in context." }),
  ).toBeVisible();
  const queue = page.locator(
    ".submission-table-desktop:visible, .submission-cards:visible",
  );
  const rows = page.locator(
    ".ui-table tbody tr:visible, .submission-cards > article:visible",
  );
  await expect(queue).toContainText(
    "From Prototype to Production: Reliable Agent Systems",
  );
  await expect(queue).toContainText("4.42");
  await expect(rows).toHaveCount(6);

  await page.getByLabel("Search submissions").fill("Mina Okafor");
  await expect(page).toHaveURL(/q=Mina/);
  await expect(rows).toHaveCount(1);
  await expect(queue).toContainText("AI-1042");

  await page.getByLabel("Search submissions").fill("");
  await page.getByLabel("Status", { exact: true }).selectOption("accepted");
  await expect(page).toHaveURL(/status=accepted/);
  await expect(rows).toHaveCount(1);
  await expect(queue).toContainText("Designing Human Checkpoints That Scale");

  const results = await new AxeBuilder({ page })
    .include(".submission-list")
    .analyze();
  expect(results.violations).toEqual([]);
});

test("detail preserves the exact submitted form and organizer context", async ({
  page,
}) => {
  await page.goto(detailPath);

  await expect(
    page.getByRole("heading", {
      name: "From Prototype to Production: Reliable Agent Systems",
      level: 1,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("CFP form v2 · submitted snapshot"),
  ).toBeVisible();
  await expect(page.getByText("What will attendees learn?")).toBeVisible();
  await expect(page.getByText("Mina Okafor", { exact: true })).toBeVisible();
  await expect(page.getByText("Theo Martin", { exact: true })).toBeVisible();
  await expect(page.locator(".submission-score")).toContainText("4.42");
  await expect(page.getByText("3 of 4")).toBeVisible();
  await expect(
    page.getByText("Moved into review after eligibility check."),
  ).toBeVisible();
});

test("legal lifecycle changes require a reason and record an audit entry", async ({
  page,
}) => {
  await page.goto(`${submissionsPath}/AI-1068`);

  await page.getByRole("button", { name: "Move to review" }).click();
  const dialog = page.getByRole("dialog", { name: "Move to review" });
  await expect(
    dialog.getByRole("button", { name: "Record change" }),
  ).toBeDisabled();
  await dialog
    .getByLabel("Reason for change")
    .fill("Eligibility check completed; route to the architecture panel.");
  await dialog.getByRole("button", { name: "Record change" }).click();

  await expect(page.getByText("Under review", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Moved to review", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Eligibility check completed; route to the architecture panel.",
    ),
  ).toBeVisible();
  await expect(page.locator(".ui-toast")).toContainText("Status updated");
});

test("internal notes are required, private, and immediately visible", async ({
  page,
}) => {
  await page.goto(detailPath);

  const addNote = page.getByRole("button", { name: "Add note" });
  await expect(addNote).toBeDisabled();
  await page
    .getByLabel("Add an internal note")
    .fill("Confirm the incident diagram has alt text before scheduling.");
  await addNote.click();
  await expect(
    page.getByText(
      "Confirm the incident diagram has alt text before scheduling.",
    ),
  ).toBeVisible();
  await expect(page.locator(".ui-toast")).toContainText("Internal note added");
});

test("degraded and access fixtures preserve safe boundaries", async ({
  page,
}) => {
  await page.goto("/fixtures/submissions/partial");
  await expect(
    page.getByText("Upstream history is temporarily unavailable"),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "From Prototype to Production: Reliable Agent Systems",
    }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Withdraw" })).toBeDisabled();
  await expect(page.getByLabel("Add an internal note")).toBeDisabled();

  await page.goto("/fixtures/submissions/permission");
  await expect(
    page.getByRole("heading", { name: "Submissions are restricted" }),
  ).toBeVisible();

  await page.goto("/fixtures/submissions/stale");
  await expect(page.getByText("This snapshot may be behind")).toBeVisible();
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(
    page.getByText("Submission projection is current"),
  ).toBeVisible();

  await page.goto(`${submissionsPath}?state=permission`);
  await expect(
    page.getByRole("heading", { name: "Every proposal, in context." }),
  ).toBeVisible();
});

test("empty fixtures and 360px layouts remain clear and accessible", async ({
  page,
}) => {
  await page.goto("/fixtures/submissions/empty");
  await expect(
    page.getByRole("heading", { name: "No submissions yet" }),
  ).toBeVisible();

  await page.goto("/fixtures/submissions/empty-filter");
  await expect(
    page.getByRole("heading", { name: "No submissions match" }),
  ).toBeVisible();

  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(submissionsPath);
  await expect(page.getByLabel("Submission cards")).toBeVisible();
  await expect(page.getByRole("table")).toBeHidden();

  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);

  const results = await new AxeBuilder({ page })
    .include(".submission-list")
    .analyze();
  expect(results.violations).toEqual([]);
});
