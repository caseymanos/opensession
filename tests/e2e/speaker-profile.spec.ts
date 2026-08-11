import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import type {
  SpeakerProfileResponse,
  SpeakerProfileSaveCommand,
} from "@sessionbox-killer/contracts";

import { mockPortalAuth, portalCsrfToken } from "./portal-auth";

const profilePath = "/fixtures/portal/profile";
const productionProfilePath = "/portal/ai-engineer-summit/profile";

const productionProfileFixture = {
  audit: [
    {
      action: "saved",
      actor: "speaker",
      at: "2026-08-11T08:00:00.000Z",
      summary: "Profile details updated.",
    },
  ],
  fields: {
    bio: "Mina builds reliability systems for production AI teams.",
    bluesky_url: "https://bsky.app/profile/mina.example.com",
    company: "Relay",
    display_name: "Mina Okafor",
    headshot_alt: "Portrait of Mina Okafor",
    linkedin_url: "https://www.linkedin.com/in/mina-okafor",
    pronouns: "she/her",
    title: "Principal engineer",
    website_url: "https://mina.example.com",
  },
  headshot: {
    alt: "Portrait of Mina Okafor",
    content_type: "image/png",
    file_name: "mina.png",
    id: "file_headshot_1",
    preview_url: "/api/portal/ai-engineer-summit/profile/headshot",
    status: "ready",
    version: 1,
  },
  policy: {
    accepted_content_types: ["image/jpeg", "image/png", "image/webp"],
    max_bytes: 8 * 1024 * 1024,
    min_height: 1200,
    min_width: 1200,
    scope: "organization",
  },
  profile_id: "contact_mina",
  publication_state: "draft",
  reuse_scope: "organization",
  updated_at: "2026-08-11T08:00:00.000Z",
  upload_context: {
    event_id: "evt_ai_summit",
    organization_id: "organization_one",
    owner_contact_id: "contact_mina",
    purpose: "headshot",
    replacement_file_id: "file_headshot_1",
  },
  version: 3,
} satisfies SpeakerProfileResponse;

async function mockProductionProfile(page: Page) {
  await page.route(
    "**/api/portal/ai-engineer-summit/profile",
    async (route) => {
      await route.fulfill({ json: productionProfileFixture, status: 200 });
    },
  );
  await page.route(
    "**/api/portal/ai-engineer-summit/profile/headshot*",
    async (route) => {
      await route.fulfill({
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        ),
        contentType: "image/png",
        status: 200,
      });
    },
  );
}

test.beforeEach(async ({ page }) => mockPortalAuth(page));

