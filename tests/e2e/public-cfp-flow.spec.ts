import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { mockTurnstile } from "./turnstile";

test.beforeEach(async ({ page }) => mockTurnstile(page));

const publicPath = "/e/ai-engineer-summit/cfp";
const interactivePath = "/fixtures/public-cfp/interactive";
const draftStorageKey = "opensession.public-cfp.ai-engineer-summit.draft";
const confirmationStorageKey =
  "opensession.public-cfp.ai-engineer-summit.confirmation";
const idempotencyStorageKey =
  "opensession.public-cfp.ai-engineer-summit.idempotency";

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
    ([draftKey, confirmationKey]) => {
      window.localStorage.removeItem(draftKey);
      window.localStorage.removeItem(confirmationKey);
    },
    [draftStorageKey, confirmationStorageKey],
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
  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ user: { email: "mina@example.com" } }),
      contentType: "application/json",
      status: 200,
    });
  });
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
    page.getByRole("link", { name: "program@aiengineersummit.com" }).first(),
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
  let payload: unknown;
  await page.route(
    "**/api/v1/public/events/ai-engineer-summit/submissions",
    async (route) => {
      payload = route.request().postDataJSON();
      await route.fulfill({
        body: JSON.stringify({ submission_id: "AES-777777" }),
        contentType: "application/json",
        status: 201,
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
    routing: {
      default_reviewer_group_id: "group-product",
      route_key: "product-track-d",
      submission_track: "Product · Track D",
    },
    turnstile_action: "cfp_submit",
    turnstile_token: expect.stringMatching(/^test-token-/),
  });
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
    "Save failed · retry",
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
  let requestCount = 0;
  let idempotencyKey = "";
  await page.route(
    "**/api/v1/public/events/ai-engineer-summit/submissions",
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
  const idempotencyKeys: string[] = [];
  await page.route(
    "**/api/v1/public/events/ai-engineer-summit/submissions",
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
        body: JSON.stringify({ submission_id: "AES-429429" }),
        contentType: "application/json",
        status: 201,
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
  let requestCount = 0;
  await page.route(
    "**/api/v1/public/events/ai-engineer-summit/submissions",
    async (route) => {
      requestCount += 1;
      await route.fulfill({
        body: JSON.stringify({ submission_id: "AES-654321" }),
        contentType: "application/json",
        status: 201,
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
