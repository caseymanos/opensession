import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { mockPortalAuth, portalBootstrapFixture } from "./portal-auth";
import {
  portalAuthorityForeignSlug,
  portalAuthorityInvitationEndpoint,
  portalAuthoritySlug,
} from "./portal-authority-fixture";
import { mockTurnstile } from "./turnstile";

const portalPath = "/portal/ai-engineer-summit";
const activePortalFixturePath = "/fixtures/portal/active";

test.beforeEach(async ({ page }) => {
  await mockPortalAuth(page);
  await mockTurnstile(page);
});

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
  await expect(page.getByText("program team will notify you")).toBeVisible();
});

test("production portal keeps unconfigured readiness neutral", async ({
  page,
}) => {
  await page.unroute("**/api/portal/*/bootstrap");
  await page.route("**/api/portal/*/bootstrap", async (route) => {
    await route.fulfill({
      json: {
        ...portalBootstrapFixture,
        readiness: {
          next_due_at: null,
          outstanding_task_count: 0,
          overdue_task_count: 0,
          required_complete: 0,
          required_total: 0,
          status: "not_configured",
        },
        tasks: [
          {
            ...portalBootstrapFixture.tasks[0],
            approval_required: true,
            required: false,
            source_status: "submitted",
            status: "open",
            title: "Optional supporting material",
          },
        ],
      },
      status: 200,
    });
  });
  await page.goto(portalPath);
  await expect(
    page.getByRole("heading", { name: "No required tasks assigned" }),
  ).toBeVisible();
  await expect(page.getByText("Not configured", { exact: true })).toBeVisible();
  await expect(page.getByText("No required tasks are assigned.")).toBeVisible();
  await expect(
    page.getByText("Optional · submitted · awaiting approval"),
  ).toBeVisible();
  await expect(page.getByText("Required tasks ready")).toHaveCount(0);
});

test("submitted required work without approval waits on the program team without a false ready state", async ({
  page,
}) => {
  await page.unroute("**/api/portal/*/bootstrap");
  await page.route("**/api/portal/*/bootstrap", async (route) => {
    await route.fulfill({
      json: {
        ...portalBootstrapFixture,
        readiness: {
          next_due_at: null,
          outstanding_task_count: 1,
          overdue_task_count: 0,
          required_complete: 0,
          required_total: 1,
          status: "outstanding",
        },
        tasks: [
          {
            ...portalBootstrapFixture.tasks[0],
            approval_required: false,
            required: true,
            source_status: "submitted",
            status: "open",
            title: "Final presentation",
          },
        ],
      },
      status: 200,
    });
  });
  await page.goto(portalPath);
  await expect(page.getByText("1 submitted to program team")).toBeVisible();
  await expect(page.getByText("Required tasks ready")).toHaveCount(0);
  await expect(page.getByText("No speaker action is needed")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review required tasks" }),
  ).toHaveCount(0);
});

test("mixed actionable and submitted work separates the speaker's part from program-team processing", async ({
  page,
}) => {
  await page.unroute("**/api/portal/*/bootstrap");
  await page.route("**/api/portal/*/bootstrap", async (route) => {
    await route.fulfill({
      json: {
        ...portalBootstrapFixture,
        readiness: {
          next_due_at: "2026-08-16T16:00:00.000Z",
          outstanding_task_count: 2,
          overdue_task_count: 0,
          required_complete: 0,
          required_total: 2,
          status: "outstanding",
        },
        tasks: [
          {
            ...portalBootstrapFixture.tasks[0],
            approval_required: false,
            required: true,
            source_status: "not_started",
            status: "open",
            title: "Confirm biography",
          },
          {
            ...portalBootstrapFixture.tasks[0],
            approval_required: true,
            id: "task_slides",
            required: true,
            source_status: "submitted",
            status: "open",
            title: "Final presentation",
          },
        ],
      },
      status: 200,
    });
  });
  await page.goto(portalPath);
  await expect(page.getByText("1 your action · 1 submitted")).toBeVisible();
  await expect(
    page.getByText("Finish 1 open required task on your side."),
  ).toBeVisible();
  await expect(
    page.getByText("1 submitted required task remains with the program team."),
  ).toBeVisible();
  await expect(page.getByText("Required tasks ready")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Review required tasks" }),
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
        name: "You’re on the program, Mina.",
      }),
    ).toBeVisible();
    await expect(page.getByText("The Reliability Gap")).toBeVisible();
  }
});

