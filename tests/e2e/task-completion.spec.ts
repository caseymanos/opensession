import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const portalPath = "/portal/ai-engineer-summit";
const speakerTaskPath = `${portalPath}/tasks/final-slides`;
const organizerTaskPath =
  "/app/ai-engineer-summit/people/mina-okafor/tasks/final-slides";

test("speaker can reach a complete task brief without exposing event task data in the profile", async ({
  page,
}) => {
  await page.goto(portalPath);

  await expect(
    page.getByText("Final presentation", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Review submission" }).click();
  await expect(page).toHaveURL(speakerTaskPath);
  await expect(
    page.getByRole("heading", { name: "Upload your final presentation" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: /Tasks 3/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByText("Program-team approval required")).toBeVisible();
  await expect(page.getByText("Required", { exact: true })).toBeVisible();
  await expect(
    page.locator(".task-brief").getByText(/Overdue by 2 days · due August 7/),
  ).toBeVisible();

  const results = await new AxeBuilder({ page })
    .include(".task-completion")
    .analyze();
  expect(results.violations).toEqual([]);
});

test("speaker file replacement validates input and preserves version history", async ({
  page,
}) => {
  await page.goto(speakerTaskPath);
  await page.getByRole("button", { name: "Replace file" }).click();

  await page.locator("#task-file-input").setInputFiles({
    buffer: Buffer.from("not a presentation"),
    mimeType: "application/octet-stream",
    name: "unsafe-deck.exe",
  });
  await expect(page.getByRole("alert")).toContainText(
    "Choose a PDF or PPTX file.",
  );

  await page.locator("#task-file-input").setInputFiles({
    buffer: Buffer.from("renamed executable"),
    mimeType: "application/octet-stream",
    name: "renamed-deck.pdf",
  });
  await expect(page.getByRole("alert")).toContainText(
    "The file type does not match its PDF or PPTX extension.",
  );

  await page.locator("#task-file-input").evaluate((input) => {
    const oversizedFile = new File(
      ["oversized fixture"],
      "oversized-deck.pdf",
      {
        type: "application/pdf",
      },
    );
    Object.defineProperty(oversizedFile, "size", {
      value: 50 * 1024 * 1024 + 1,
    });
    const transfer = new DataTransfer();
    transfer.items.add(oversizedFile);
    Object.defineProperty(input, "files", {
      configurable: true,
      value: transfer.files,
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.getByRole("alert")).toContainText(
    "Choose a file smaller than 50 MB.",
  );
  await page
    .locator("#task-file-input")
    .evaluate((input) => Reflect.deleteProperty(input, "files"));

  await page.locator("#task-file-input").setInputFiles({
    buffer: Buffer.from("pptx fixture"),
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    name: "mina-production-agents-v4.pptx",
  });
  await expect(page.getByText("Ready to upload")).toBeVisible();

  await page.getByRole("checkbox").uncheck();
  await expect(
    page.getByRole("button", { name: "Submit replacement" }),
  ).toBeDisabled();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Submit replacement" }).click();

  await expect(page.getByRole("progressbar")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Version 4 is waiting for review" }),
  ).toBeVisible({ timeout: 3_000 });
  await expect(page.locator(".task-version-history")).toContainText(
    "Version 4 · current",
  );
  await expect(page.locator(".task-version-history")).toContainText(
    "Version 3 · replaced",
  );
});

test("failed processing recovery is fixture-only and does not require reupload", async ({
  page,
}) => {
  await page.goto(`${speakerTaskPath}?state=failed`);
  await expect(
    page.getByRole("heading", { name: "Version 3 is waiting for review" }),
  ).toBeVisible();
  await expect(page.getByText("processing did not finish")).toHaveCount(0);

  await page.goto("/fixtures/portal-task/failed");
  await expect(page.getByRole("alert")).toContainText(
    "processing did not finish",
  );
  await expect(page.getByText("mina-production-agents-v4.pdf")).toBeVisible();
  await page.getByRole("button", { name: "Retry processing" }).click();
  await expect(
    page.getByRole("heading", { name: "Version 4 is waiting for review" }),
  ).toBeVisible({ timeout: 2_500 });
});

test("organizer approval updates readiness and audit state without a reload", async ({
  page,
}) => {
  await page.goto(organizerTaskPath);

  const workspace = page.locator(".task-completion");
  await expect(workspace).toContainText("mina-production-agents-v3.pdf");
  await expect(workspace).toContainText("Security scan");
  await expect(workspace).not.toContainText("r2://");
  await expect(workspace).not.toContainText("sessionbox-killer-uploads");

  await page.getByRole("button", { name: "Approve version 3" }).click();
  await expect(
    page.locator(".organizer-task-summary").filter({
      hasText: "Speaker readiness",
    }),
  ).toContainText("5 / 5");
  await expect(
    page.getByRole("heading", { name: "Presentation approved" }),
  ).toBeVisible();
  await expect(page.locator(".ui-toast")).toContainText(
    "readiness view updated immediately",
  );
  await expect(page.locator(".organizer-audit")).toContainText(
    "Version approved",
  );
});

test("organizer rejection requires and records a reason", async ({ page }) => {
  await page.goto(organizerTaskPath);
  await page.getByRole("button", { name: "Request changes" }).click();
  await page.getByRole("button", { name: "Send request" }).click();
  await expect(
    page.getByText("Explain what Mina needs to change."),
  ).toBeVisible();

  await page
    .getByLabel("Reason for requesting changes")
    .fill("Please embed the demo video and export the deck again.");
  await page.getByRole("button", { name: "Send request" }).click();

  await expect(
    page.getByRole("heading", { name: "Replacement requested" }),
  ).toBeVisible();
  await expect(page.getByText(/Please embed the demo video/)).toBeVisible();
  await expect(page.locator(".ui-toast")).toContainText(
    "Readiness remains 4 of 5",
  );
  await expect(page.locator(".organizer-audit")).toContainText(
    "Changes requested",
  );
});

test("speaker and organizer task workspaces remain contained at 360px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });

  for (const path of [speakerTaskPath, organizerTaskPath]) {
    await page.goto(path);
    await expect(page.locator(".task-completion")).toBeVisible();
    const widths = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);

    const results = await new AxeBuilder({ page })
      .include(".task-completion")
      .analyze();
    expect(results.violations).toEqual([]);
  }
});
