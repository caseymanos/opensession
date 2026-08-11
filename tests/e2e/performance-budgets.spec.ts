import { expect, test, type Page } from "@playwright/test";

import { publicScheduleProjectionFixture } from "../../apps/web/src/public/publicScheduleModel";

const samples = 5;

function percentile(
  values: readonly number[],
  percentileValue: number,
): number {
  const ordered = [...values].sort((left, right) => left - right);
  return (
    ordered[Math.max(0, Math.ceil(ordered.length * percentileValue) - 1)] ?? 0
  );
}

async function measureLargestContentfulPaint(
  page: Page,
  path: string,
  ready: () => Promise<void>,
): Promise<number[]> {
  await page.addInitScript(() => {
    const measurement = { value: 0 };
    Object.defineProperty(globalThis, "__ral80Lcp", {
      configurable: true,
      value: measurement,
    });
    new PerformanceObserver((list) => {
      const entry = list.getEntries().at(-1);
      if (entry) measurement.value = entry.startTime;
    }).observe({ buffered: true, type: "largest-contentful-paint" });
  });
  const values: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    await page.goto(path, { waitUntil: "networkidle" });
    await ready();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    const value = await page.evaluate(() => {
      const measurement = (
        globalThis as typeof globalThis & { __ral80Lcp?: { value: number } }
      ).__ral80Lcp;
      return measurement?.value ?? 0;
    });
    expect(value).toBeGreaterThan(0);
    values.push(Math.round(value * 100) / 100);
  }
  return values;
}

test("RAL-80 public mobile LCP remains within the repeated budget", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium");
  await page.route("**/api/v1/public/events/*/schedule", (route) =>
    route.fulfill({
      headers: { ETag: '"ral-80-public-lcp"' },
      json: publicScheduleProjectionFixture,
      status: 200,
    }),
  );
  const values = await measureLargestContentfulPaint(
    page,
    "/e/ai-engineer-summit",
    async () => {
      await expect(page.locator(".public-session-card")).toHaveCount(5);
    },
  );
  const p75 = percentile(values, 0.75);
  expect(p75).toBeLessThanOrEqual(2_000);
  const receipt = {
    artifact: "ral-80-public-mobile-lcp",
    budgetMilliseconds: 2_000,
    build: process.env.GITHUB_SHA ?? "local-working-tree",
    conditions: {
      browser: testInfo.project.name,
      samples,
      seed: "public-schedule-v1",
    },
    p75Milliseconds: p75,
    url: "/e/ai-engineer-summit",
    valuesMilliseconds: values,
  };
  await testInfo.attach("ral-80-public-mobile-lcp.json", {
    body: Buffer.from(JSON.stringify(receipt, null, 2)),
    contentType: "application/json",
  });
  console.info(JSON.stringify(receipt));
});

test("RAL-80 organizer desktop LCP remains within the repeated budget", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  const values = await measureLargestContentfulPaint(page, "/", async () => {
    await expect(
      page.getByRole("heading", {
        name: /Good (?:morning|afternoon|evening), Casey\./,
      }),
    ).toBeVisible();
  });
  const p75 = percentile(values, 0.75);
  expect(p75).toBeLessThanOrEqual(2_500);
  const receipt = {
    artifact: "ral-80-organizer-desktop-lcp",
    budgetMilliseconds: 2_500,
    build: process.env.GITHUB_SHA ?? "local-working-tree",
    conditions: {
      browser: testInfo.project.name,
      samples,
      seed: "organizer-workspace-v1",
    },
    p75Milliseconds: p75,
    url: "/",
    valuesMilliseconds: values,
  };
  await testInfo.attach("ral-80-organizer-desktop-lcp.json", {
    body: Buffer.from(JSON.stringify(receipt, null, 2)),
    contentType: "application/json",
  });
  console.info(JSON.stringify(receipt));
});
