import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const server = createTestHarness({
  workers: [
    {
      configPath: "workers/app/wrangler.jsonc",
      vars: {
        FEATURE_FLAGS: {
          ai: false,
          embeds: false,
          email: false,
          integrations: false,
          webhooks: false,
          writes: false,
        },
      },
    },
  ],
});

let origin = "";

beforeAll(async () => {
  origin = (await server.listen()).url.origin;
});

afterAll(async () => {
  await server.close();
});

describe("upload write kill switch", () => {
  it.each([
    ["POST", "/api/uploads/intents"],
    ["PUT", "/api/uploads/file_1/content"],
    ["POST", "/api/uploads/file_1/finalize"],
  ])("blocks %s %s before authentication or storage", async (method, path) => {
    const response = await server.fetch(path, {
      body: "{}",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        "Sec-Fetch-Site": "same-origin",
      },
      method,
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "writes_disabled" },
    });
  });
});