test("speaker profile exposes reusable fields and an unpublished public preview", async ({
  page,
}) => {
  await page.goto(profilePath);

  await expect(
    page.getByRole("heading", {
      name: "Shape how the audience meets you.",
      level: 1,
    }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Profile" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByText("Unpublished draft")).toBeVisible();

  const preview = page.locator(".public-speaker-preview");
  await expect(preview).toContainText("Mina Okafor");
  await expect(preview).toContainText("VP, AI Reliability · Northstar Labs");
  await expect(preview).not.toContainText("readiness");
  await expect(preview).not.toContainText("tasks");

  await page.getByRole("button", { name: "Full profile" }).click();
  await expect(preview).toContainText("Mina builds reliability systems");
  await expect(preview.getByRole("link", { name: /LinkedIn/ })).toBeVisible();

  const results = await new AxeBuilder({ page })
    .include(".speaker-profile-main")
    .analyze();
  expect(results.violations).toEqual([]);
});

test("invalid social URLs are rejected and never enter the public preview", async ({
  page,
}) => {
  await page.goto(profilePath);
  await page.getByRole("button", { name: "Full profile" }).click();

  await page.getByLabel("LinkedIn URL").fill("https://example.com/mina");
  await expect(page.getByText("Use a linkedin.com profile URL.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save now" })).toBeDisabled();
  await expect(
    page.locator(".public-speaker-preview").getByRole("link", {
      name: /LinkedIn/,
    }),
  ).toHaveCount(0);

  await page.getByLabel("Website URL").fill("javascript:alert(1)");
  await expect(
    page.getByText("Enter a complete http:// or https:// URL."),
  ).toBeVisible();
  await expect(
    page.locator(".public-speaker-preview").getByRole("link", {
      name: /Website/,
    }),
  ).toHaveCount(0);
});

test("autosave makes pending and saved states explicit and records an audit entry", async ({
  page,
}) => {
  await page.goto(profilePath);

  await page.getByLabel("Display name").fill("Mina N. Okafor");
  await expect(page.getByRole("status")).toContainText("Unsaved changes");
  await expect(
    page.locator(".public-speaker-preview").getByRole("heading", {
      name: "Mina N. Okafor",
    }),
  ).toBeVisible();

  await expect(page.getByRole("status")).toContainText("All changes saved", {
    timeout: 3_000,
  });
  await expect(page.getByRole("status")).toContainText("Saved just now");
  await expect(
    page.getByText("Profile autosaved · Mina Okafor · Just now"),
  ).toBeVisible();
});

test("manual save remains available when autosave is disabled", async ({
  page,
}) => {
  await page.goto(profilePath);

  await page.getByRole("switch", { name: "Autosave profile" }).click();
  await page.getByLabel("Company or organization").fill("Northstar Research");
  await expect(page.getByRole("status")).toContainText("Unsaved changes");
  await page.waitForTimeout(1_100);
  await expect(page.getByRole("status")).toContainText("Unsaved changes");

  await page.getByRole("button", { name: "Save now" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Profile saved" }),
  ).toContainText("attendee preview remains unpublished");
  await expect(
    page.getByText("Profile saved · Mina Okafor · Just now"),
  ).toBeVisible();
});

test("headshot replacement validates files, processes a private preview, and keeps alt semantics", async ({
  page,
}) => {
  await page.goto(profilePath);
  const input = page.getByLabel("Replace headshot");

  await input.setInputFiles({
    buffer: Buffer.from("not an image"),
    mimeType: "text/plain",
    name: "notes.txt",
  });
  await expect(page.locator(".profile-headshot-error")).toHaveText(
    "Choose a JPG, PNG, or WebP image.",
  );

  const pngBase64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 1200;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable");
    context.fillStyle = "#d97859";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#15201c";
    context.font = "bold 320px sans-serif";
    context.fillText("MO", 330, 720);
    return canvas.toDataURL("image/png").split(",")[1] ?? "";
  });

  await input.setInputFiles({
    buffer: Buffer.from(pngBase64, "base64"),
    mimeType: "image/png",
    name: "mina-updated.png",
  });
  await expect(page.getByText("mina-updated.png")).toBeVisible();
  await expect(
    page.locator(".profile-headshot-copy").getByText("Ready"),
  ).toBeVisible({ timeout: 2_000 });

  await page
    .getByLabel("Headshot alt text")
    .fill("Mina Okafor in front of a coral background");
  await expect(page.locator(".public-speaker-preview img")).toHaveAttribute(
    "alt",
    "Mina Okafor in front of a coral background",
  );
});

test("speaker profile remains accessible and contained at 360px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(profilePath);

  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);
  await expect(
    page.getByRole("switch", { name: "Autosave profile" }),
  ).toBeVisible();
  await expect(
    page.getByText("Reusable identity, event-private operations"),
  ).toBeVisible();
  const activeProfileLink = page.getByRole("link", { name: "Profile" });
  const activeProfileBounds = await activeProfileLink.boundingBox();
  expect(activeProfileBounds).not.toBeNull();
  expect(activeProfileBounds?.x).toBeGreaterThanOrEqual(0);
  expect(
    (activeProfileBounds?.x ?? 0) + (activeProfileBounds?.width ?? 0),
  ).toBeLessThanOrEqual(360);

  const results = await new AxeBuilder({ page })
    .include(".speaker-profile-main")
    .analyze();
  expect(results.violations).toEqual([]);
});

