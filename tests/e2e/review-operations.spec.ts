import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const reviewOperationsPath = "/app/ai-engineer-summit/reviews";

test("review operations exposes the active weighted rubric and immutable snapshots", async ({
  page,
}) => {
  await page.goto(reviewOperationsPath);

  await expect(
    page.getByRole("heading", { name: "A fair process people can inspect." }),
  ).toBeVisible();
  await expect(page.getByText("Rubric v2 active")).toBeVisible();
  await expect(page.getByText("Assigned proposals only")).toBeVisible();
  await expect(page.getByText("100%", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Score scale 1 through 5")).toHaveCount(3);
  await expect(
    page.getByText("Submitted reviews stay on rubric v2."),
  ).toBeVisible();

  const results = await new AxeBuilder({ page })
    .include(".review-operations-page")
    .analyze();
  expect(results.violations).toEqual([]);
});

test("rubric validation prevents invalid versions and preserves submitted snapshots", async ({
  page,
}) => {
  await page.goto(reviewOperationsPath);

  const audienceWeight = page
    .getByRole("spinbutton", { name: "Weight" })
    .first();
  const publish = page.getByRole("button", { name: "Publish rubric v3" });

  await audienceWeight.fill("50");
  await expect(page.getByText("110%", { exact: true })).toBeVisible();
  await expect(publish).toBeDisabled();

  await audienceWeight.fill("40");
  await expect(publish).toBeEnabled();
  await page.getByRole("button", { name: "Add criterion" }).click();
  await expect(
    page.getByText("Every criterion needs guidance and weight"),
  ).toBeVisible();
  await expect(publish).toBeDisabled();
  await page.getByRole("button", { name: "Delete New criterion" }).click();

  await page.getByRole("spinbutton", { name: "Weight" }).nth(0).fill("45");
  await page.getByRole("spinbutton", { name: "Weight" }).nth(1).fill("30");
  await expect(page.getByText("100%", { exact: true })).toBeVisible();

  await publish.click();
  const dialog = page.getByRole("dialog", { name: "Publish rubric v3?" });
  await expect(dialog).toContainText("Submitted review snapshots remain on v2");
  await dialog.getByRole("button", { name: "Publish version" }).click();
  await expect(page.getByText("Rubric v3 active")).toBeVisible();
  await expect(
    page.getByText("Submitted reviews stay on rubric v2."),
  ).toBeVisible();
  const publishedToast = page
    .getByRole("status")
    .filter({ hasText: "Rubric published" });
  await expect(publishedToast).toBeVisible();
  await expect(
    publishedToast.getByText("submitted snapshots did not change"),
  ).toBeVisible();

  await page.getByRole("button", { name: /Assignments/ }).click();
  await expect(
    page.locator("tbody tr").filter({ hasText: "Priya Das" }),
  ).toContainText("v3 snapshot");
  await expect(
    page.locator("tbody tr").filter({ hasText: "Casey Brooks" }),
  ).toContainText("v2 snapshot");

  await page
    .getByRole("button", { name: "View audit for AES-1081 and Priya Das" })
    .click();
  const pendingSnapshot = page.getByRole("dialog", {
    name: "Assignment history",
  });
  await expect(pendingSnapshot).toContainText("Audience value45%");
  await expect(pendingSnapshot).toContainText("Specificity & evidence30%");
  await pendingSnapshot
    .getByRole("button", { name: "Close Assignment history" })
    .click();

  await page
    .getByRole("button", { name: "View audit for AES-1120 and Casey Brooks" })
    .click();
  const submittedSnapshot = page.getByRole("dialog", {
    name: "Assignment history",
  });
  await expect(submittedSnapshot).toContainText("Audience value40%");
  await expect(submittedSnapshot).toContainText("Specificity & evidence35%");
  await submittedSnapshot
    .getByRole("button", { name: "Close Assignment history" })
    .click();

  await page.getByRole("button", { name: "Assign reviewer" }).click();
  const assign = page.getByRole("dialog", { name: "Assign a reviewer" });
  await assign.getByLabel("Proposal").selectOption("AES-1120");
  await assign
    .getByLabel("Reviewer", { exact: true })
    .selectOption("Inez Park");
  await assign.getByRole("button", { name: "Create assignment" }).click();
  await expect(
    page.locator("tbody tr").filter({ hasText: "Inez Park" }),
  ).toContainText("v3 snapshot");
});

test("reviewer groups prove Track D routing and support deliberate membership changes", async ({
  page,
}) => {
  await page.goto(reviewOperationsPath);
  await page.getByRole("button", { name: /Reviewer groups/ }).click();

  await expect(page.getByText("4 of 4 routes mapped")).toBeVisible();
  await expect(page.getByText("Track D proof:")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Product reviewers" }),
  ).toBeVisible();
  await expect(
    page.getByText("Product · Track D", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Remove Inez Park from Product reviewers",
    })
    .click();
  const removeDialog = page.getByRole("dialog", {
    name: "Remove reviewer from group?",
  });
  await expect(removeDialog).toContainText(
    "Existing individual assignments and their audit history will not be changed.",
  );
  await removeDialog
    .getByRole("button", { name: "Remove reviewer", exact: true })
    .click();
  await expect(page.getByText("Inez Park", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Reviewer removed")).toBeVisible();

  const productGroup = page
    .locator(".review-ops-group-grid article")
    .filter({ hasText: "Product reviewers" });
  await productGroup.getByRole("button", { name: "Add reviewer" }).click();
  const addDialog = page.getByRole("dialog", {
    name: "Add reviewer to group",
  });
  await addDialog.getByLabel("Reviewer name").fill("Robin Li");
  await addDialog
    .getByRole("button", { name: "Add reviewer", exact: true })
    .click();
  await expect(
    productGroup.getByText("Robin Li", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Reviewer added")).toBeVisible();
  await page.getByRole("button", { name: "Dismiss Reviewer added" }).click();
  await expect(page.getByText("Reviewer added")).toHaveCount(0);
});

test("assignments are idempotent, auditable, and remove scoring after a conflict", async ({
  page,
}) => {
  await page.goto(reviewOperationsPath);
  await page.getByRole("button", { name: /Assignments/ }).click();

  const assignmentTable = page.getByRole("table");
  await expect(
    assignmentTable.getByText("Pending", { exact: true }),
  ).toBeVisible();
  await expect(
    assignmentTable.getByText("In progress", { exact: true }),
  ).toBeVisible();
  await expect(
    assignmentTable.getByText("Submitted", { exact: true }),
  ).toBeVisible();

  const createAssignment = async () => {
    await page.getByRole("button", { name: "Assign reviewer" }).click();
    const dialog = page.getByRole("dialog", { name: "Assign a reviewer" });
    await expect(dialog).toContainText("safe to retry");
    await dialog.getByRole("button", { name: "Create assignment" }).click();
  };

  await createAssignment();
  await expect(page.getByText("Assignment created")).toBeVisible();
  const theoRows = page.locator("tbody tr").filter({ hasText: "Theo Martin" });
  await expect(theoRows).toHaveCount(1);
  await expect(page.getByRole("button", { name: /Assignments/ })).toContainText(
    "5",
  );
  await createAssignment();
  await expect(theoRows).toHaveCount(1);

  await page
    .getByRole("button", {
      name: "Remove assignment for Theo Martin on AES-1081",
    })
    .click();
  const removeDialog = page.getByRole("dialog", {
    name: "Remove this assignment?",
  });
  await expect(removeDialog).toContainText(
    "assignment and its history remain in the audit log",
  );
  await removeDialog.getByRole("button", { name: "Remove assignment" }).click();
  await expect(theoRows).toContainText("Removed · no access");
  await expect(
    page.getByRole("status").filter({ hasText: "Assignment removed" }),
  ).toContainText("history remains auditable");

  await page
    .getByRole("button", { name: "View audit for AES-1081 and Theo Martin" })
    .click();
  const removalAudit = page.getByRole("dialog", {
    name: "Assignment history",
  });
  await expect(removalAudit).toContainText("proposal access revoked");
  await removalAudit
    .getByRole("button", { name: "Close Assignment history" })
    .click();

  await createAssignment();
  await expect(theoRows).toHaveCount(1);
  await expect(theoRows).toContainText("Pending");
  await expect(
    page.getByRole("status").filter({ hasText: "Assignment restored" }),
  ).toContainText("prior history intact");

  await page
    .getByRole("button", {
      name: "Disclose conflict for Maya Singh on AES-1042",
    })
    .click();
  const conflictDialog = page.getByRole("dialog", {
    name: "Record this conflict?",
  });
  await expect(conflictDialog).toContainText(
    "Their scoring requirement will be removed",
  );
  await conflictDialog.getByRole("button", { name: "Record conflict" }).click();
  const mayaRow = page.locator("tbody tr").filter({ hasText: "Maya Singh" });
  await expect(mayaRow).toContainText("Conflict · no score");
  const conflictToast = page
    .getByRole("status")
    .filter({ hasText: "Conflict disclosed" });
  await expect(conflictToast).toBeVisible();
  await expect(
    conflictToast.getByText(
      "Scoring requirement removed and the organizer alert is visible.",
    ),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "View audit for AES-1042 and Maya Singh" })
    .click();
  const drawer = page.getByRole("dialog", { name: "Assignment history" });
  await expect(drawer).toContainText("Rubric v2 snapshot");
  await expect(drawer).toContainText("Scoring requirement removed.");
  await expect(drawer).toContainText("organizer alerted");
});

test("review operations remains usable at 360px without document overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(reviewOperationsPath);

  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);

  await page.getByRole("button", { name: /Assignments/ }).click();
  await expect(
    page.getByText(
      "Scroll the table to see reviewer, rubric, status, and actions.",
    ),
  ).toBeVisible();
  const tableWidths = await page
    .locator(".review-ops-table-wrap")
    .evaluate((element) => ({
      client: element.clientWidth,
      scroll: element.scrollWidth,
    }));
  expect(tableWidths.scroll).toBeGreaterThan(tableWidths.client);

  const results = await new AxeBuilder({ page })
    .include(".review-operations-page")
    .analyze();
  expect(results.violations).toEqual([]);
});
