import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { mockTurnstile } from "./turnstile";

const publicPath = "/e/ai-engineer-summit/cfp";
const interactivePath = "/fixtures/public-cfp/interactive";
const draftStorageKey = "opensession.public-cfp.ai-engineer-summit.draft";
const confirmationStorageKey =
  "opensession.public-cfp.ai-engineer-summit.confirmation";
const idempotencyStorageKey =
  "opensession.public-cfp.ai-engineer-summit.idempotency";
const serverDraftStorageKey =
  "opensession.public-cfp.ai-engineer-summit.server-draft";
const unsyncedDraftStorageKey =
  "opensession.public-cfp.ai-engineer-summit.unsynced-draft";
const csrfToken = "test-csrf-token-for-public-cfp-000000000000";

const publicCfpConfiguration = {
  acceptingSubmissions: true,
  event: {
    cfpClosesAt: "2026-08-22T00:00:00.000Z",
    cfpOpensAt: "2026-07-01T16:00:00.000Z",
    endsAt: "2026-10-15T00:00:00.000Z",
    name: "AI Engineer Summit",
    slug: "ai-engineer-summit",
    startsAt: "2026-10-13T16:00:00.000Z",
    timezone: "America/Los_Angeles",
    venue: "Fort Mason Center · San Francisco",
  },
  form: {
    editAfterClose: false,
    fields: [
      {
        helpText: "",
        key: "title",
        label: "Session title",
        options: [],
        required: true,
        rules: [],
        type: "short_text",
        validation: { maxLength: 100, minLength: 8 },
      },
      {
        helpText: "What will attendees learn, and why does it matter now?",
        key: "abstract",
        label: "Abstract",
        options: [],
        required: true,
        rules: [],
        type: "long_text",
        validation: { maxLength: 1_200, minLength: 120 },
      },
      {
        helpText: "One outcome per line.",
        key: "outcomes",
        label: "Attendee outcomes",
        options: [],
        required: true,
        rules: [],
        type: "long_text",
        validation: {},
      },
      {
        helpText: "Choose the review track.",
        key: "track",
        label: "Track",
        options: ["AI Engineering", "Evaluation", "Infrastructure", "Product"],
        required: true,
        rules: [],
        type: "single_select",
        validation: {},
      },
      {
        helpText: "Choose the session length.",
        key: "format",
        label: "Format",
        options: ["30-minute talk", "45-minute talk", "90-minute workshop"],
        required: true,
        rules: [],
        type: "single_select",
        validation: {},
      },
      {
        helpText: "List required software, accounts, setup, and experience.",
        key: "workshop_prerequisites",
        label: "Workshop prerequisites",
        options: [],
        required: false,
        rules: [
          {
            effect: "show",
            id: "show-workshop-prerequisites",
            operator: "equals",
            sourceKey: "format",
            value: "90-minute workshop",
          },
          {
            effect: "require",
            id: "require-workshop-prerequisites",
            operator: "equals",
            sourceKey: "format",
            value: "90-minute workshop",
          },
        ],
        type: "long_text",
        validation: { maxLength: 4_000 },
      },
    ],
    name: "Call for proposals",
    submissionLimit: 3,
    version: 2,
    welcomeContent:
      "Bring a practical field report with clear evidence and useful tradeoffs.",
  },
  formats: ["30-minute talk", "45-minute talk", "90-minute workshop"],
  tracks: [
    {
      description:
        "Architecture, orchestration, reliability, and evaluation in production.",
      selection: "AI Engineering",
    },
    {
      description:
        "Measurement systems, evaluation practice, and quality operations.",
      selection: "Evaluation",
    },
    {
      description:
        "Platforms, inference, tooling, security, and infrastructure.",
      selection: "Infrastructure",
    },
    {
      description: "Human workflows, product strategy, and deployment.",
      selection: "Product",
    },
  ],
};

test.beforeEach(async ({ page }) => {
  await mockTurnstile(page);
  await page.route(
    "**/api/v1/public/events/ai-engineer-summit/cfp",
    async (route) => {
      await route.fulfill({
        body: JSON.stringify(publicCfpConfiguration),
        contentType: "application/json",
        status: 200,
      });
    },
  );
});

const reviewDraft = {
  abstract:
    "Agent systems fail in production for reasons that rarely appear in benchmarks. This session turns real incident patterns into practical architecture, recovery, and observability techniques.",
  consent: true,
  email: "mina@example.com",
  format: "30-minute talk",
  outcomes: "Recognize common reliability failure modes.",
  speakers: [
    {
      email: "mina@example.com",
      id: "speaker-primary",
      name: "Mina Okafor",
      role: "Principal engineer",
    },
  ],
  step: "review",
  title: "The Reliability Gap in Production Agents",
  track: "AI Engineering",
  verified: true,
};

async function clearApplication(page: Page, path = interactivePath) {
  await page.goto(path);
  await page.evaluate(
    ([draftKey, confirmationKey, serverDraftKey, unsyncedKey]) => {
      window.localStorage.removeItem(draftKey);
      window.localStorage.removeItem(confirmationKey);
      window.localStorage.removeItem(serverDraftKey);
      window.localStorage.removeItem(unsyncedKey);
    },
    [
      draftStorageKey,
      confirmationStorageKey,
      serverDraftStorageKey,
      unsyncedDraftStorageKey,
    ],
  );
  await page.reload();
}

async function storeReviewDraft(page: Page) {
  await page.evaluate(
    ([key, draft]) => window.localStorage.setItem(key, JSON.stringify(draft)),
    [draftStorageKey, reviewDraft] as const,
  );
}

async function mockVerifiedSession(page: Page) {
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
  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        csrf_token: csrfToken,
        expires_at: "2099-01-01T00:00:00.000Z",
        redirect_path: "/",
        user: {
          display_name: "Mina Okafor",
          email: "mina@example.com",
          id: "user_mina",
        },
      }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route(
    "**/api/v1/public/events/ai-engineer-summit/submissions",
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        body: JSON.stringify({ submissions: [] }),
        contentType: "application/json",
        status: 200,
      });
    },
  );
}

async function mockDraftCreation(
  page: Page,
  friendlyId: string,
  submissionId: string,
) {
  await page.route(
    "**/api/v1/public/events/ai-engineer-summit/submissions",
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        body: JSON.stringify({
          friendly_id: friendlyId,
          outcome: "applied",
          source_version: 1,
          status: "draft",
          submission_id: submissionId,
        }),
        contentType: "application/json",
        status: 201,
      });
    },
  );
}