test("production profile consumes the authoritative contract and ignores fixture query state", async ({
  page,
}) => {
  await mockProductionProfile(page);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(`${productionProfilePath}?state=error`);

  await expect(
    page.getByRole("heading", { name: "Shape how the audience meets you." }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Profile" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByText("Profile details updated.")).toBeVisible();
  await expect(page.getByText("Unpublished draft")).toBeVisible();
  await expect(page.locator(".public-speaker-preview")).toContainText(
    "AI Engineer Summit",
  );
  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);
  const results = await new AxeBuilder({ page })
    .include(".speaker-profile-main")
    .analyze();
  expect(results.violations).toEqual([]);
});

test("production retry replays the exact save envelope after an unknown outcome", async ({
  page,
}) => {
  await mockProductionProfile(page);
  const commands: SpeakerProfileSaveCommand[] = [];
  let logicalMutations = 0;
  await page.route(
    "**/api/portal/ai-engineer-summit/profile/commands",
    async (route) => {
      const command = route
        .request()
        .postDataJSON() as SpeakerProfileSaveCommand;
      commands.push(command);
      expect(route.request().headers()["x-csrf-token"]).toBe(portalCsrfToken);
      if (commands.length === 1) {
        logicalMutations += 1;
        await route.fulfill({
          json: {
            error: {
              code: "profile_outcome_unknown",
              message: "Retry the same command.",
              retryable: true,
            },
            request_id: "request_unknown",
          },
          status: 202,
        });
        return;
      }
      await route.fulfill({
        json: {
          ok: true,
          outcome: "replayed",
          profile: {
            ...productionProfileFixture,
            fields: command.fields,
            updated_at: "2026-08-11T08:05:00.000Z",
            version: 4,
          },
          projection: "durable",
        },
        status: 200,
      });
    },
  );
  await page.goto(productionProfilePath);
  await page.getByRole("switch", { name: "Autosave profile" }).click();
  await page.getByLabel("Company or organization").fill("Signal Relay");
  await page.getByRole("button", { name: "Save now" }).click();

  await expect(page.getByText("We could not confirm the save")).toBeVisible();
  await expect(page.getByLabel("Company or organization")).toBeDisabled();
  await page.getByRole("button", { name: "Retry exact save" }).click();
  await expect(page.getByText("Save recovered")).toBeVisible();
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(commands[0]);
  expect(logicalMutations).toBe(1);
  await expect(page.getByLabel("Company or organization")).toHaveValue(
    "Signal Relay",
  );
});

test("repair-pending save remains locked until the same command settles durable", async ({
  page,
}) => {
  await mockProductionProfile(page);
  const commands: SpeakerProfileSaveCommand[] = [];
  await page.route(
    "**/api/portal/ai-engineer-summit/profile/commands",
    async (route) => {
      const command = route
        .request()
        .postDataJSON() as SpeakerProfileSaveCommand;
      commands.push(command);
      await route.fulfill({
        json: {
          ok: true,
          outcome: commands.length === 1 ? "applied" : "replayed",
          profile: {
            ...productionProfileFixture,
            fields: command.fields,
            updated_at: "2026-08-11T08:06:00.000Z",
            version: 4,
          },
          projection: commands.length === 1 ? "repair_pending" : "durable",
        },
        status: 200,
      });
    },
  );
  await page.goto(productionProfilePath);
  await page.getByRole("switch", { name: "Autosave profile" }).click();
  await page.getByLabel("Role or title").fill("Distinguished engineer");
  await page.getByRole("button", { name: "Save now" }).click();

  await expect(
    page.getByText("Saved, finishing synchronization"),
  ).toBeVisible();
  await expect(page.getByLabel("Role or title")).toBeDisabled();
  await page.getByRole("button", { name: "Check synchronization" }).click();
  await expect(page.getByText("Save recovered")).toBeVisible();
  expect(commands[1]).toEqual(commands[0]);
});

test("headshot finalize recovery does not upload the private file twice", async ({
  page,
}) => {
  await mockProductionProfile(page);
  let intentRequests = 0;
  let contentPuts = 0;
  let finalizeRequests = 0;
  const commands: SpeakerProfileSaveCommand[] = [];
  await page.route("**/api/uploads/intents", async (route) => {
    intentRequests += 1;
    const intent = route.request().postDataJSON() as {
      checksum_sha256: string;
    };
    await route.fulfill({
      json: {
        file: {
          id: "file_headshot_2",
          lineage_id: "file_headshot_1",
          status: "pending",
          version: 2,
        },
        upload: {
          expires_at: "2026-08-11T09:00:00.000Z",
          headers: {
            "Content-Type": "image/png",
            "X-Content-SHA256": intent.checksum_sha256,
            "X-Upload-Token": "opaque-upload-token",
          },
          method: "PUT",
          url: "/api/uploads/file_headshot_2/content",
        },
      },
      status: 201,
    });
  });
  await page.route("**/api/uploads/file_headshot_2/content", async (route) => {
    contentPuts += 1;
    await route.fulfill({ status: 204 });
  });
  await page.route("**/api/uploads/file_headshot_2/finalize", async (route) => {
    finalizeRequests += 1;
    if (finalizeRequests === 1) {
      await route.fulfill({
        json: {
          error: {
            code: "file_not_uploaded",
            message: "Processing is not finished.",
          },
        },
        status: 409,
      });
      return;
    }
    await route.fulfill({
      json: {
        byte_size: 100,
        checksum_sha256: "a".repeat(64),
        content_type: "image/png",
        detected_content_type: "image/png",
        id: "file_headshot_2",
        status: "ready",
        version: 2,
      },
      status: 200,
    });
  });
  await page.route(
    "**/api/portal/ai-engineer-summit/profile/commands",
    async (route) => {
      const command = route
        .request()
        .postDataJSON() as SpeakerProfileSaveCommand;
      commands.push(command);
      await route.fulfill({
        json: {
          ok: true,
          outcome: "applied",
          profile: {
            ...productionProfileFixture,
            fields: command.fields,
            headshot: {
              ...productionProfileFixture.headshot,
              file_name: "mina-new.png",
              id: "file_headshot_2",
              version: 2,
            },
            updated_at: "2026-08-11T08:07:00.000Z",
            version: 4,
          },
          projection: "durable",
        },
        status: 200,
      });
    },
  );

  await page.goto(productionProfilePath);
  await page.getByRole("switch", { name: "Autosave profile" }).click();
  const pngBase64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 1200;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable");
    context.fillStyle = "#d97859";
    context.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png").split(",")[1] ?? "";
  });
  await page.getByLabel("Replace headshot").setInputFiles({
    buffer: Buffer.from(pngBase64, "base64"),
    mimeType: "image/png",
    name: "mina-new.png",
  });
  await expect(page.getByText("mina-new.png")).toBeVisible();
  await page.getByRole("button", { name: "Save now" }).click();
  await expect(page.getByText("Headshot processing paused")).toBeVisible();
  await page.getByRole("button", { name: "Retry processing" }).click();
  await expect(page.getByText("Profile saved")).toBeVisible();
  expect(intentRequests).toBe(1);
  expect(contentPuts).toBe(1);
  expect(finalizeRequests).toBe(2);
  expect(commands).toHaveLength(1);
  expect(commands[0]?.headshot_file_id).toBe("file_headshot_2");
});

