import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import type {
  ReviewerAssignmentListResponse,
  ReviewScoringCommand,
} from "@sessionbox-killer/contracts";
import { mockAccountLogout } from "./account-auth";

const reviewPath = "/fixtures/reviewer/interactive";
const storageKey = "opensession.reviewer.visual-draft";
const productionStorageKey = `${storageKey}.ai-engineer-summit`;
const csrfToken = "reviewer-e2e-csrf-token-that-is-at-least-forty-characters";

function productionResponse(): ReviewerAssignmentListResponse {
  return {
    assignments: [
      {
        assignment: {
          assignedAt: "2026-08-10T18:00:00.000Z",
          audit: [],
          conflictNote: null,
          id: "assignment_production",
          reviewer: {
            displayName: "Riley Reviewer",
            id: "reviewer_riley",
          },
          reviewerGroupId: "group_engineering",
          rubric: {
            criteria: [
              {
                guidance: "Assess concrete audience value.",
                id: "criterion_value",
                label: "Audience value",
                weight: 60,
              },
              {
                guidance: "Assess credible supporting evidence.",
                id: "criterion_evidence",
                label: "Evidence",
                weight: 40,
              },
            ],
            id: "rubric_program",
            name: "Program quality",
            version: 2,
          },
          scoringRequired: true,
          sourceVersion: 1,
          status: "pending",
          submission: {
            id: "submission_production",
            reference: "AES-2042",
            title: "Reliable Agents in Practice",
            track: "AI Engineering",
          },
          updatedAt: "2026-08-10T18:00:00.000Z",
        },
        context: {
          abstract: "A field-tested reliability model for production agents.",
          audience: "Engineers shipping agent workflows.",
          format: "30-minute talk",
          outcomes: ["Recognize and recover from common failure modes."],
        },
        draft: { note: "", scores: [] },
        submittedAt: null,
      },
    ],
    event: {
      brand: { accent: "#cde878", background: "#f5f2ea", ink: "#10201d" },
      id: "event_engineering",
      name: "AI Engineer Summit 2026",
      reviewDueAt: "2026-08-28T00:00:00.000Z",
      slug: "ai-engineer-summit",
      timezone: "America/Los_Angeles",
    },
    reviewer: { displayName: "Riley Reviewer", id: "reviewer_riley" },
  };
}

async function installProductionReview(
  page: Page,
  onCommand: (
    command: ReviewScoringCommand,
    attempt: number,
  ) => Promise<number>,
) {
  await page.context().addCookies([
    {
      httpOnly: false,
      name: "__Host-opensession-csrf",
      sameSite: "Lax",
      secure: true,
      url: "https://127.0.0.1:8787",
      value: csrfToken,
    },
  ]);
  const response = productionResponse();
  let attempts = 0;
  await page.route(
    "**/api/events/ai-engineer-summit/reviewer-assignments**",
    async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ json: response });
        return;
      }
      attempts += 1;
      expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
      const command = route.request().postDataJSON() as ReviewScoringCommand;
      const version = await onCommand(command, attempts);
      if (version < 0) {
        await route.fulfill({
          json: {
            error: {
              code: "review_operations_authority_unavailable",
              message: "Review service unavailable.",
            },
            request_id: "request_review_e2e",
          },
          status: 503,
        });
        return;
      }
      await route.fulfill({
        json: {
          ok: true,
          result: {
            appliedAt: "2026-08-11T12:00:00.000Z",
            commandId: command.commandId,
            entityId: command.assignmentId,
            entityType: "assignment",
            outcome: "applied",
            projection: "durable",
            version,
          },
        },
      });
    },
  );
}

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