function ownedSubmission(
  status:
    | "accepted"
    | "declined"
    | "draft"
    | "in_review"
    | "submitted"
    | "waitlisted"
    | "withdrawn",
  sourceVersion: number,
) {
  return {
    content: {
      answers: {
        abstract: reviewDraft.abstract,
        format: reviewDraft.format,
        outcomes: reviewDraft.outcomes,
        title: reviewDraft.title,
        track: reviewDraft.track,
        workshop_prerequisites: "",
      },
      participants: reviewDraft.speakers,
    },
    form_version: 2,
    friendly_id: "AES-LIFECYCLE",
    source_version: sourceVersion,
    status,
    submission_id: "submission_test_lifecycle",
    updated_at: "2026-08-10T18:30:00.000Z",
  };
}

test("anonymous welcome explains the event, deadline, tracks, limit, and support", async ({
  page,
}) => {
  await clearApplication(page, publicPath);

  await expect(
    page.getByRole("heading", {
      name: "Bring the work behind the breakthrough.",
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Friday, August 21 at 5:00 PM PDT"),
  ).toBeVisible();
  await expect(page.getByText("Up to 3 proposals")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "AI Engineering" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "hello@opensessionboard.com" }).first(),
  ).toBeVisible();

  const results = await new AxeBuilder({ page })
    .include(".public-cfp-flow")
    .analyze();
  expect(results.violations).toEqual([]);
});

test("verified applicant completes participants, review, consent, and one final submission", async ({
  page,
}) => {
  await clearApplication(page);

  await page.getByRole("button", { name: "Start a proposal" }).click();
  await page.getByLabel("Email address").fill("mina@example.com");
  await page.getByRole("button", { name: "Email my private link" }).click();
  await expect(
    page.getByRole("heading", { name: "Check your inbox" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Continue from verified fixture" })
    .click();
  await expect(page.getByText("Email verified")).toBeVisible();
  await page.getByRole("button", { name: "Continue to your proposal" }).click();

  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByRole("heading", { name: "Complete the proposal" }),
  ).toBeVisible();
  await expect(page.getByLabel("Session title")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await page
    .getByRole("link", {
      name: "Use at least 8 characters for the session title.",
    })
    .click();
  await expect(page.getByLabel("Session title")).toBeFocused();

  await page
    .getByLabel("Session title")
    .fill("The Reliability Gap in Production Agents");
  await page
    .getByLabel("Abstract")
    .fill(
      "Agent systems fail in production for reasons that rarely appear in benchmarks. This session turns real incident patterns into practical architecture, recovery, and observability techniques.",
    );
  await page
    .getByLabel("What will attendees be able to do?")
    .fill(
      "Recognize common reliability failure modes.\nChoose useful human checkpoints.\nInstrument retries so incidents remain explainable.",
    );
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByLabel("Display name").fill("Mina Okafor");
  await expect(page.getByLabel("Email")).toHaveValue("mina@example.com");
  await page.getByLabel("Title or role").fill("Principal engineer");
  await page.getByRole("button", { name: "Add a co-speaker" }).click();
  await page.getByLabel("Display name").nth(1).fill("Alex Chen");
  await page.getByLabel("Email").nth(1).fill("alex@example.com");
  await page.getByLabel("Title or role").nth(1).fill("Staff product engineer");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(
    page.getByRole("heading", { name: "Review before submitting." }),
  ).toBeVisible();
  await expect(page.getByText("Alex Chen")).toBeVisible();
  await page.getByRole("button", { name: "Submit proposal" }).click();
  await expect(
    page.getByRole("heading", { name: "One confirmation remains" }),
  ).toBeVisible();
  await page.getByLabel(/I confirm everyone listed agreed/).check();
  await page.getByRole("button", { name: "Submit proposal" }).dblclick();

  await expect(
    page.getByRole("heading", { name: "You’re in the review queue." }),
  ).toBeVisible();
  const confirmation = await page
    .locator(".public-cfp-confirmation-id strong")
    .textContent();
  expect(confirmation).toMatch(/^AES-\d{6}$/);

  await page.reload();
  await expect(page.locator(".public-cfp-confirmation-id strong")).toHaveText(
    confirmation ?? "",
  );
});

test("participant limits and duplicate emails fail inline before secure sync", async ({
  page,
}) => {
  await clearApplication(page);
  await page.evaluate(
    ([key, draft]) => window.localStorage.setItem(key, JSON.stringify(draft)),
    [
      draftStorageKey,
      { ...reviewDraft, consent: false, step: "participants" },
    ] as const,
  );
  await page.reload();

  await page.getByRole("button", { name: "Add a co-speaker" }).click();
  await page.getByLabel("Display name").nth(1).fill("Duplicate Speaker");
  await page.getByLabel("Email").nth(1).fill("a@@b.com");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator("#speaker-1-email-error")).toHaveText(
    "Enter a valid email address.",
  );
  await page.getByLabel("Email").nth(1).fill("mina@example.com");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator("#speaker-1-email-error")).toHaveText(
    "Each participant email address must be unique.",
  );

  await page.getByLabel("Email").nth(1).fill("speaker-2@example.com");
  for (let index = 3; index <= 8; index += 1) {
    await page.getByRole("button", { name: "Add a co-speaker" }).click();
  }
  await expect(
    page.getByRole("button", { name: "Participant limit reached" }),
  ).toBeDisabled();
});

test("Workshop conditions announce, require, and clear hidden answers", async ({
  page,
}) => {
  await clearApplication(page);
  await page.getByRole("button", { name: "Start a proposal" }).click();
  await page.getByLabel("Email address").fill("mina@example.com");
  await page.getByRole("button", { name: "Email my private link" }).click();
  await page
    .getByRole("button", { name: "Continue from verified fixture" })
    .click();
  await page.getByRole("button", { name: "Continue to your proposal" }).click();

  await page
    .getByLabel("Session title")
    .fill("A practical production workshop");
  await page
    .getByLabel("Abstract")
    .fill(
      "This hands-on workshop turns production incident patterns into repeatable architecture, recovery, and observability exercises for teams operating agent systems.",
    );
  await page
    .getByLabel("What will attendees be able to do?")
    .fill("Diagnose a failure and select a safe recovery strategy.");
  await page.getByLabel("Track").selectOption("Product");
  await expect(page.locator(".public-cfp-route-note")).toContainText(
    "Product · Track D",
  );
  await page.getByLabel("Format").selectOption("90-minute workshop");
  await expect(page.getByLabel("Workshop prerequisites")).toBeVisible();
  await expect(page.locator(".ui-sr-only")).toContainText(
    "Workshop prerequisites is now visible and required.",
  );

  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByRole("link", {
      name: "Add workshop prerequisites before continuing.",
    }),
  ).toBeVisible();
  await page
    .getByLabel("Workshop prerequisites")
    .fill("Bring a laptop with Node.js and Git installed.");
  await page.getByLabel("Format").selectOption("30-minute talk");
  await expect(page.getByLabel("Workshop prerequisites")).toHaveCount(0);
  await expect(page.locator(".ui-sr-only")).toContainText(
    "Its saved answer was cleared.",
  );
  await page.getByLabel("Format").selectOption("90-minute workshop");
  await expect(page.getByLabel("Workshop prerequisites")).toHaveValue("");
});

