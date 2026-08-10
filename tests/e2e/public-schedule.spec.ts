import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { publicScheduleProjectionFixture } from "../../apps/web/src/public/publicScheduleModel";

const publicPath = "/e/ai-engineer-summit";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/public/events/*/schedule", async (route) => {
    const parts = new URL(route.request().url()).pathname.split("/");
    const slug = parts.at(-2);
    if (slug !== publicScheduleProjectionFixture.event.slug) {
      await route.fulfill({
        contentType: "application/json",
        json: { error: { code: "not_found" } },
        status: 404,
      });
      return;
    }
    await route.fulfill({
      headers: {
        "Cache-Control": "public, max-age=0, must-revalidate",
        ETag: '"public-schedule-fixture-v4"',
      },
      json: publicScheduleProjectionFixture,
      status: 200,
    });
  });
});

test("anonymous schedule exposes only the current published projection", async ({
  context,
  page,
}) => {
  const requestHosts = new Set<string>();
  const requestedPaths: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    requestHosts.add(url.hostname);
    requestedPaths.push(url.pathname);
  });

  await page.goto(publicPath);

  await expect(
    page.getByRole("heading", {
      name: "AI Engineer Summit",
    }),
  ).toBeVisible();
  await expect(page.getByText("Public version 4")).toBeVisible();
  await expect(page.locator(".public-session-card")).toHaveCount(5);
  await expect(page.getByText("Evaluation Patterns We Retired")).toHaveCount(0);

  const runtime = page
    .locator(".public-session-card")
    .filter({ hasText: "The Agent Runtime Is the Product" });
  await expect(runtime).toContainText("1:00 PM");
  await expect(runtime).toHaveCount(1);

  expect([...requestHosts]).toEqual(["127.0.0.1"]);
  expect(requestedPaths.some((path) => path.includes("PublicSchedule-"))).toBe(
    true,
  );
  expect(
    requestedPaths.includes(
      "/api/v1/public/events/ai-engineer-summit/schedule",
    ),
  ).toBe(true);
  expect(requestedPaths.some((path) => path.includes("WorkspaceApp-"))).toBe(
    false,
  );
  expect(
    requestedPaths.some((path) => path.includes("ReviewerWorkspace-")),
  ).toBe(false);
  expect(requestedPaths.some((path) => path.includes("SpeakerPortal-"))).toBe(
    false,
  );
  expect(await context.cookies()).toEqual([]);

  const results = await new AxeBuilder({ page })
    .include(".public-program")
    .analyze();
  expect(results.violations).toEqual([]);
});

test("day, search, track, and room filters use shareable URL state", async ({
  page,
}) => {
  await page.goto(`${publicPath}?q=bench&track=Evaluation&room=gallery`);

  await expect(page.getByLabel("Search the schedule")).toHaveValue("bench");
  await expect(page.getByLabel("Track")).toHaveValue("Evaluation");
  await expect(page.getByLabel("Room")).toHaveValue("gallery");
  await expect(page.locator(".public-session-card")).toHaveCount(1);
  await expect(page.locator(".public-session-card")).toContainText(
    "Benchmarks After the Benchmark",
  );

  await page
    .getByRole("button", { name: "Wednesday August 19 3", exact: true })
    .click();
  await expect(page.locator(".public-session-card")).toHaveCount(0);
  const filteredUrl = new URL(page.url());
  expect(filteredUrl.searchParams.get("day")).toBe("2026-08-19");
  expect(filteredUrl.searchParams.get("q")).toBe("bench");
  expect(filteredUrl.searchParams.get("track")).toBe("Evaluation");
  expect(filteredUrl.searchParams.get("room")).toBe("gallery");

  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.locator(".public-session-card")).toHaveCount(3);
  const clearedUrl = new URL(page.url());
  expect(clearedUrl.searchParams.get("day")).toBe("2026-08-19");
  expect(clearedUrl.searchParams.has("q")).toBe(false);
  expect(clearedUrl.searchParams.has("track")).toBe(false);
  expect(clearedUrl.searchParams.has("room")).toBe(false);

  await page.goBack();
  await expect(
    page.getByRole("button", { name: "Tuesday August 18 5", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Search the schedule")).toHaveValue("bench");

  await page.goForward();
  await expect(
    page.getByRole("button", { name: "Wednesday August 19 3", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Search the schedule")).toHaveValue("");
});

test("anonymous attendees can build, reload, edit, and export a personal itinerary", async ({
  page,
}) => {
  await page.goto(publicPath);

  const opening = page
    .locator(".public-session-card")
    .filter({ hasText: "Opening & State of AI Engineering" });
  const benchmarks = page
    .locator(".public-session-card")
    .filter({ hasText: "Benchmarks After the Benchmark" });
  await opening
    .getByRole("button", {
      name: "Add Opening & State of AI Engineering to my schedule",
    })
    .click();
  await benchmarks
    .getByRole("button", {
      name: "Add Benchmarks After the Benchmark to my schedule",
    })
    .click();

  await page
    .locator(".public-view-switcher")
    .getByRole("button", { name: /My schedule/ })
    .click();
  expect(new URL(page.url()).searchParams.get("view")).toBe("mine");
  await expect(
    page.getByRole("heading", { name: "My schedule" }),
  ).toBeVisible();
  await expect(page.locator(".public-itinerary-card")).toHaveCount(2);
  await expect(page.locator(".public-itinerary-card").first()).toContainText(
    "Conference chair · OpenSession",
  );
  await expect(page.locator(".public-itinerary-card").nth(1)).toContainText(
    "Evaluation lead · SignalBench",
  );

  const exportLink = page.getByRole("link", { name: "Export my schedule" });
  await expect(exportLink).toHaveAttribute(
    "download",
    "ai-engineer-summit-my-schedule.ics",
  );
  const href = await exportLink.getAttribute("href");
  const calendar = decodeURIComponent(href?.split(",")[1] ?? "");
  expect(calendar.match(/BEGIN:VEVENT/g)).toHaveLength(2);
  expect(calendar).toContain(
    "UID:opening-state-ai-engineering.ai-engineer-summit@opensession.dev",
  );
  expect(calendar).toContain(
    "UID:benchmarks-after-benchmark.ai-engineer-summit@opensession.dev",
  );

  await page.reload();
  await expect(page.locator(".public-itinerary-card")).toHaveCount(2);
  await page
    .locator(".public-itinerary-card")
    .filter({ hasText: "Benchmarks After the Benchmark" })
    .getByRole("button", { name: "Remove from my schedule" })
    .click();
  await expect(page.locator(".public-itinerary-card")).toHaveCount(1);

  await page
    .locator(".public-view-switcher")
    .getByRole("button", { name: /All sessions/ })
    .click();
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "My schedule" }),
  ).toBeVisible();
  await expect(page.locator(".public-itinerary-card")).toHaveCount(1);
});

test("personal itinerary reconciles stale publication data", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "opensession.personal-itinerary.v1:ai-engineer-summit",
      JSON.stringify({
        eventSlug: "ai-engineer-summit",
        publicationVersion: 3,
        sessionIds: [
          "opening-state-ai-engineering",
          "agent-runtime-product-v3",
        ],
        version: 1,
      }),
    );
  });

  await page.goto(`${publicPath}?view=mine`);
  await expect(page.locator(".public-itinerary-card")).toHaveCount(1);
  await expect(
    page.getByText("1 unavailable session was removed"),
  ).toBeVisible();
  const stored = await page.evaluate(() =>
    JSON.parse(
      window.localStorage.getItem(
        "opensession.personal-itinerary.v1:ai-engineer-summit",
      ) ?? "{}",
    ),
  );
  expect(stored).toMatchObject({
    eventSlug: "ai-engineer-summit",
    publicationVersion: 4,
    sessionIds: ["opening-state-ai-engineering"],
    version: 1,
  });
});

test("personal itinerary explains conflicts and unavailable persistence", async ({
  page,
}) => {
  await page.unroute("**/api/v1/public/events/*/schedule");
  await page.route("**/api/v1/public/events/*/schedule", async (route) => {
    const projection = structuredClone(publicScheduleProjectionFixture);
    const benchmarks = projection.sessions.find(
      (session) => session.id === "benchmarks-after-benchmark",
    );
    if (benchmarks) {
      benchmarks.startAt = "2026-08-18T09:15:00-07:00";
    }
    await route.fulfill({ json: projection, status: 200 });
  });
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("Storage disabled", "SecurityError");
    };
  });

  await page.goto(publicPath);
  for (const title of [
    "Opening & State of AI Engineering",
    "Benchmarks After the Benchmark",
  ]) {
    await page
      .locator(".public-session-card")
      .filter({ hasText: title })
      .getByRole("button", { name: `Add ${title} to my schedule` })
      .click();
  }
  await page
    .locator(".public-view-switcher")
    .getByRole("button", { name: /My schedule/ })
    .click();

  await expect(page.getByText("Saved for this visit only.")).toBeVisible();
  await expect(page.getByText("1 time conflict to resolve.")).toBeVisible();
  await expect(page.getByText(/Overlaps with Benchmarks/)).toBeVisible();

  const results = await new AxeBuilder({ page })
    .include(".public-program")
    .analyze();
  expect(results.violations).toEqual([]);
});

test("published session deep links include details and portable calendar actions", async ({
  page,
}) => {
  await page.goto(`${publicPath}/sessions/agent-runtime-product`);

  await expect(
    page.getByRole("heading", { name: "The Agent Runtime Is the Product" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Ren Ito" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Ren Ito/ })).toHaveAttribute(
    "href",
    "/e/ai-engineer-summit/speakers/ren-ito",
  );
  await expect(page.getByText("1:00 PM–1:30 PM · Pacific time")).toBeVisible();
  await expect(page.getByText("Firehouse", { exact: true })).toBeVisible();
  await expect(page.getByText("Current in public version 4")).toBeVisible();

  const ics = page.getByRole("link", { name: "Download .ics" });
  await expect(ics).toHaveAttribute("download", "agent-runtime-product.ics");
  const href = await ics.getAttribute("href");
  expect(href).not.toBeNull();
  const calendar = decodeURIComponent(href?.split(",")[1] ?? "");
  expect(calendar).toContain("BEGIN:VCALENDAR");
  expect(calendar).toContain("DTSTART:20260818T200000Z");
  expect(calendar).toContain("DTEND:20260818T203000Z");
  expect(calendar).toContain("SUMMARY:The Agent Runtime Is the Product");

  await expect(
    page.getByRole("link", { name: "Google Calendar" }),
  ).toHaveAttribute(
    "href",
    /calendar\.google\.com\/calendar\/render\?.*20260818T200000Z/,
  );
  await expect(
    page.getByRole("link", { name: "Back to schedule" }),
  ).toHaveAttribute("href", publicPath);

  const results = await new AxeBuilder({ page })
    .include(".public-program")
    .analyze();
  expect(results.violations).toEqual([]);
});

test("public schedule remains usable without page overflow at 360px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(publicPath);

  await expect(page.getByLabel("Search the schedule")).toBeVisible();
  await expect(page.locator(".public-session-card")).toHaveCount(5);
  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);

  await page
    .locator(".public-session-card")
    .filter({ hasText: "Opening & State of AI Engineering" })
    .getByRole("link")
    .click();
  await expect(
    page.getByRole("heading", { name: "Opening & State of AI Engineering" }),
  ).toBeVisible();
  const detailWidths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(detailWidths.scroll).toBeLessThanOrEqual(detailWidths.client + 1);

  const results = await new AxeBuilder({ page })
    .include(".public-program")
    .analyze();
  expect(results.violations).toEqual([]);
});

test("production public URLs fail safely when the projection is unavailable", async ({
  page,
}) => {
  await page.unroute("**/api/v1/public/events/*/schedule");
  await page.route("**/api/v1/public/events/*/schedule", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: { error: { code: "public_projection_unavailable" } },
      status: 503,
    });
  });

  await page.goto(`${publicPath}?state=empty`);
  await expect(
    page.getByRole("heading", { name: "We couldn’t load the public schedule" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.locator(".public-session-card")).toHaveCount(0);
});

test("empty, error, unknown, and superseded public links recover clearly", async ({
  page,
}) => {
  await page.goto(`${publicPath}?state=empty`);
  await expect(page.locator(".public-session-card")).toHaveCount(5);
  await expect(
    page.getByRole("heading", { name: "The published program is coming soon" }),
  ).toHaveCount(0);

  await page.goto(`${publicPath}?state=error`);
  await expect(page.locator(".public-session-card")).toHaveCount(5);
  await expect(
    page.getByRole("heading", { name: "We couldn’t load the public schedule" }),
  ).toHaveCount(0);

  await page.goto("/fixtures/public-schedule/empty");
  await expect(
    page.getByRole("heading", { name: "The published program is coming soon" }),
  ).toBeVisible();

  await page.goto("/fixtures/public-schedule/error");
  await expect(
    page.getByRole("heading", { name: "We couldn’t load the public schedule" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();

  await page.goto(`${publicPath}/sessions/not-a-session`);
  await expect(
    page.getByRole("heading", { name: "Session not found" }),
  ).toBeVisible();

  await page.goto(`${publicPath}/sessions/agent-runtime-product-v3`);
  await expect(
    page.getByRole("heading", { name: "Session not found" }),
  ).toBeVisible();

  await page.goto("/e/not-this-event");
  await expect(
    page.getByRole("heading", { name: "Program not found" }),
  ).toBeVisible();
});