test("incognito speaker invitation stays event-scoped and enumeration-safe", async ({
  page,
}) => {
  await page.unroute("**/api/portal/*/bootstrap");
  await page.route("**/api/portal/*/bootstrap", async (route) => {
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
  await page.route("**/api/portal/*/invitations", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      email: "mina@example.com",
      turnstile_action: "sign_in",
      turnstile_token: "test-token-1",
    });
    expect(route.request().url()).toContain(
      "/api/portal/ai-engineer-summit/invitations",
    );
    await route.fulfill({
      json: {
        accepted: true,
        message:
          "If that address can access this event, a private link is on its way.",
      },
      status: 202,
    });
  });

  await page.goto(portalPath);
  await expect(
    page.getByRole("heading", { name: "Sign in to your speaker portal" }),
  ).toBeVisible();
  await expect(page.getByText("Mina Okafor")).toHaveCount(0);
  await expect(page.getByText("The Reliability Gap")).toHaveCount(0);
  await page.getByLabel("Invited email").fill("mina@example.com");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("status")).toContainText(
    "If mina@example.com still has access",
  );
  await expect(page).toHaveURL(portalPath);
});

test("production recovery form is keyboard-operable at 360px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.unroute("**/api/portal/*/bootstrap");
  await page.route("**/api/portal/*/bootstrap", async (route) => {
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
  await page.route("**/api/portal/*/invitations", async (route) => {
    await route.fulfill({
      json: {
        accepted: true,
        message:
          "If that address can access this event, a private link is on its way.",
      },
      status: 202,
    });
  });

  await page.goto(portalPath);
  const email = page.getByLabel("Invited email");
  await email.focus();
  await page.keyboard.type("keyboard@example.test");
  const requestLink = page.getByRole("button", {
    name: "Email me a sign-in link",
  });
  await requestLink.focus();
  await expect(requestLink).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toContainText(
    "If keyboard@example.test still has access",
  );
  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);
});

test("authenticated portal reload preserves the canonical event model", async ({
  page,
}) => {
  await page.goto(portalPath);
  await expect(
    page.getByRole("heading", { name: "You’re on the program, Mina." }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("AI Engineer Summit", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("The Reliability Gap")).toBeVisible();
});

test("real invitation exchange creates a session and denies a foreign event", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "One desktop project proves the complete Worker-backed authority path.",
  );
  await page.unroute("**/api/portal/*/bootstrap");
  await page.unroute("**/api/auth/logout");
  const invitation = await page.request.post(portalAuthorityInvitationEndpoint);
  expect(invitation.ok()).toBe(true);
  const { token } = (await invitation.json()) as { token: string };

  await page.goto(`/auth/magic#token=${encodeURIComponent(token)}`);
  await expect(page).toHaveURL(`/portal/${portalAuthoritySlug}`);
  await expect(
    page.getByRole("heading", { name: "You’re on the program, Browser." }),
  ).toBeVisible();
  await expect(page.getByText("Real Authority in the Browser")).toBeVisible();
  await expect(page).not.toHaveURL(/token=/);

  await page.reload();
  await expect(page.getByText("Authority Browser Summit")).toBeVisible();
  await expect(page.getByText("Real Authority in the Browser")).toBeVisible();

  await page.goto(`/portal/${portalAuthorityForeignSlug}`);
  await expect(
    page.getByRole("heading", {
      name: "This portal is not available to this account",
    }),
  ).toBeVisible();
  await expect(page.getByText("Browser Speaker")).toHaveCount(0);
  await expect(page.getByText("Real Authority in the Browser")).toHaveCount(0);
});

test("foreign speaker and event access fails closed without private data", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.unroute("**/api/portal/*/bootstrap");
  await page.route("**/api/portal/*/bootstrap", async (route) => {
    await route.fulfill({
      json: {
        error: {
          code: "portal_access_denied",
          message: "This account cannot access the requested speaker portal.",
        },
      },
      status: 403,
    });
  });
  await page.goto("/portal/foreign-conference");
  await expect(
    page.getByRole("heading", {
      name: "This portal is not available to this account",
    }),
  ).toBeVisible();
  await expect(page.getByText("Mina Okafor")).toHaveCount(0);
  await expect(page.getByText("The Reliability Gap")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Sign out and use invited email" }),
  ).toBeVisible();
  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);
});

test("production logout can be activated from the keyboard", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(portalPath);
  const signOut = page.getByRole("button", { name: "Sign out" });
  await signOut.focus();
  await expect(signOut).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Sign in to your speaker portal" }),
  ).toBeVisible();
});

test("speaker can end the authenticated portal session", async ({ page }) => {
  await page.goto(portalPath);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByRole("heading", { name: "Sign in to your speaker portal" }),
  ).toBeVisible();
  await expect(page).toHaveURL(portalPath);
  await expect(page.getByText("Mina Okafor")).toHaveCount(0);
  await expect(page.getByText("The Reliability Gap")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Email me a sign-in link" }),
  ).toBeVisible();
});

test("speaker portal remains usable at 360px without page overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(portalPath);

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