test("Product selection submits one canonical Track D reviewer route", async ({
  page,
}) => {
  await mockVerifiedSession(page);
  await mockDraftCreation(page, "AES-777777", "submission_test_777777");
  let payload: unknown;
  let csrfHeader = "";
  await page.route(
    "**/api/v1/public/events/ai-engineer-summit/submissions/submission_test_777777",
    async (route) => {
      payload = route.request().postDataJSON();
      csrfHeader = route.request().headers()["x-csrf-token"] ?? "";
      await route.fulfill({
        body: JSON.stringify({
          friendly_id: "AES-777777",
          outcome: "applied",
          source_version: 2,
          status: "submitted",
          submission_id: "submission_test_777777",
        }),
        contentType: "application/json",
        status: 200,
      });
    },
  );

  await page.goto(publicPath);
  await page.evaluate(
    ([key, draft]) =>
      window.localStorage.setItem(
        key,
        JSON.stringify({ ...draft, track: "Product" }),
      ),
    [draftStorageKey, reviewDraft] as const,
  );
  await page.reload();
  await page.getByRole("button", { name: "Submit proposal" }).click();
  await expect(page.locator(".public-cfp-confirmation-id strong")).toHaveText(
    "AES-777777",
  );
  expect(payload).toMatchObject({
    answers: { track: "Product" },
    expected_source_version: 1,
    form_version: 2,
    mode: "submit",
    participant_consent: true,
    turnstile_action: "cfp_submit",
    turnstile_token: expect.stringMatching(/^test-token-/),
  });
  expect(payload).not.toHaveProperty("routing");
  expect(csrfHeader).toBe(csrfToken);
});

test("authenticated changes autosave once, then use the projected source version", async ({
  page,
}) => {
  await mockVerifiedSession(page);
  let createdPayload: Record<string, unknown> | undefined;
  let updatedPayload: Record<string, unknown> | undefined;
  let createdCsrf = "";
  let updatedCsrf = "";
  await page.route(
    "**/api/v1/public/events/ai-engineer-summit/submissions",
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      createdPayload = route.request().postDataJSON() as Record<
        string,
        unknown
      >;
      createdCsrf = route.request().headers()["x-csrf-token"] ?? "";
      await route.fulfill({
        body: JSON.stringify({
          friendly_id: "AES-AUTOSAVE",
          outcome: "applied",
          source_version: 1,
          status: "draft",
          submission_id: "submission_test_autosave",
        }),
        contentType: "application/json",
        status: 201,
      });
    },
  );
  await page.route(
    "**/api/v1/public/events/ai-engineer-summit/submissions/submission_test_autosave",
    async (route) => {
      updatedPayload = route.request().postDataJSON() as Record<
        string,
        unknown
      >;
      updatedCsrf = route.request().headers()["x-csrf-token"] ?? "";
      await route.fulfill({
        body: JSON.stringify({
          friendly_id: "AES-AUTOSAVE",
          outcome: "applied",
          source_version: 2,
          status: "draft",
          submission_id: "submission_test_autosave",
        }),
        contentType: "application/json",
        status: 200,
      });
    },
  );

  await page.goto(publicPath);
  const configurationLoaded = page.waitForResponse(
    (response) => response.url().endsWith("/cfp") && response.status() === 200,
  );
  const sessionLoaded = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/auth/session") && response.status() === 200,
  );
  await storeReviewDraft(page);
  await page.reload();
  await Promise.all([configurationLoaded, sessionLoaded]);
  await page.getByRole("button", { name: "Edit participants" }).click();
  await page.getByLabel("Title or role").fill("Principal systems engineer");
  await expect(page.locator(".public-cfp-save")).toContainText(
    "Saved securely",
  );
  expect(createdPayload).toMatchObject({
    answers: { title: reviewDraft.title },
    form_version: 2,
    mode: "draft",
  });
  expect(createdPayload).not.toHaveProperty("routing");
  expect(createdCsrf).toBe(csrfToken);

  await page.getByLabel("Title or role").fill("Principal engineer");
  await expect
    .poll(() => updatedPayload)
    .toMatchObject({ expected_source_version: 1, mode: "draft" });
  await expect(page.locator(".public-cfp-save")).toContainText(
    "Saved securely",
  );
  expect(updatedCsrf).toBe(csrfToken);
  await expect
    .poll(() =>
      page.evaluate((key) => {
        const stored = window.localStorage.getItem(key);
        return stored ? JSON.parse(stored).sourceVersion : null;
      }, serverDraftStorageKey),
    )
    .toBe(2);
});

test("slow consecutive saves resolve the latest source version at execution", async ({
  page,
}) => {
  await mockVerifiedSession(page);
  const remote = ownedSubmission("draft", 1);
  remote.friendly_id = "AES-SERIAL-SAVE";
  remote.submission_id = "submission_serial_save";
  await page.route(
    "**/api/v1/public/events/ai-engineer-summit/submissions",
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        body: JSON.stringify({ submissions: [remote] }),
        contentType: "application/json",
        status: 200,
      });
    },
  );
  let releaseFirst: (() => void) | undefined;
  let markFirstStarted: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const expectedVersions: number[] = [];
  await page.route(
    "**/api/v1/public/events/ai-engineer-summit/submissions/submission_serial_save",
    async (route) => {
      const body = route.request().postDataJSON() as {
        expected_source_version: number;
      };
      expectedVersions.push(body.expected_source_version);
      if (expectedVersions.length === 1) {
        markFirstStarted?.();
        await firstReleased;
      }
      await route.fulfill({
        body: JSON.stringify({
          friendly_id: remote.friendly_id,
          outcome: "applied",
          source_version: expectedVersions.length + 1,
          status: "draft",
          submission_id: remote.submission_id,
        }),
        contentType: "application/json",
        status: 200,
      });
    },
  );

  await page.goto(publicPath);
  const title = page.getByLabel("Session title");
  await title.fill("First slow save remains in flight");
  await firstStarted;
  await title.fill("Second save uses the committed version");
  await page.waitForTimeout(800);
  releaseFirst?.();
  await expect.poll(() => expectedVersions).toEqual([1, 2]);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.locator(".public-cfp-save")).toContainText(
    "Saved securely",
  );
});

