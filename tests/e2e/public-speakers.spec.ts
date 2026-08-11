import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

import { publicSpeakerProjectionFixture } from "../../apps/web/src/public/publicSpeakerModel";

const speakerPath = "/e/ai-engineer-summit/speakers";
const fixtureHeadshotSlugs = new Set([
  "alex-chen",
  "elena-vasquez",
  "mina-okafor",
  "priya-nair",
  "ren-ito",
  "sam-rivera",
]);

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/public/events/*/speakers", async (route) => {
    const parts = new URL(route.request().url()).pathname.split("/");
    const slug = parts.at(-2);
    if (slug !== publicSpeakerProjectionFixture.event.slug) {
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
        ETag: '"public-speakers-fixture-v4"',
      },
      json: publicSpeakerProjectionFixture,
      status: 200,
    });
  });
  await page.route(
    "**/api/v1/public/events/*/speakers/*/headshot*",
    async (route) => {
      const parts = new URL(route.request().url()).pathname.split("/");
      const speakerSlug = parts.at(-2) ?? "";
      if (!fixtureHeadshotSlugs.has(speakerSlug)) {
        await route.fulfill({ status: 404 });
        return;
      }
      await route.fulfill({
        contentType: "image/svg+xml",
        headers: { "Cache-Control": "public, max-age=31536000, immutable" },
        path: fileURLToPath(
          new URL(
            `../../apps/web/public/speakers/${speakerSlug}.svg`,
            import.meta.url,
          ),
        ),
        status: 200,
      });
    },
  );
});

test("published gallery searches approved speaker cards with URL state", async ({
  page,
}) => {
  const headshotResponses: { contentType: string; status: number }[] = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.endsWith("/headshot")) {
      headshotResponses.push({
        contentType: response.headers()["content-type"] ?? "",
        status: response.status(),
      });
    }
  });
  await page.goto(speakerPath);

  await expect(
    page.getByRole("heading", {
      name: "Meet the people building what’s next.",
    }),
  ).toBeVisible();
  await expect(page.locator(".speaker-gallery-card")).toHaveCount(10);
  await expect(page.getByText("10 published speakers")).toBeVisible();
  await expect(page.getByRole("link", { name: /Mina Okafor/ })).toBeVisible();
  await expect(
    page.getByAltText("Illustrated portrait of Mina Okafor"),
  ).toBeVisible();
  const fixtureHeadshots = page.locator(".speaker-gallery-card img");
  await expect(fixtureHeadshots).toHaveCount(fixtureHeadshotSlugs.size);
  await expect
    .poll(() => headshotResponses.length)
    .toBe(fixtureHeadshotSlugs.size);
  expect(headshotResponses).toEqual(
    Array.from({ length: fixtureHeadshotSlugs.size }, () => ({
      contentType: "image/svg+xml",
      status: 200,
    })),
  );
  const imageDimensions = await fixtureHeadshots.evaluateAll((images) =>
    images.map((image) => ({
      complete: (image as HTMLImageElement).complete,
      naturalHeight: (image as HTMLImageElement).naturalHeight,
      naturalWidth: (image as HTMLImageElement).naturalWidth,
    })),
  );
  expect(
    imageDimensions.every(
      (image) =>
        image.complete && image.naturalWidth > 0 && image.naturalHeight > 0,
    ),
  ).toBe(true);

  await page.getByLabel("Search speakers").fill("SignalBench");
  await expect(page).toHaveURL(/q=SignalBench/);
  await expect(page.locator(".speaker-gallery-card")).toHaveCount(1);
  await expect(page.getByRole("link", { name: /Sam Rivera/ })).toBeVisible();

  const results = await new AxeBuilder({ page })
    .include(".speaker-public-site")
    .analyze();
  expect(results.violations).toEqual([]);
});

test("profile exposes only approved bio, links, and current published sessions", async ({
  page,
}) => {
  await page.goto(`${speakerPath}/sam-rivera`);

  await expect(
    page.getByRole("heading", { name: "Sam Rivera", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("they/them")).toBeVisible();
  await expect(page.getByText("Evaluation lead · SignalBench")).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Sam Rivera links" }),
  ).toContainText("Website");
  await expect(page.locator(".speaker-session-list article")).toHaveCount(2);
  await expect(
    page.getByRole("link", { name: /Benchmarks After the Benchmark/ }),
  ).toHaveAttribute(
    "href",
    "/e/ai-engineer-summit/sessions/benchmarks-after-benchmark",
  );
  await expect(
    page.getByRole("link", { name: /Your Eval Suite Is Lying to You/ }),
  ).toBeVisible();

  const html = await page.locator("html").innerText();
  expect(html).not.toContain("email");
  expect(html).not.toContain("readiness");
  expect(html).not.toContain("headshotFileName");
  expect(html).not.toContain("object key");
});

test("missing headshot and biography have intentional public fallbacks", async ({
  page,
}) => {
  await page.goto("/fixtures/public-speakers/missing-profile");

  await expect(
    page.getByRole("heading", { name: "Jo Bell", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "No published headshot for Jo Bell" }),
  ).toBeVisible();
  await expect(page.getByText("Portrait coming soon")).toBeVisible();
  await expect(
    page.getByText("This speaker’s approved biography is not published yet."),
  ).toBeVisible();
  await expect(page.getByText("No public links provided.")).toBeVisible();
  await expect(page.locator(".speaker-session-list article")).toHaveCount(1);
});

test("fixture-only empty/error states cannot be selected from production query values", async ({
  page,
}) => {
  await page.goto("/fixtures/public-speakers/empty");
  await expect(
    page.getByRole("heading", { name: "Speakers are coming soon" }),
  ).toBeVisible();

  await page.goto("/fixtures/public-speakers/error");
  await expect(
    page.getByRole("heading", { name: "We couldn’t load the speakers" }),
  ).toBeVisible();

  await page.goto(`${speakerPath}?state=error`);
  await expect(
    page.getByRole("heading", {
      name: "Meet the people building what’s next.",
    }),
  ).toBeVisible();
  await expect(page.locator(".speaker-gallery-card")).toHaveCount(10);
});

test("gallery and profile remain keyboard-clear and overflow-free at 360px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(speakerPath);

  const galleryWidths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(galleryWidths.scroll).toBeLessThanOrEqual(galleryWidths.client + 1);
  await expect(page.locator(".speaker-gallery-grid")).toBeVisible();

  await page.getByRole("link", { name: /Sam Rivera/ }).click();
  await expect(
    page.getByRole("heading", { name: "Sam Rivera", level: 1 }),
  ).toBeVisible();
  const profileWidths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(profileWidths.scroll).toBeLessThanOrEqual(profileWidths.client + 1);

  const results = await new AxeBuilder({ page })
    .include(".speaker-public-site")
    .analyze();
  expect(results.violations).toEqual([]);
});

test("invalid or private-shaped projection payload fails closed", async ({
  page,
}) => {
  await page.unroute("**/api/v1/public/events/*/speakers");
  await page.route("**/api/v1/public/events/*/speakers", async (route) => {
    await route.fulfill({
      json: {
        ...publicSpeakerProjectionFixture,
        speakers: [
          {
            ...publicSpeakerProjectionFixture.speakers[0],
            contactEmail: "private@example.com",
          },
        ],
      },
      status: 200,
    });
  });
  await page.goto(speakerPath);
  await expect(
    page.getByRole("heading", { name: "We couldn’t load the speakers" }),
  ).toBeVisible();
  await expect(page.getByText("private@example.com")).toHaveCount(0);
});
