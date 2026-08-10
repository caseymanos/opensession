import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const reviewPath = "/review/ai-engineer-summit";
const storageKey = "opensession.reviewer.visual-draft";

async function openFreshReview(page: Page) {
  await page.goto(reviewPath);
  await page.evaluate((key) => window.localStorage.removeItem(key), storageKey);
  await page.reload();
}

test("reviewer workspace exposes queue, proposal, and persistent guidance", async ({
  page,
}) => {
  await openFreshReview(page);

  await expect(
    page.getByRole("heading", { name: "Review queue", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "The Reliability Gap in Production Agents",
      level: 1,
    }),
  ).toBeVisible();
  await expect(page.locator(".review-queue-item")).toHaveCount(5);
  await expect(page.locator(".review-criterion")).toHaveCount(3);
  await expect(page.getByText("Score every criterion.")).toBeVisible();

  const results = await new AxeBuilder({ page })
    .include(".reviewer-workspace")
    .analyze();
  expect(results.violations).toEqual([]);
});

test("review validation names missing criteria before final submit", async ({
  page,
}) => {
  await openFreshReview(page);

  await page.getByRole("button", { name: "Submit review" }).click();
  await expect(
    page.getByRole("heading", { name: "Complete this review" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Score Audience value" }),
  ).toBeVisible();

  for (const criterion of ["relevance", "specificity", "originality"]) {
    const score = page
      .locator(`#criterion-${criterion}`)
      .getByRole("radio", { name: "4", exact: true });
    await expect(score).toHaveCount(1);
    await score.check();
  }
  await page
    .getByLabel("Private note to the program team")
    .fill("Strong practical framing.");
  await page.getByRole("button", { name: "Submit review" }).click();
  const dialog = page.getByRole("dialog", { name: "Submit this review?" });
  await expect(dialog).toContainText("4.0 out of 5");
  await dialog.getByRole("button", { name: "Submit final review" }).click();
  await expect(page.getByText("Submitted · read only")).toBeVisible();
  await expect(
    page
      .locator("#criterion-relevance")
      .getByRole("radio", { name: "4", exact: true }),
  ).toBeDisabled();
});

test("review queue opens each assignment and keeps drafts isolated", async ({
  page,
}) => {
  await openFreshReview(page);

  const evaluationAssignment = page
    .locator(".review-queue-item")
    .filter({ hasText: "Your Eval Suite Is Lying to You" });
  await evaluationAssignment.click();
  await expect(evaluationAssignment).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", {
      name: "Your Eval Suite Is Lying to You",
      level: 1,
    }),
  ).toBeVisible();
  await expect(page.locator(".review-proposal-meta")).toContainText("AES-1036");

  await page
    .locator("#criterion-relevance")
    .getByRole("radio", { name: "3", exact: true })
    .check();
  await page
    .locator(".review-queue-item")
    .filter({ hasText: "The Reliability Gap in Production Agents" })
    .click();
  await expect(
    page
      .locator("#criterion-relevance")
      .getByRole("radio", { name: "3", exact: true }),
  ).not.toBeChecked();

  await evaluationAssignment.click();
  await expect(
    page
      .locator("#criterion-relevance")
      .getByRole("radio", { name: "3", exact: true }),
  ).toBeChecked();

  await page
    .locator(".review-queue-item")
    .filter({ hasText: "Designing Human Checkpoints That Scale" })
    .click();
  await expect(page.getByText("Submitted · read only")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review submitted" }),
  ).toBeDisabled();
});

test("reviewer access and offline states explain recovery", async ({
  page,
}) => {
  await page.goto("/fixtures/reviewer/expired");
  await expect(
    page.getByRole("heading", { name: "This review link has expired" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send a new sign-in link" }),
  ).toBeVisible();

  await page.goto("/fixtures/reviewer/permission");
  await expect(
    page.getByRole("heading", { name: "This proposal is not assigned to you" }),
  ).toBeVisible();

  await page.goto("/fixtures/reviewer/offline");
  await page.evaluate((key) => window.localStorage.removeItem(key), storageKey);
  await page.reload();
  await expect(page.locator(".review-offline")).toContainText("You’re offline");
  await expect(
    page.getByRole("button", { name: "Submit review" }),
  ).toBeDisabled();
  await page
    .locator("#criterion-relevance")
    .getByRole("radio", { name: "3", exact: true })
    .check();
  await expect(page.getByText("Saved in this browser")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate((key) => window.localStorage.getItem(key), storageKey),
    )
    .toContain('"relevance":3');
  await page.reload();
  await expect(
    page
      .locator("#criterion-relevance")
      .getByRole("radio", { name: "3", exact: true }),
  ).toBeChecked();
  await page.getByRole("button", { name: "Retry now" }).click();
  await expect(page.locator(".review-offline")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Submit review" }),
  ).toBeEnabled();
  await expect(
    page.getByText("Connection restored", { exact: true }),
  ).toBeVisible();

  await page.goto("/fixtures/reviewer/submitted");
  await expect(page.getByText("Submitted · read only")).toBeVisible();
});

test("production review URLs ignore fixture query state", async ({ page }) => {
  for (const state of ["expired", "offline", "permission", "submitted"]) {
    await page.goto(`${reviewPath}?state=${state}`);
    await expect(
      page.getByRole("heading", {
        name: "The Reliability Gap in Production Agents",
        level: 1,
      }),
    ).toBeVisible();
    await expect(page.locator(".review-offline")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Submit review" }),
    ).toBeEnabled();
  }
});

test("review scoring remains usable at 360px without page overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await openFreshReview(page);

  await expect(
    page.getByRole("heading", { name: "Review queue" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your score" })).toBeVisible();
  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);

  const results = await new AxeBuilder({ page })
    .include(".reviewer-workspace")
    .analyze();
  expect(results.violations).toEqual([]);
});