test("a finalized headshot is reused after a profile version conflict", async ({
  page,
}) => {
  await mockProductionProfile(page);
  let intentRequests = 0;
  let contentPuts = 0;
  let finalizeRequests = 0;
  const commands: SpeakerProfileSaveCommand[] = [];

  await page.route("**/api/uploads/intents", async (route) => {
    intentRequests += 1;
    const intent = route.request().postDataJSON() as {
      checksum_sha256: string;
    };
    await route.fulfill({
      json: {
        file: {
          id: "file_headshot_2",
          lineage_id: "file_headshot_1",
          status: "pending",
          version: 2,
        },
        upload: {
          expires_at: "2026-08-11T09:00:00.000Z",
          headers: {
            "Content-Type": "image/png",
            "X-Content-SHA256": intent.checksum_sha256,
            "X-Upload-Token": "opaque-upload-token",
          },
          method: "PUT",
          url: "/api/uploads/file_headshot_2/content",
        },
      },
      status: 201,
    });
  });
  await page.route("**/api/uploads/file_headshot_2/content", async (route) => {
    contentPuts += 1;
    await route.fulfill({ status: 204 });
  });
  await page.route("**/api/uploads/file_headshot_2/finalize", async (route) => {
    finalizeRequests += 1;
    await route.fulfill({
      json: {
        byte_size: 100,
        checksum_sha256: "a".repeat(64),
        content_type: "image/png",
        detected_content_type: "image/png",
        id: "file_headshot_2",
        status: "ready",
        version: 2,
      },
      status: 200,
    });
  });
  await page.route(
    "**/api/portal/ai-engineer-summit/profile/commands",
    async (route) => {
      const command = route
        .request()
        .postDataJSON() as SpeakerProfileSaveCommand;
      commands.push(command);
      if (commands.length === 1) {
        await route.fulfill({
          json: {
            error: {
              actual_version: 4,
              code: "profile_version_conflict",
              expected_version: 3,
              message: "The profile changed elsewhere.",
              retryable: false,
            },
            request_id: "req_profile_conflict",
          },
          status: 412,
        });
        return;
      }
      await route.fulfill({
        json: {
          ok: true,
          outcome: "applied",
          profile: {
            ...productionProfileFixture,
            fields: command.fields,
            headshot: {
              ...productionProfileFixture.headshot,
              file_name: "mina-conflict.png",
              id: "file_headshot_2",
              version: 2,
            },
            updated_at: "2026-08-11T08:08:00.000Z",
            version: 5,
          },
          projection: "durable",
        },
        status: 200,
      });
    },
  );

  await page.goto(productionProfilePath);
  const pngBase64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 1200;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable");
    context.fillStyle = "#15201c";
    context.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png").split(",")[1] ?? "";
  });
  await page.getByLabel("Replace headshot").setInputFiles({
    buffer: Buffer.from(pngBase64, "base64"),
    mimeType: "image/png",
    name: "mina-conflict.png",
  });
  await expect(page.getByText("mina-conflict.png")).toBeVisible();
  await page.getByRole("button", { name: "Save now" }).click();
  await expect(page.getByText("This profile changed elsewhere")).toBeVisible();
  await expect(page.getByLabel("Display name")).toBeDisabled();
  await page.waitForTimeout(1_100);
  expect(commands).toHaveLength(1);

  await page.unroute("**/api/portal/ai-engineer-summit/profile");
  await page.route(
    "**/api/portal/ai-engineer-summit/profile",
    async (route) => {
      await route.fulfill({
        json: { ...productionProfileFixture, version: 4 },
        status: 200,
      });
    },
  );
  await page.getByRole("button", { name: "Load latest version" }).click();
  await expect(page.getByText("Latest version loaded")).toBeVisible();
  await page.waitForTimeout(1_100);
  expect(commands).toHaveLength(1);
  await page.getByRole("button", { name: "Save now" }).click();
  await expect(page.getByText("Profile saved")).toBeVisible();

  expect(intentRequests).toBe(1);
  expect(contentPuts).toBe(1);
  expect(finalizeRequests).toBe(1);
  expect(commands).toHaveLength(2);
  expect(commands[0]?.headshot_file_id).toBe("file_headshot_2");
  expect(commands[1]?.headshot_file_id).toBe("file_headshot_2");
  expect(commands[1]?.expected_version).toBe(4);
  expect(commands[1]?.command_id).not.toBe(commands[0]?.command_id);
});
