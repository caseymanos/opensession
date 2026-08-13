import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("organizer shell exposes the five-part information architecture", async ({
  page,
}, testInfo) => {
  await page.goto("/app/ai-engineer-summit/home");

  if (testInfo.project.name === "mobile-chromium") {
    await page.getByRole("button", { name: "Open navigation" }).click();
  }

  const navigation = page.getByRole("navigation", {
    name: "Primary navigation",
  });
  await expect(navigation).toBeVisible();
  await expect(page.locator(".event-switcher").first()).toContainText(
    "AI Engineer Summit 2026",
  );
  await expect(page.locator(".event-switcher").first()).toContainText(
    "October 13–14, 2026",
  );

  for (const group of [
    "Collect",
    "Decide",
    "Prepare",
    "Publish",
    "Configure",
  ]) {
    await expect(
      navigation.getByRole("heading", { name: group }),
    ).toBeVisible();
  }

  await expect(navigation.getByRole("link", { name: "CFP" })).toHaveAttribute(
    "href",
    "/app/ai-engineer-summit/cfp",
  );
  await expect(
    navigation.getByRole("link", { name: "Public program" }),
  ).toHaveAttribute("href", "/e/ai-engineer-summit");

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations).toEqual([]);
});

test("mobile navigation traps focus, closes with Escape, and restores focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/app/ai-engineer-summit/home");

  const trigger = page.getByRole("button", { name: "Open navigation" });
  await trigger.click();

  const drawer = page.getByRole("dialog", { name: "Event navigation" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("link", { name: "Agenda" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("fixture route covers explicit states and guarded production data", async ({
  page,
}) => {
  for (const state of ["normal", "empty", "loading", "error", "permission"]) {
    await page.goto(`/fixtures/ui?state=${state}`);
    await expect(
      page.getByRole("heading", { name: `${state} fixture` }),
    ).toBeVisible();
  }

  await page.goto("/fixtures/ui?environment=production&demo=false");
  await expect(
    page.getByRole("region", { name: "Environment status" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reset demo" })).toHaveCount(0);
});

test("@judge @judge-a11y dialog traps focus and the fixture passes axe at 360px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/fixtures/ui");

  const trigger = page.getByRole("button", { name: "Open dialog" });
  await trigger.click();
  const dialog = page.getByRole("dialog", {
    name: "Publish this form version?",
  });
  await expect(dialog).toBeVisible();

  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("button", { name: "Publish version" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations).toEqual([]);
});

test("@judge @judge-e2e-07 demo reset requires the exact phrase and reports the durable completion", async ({
  page,
}) => {
  const csrfToken = "demo-reset-e2e-csrf-token-that-is-at-least-forty-chars";
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
  let requestCount = 0;
  await page.route("**/api/events/*/demo/reset", async (route) => {
    requestCount += 1;
    const request = route.request();
    expect(request.method()).toBe("POST");
    expect(request.headers()["x-csrf-token"]).toBe(csrfToken);
    expect(request.headers()["idempotency-key"]).toMatch(
      /^demo_reset_[a-f0-9]{32}$/,
    );
    expect(request.postDataJSON()).toEqual({
      confirmation: "RESET AI ENGINEER SUMMIT 2026",
    });
    await route.fulfill(
      requestCount === 1
        ? {
            json: {
              receipt: {
                audit_event_id: "audit_demo_reset_e2e",
                digest: "a".repeat(64),
                operation_count: 134,
                outcome: "applied",
                reset_run_id: "demo_reset_e2e_request",
                snapshot_id: `snapshot_${"b".repeat(24)}`,
              },
            },
            status: 200,
          }
        : {
            json: {
              error: {
                code: "authority_unavailable",
                message: "Demo authority did not converge after the reset.",
              },
              request_id: "req_demo_reset_failed_e2e",
            },
            status: 503,
          },
    );
  });

  await page.goto("/app/ai-engineer-summit/home");
  await page.getByRole("button", { name: "Reset demo" }).click();
  const dialog = page.getByRole("dialog", { name: "Reset all demo data?" });
  const submit = dialog.getByRole("button", { name: "Reset demo data" });
  await expect(submit).toBeDisabled();
  await dialog.getByLabel("Confirmation phrase").fill("RESET DEMO");
  await expect(submit).toBeDisabled();
  await dialog
    .getByLabel("Confirmation phrase")
    .fill("RESET AI ENGINEER SUMMIT 2026");
  await expect(submit).toBeEnabled();
  await submit.click();

  await expect(dialog).toBeHidden();
  await expect(
    page.getByText("Demo data reset", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "134 authoritative records restored from snapshot_bbbbbbbbbbbbbbbbbbbbbbbb · digest aaaaaaaaaaaa…",
      { exact: false },
    ),
  ).toBeVisible();
  await expect(
    page.getByText("reset run demo_reset_e2e_request"),
  ).toBeVisible();
  expect(requestCount).toBe(1);

  await page.getByRole("button", { name: "Reset demo" }).click();
  const retryDialog = page.getByRole("dialog", {
    name: "Reset all demo data?",
  });
  await retryDialog
    .getByLabel("Confirmation phrase")
    .fill("RESET AI ENGINEER SUMMIT 2026");
  await retryDialog.getByRole("button", { name: "Reset demo data" }).click();

  await expect(page.getByText("Demo reset did not finish")).toBeVisible();
  await expect(page.getByText("req_demo_reset_failed_e2e")).toBeVisible();
  await expect(retryDialog).toContainText(
    "Demo authority did not converge after the reset.",
  );
  expect(requestCount).toBe(2);
});

test("@judge @judge-a11y workspace remains usable at a 200 percent text scale", async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 450 });
  await page.goto("/app/ai-engineer-summit/home");

  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open navigation" }),
  ).toBeVisible();
  expect(
    await page.locator("body").evaluate((body) => body.scrollWidth),
  ).toBeLessThanOrEqual(640);
});
