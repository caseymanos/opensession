import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const builderPath = "/app/ai-engineer-summit/cfp";
const storageKey = "opensession.cfp-builder.visual-draft.ai-engineer-summit";

function authoritativeFormFixture() {
  const fields = [
    {
      helpText: "Set expectations before applicants begin.",
      id: "block-introduction",
      key: "proposal_details",
      label: "Proposal details",
      options: [],
      order: 1,
      required: false,
      rules: [],
      type: "section",
      validation: {},
    },
    {
      helpText: "Make it concise and specific. You can refine this later.",
      id: "block-title",
      key: "title",
      label: "Session title",
      options: [],
      order: 2,
      required: true,
      rules: [],
      type: "short_text",
      validation: { maxLength: 100, minLength: 8 },
    },
    {
      helpText: "What will attendees learn, and why does it matter now?",
      id: "block-abstract",
      key: "abstract",
      label: "Session abstract",
      options: [],
      order: 3,
      required: true,
      rules: [],
      type: "long_text",
      validation: { maxLength: 1_200, minLength: 120 },
    },
    {
      helpText: "One concrete outcome per line.",
      id: "block-outcomes",
      key: "outcomes",
      label: "Attendee outcomes",
      options: [],
      order: 4,
      required: true,
      rules: [],
      type: "long_text",
      validation: { maxLength: 1_200, minLength: 20 },
    },
    {
      helpText: "Choose the program track reviewers should use.",
      id: "block-track",
      key: "track",
      label: "Track",
      options: ["AI Engineering", "Product"],
      order: 5,
      required: true,
      rules: [],
      type: "single_select",
      validation: {},
    },
    {
      helpText: "Choose the format that best supports this material.",
      id: "block-format",
      key: "format",
      label: "Session format",
      options: ["Talk", "Workshop", "Panel"],
      order: 6,
      required: true,
      rules: [],
      type: "single_select",
      validation: {},
    },
    {
      helpText:
        "List software, accounts, or experience attendees should bring.",
      id: "block-prerequisites",
      key: "workshop_prerequisites",
      label: "Workshop prerequisites",
      options: [],
      order: 7,
      required: false,
      rules: [
        {
          effect: "show",
          id: "rule-prerequisites-show",
          operator: "equals",
          sourceKey: "format",
          value: "Workshop",
        },
        {
          effect: "require",
          id: "rule-prerequisites-require",
          operator: "equals",
          sourceKey: "format",
          value: "Workshop",
        },
      ],
      type: "long_text",
      validation: { maxLength: 600, minLength: 20 },
    },
    {
      helpText: "Share a representative talk, article, or project.",
      id: "block-reference",
      key: "supporting_url",
      label: "Supporting link",
      options: [],
      order: 8,
      required: false,
      rules: [],
      type: "url",
      validation: {},
    },
  ];
  return {
    diagnostics: [],
    event: {
      cfpClosesAt: "2026-08-13T06:59:00.000Z",
      id: "event-ai-engineer-summit",
      name: "AI Engineer Summit",
      slug: "ai-engineer-summit",
      timezone: "America/Los_Angeles",
    },
    form: {
      editAfterClose: false,
      fields,
      id: "form-ai-engineer-summit-v2",
      name: "Call for proposals",
      publishedAt: null as string | null,
      sourceVersion: 1,
      status: "draft",
      submissionLimit: 3,
      version: 2,
      welcomeContent:
        "We value specific ideas, useful lessons, and a point of view.",
    },
    publicUrl: "/e/ai-engineer-summit/cfp",
    publishedVersion: 1,
    publishable: true,
  };
}

test.beforeEach(async ({ page }) => {
  await page.context().addCookies([
    {
      httpOnly: false,
      name: "__Host-opensession-csrf",
      sameSite: "Lax",
      secure: true,
      url: "https://127.0.0.1:8787",
      value: "cfp-builder-e2e-csrf-token",
    },
  ]);
  let state = authoritativeFormFixture();
  await page.route(
    "**/api/events/ai-engineer-summit/cfp/form**",
    async (route) => {
      const request = route.request();
      if (request.method() === "GET") {
        await route.fulfill({ json: state, status: 200 });
        return;
      }
      const body = request.postDataJSON() as {
        form?: typeof state.form;
      };
      if (request.url().endsWith("/publish")) {
        state = {
          ...state,
          form: {
            ...state.form,
            publishedAt: "2026-08-10T12:00:00.000Z",
            sourceVersion: state.form.sourceVersion + 1,
            status: "published",
          },
          publishedVersion: state.form.version,
          publishable: false,
        };
      } else if (body.form) {
        state = {
          ...state,
          form: {
            ...state.form,
            ...body.form,
            sourceVersion: state.form.sourceVersion + 1,
            status: "draft",
          },
        };
      }
      await route.fulfill({
        json: { outcome: "applied", result: state },
        status: 200,
      });
    },
  );
});

async function openFreshBuilder(page: Page) {
  await page.goto(builderPath);
  await page.evaluate((key) => {
    window.localStorage.removeItem(key);
  }, storageKey);
  await page.reload();
}

