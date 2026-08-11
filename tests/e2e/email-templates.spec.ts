import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const fixturePath = "/fixtures/email-templates/default";

test("organizer edits and previews a selected real speaker in both formats", async ({
  page,
}) => {
  await page.goto(fixturePath);

  await expect(
    page.getByRole("heading", { name: "Write once. Preview every person." }),
  ).toBeVisible();
  await expect(page.getByLabel("Preview recipient")).toHaveValue(
    "contact_mina_okafor",
  );
  await expect(page.getByText("Mina Okafor", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Selected speaker", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".email-preview-envelope dd").last()).toContainText(
    "AI Engineer Summit 2026",
  );

  const previewFrame = page.frameLocator("iframe");
  await expect(
    previewFrame.getByRole("heading", {
      name: "You’re on the program, Mina",
    }),
  ).toBeVisible();
  await expect(
    previewFrame.getByText("Agents that recover in production"),
  ).toBeVisible();

  await page.getByRole("tab", { name: "Plain text" }).click();
  await expect(page.getByRole("tabpanel")).toContainText(
    "You’re on the program, Mina",
  );
  await expect(page.getByRole("tabpanel")).toContainText(
    "https://events.opensession.invalid/ai-engineer-summit/submissions/SUB-0104",
  );

  await page
    .getByLabel("Subject", { exact: true })
    .fill("Welcome {{recipient.first_name}} to {{event.name}}");
  await expect(page.locator(".email-preview-envelope dd").last()).toHaveText(
    "Welcome Mina to AI Engineer Summit 2026",
  );
});

test("invalid-token proof blocks actions at an exact location without mutating the draft", async ({
  page,
}) => {
  await page.goto(fixturePath);
  const originalSubject = await page
    .getByLabel("Subject", { exact: true })
    .inputValue();

  await page.getByRole("button", { name: "Show invalid-token proof" }).click();
  const error = page.getByRole("alert").filter({
    hasText: "Intentional invalid token caught",
  });
  await expect(error).toContainText("subject:");
  await expect(error).toContainText("Unknown merge field recipient.nickname.");
  await expect(
    page.getByRole("button", { name: "Save new version" }),
  ).toBeDisabled();
  await expect(page.getByLabel("Subject", { exact: true })).toHaveValue(
    originalSubject,
  );

  await page.getByRole("button", { name: "Return to valid preview" }).click();
  await expect(error).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Save new version" }),
  ).toBeEnabled();
});

test("save and activation append immutable versions instead of rewriting history", async ({
  page,
}) => {
  await page.goto(fixturePath);
  await expect(page.getByText("7 immutable versions")).toBeVisible();

  await page.getByRole("button", { name: "Save new version" }).click();
  await expect(page.getByText("8 immutable versions")).toBeVisible();
  await expect(page.locator(".email-template-title-line")).toContainText(
    "draft · v2",
  );
  await expect(page.locator(".email-command-notice")).toHaveText(
    /Draft version 2 saved/,
  );

  await page
    .getByLabel("Subject", { exact: true })
    .fill("Atomic activation for {{recipient.first_name}}");
  await expect(page.locator(".email-preview-envelope dd").last()).toHaveText(
    "Atomic activation for Mina",
  );
  await page.getByRole("button", { name: "Activate version" }).click();
  await expect(page.getByText("9 immutable versions")).toBeVisible();
  await expect(page.locator(".email-template-title-line")).toContainText(
    "active · v3",
  );
  await expect(page.getByLabel("Subject", { exact: true })).toHaveValue(
    "Atomic activation for {{recipient.first_name}}",
  );
  await expect(page.locator(".email-command-notice")).toHaveText(
    /Version 3 activated/,
  );
  await expect(
    page.getByRole("button", { name: /Submission accepted/ }),
  ).toHaveCount(3);

  await page.getByRole("button", { name: "Archive version" }).click();
  await expect(page.getByText("10 immutable versions")).toBeVisible();
  await expect(page.locator(".email-template-title-line")).toContainText(
    "archived · v4",
  );
  await expect(page.locator(".email-command-notice")).toContainText(
    "archived as the immutable family head",
  );
  await expect(
    page.getByRole("button", { name: "Archive version" }),
  ).toHaveCount(0);

  await page
    .getByRole("navigation", { name: "Email template versions" })
    .getByRole("button", { name: /Submission accepted/ })
    .last()
    .click();
  await expect(
    page.getByText("Historical version · read-only", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".email-historical-notice")).toContainText(
    "retained for audit and campaign history",
  );
  await expect(
    page.getByRole("button", { name: "Save new version" }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Subject", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Internal name")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Add paragraph" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", {
      name: /Insert recipient.first_name into/,
    }),
  ).toBeDisabled();
});

test("switching immutable versions protects unsaved editor work", async ({
  page,
}) => {
  await page.goto(fixturePath);
  const subject = page.getByLabel("Subject", { exact: true });
  const receipt = page
    .getByRole("navigation", { name: "Email template versions" })
    .getByRole("button", { name: /Submission receipt/ });
  await subject.fill("Unsaved switch guard");
  await expect(page.getByText("Unsaved edits", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      return window.dispatchEvent(event);
    }),
  ).toBe(false);

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Discard unsaved template edits");
    await dialog.dismiss();
  });
  await receipt.click();
  await expect(subject).toHaveValue("Unsaved switch guard");

  page.once("dialog", async (dialog) => {
    await dialog.accept();
  });
  await receipt.click();
  await expect(subject).not.toHaveValue("Unsaved switch guard");
  await expect(page.locator(".email-template-title-line")).toContainText(
    "active · v1",
  );
});

test("desktop workspace is accessible and the sandbox has no script capability", async ({
  page,
}) => {
  await page.goto(fixturePath);
  await expect(page.locator("iframe")).toHaveAttribute("sandbox", "");
  const results = await new AxeBuilder({ page })
    .include(".email-template-page")
    .exclude(".email-preview-envelope iframe")
    .analyze();
  expect(results.violations).toEqual([]);
});

test("mobile workspace remains operable without horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(fixturePath);

  await expect(page.getByLabel("Preview recipient")).toHaveValue(
    "contact_mina_okafor",
  );
  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);

  await page.getByRole("button", { name: "Show invalid-token proof" }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Unknown merge field recipient.nickname." }),
  ).toBeVisible();
  const results = await new AxeBuilder({ page })
    .include(".email-template-page")
    .exclude(".email-preview-envelope iframe")
    .analyze();
  expect(results.violations).toEqual([]);
});
