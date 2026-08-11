import { expect, test, type Page } from "@playwright/test";

import { publicScheduleProjectionFixture } from "../../apps/web/src/public/publicScheduleModel";

const samples = 5;

interface PublicMobileVitals {
  cls: number;
  inpMilliseconds: number;
  lcpMilliseconds: number;
}

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

async function measurePublicMobileVitals(
  page: Page,
  path: string,
  ready: () => Promise<void>,
): Promise<PublicMobileVitals[]> {
  await page.addInitScript(() => {
    const measurement = {
      cls: 0,
      interactionDurations: [] as number[],
      lcp: 0,
    };
    Object.defineProperty(globalThis, "__ral69Vitals", {
      configurable: true,
      value: measurement,
    });
    new PerformanceObserver((list) => {
      const entry = list.getEntries().at(-1);
      if (entry) measurement.lcp = entry.startTime;
    }).observe({ buffered: true, type: "largest-contentful-paint" });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const layoutShift = entry as PerformanceEntry & {
          hadRecentInput: boolean;
          value: number;
        };
        if (!layoutShift.hadRecentInput) measurement.cls += layoutShift.value;
      }
    }).observe({ buffered: true, type: "layout-shift" });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const event = entry as PerformanceEntry & { interactionId: number };
        if (event.interactionId > 0) {
          measurement.interactionDurations.push(entry.duration);
        }
      }
    }).observe({
      buffered: true,
      durationThreshold: 0,
      type: "event",
    } as PerformanceObserverInit);
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        measurement.interactionDurations.push(entry.duration);
      }
    }).observe({ buffered: true, type: "first-input" });
  });

  const values: PublicMobileVitals[] = [];
  for (let index = 0; index < samples; index += 1) {
    await page.goto(path, { waitUntil: "networkidle" });
    await ready();
    const itineraryButton = page
      .locator(".public-session-card-actions button")
      .first();
    await itineraryButton.click();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    await page.waitForTimeout(100);
    const measurement = await page.evaluate(() => {
      const current = (
        globalThis as typeof globalThis & {
          __ral69Vitals?: {
            cls: number;
            interactionDurations: number[];
            lcp: number;
          };
        }
      ).__ral69Vitals;
      return {
        cls: current?.cls ?? 0,
        interactionDurations: current?.interactionDurations ?? [],
        lcp: current?.lcp ?? 0,
      };
    });
    expect(measurement.lcp).toBeGreaterThan(0);
    expect(measurement.interactionDurations.length).toBeGreaterThan(0);
    values.push({
      cls: Math.round(measurement.cls * 10_000) / 10_000,
      inpMilliseconds:
        Math.round(Math.max(...measurement.interactionDurations) * 100) / 100,
      lcpMilliseconds: Math.round(measurement.lcp * 100) / 100,
    });
  }
  return values;
}

test("RAL-69 public mobile Core Web Vitals remain within repeated budgets", async ({
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
  const values = await measurePublicMobileVitals(
    page,
    "/e/ai-engineer-summit",
    async () => {
      await expect(page.locator(".public-session-card")).toHaveCount(5);
    },
  );
  const p75 = {
    cls: percentile(
      values.map((value) => value.cls),
      0.75,
    ),
    inpMilliseconds: percentile(
      values.map((value) => value.inpMilliseconds),
      0.75,
    ),
    lcpMilliseconds: percentile(
      values.map((value) => value.lcpMilliseconds),
      0.75,
    ),
  };
  expect(p75.lcpMilliseconds).toBeLessThanOrEqual(2_000);
  expect(p75.inpMilliseconds).toBeLessThanOrEqual(200);
  expect(p75.cls).toBeLessThanOrEqual(0.1);
  const receipt = {
    artifact: "ral-69-public-mobile-core-web-vitals",
    budgets: {
      cls: 0.1,
      inpMilliseconds: 200,
      lcpMilliseconds: 2_000,
    },
    build: process.env.GITHUB_SHA ?? "local-working-tree",
    conditions: {
      browser: testInfo.project.name,
      delivery: "production Vite assets via local Workerd",
      interaction: "toggle first published session in personal itinerary",
      samples,
      seed: "public-schedule-v1",
    },
    p75,
    url: "/e/ai-engineer-summit",
    values,
  };
  await testInfo.attach("ral-69-public-mobile-core-web-vitals.json", {
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