test("a fresh browser resumes the latest owned draft from the server", async ({
  page,
}) => {
  await mockVerifiedSession(page);
  await page.route(
    "**/api/v1/public/events/ai-engineer-summit/submissions",
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        body: JSON.stringify({
          submissions: [
            {
              content: {
                answers: {
                  abstract: reviewDraft.abstract,
                  format: reviewDraft.format,
                  outcomes: reviewDraft.outcomes,
                  title: reviewDraft.title,
                  track: reviewDraft.track,
                  workshop_prerequisites: "",
                },
                participants: reviewDraft.speakers,
              },
              form_version: 2,
              friendly_id: "AES-RESUME",
              source_version: 7,
              status: "draft",
              submission_id: "submission_test_resume",
              updated_at: "2026-08-10T18:30:00.000Z",
            },
          ],
        }),
        contentType: "application/json",
        status: 200,
      });
    },
  );

  await page.goto(publicPath);
  await expect(
    page.getByRole("heading", { name: "Shape the session." }),
  ).toBeVisible();
  await expect(page.getByLabel("Session title")).toHaveValue(reviewDraft.title);
  await expect(page.locator(".public-cfp-save")).toContainText(
    "Saved securely",
  );
  await expect(page.locator(".ui-sr-only")).toContainText(
    "Draft AES-RESUME resumed securely.",
  );
  await expect
    .poll(() =>
      page.evaluate(
        (key) => window.localStorage.getItem(key),
        serverDraftStorageKey,
      ),
    )
    .toContain("submission_test_resume");
});