test("reviewer account menu ends the authenticated session", async ({
  page,
}) => {
  const logout = await mockAccountLogout(page);
  await page.goto(reviewPath);

  const account = page.getByRole("button", { name: "Morgan Lee account" });
  await account.press("Enter");
  const signOut = page.getByRole("menuitem", { name: "Sign out" });
  await expect(signOut).toBeFocused();
  await signOut.press("Enter");

  await expect(
    page.getByRole("heading", { name: "Sign in to your program" }),
  ).toBeVisible();
  expect(logout.attempts()).toBe(1);
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

test("review scoring remains usable at 360px without page overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await openFreshReview(page);

  await expect(
    page.getByRole("heading", { name: "Review queue" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your score" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Declare conflict" }),
  ).toBeVisible();
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

test("rubric scoring and submission confirmation work from the keyboard", async ({
  page,
}) => {
  await openFreshReview(page);
  const firstScore = page
    .locator("#criterion-relevance")
    .getByRole("radio", { name: "1", exact: true });
  await firstScore.focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page
      .locator("#criterion-relevance")
      .getByRole("radio", { name: "2", exact: true }),
  ).toBeChecked();
  for (const criterion of ["specificity", "originality"]) {
    await page
      .locator(`#criterion-${criterion}`)
      .getByRole("radio", { name: "4", exact: true })
      .check();
  }
  await page.getByRole("button", { name: "Submit review" }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Submit this review?" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("production reviewer loads scoped context and submits one final snapshot", async ({
  page,
}) => {
  const commands: ReviewScoringCommand[] = [];
  await installProductionReview(page, async (command) => {
    commands.push(command);
    return commands.length + 1;
  });
  await page.goto("/review/ai-engineer-summit");
  await page.evaluate(
    (key) => window.localStorage.removeItem(key),
    productionStorageKey,
  );
  await page.reload();

  await expect(
    page.getByRole("heading", { name: "Reliable Agents in Practice" }),
  ).toBeVisible();
  await expect(page.getByText("Due August 27")).toBeVisible();
  for (const criterion of ["criterion_value", "criterion_evidence"]) {
    await page
      .locator(`#criterion-${criterion}`)
      .getByRole("radio", { name: "4", exact: true })
      .check();
  }
  await page
    .getByLabel("Private note to the program team")
    .fill("Strong practical evidence.");
  await page.getByRole("button", { name: "Submit review" }).click();
  await page
    .getByRole("dialog", { name: "Submit this review?" })
    .getByRole("button", { name: "Submit final review" })
    .click();

  await expect(page.getByText("Submitted · read only")).toBeVisible();
  await page.waitForTimeout(800);
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({
    draft: {
      note: "Strong practical evidence.",
      scores: [
        { criterionId: "criterion_value", score: 4 },
        { criterionId: "criterion_evidence", score: 4 },
      ],
    },
    expectedVersion: 1,
    type: "submit_review",
  });
});

test("authenticated reviewer direct navigation and refresh stay in the reviewer workflow", async ({
  page,
}) => {
  const requestedPaths: string[] = [];
  page.on("request", (request) => requestedPaths.push(request.url()));
  await page.route(
    "**/api/events/ai-engineer-summit/review-workspace",
    async (route) => route.fulfill({ json: { surface: "reviewer" } }),
  );
  await installProductionReview(page, async () => 2);

  await page.goto("/app/ai-engineer-summit/reviews");
  await expect(
    page.getByRole("heading", { name: "Reliable Agents in Practice" }),
  ).toBeVisible();
  await expect(page.locator(".reviewer-profile")).toContainText(
    "Riley Reviewer",
  );
  await expect(page.locator(".reviewer-profile")).toContainText("Reviewer");
  await expect(page.getByText("Casey Manos")).toHaveCount(0);
  await expect(page.getByText("Organizer", { exact: true })).toHaveCount(0);

  await page.reload();
  await expect(page.locator(".reviewer-profile")).toContainText(
    "Riley Reviewer",
  );
  expect(
    requestedPaths.filter((path) => path.includes("/review-operations")),
  ).toEqual([]);
  expect(
    requestedPaths.filter((path) => path.endsWith("/reviewer-assignments")),
  ).toHaveLength(2);
});

test("failed production autosave retries the exact frozen command", async ({
  page,
}) => {
  const bodies: string[] = [];
  await installProductionReview(page, async (command, attempt) => {
    bodies.push(JSON.stringify(command));
    return attempt === 1 ? -1 : 2;
  });
  await page.goto("/review/ai-engineer-summit");
  await page
    .locator("#criterion-criterion_value")
    .getByRole("radio", { name: "3", exact: true })
    .check();
  await expect(page.getByText("Draft saved in this browser")).toBeVisible();
  await page.getByRole("button", { name: "Retry save" }).click();
  await expect(page.getByText("Draft saved", { exact: true })).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toBe(bodies[0]);
});