test("CFP route exposes the complete visual builder", async ({ page }) => {
  await openFreshBuilder(page);

  await expect(
    page.getByRole("heading", { name: "Call for proposals", level: 1 }),
  ).toBeVisible();
  const mobileMenu = page.getByRole("button", { name: "Open navigation" });
  if (await mobileMenu.isVisible()) {
    await mobileMenu.click();
  }
  await expect(page.getByRole("link", { name: "CFP" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  if (await mobileMenu.isVisible()) {
    await page.getByRole("button", { name: "Close Event navigation" }).click();
  }
  await expect(page.locator(".cfp-palette-list > button")).toHaveCount(8);
  await expect(page.locator(".cfp-canvas-block")).toHaveCount(8);
  await expect(page.getByLabel("Label")).toHaveValue("Session title");

  const accessibilityScanResults = await new AxeBuilder({ page })
    .include(".cfp-builder-page")
    .analyze();
  expect(accessibilityScanResults.violations).toEqual([]);
});

test("field edits, insertion, reorder, and local recovery work", async ({
  page,
}) => {
  await openFreshBuilder(page);
  let writes = 0;
  page.on("request", (request) => {
    if (
      request.url().includes("/api/events/ai-engineer-summit/cfp/form") &&
      request.method() !== "GET"
    ) {
      writes += 1;
    }
  });

  await page.getByLabel("Label").fill("A title people remember");
  await page.getByRole("button", { name: "File upload" }).click();
  await expect(page.locator(".cfp-canvas-block")).toHaveCount(9);
  await expect(page.getByLabel("Stable key")).toHaveValue("file_9");

  await page.getByRole("button", { name: "Move File upload up" }).click();
  await expect(page.getByRole("status")).toContainText(/Unsaved|Saving|Saved/);
  await expect(page.getByText("Saved securely")).toBeVisible();
  expect(writes).toBe(1);

  await page.reload();
  await expect(
    page.getByRole("button", { name: "Edit A title people remember" }),
  ).toBeVisible();
  await expect(page.locator(".cfp-canvas-block")).toHaveCount(9);
  await page.waitForTimeout(900);
  expect(writes).toBe(1);

  await page.evaluate((key) => {
    window.localStorage.setItem(
      key,
      JSON.stringify([{ rules: "invalid-untrusted-shape" }]),
    );
  }, storageKey);
  await page.reload();
  await expect(page.locator(".cfp-canvas-block")).toHaveCount(9);
  await expect(
    page.getByRole("button", { name: "Edit A title people remember" }),
  ).toBeVisible();
});

test("preview and publishing explain version impact", async ({ page }) => {
  await openFreshBuilder(page);

  await page.getByRole("button", { name: "Preview" }).click();
  const preview = page.getByRole("dialog", { name: "Preview application" });
  await expect(preview).toBeVisible();
  await preview.getByRole("button", { name: "Mobile" }).click();
  await expect(preview.locator(".cfp-public-preview")).toHaveClass(/is-mobile/);
  await preview
    .getByRole("button", { name: "Close Preview application" })
    .click();

  await page.getByLabel("Label").fill("Release-safe session title");
  await expect(page.getByRole("status")).toContainText("Unsaved changes");
  await page.getByRole("button", { name: "Publish changes" }).click();
  const publish = page.getByRole("dialog", { name: "Publish version 2?" });
  await expect(publish).toContainText("Existing version 1 drafts");
  await expect(publish).toContainText("/e/ai-engineer-summit/cfp");
  await publish
    .getByRole("button", { name: "Publish version 2", exact: true })
    .click();
  await expect(page.locator(".ui-toast")).toContainText("CFP published");
  await expect(page.getByText("Published v2", { exact: true })).toBeVisible();

  await page.reload();
  await expect(
    page.getByRole("button", { name: "Edit Release-safe session title" }),
  ).toBeVisible();
});

test("conditional rule builder and preview share Workshop evaluation", async ({
  page,
}) => {
  await openFreshBuilder(page);

  await page
    .getByRole("button", { name: "Edit Workshop prerequisites" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Conditional logic" }),
  ).toBeVisible();
  await expect(page.getByText("Rule 1", { exact: true })).toBeVisible();
  await expect(page.getByText("Rule 2", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Action").nth(0)).toHaveValue("show");
  await expect(page.getByLabel("Action").nth(1)).toHaveValue("require");
  await expect(page.getByLabel("Earlier choice field").nth(0)).toHaveValue(
    "format",
  );

  await page.getByRole("button", { name: "Preview" }).click();
  const preview = page.getByRole("dialog", { name: "Preview application" });
  await expect(preview.getByLabel("Workshop prerequisites")).toHaveCount(0);
  await preview.getByLabel("Session format").selectOption("Workshop");
  await expect(preview.getByLabel("Workshop prerequisites")).toBeVisible();
  await expect(preview.getByLabel("Workshop prerequisites")).toHaveAttribute(
    "required",
  );
  await preview
    .getByLabel("Workshop prerequisites")
    .fill("Install Node.js and clone the exercise repository.");
  await preview.getByLabel("Session format").selectOption("Talk");
  await expect(preview.getByLabel("Workshop prerequisites")).toHaveCount(0);
  await preview.getByLabel("Session format").selectOption("Workshop");
  await expect(preview.getByLabel("Workshop prerequisites")).toHaveValue("");
});

test("deleted conditional references block publication with a precise repair", async ({
  page,
}) => {
  await openFreshBuilder(page);

  await page.getByRole("button", { name: "Delete Session format" }).click();
  await page.getByRole("button", { name: "Publish changes" }).click();
  const publish = page.getByRole("dialog", { name: "Publish version 2?" });
  await expect(publish).toContainText("references deleted field “format”");
  await expect(
    publish.getByRole("button", { name: "Publish version 2", exact: true }),
  ).toBeDisabled();
});

test("builder remains operable without horizontal page overflow at 360px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await openFreshBuilder(page);

  await expect(
    page.getByRole("heading", { name: "Field palette" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Application canvas" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Edit field" })).toBeVisible();

  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);

  const accessibilityScanResults = await new AxeBuilder({ page })
    .include(".cfp-builder-page")
    .analyze();
  expect(accessibilityScanResults.violations).toEqual([]);
});