test("a concurrent device edit requires an export before either version can replace the other", async ({
  page,
}) => {
  await mockVerifiedSession(page);
  const baseline = ownedSubmission("draft", 1);
  const remote = ownedSubmission("draft", 2);
  remote.content.answers.title = "The server-side proposal title";
  const deviceDraft = {
    ...reviewDraft,
    title: "The device-side proposal title",
  };
  const metadata = {
    friendlyId: baseline.friendly_id,
    formVersion: baseline.form_version,
    lastSyncedFingerprint: JSON.stringify({
      content: baseline.content,
      formVersion: baseline.form_version,
    }),
    sourceVersion: 1,
    submissionId: baseline.submission_id,
  };
  await page.addInitScript(
    ({ draftKey, draftValue, metadataKey, metadataValue }) => {
      window.localStorage.setItem(draftKey, JSON.stringify(draftValue));
      window.localStorage.setItem(metadataKey, JSON.stringify(metadataValue));
    },
    {
      draftKey: draftStorageKey,
      draftValue: deviceDraft,
      metadataKey: serverDraftStorageKey,
      metadataValue: metadata,
    },
  );
  await page.route(
    "**/api/v1/public/events/ai-engineer-summit/submissions",
    async (route) => {
      await route.fulfill({
        body: JSON.stringify({ submissions: [remote] }),
        contentType: "application/json",
        status: 200,
      });
    },
  );

  await page.goto(publicPath);
  await expect(
    page.getByRole("alertdialog", { name: "Choose the version to keep." }),
  ).toBeVisible();
  await expect(page.getByText("The device-side proposal title")).toBeVisible();
  await expect(page.getByText("The server-side proposal title")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Use server version" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Download both versions" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Download both versions" }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    page.getByRole("button", { name: "Download both versions" }),
  ).toBeFocused();
  expect(
    (await new AxeBuilder({ page }).include(".public-cfp-card").analyze())
      .violations,
  ).toEqual([]);

  const downloadStarted = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download both versions" }).click();
  const download = await downloadStarted;
  expect(download.suggestedFilename()).toMatch(
    /^opensession-draft-conflict-.*\.json$/,
  );
  await expect(
    page.getByRole("button", { name: "Use server version" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Use server version" }).click();
  await expect(page.getByLabel("Session title")).toHaveValue(
    "The server-side proposal title",
  );
  await expect(page.getByRole("main")).toBeFocused();
});

test("an autosave conflict re-reads authority state and preserves both versions", async ({
  page,
}) => {
  await mockVerifiedSession(page);
  const initial = ownedSubmission("draft", 1);
  const advanced = ownedSubmission("draft", 2);
  advanced.content.answers.title = "Server advanced while saving";
  let reads = 0;
  await page.route(
    "**/api/v1/public/events/ai-engineer-summit/submissions",
    async (route) => {
      reads += 1;
      await route.fulfill({
        body: JSON.stringify({
          submissions: [reads === 1 ? initial : advanced],
        }),
        contentType: "application/json",
        status: 200,
      });
    },
  );
  await page.route(
    "**/api/v1/public/events/ai-engineer-summit/submissions/submission_test_lifecycle",
    async (route) => {
      await route.fulfill({
        body: JSON.stringify({
          error: {
            code: "source_version_conflict",
            message: "This proposal changed elsewhere.",
          },
          request_id: "request_conflict",
        }),
        contentType: "application/json",
        status: 409,
      });
    },
  );

  await page.goto(publicPath);
  await expect(page.getByLabel("Session title")).toHaveValue(reviewDraft.title);
  await page.getByLabel("Session title").fill("Device changed while saving");
  await expect(
    page.getByRole("alertdialog", { name: "Choose the version to keep." }),
  ).toBeVisible();
  expect(reads).toBeGreaterThanOrEqual(2);
  await expect(page.getByText("Device changed while saving")).toBeVisible();
  await expect(page.getByText("Server advanced while saving")).toBeVisible();
});

test("a deadline-policy 409 stops sync without inventing a version conflict", async ({
  page,
}) => {
  await mockVerifiedSession(page);
  let reads = 0;
  await page.route(
    "**/api/v1/public/events/ai-engineer-summit/submissions",
    async (route) => {
      reads += 1;
      await route.fulfill({
        body: JSON.stringify({ submissions: [ownedSubmission("draft", 2)] }),
        contentType: "application/json",
        status: 200,
      });
    },
  );
  await page.route(
    "**/api/v1/public/events/ai-engineer-summit/submissions/submission_test_lifecycle",
    async (route) => {
      await route.fulfill({
        body: JSON.stringify({
          error: {
            code: "cfp_closed",
            message: "The call no longer permits draft edits.",
          },
          request_id: "request_closed",
        }),
        contentType: "application/json",
        status: 409,
      });
    },
  );

  await page.goto(publicPath);
  await page.getByLabel("Session title").fill("A change after the deadline");
  await expect(page.getByRole("alert")).toContainText(
    "The call no longer permits this save",
  );
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect(reads).toBe(1);
});

test("switching proposals invalidates an in-flight autosave without cross-writing", async ({
  page,
}) => {
  await mockVerifiedSession(page);
  const proposalA = {
    ...ownedSubmission("draft", 2),
    friendly_id: "AES-PROPOSAL-A",
    submission_id: "submission_proposal_a",
  };
  proposalA.content = {
    ...proposalA.content,
    answers: { ...proposalA.content.answers, title: "Proposal A" },
  };
  const proposalB = {
    ...ownedSubmission("draft", 5),
    friendly_id: "AES-PROPOSAL-B",
    submission_id: "submission_proposal_b",
  };
  proposalB.content = {
    ...proposalB.content,
    answers: { ...proposalB.content.answers, title: "Proposal B" },
  };
  await page.route(
    "**/api/v1/public/events/ai-engineer-summit/submissions",
    async (route) => {
      await route.fulfill({
        body: JSON.stringify({ submissions: [proposalA, proposalB] }),
        contentType: "application/json",
        status: 200,
      });
    },
  );
  let releaseProposalA: (() => void) | undefined;
  const proposalAReleased = new Promise<void>((resolve) => {
    releaseProposalA = resolve;
  });
  let proposalBWrites = 0;
  await page.route(
    "**/api/v1/public/events/ai-engineer-summit/submissions/submission_proposal_a",
    async (route) => {
      await proposalAReleased;
      await route.fulfill({
        body: JSON.stringify({
          friendly_id: proposalA.friendly_id,
          outcome: "applied",
          source_version: 3,
          status: "draft",
          submission_id: proposalA.submission_id,
        }),
        contentType: "application/json",
        status: 200,
      });
    },
  );
  await page.route(
    "**/api/v1/public/events/ai-engineer-summit/submissions/submission_proposal_b",
    async (route) => {
      proposalBWrites += 1;
      await route.fulfill({ status: 500 });
    },
  );

  await page.goto(publicPath);
  await page
    .locator("article")
    .filter({ hasText: "Proposal A" })
    .getByRole("button", { name: "Continue this draft" })
    .click();
  const proposalARequest = page.waitForRequest((request) =>
    request.url().endsWith("/submissions/submission_proposal_a"),
  );
  await page.getByLabel("Session title").fill("Proposal A edited locally");
  await proposalARequest;
  await page.getByRole("button", { name: "View all your proposals" }).click();
  await page
    .locator("article")
    .filter({ hasText: "Proposal B" })
    .getByRole("button", { name: "Continue this draft" })
    .click();
  releaseProposalA?.();

  await expect(page.getByLabel("Session title")).toHaveValue("Proposal B");
  await page.waitForTimeout(900);
  expect(proposalBWrites).toBe(0);
  await expect
    .poll(() =>
      page.evaluate((key) => {
        const stored = window.localStorage.getItem(key);
        return stored ? JSON.parse(stored).submissionId : null;
      }, serverDraftStorageKey),
    )
    .toBe("submission_proposal_b");
  await page.getByRole("button", { name: "View all your proposals" }).click();
  await expect(page.getByText("Proposal A edited locally")).toBeVisible();
});

test("an unsynced device proposal remains a distinct dashboard choice", async ({
  page,
}) => {
  await mockVerifiedSession(page);
  const localDraft = {
    ...reviewDraft,
    title: "Unsynced proposal on this device",
  };
  await page.addInitScript(
    ({ key, value }) => window.localStorage.setItem(key, JSON.stringify(value)),
    { key: draftStorageKey, value: localDraft },
  );
  const serverA = {
    ...ownedSubmission("draft", 2),
    friendly_id: "AES-SERVER-A",
    submission_id: "submission_server_a",
  };
  serverA.content = {
    ...serverA.content,
    answers: { ...serverA.content.answers, title: "Server proposal A" },
  };
  const serverB = {
    ...ownedSubmission("submitted", 4),
    friendly_id: "AES-SERVER-B",
    submission_id: "submission_server_b",
  };
  serverB.content = {
    ...serverB.content,
    answers: { ...serverB.content.answers, title: "Server proposal B" },
  };
  await page.route(
    "**/api/v1/public/events/ai-engineer-summit/submissions",
    async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          body: JSON.stringify({
            friendly_id: "AES-DEVICE-SYNCED",
            outcome: "applied",
            source_version: 1,
            status: "draft",
            submission_id: "submission_device_synced",
          }),
          contentType: "application/json",
          status: 201,
        });
        return;
      }
      await route.fulfill({
        body: JSON.stringify({ submissions: [serverA, serverB] }),
        contentType: "application/json",
        status: 200,
      });
    },
  );

  await page.goto(publicPath);
  await expect(
    page.getByText("Unsynced proposal on this device"),
  ).toBeVisible();
  await expect(page.getByText("Server proposal A")).toBeVisible();
  await expect(page.getByText("Server proposal B")).toBeVisible();
  await page
    .getByRole("button", {
      name: "Continue this draft: Server proposal A (AES-SERVER-A)",
    })
    .click();
  await expect(page.getByLabel("Session title")).toHaveValue(
    "Server proposal A",
  );
  await page.getByRole("button", { name: "View all your proposals" }).click();
  await expect(
    page.getByText("Unsynced proposal on this device"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue device proposal" }).click();
  await page.getByRole("button", { name: "Edit proposal" }).click();
  await expect(page.getByLabel("Session title")).toHaveValue(
    "Unsynced proposal on this device",
  );
  await page
    .getByLabel("Session title")
    .fill("Edited device proposal now synced once");
  await expect(page.locator(".public-cfp-save")).toContainText(
    "Saved securely",
  );
  await page.getByRole("button", { name: "View all your proposals" }).click();
  await expect(page.getByText("This device · Not yet synced")).toHaveCount(0);
  await expect(
    page.getByText("Edited device proposal now synced once"),
  ).toHaveCount(1);
});

test("closed calls preserve permitted draft edits but disable final submission", async ({
  page,
}) => {
  await mockVerifiedSession(page);
  await page.route(
    "**/api/v1/public/events/ai-engineer-summit/cfp",
    async (route) => {
      await route.fulfill({
        body: JSON.stringify({
          ...publicCfpConfiguration,
          acceptingSubmissions: false,
          form: { ...publicCfpConfiguration.form, editAfterClose: true },
        }),
        contentType: "application/json",
        status: 200,
      });
    },
  );
  await page.route(
    "**/api/v1/public/events/ai-engineer-summit/submissions",
    async (route) => {
      await route.fulfill({
        body: JSON.stringify({ submissions: [ownedSubmission("draft", 4)] }),
        contentType: "application/json",
        status: 200,
      });
    },
  );

  await page.goto(publicPath);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByText("The submission deadline has passed."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Submit proposal" }),
  ).toBeDisabled();
});

test("multiple owned proposals expose lifecycle status and allow another draft", async ({
  page,
}) => {
  await mockVerifiedSession(page);
  const draft = ownedSubmission("draft", 3);
  const accepted = {
    ...ownedSubmission("accepted", 5),
    friendly_id: "AES-ACCEPTED",
    submission_id: "submission_test_accepted",
  };
  accepted.content = {
    ...accepted.content,
    answers: {
      ...accepted.content.answers,
      title: "An accepted proposal",
    },
  };
  await page.route(
    "**/api/v1/public/events/ai-engineer-summit/submissions",
    async (route) => {
      await route.fulfill({
        body: JSON.stringify({ submissions: [draft, accepted] }),
        contentType: "application/json",
        status: 200,
      });
    },
  );

  await page.goto(publicPath);
  await expect(
    page.getByRole("heading", { name: "Choose a proposal." }),
  ).toBeVisible();
  await page
    .locator("article")
    .filter({ hasText: "An accepted proposal" })
    .getByRole("button", { name: "View this status" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your proposal was accepted." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "View all your proposals" }).click();
  await page.getByRole("button", { name: "Start another proposal" }).click();
  await expect(
    page.getByRole("heading", { name: "Shape the session." }),
  ).toBeVisible();
});

test("an alternate event slug drives configuration and browser storage scope", async ({
  page,
}) => {
  const alternateConfiguration = {
    ...publicCfpConfiguration,
    event: {
      ...publicCfpConfiguration.event,
      name: "Community Systems Day",
      slug: "community-systems-day",
    },
    form: {
      ...publicCfpConfiguration.form,
      fields: publicCfpConfiguration.form.fields.map((field) =>
        field.key === "track"
          ? { ...field, options: ["Community"] }
          : field.key === "format"
            ? { ...field, options: ["Lightning talk"] }
            : field.key === "workshop_prerequisites"
              ? { ...field, rules: [] }
              : field,
      ),
    },
    formats: ["Lightning talk"],
    tracks: [
      {
        description: "Local infrastructure and community operations.",
        selection: "Community",
      },
    ],
  };
  await page.route(
    "**/api/v1/public/events/community-systems-day/cfp",
    async (route) => {
      await route.fulfill({
        body: JSON.stringify(alternateConfiguration),
        contentType: "application/json",
        status: 200,
      });
    },
  );

  await page.goto("/e/community-systems-day/cfp");
  await expect(page.getByText("Community Systems Day").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Community" })).toBeVisible();
  await page.getByRole("button", { name: "Start a proposal" }).click();
  await page.getByLabel("Email address").fill("alternate@example.com");
  await expect
    .poll(() =>
      page.evaluate(() => ({
        alternate: window.localStorage.getItem(
          "opensession.public-cfp.community-systems-day.draft",
        ),
        defaultValue: window.localStorage.getItem(
          "opensession.public-cfp.ai-engineer-summit.draft",
        ),
      })),
    )
    .toMatchObject({
      alternate: expect.stringContaining("alternate@example.com"),
      defaultValue: null,
    });
});

test("a failed owned-submission read blocks duplicate draft creation", async ({
  page,
}) => {
  await mockVerifiedSession(page);
  let postCount = 0;
  await page.route(
    "**/api/v1/public/events/ai-engineer-summit/submissions",
    async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ status: 503 });
        return;
      }
      postCount += 1;
      await route.fulfill({ status: 500 });
    },
  );

  await page.goto(publicPath);
  await storeReviewDraft(page);
  await page.reload();
  await expect(page.locator(".ui-sr-only")).toContainText(
    "Your server drafts could not be checked",
  );
  await expect(page.getByRole("alert")).toContainText(
    "Server drafts could not be checked",
  );
  await expect(
    page.getByRole("button", { name: "Retry connection" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Submit proposal" }).click();
  await expect(
    page.getByText(/could not sync this exact version/i),
  ).toBeVisible();
  expect(postCount).toBe(0);
});

test("an account change quarantines the previous browser user's draft before ownership fails", async ({
  page,
}) => {
  await mockVerifiedSession(page);
  await page.addInitScript(
    ({ key, value }) => window.localStorage.setItem(key, JSON.stringify(value)),
    {
      key: draftStorageKey,
      value: {
        ...reviewDraft,
        email: "previous@example.com",
        speakers: [
          {
            ...reviewDraft.speakers[0],
            email: "previous@example.com",
          },
        ],
        step: "account",
      },
    },
  );
  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        csrf_token: csrfToken,
        expires_at: "2099-01-01T00:00:00.000Z",
        redirect_path: "/",
        user: {
          display_name: "New Account",
          email: "new-account@example.com",
          id: "user_new_account",
        },
      }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route(
    "**/api/v1/public/events/ai-engineer-summit/submissions",
    async (route) => route.fulfill({ status: 503 }),
  );

  await page.goto(publicPath);
  await expect(page.getByText("new-account@example.com")).toBeVisible();
  await expect(page.getByText("previous@example.com")).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText(
    "Server drafts could not be checked",
  );
});

test("a transient session-read failure exposes a manual recovery path", async ({
  page,
}) => {
  await page.addInitScript(
    ({ key, value }) => window.localStorage.setItem(key, JSON.stringify(value)),
    {
      key: draftStorageKey,
      value: {
        ...reviewDraft,
        email: "previous-session@example.com",
        speakers: [
          {
            ...reviewDraft.speakers[0],
            email: "previous-session@example.com",
          },
        ],
        step: "account",
      },
    },
  );
  let sessionReads = 0;
  await page.route("**/api/auth/session", async (route) => {
    sessionReads += 1;
    if (sessionReads === 1) {
      await route.fulfill({ status: 503 });
      return;
    }
    await route.fulfill({
      body: JSON.stringify({
        csrf_token: csrfToken,
        expires_at: "2099-01-01T00:00:00.000Z",
        redirect_path: "/",
        user: {
          display_name: "Mina Okafor",
          email: "mina@example.com",
          id: "user_mina",
        },
      }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route(
    "**/api/v1/public/events/ai-engineer-summit/submissions",
    async (route) =>
      route.fulfill({
        body: JSON.stringify({ submissions: [] }),
        contentType: "application/json",
        status: 200,
      }),
  );

  await page.goto(publicPath);
  await expect(page.getByRole("alert")).toContainText(
    "Your sign-in session could not be checked",
  );
  await expect(
    page.getByRole("heading", { name: "We could not verify this session" }),
  ).toBeVisible();
  await expect(page.getByText("previous-session@example.com")).toHaveCount(0);
  await page.getByRole("button", { name: "Retry connection" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(sessionReads).toBe(2);
});

test("a pre-open call reports its opening time instead of claiming it closed", async ({
  page,
}) => {
  await page.route(
    "**/api/v1/public/events/ai-engineer-summit/cfp",
    async (route) => {
      await route.fulfill({
        body: JSON.stringify({
          ...publicCfpConfiguration,
          acceptingSubmissions: false,
          event: {
            ...publicCfpConfiguration.event,
            cfpOpensAt: "2099-07-01T16:00:00.000Z",
          },
        }),
        contentType: "application/json",
        status: 200,
      });
    },
  );

  await page.goto(publicPath);
  await expect(
    page.getByRole("heading", {
      name: "The call for proposals is not open yet",
    }),
  ).toBeVisible();
  await expect(page.getByText(/opens Wednesday, July 1/i)).toBeVisible();
  await expect(page.getByText(/already closed/i)).toHaveCount(0);
});

test("a submitted proposal restores authoritative confirmation after reload", async ({
  page,
}) => {
  await mockVerifiedSession(page);
  let current: ReturnType<typeof ownedSubmission> | null = null;
  let postCount = 0;
  await page.route(
    "**/api/v1/public/events/ai-engineer-summit/submissions",
    async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          body: JSON.stringify({ submissions: current ? [current] : [] }),
          contentType: "application/json",
          status: 200,
        });
        return;
      }
      postCount += 1;
      current = ownedSubmission("draft", 1);
      await route.fulfill({
        body: JSON.stringify({
          friendly_id: current.friendly_id,
          outcome: "applied",
          source_version: 1,
          status: "draft",
          submission_id: current.submission_id,
        }),
        contentType: "application/json",
        status: 201,
      });
    },
  );
  await page.route(
    "**/api/v1/public/events/ai-engineer-summit/submissions/submission_test_lifecycle",
    async (route) => {
      current = ownedSubmission("submitted", 2);
      await route.fulfill({
        body: JSON.stringify({
          friendly_id: current.friendly_id,
          outcome: "applied",
          source_version: 2,
          status: "submitted",
          submission_id: current.submission_id,
        }),
        contentType: "application/json",
        status: 200,
      });
    },
  );

  await page.goto(publicPath);
  await storeReviewDraft(page);
  await page.reload();
  await page.getByRole("button", { name: "Submit proposal" }).click();
  await expect(page.locator(".public-cfp-confirmation-id strong")).toHaveText(
    "AES-LIFECYCLE",
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "You’re in the review queue." }),
  ).toBeVisible();
  await expect(page.locator(".public-cfp-confirmation-id strong")).toHaveText(
    "AES-LIFECYCLE",
  );
  expect(postCount).toBe(1);
});

test("explicit fixtures cover server policy and durable recovery states", async ({
  page,
}) => {
  await page.goto("/fixtures/public-cfp/closed");
  await expect(
    page.getByRole("heading", { name: "The call for proposals is closed" }),
  ).toBeVisible();
  await expect(page.getByText("America/Los_Angeles")).toBeVisible();

  await page.goto("/fixtures/public-cfp/limit");
  await expect(
    page.getByRole("heading", { name: "Submission limit reached" }),
  ).toBeVisible();

  await page.goto("/fixtures/public-cfp/resume");
  await expect(
    page.getByRole("heading", { name: "Who is presenting?" }),
  ).toBeVisible();
  await expect(page.getByLabel("Display name")).toHaveValue("Mina Okafor");
  await expect(page.locator(".public-cfp-save")).toContainText(
    "Saved on this device",
  );

  await page.goto("/fixtures/public-cfp/offline");
  await page.getByLabel("Display name").fill("Mina O.");
  await expect(page.locator(".public-cfp-save")).toContainText(
    "Offline · saved on this device",
  );

  await page.goto("/fixtures/public-cfp/failed");
  await page.getByLabel("Display name").fill("Mina Okafor");
  await expect(page.locator(".public-cfp-save")).toContainText(
    "Sync failed · saved on this device",
  );
});

test("production public URL ignores caller-controlled fixture query values", async ({
  page,
}) => {
  await clearApplication(page, `${publicPath}?state=closed`);
  await expect(
    page.getByRole("heading", {
      name: "Bring the work behind the breakthrough.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "The call for proposals is closed" }),
  ).toHaveCount(0);
});

test("production final submission fails closed and preserves the draft when the API rejects", async ({
  page,
}) => {
  await mockVerifiedSession(page);
  await mockDraftCreation(page, "AES-503503", "submission_test_503503");
  let requestCount = 0;
  let idempotencyKey = "";
  await page.route(
    "**/api/v1/public/events/ai-engineer-summit/submissions/submission_test_503503",
    async (route) => {
      requestCount += 1;
      idempotencyKey = route.request().headers()["idempotency-key"] ?? "";
      await route.fulfill({
        body: JSON.stringify({ error: { code: "temporarily_unavailable" } }),
        contentType: "application/json",
        status: 503,
      });
    },
  );

  await page.goto(publicPath);
  await storeReviewDraft(page);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Review before submitting." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Submit proposal" }).click();

  await expect(
    page.getByRole("heading", { name: "Your proposal was not submitted" }),
  ).toBeVisible();
  await expect(page.locator(".public-cfp-confirmation-id")).toHaveCount(0);
  expect(requestCount).toBe(1);
  expect(idempotencyKey).not.toBe("");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Review before submitting." }),
  ).toBeVisible();
});

test("429 Retry-After preserves the draft and reuses the idempotency key", async ({
  page,
}) => {
  await mockVerifiedSession(page);
  await mockDraftCreation(page, "AES-429429", "submission_test_429429");
  const idempotencyKeys: string[] = [];
  await page.route(
    "**/api/v1/public/events/ai-engineer-summit/submissions/submission_test_429429",
    async (route) => {
      idempotencyKeys.push(
        route.request().headers()["idempotency-key"] ?? "missing",
      );
      if (idempotencyKeys.length === 1) {
        await route.fulfill({
          body: JSON.stringify({ error: { code: "rate_limited" } }),
          contentType: "application/json",
          headers: { "Retry-After": "90" },
          status: 429,
        });
        return;
      }
      await route.fulfill({
        body: JSON.stringify({
          friendly_id: "AES-429429",
          outcome: "applied",
          source_version: 2,
          status: "submitted",
          submission_id: "submission_test_429429",
        }),
        contentType: "application/json",
        status: 200,
      });
    },
  );

  await page.goto(publicPath);
  await storeReviewDraft(page);
  await page.reload();
  await page.getByRole("button", { name: "Submit proposal" }).click();
  await expect(page.getByText(/retry in about 90 seconds/i)).toBeVisible();
  await expect(page.locator(".public-cfp-confirmation-id")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Submit proposal" }),
  ).toBeEnabled();

  await page.getByRole("button", { name: "Submit proposal" }).click();
  await expect(page.locator(".public-cfp-confirmation-id strong")).toHaveText(
    "AES-429429",
  );
  expect(idempotencyKeys).toHaveLength(2);
  expect(idempotencyKeys[0]).not.toBe("missing");
  expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
});

test("editing after a failed final attempt rotates the semantic idempotency key", async ({
  page,
}) => {
  await mockVerifiedSession(page);
  await mockDraftCreation(page, "AES-ROTATE", "submission_test_rotate");
  const finalKeys: string[] = [];
  let sourceVersion = 1;
  await page.route(
    "**/api/v1/public/events/ai-engineer-summit/submissions/submission_test_rotate",
    async (route) => {
      const payload = route.request().postDataJSON() as {
        mode: "draft" | "submit";
      };
      if (payload.mode === "draft") {
        sourceVersion += 1;
        await route.fulfill({
          body: JSON.stringify({
            friendly_id: "AES-ROTATE",
            outcome: "applied",
            source_version: sourceVersion,
            status: "draft",
            submission_id: "submission_test_rotate",
          }),
          contentType: "application/json",
          status: 200,
        });
        return;
      }
      finalKeys.push(route.request().headers()["idempotency-key"] ?? "missing");
      if (finalKeys.length === 1) {
        await route.fulfill({ status: 503 });
        return;
      }
      await route.fulfill({
        body: JSON.stringify({
          friendly_id: "AES-ROTATE",
          outcome: "applied",
          source_version: sourceVersion + 1,
          status: "submitted",
          submission_id: "submission_test_rotate",
        }),
        contentType: "application/json",
        status: 200,
      });
    },
  );

  await page.goto(publicPath);
  await storeReviewDraft(page);
  await page.reload();
  await page.getByRole("button", { name: "Submit proposal" }).click();
  await expect(
    page.getByRole("heading", { name: "Your proposal was not submitted" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Edit proposal" }).click();
  await page.getByLabel("Session title").fill(`${reviewDraft.title} — revised`);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Submit proposal" }).click();
  await expect(page.locator(".public-cfp-confirmation-id strong")).toHaveText(
    "AES-ROTATE",
  );
  expect(finalKeys).toHaveLength(2);
  expect(finalKeys[0]).not.toBe("missing");
  expect(finalKeys[1]).not.toBe(finalKeys[0]);
});

test("production requires a matching server session despite caller-edited local draft state", async ({
  page,
}) => {
  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({ status: 401 });
  });
  await page.goto(publicPath);
  await storeReviewDraft(page);
  await page.reload();

  await expect(
    page.getByRole("heading", { name: "Save your place." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Submit proposal" }),
  ).toHaveCount(0);
});

test("production does not trust a caller-edited local confirmation", async ({
  page,
}) => {
  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({ status: 401 });
  });
  await page.goto(publicPath);
  await page.evaluate(
    ([draftKey, confirmationKey, draft]) => {
      window.localStorage.setItem(
        draftKey,
        JSON.stringify({ ...draft, step: "confirmation" }),
      );
      window.localStorage.setItem(confirmationKey, "AES-FORGED");
    },
    [draftStorageKey, confirmationStorageKey, reviewDraft] as const,
  );
  await page.reload();

  await expect(
    page.getByRole("heading", { name: "Save your place." }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "You’re in the review queue." }),
  ).toHaveCount(0);
  await expect(page.getByText("AES-FORGED")).toHaveCount(0);
});

test("confirmed server submission remains successful when browser storage is unavailable", async ({
  page,
}) => {
  await mockVerifiedSession(page);
  await mockDraftCreation(page, "AES-654321", "submission_test_654321");
  let requestCount = 0;
  await page.route(
    "**/api/v1/public/events/ai-engineer-summit/submissions/submission_test_654321",
    async (route) => {
      requestCount += 1;
      await route.fulfill({
        body: JSON.stringify({
          friendly_id: "AES-654321",
          outcome: "applied",
          source_version: 2,
          status: "submitted",
          submission_id: "submission_test_654321",
        }),
        contentType: "application/json",
        status: 200,
      });
    },
  );

  await page.goto(publicPath);
  await storeReviewDraft(page);
  await page.addInitScript(
    ([draftKey, confirmationKey]) => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function setItem(key, value) {
        if (key === draftKey || key === confirmationKey) {
          throw new DOMException("Storage unavailable", "QuotaExceededError");
        }
        return original.call(this, key, value);
      };
    },
    [draftStorageKey, confirmationStorageKey] as const,
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Review before submitting." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Submit proposal" }).click();

  await expect(
    page.getByRole("heading", { name: "You’re in the review queue." }),
  ).toBeVisible();
  await expect(page.locator(".public-cfp-confirmation-id strong")).toHaveText(
    "AES-654321",
  );
  expect(requestCount).toBe(1);
  await expect
    .poll(() =>
      page.evaluate(
        (key) => window.localStorage.getItem(key),
        idempotencyStorageKey,
      ),
    )
    .toBeNull();
});

test("public application remains accessible without horizontal overflow at 360px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await clearApplication(page);
  await page.getByRole("button", { name: "Start a proposal" }).click();

  await expect(
    page.getByRole("heading", { name: "Save your place." }),
  ).toBeVisible();
  const progressWidths = await page
    .getByRole("navigation", { name: "Application progress" })
    .evaluate((element) => ({
      client: element.clientWidth,
      scroll: element.scrollWidth,
    }));
  expect(progressWidths.scroll).toBeLessThanOrEqual(progressWidths.client + 1);
  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);

  const results = await new AxeBuilder({ page })
    .include(".public-cfp-flow")
    .analyze();
  expect(results.violations).toEqual([]);
});
