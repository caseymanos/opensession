import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { mockPortalAuth } from "./portal-auth";

const portalPath = "/portal/ai-engineer-summit";
const activePortalFixturePath = "/fixtures/portal/active";

test.beforeEach(async ({ page }) => mockPortalAuth(page));

test("speaker portal makes readiness, tasks, and sessions immediately clear", async ({
  page,
}) => {
  await page.goto(activePortalFixturePath);

  await expect(
    page.getByRole("heading", { name: "You’re on the program, Mina." }),
  ).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "3",
  );
  await expect(page.getByText("Overdue by 2 days")).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "The Reliability Gap in Production Agents",
    }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Home" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  const results = await new AxeBuilder({ page })
    .include(".speaker-portal")
    .analyze();
  expect(results.violations).toEqual([]);
});

test("invitation recovery keeps event and invited-email context", async ({
  page,
}) => {
  for (const state of ["expired", "redeemed", "permission"]) {
    await page.goto(`/fixtures/portal/${state}`);
    await expect(
      page.getByText("AI Engineer Summit", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".portal-invitation-page > p")).toContainText(
      "mina@example.com",
    );
  }

  await page.goto("/fixtures/portal/expired");
  await expect(
    page.getByRole("button", { name: "Email me a sign-in link" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(
    page.getByText("You can request another in 60 seconds"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign-in link requested" }),
  ).toBeDisabled();

  await page.goto("/fixtures/portal/permission");
  await expect(
    page.getByRole("button", { name: "Sign in with another email" }),
  ).toBeVisible();
});

test("active portal explains the no-assignment state", async ({ page }) => {
  await page.goto("/fixtures/portal/empty");
  await expect(
    page.getByRole("heading", { name: "No sessions assigned yet" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Contact the program team" }),
  ).toBeVisible();
});

test("revoked access fails closed with event and support context", async ({
  page,
}) => {
  await page.goto("/fixtures/portal/revoked");
  await expect(
    page.getByRole("heading", { name: "Your portal access has ended" }),
  ).toBeVisible();
  await expect(
    page.getByText("AI Engineer Summit", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("speakers@aiengineersummit.com")).toBeVisible();
  await expect(page.getByText("No speaker or session data")).toBeVisible();
});

test("production portal URLs ignore fixture query state", async ({ page }) => {
  for (const state of [
    "empty",
    "expired",
    "permission",
    "redeemed",
    "revoked",
  ]) {
    await page.goto(`${portalPath}?state=${state}`);
    await expect(
      page.getByRole("heading", {
        name: "We couldn’t verify access to this event",
      }),
    ).toBeVisible();
    await expect(page.getByText("The Reliability Gap")).toHaveCount(0);
  }
});

test("production portal hides speaker data until a session is verified", async ({
  page,
}) => {
  await page.unroute("**/api/auth/session");
  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({
      json: {
        error: {
          code: "invalid_session",
          message: "Authentication is required.",
        },
      },
      status: 401,
    });
  });

  await page.goto(portalPath);
  await expect(
    page.getByRole("heading", { name: "Sign in to your speaker portal" }),
  ).toBeVisible();
  await expect(page.getByText("Mina Okafor")).toHaveCount(0);
  await expect(page.getByText("The Reliability Gap")).toHaveCount(0);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page).toHaveURL(
    /\/auth\/sign-in\?return_to=%2Fportal%2Fai-engineer-summit/,
  );
});

test("speaker can end the authenticated portal session", async ({ page }) => {
  await page.goto(portalPath);
  await page
    .getByRole("button", { name: "Sign out and use invited link" })
    .click();
  await expect(page).toHaveURL(
    /\/auth\/sign-in\?return_to=%2Fportal%2Fai-engineer-summit/,
  );
});

test("speaker portal remains usable at 360px without page overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(activePortalFixturePath);

  await expect(
    page.getByRole("navigation", { name: "Speaker portal" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your tasks" })).toBeVisible();
  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);

  const results = await new AxeBuilder({ page })
    .include(".speaker-portal")
    .analyze();
  expect(results.violations).toEqual([]);
});
