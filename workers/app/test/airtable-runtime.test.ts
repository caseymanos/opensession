import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const server = createTestHarness({
  workers: [
    {
      configPath: "workers/app/test/fixtures/airtable-runtime.wrangler.jsonc",
    },
  ],
});

beforeAll(async () => {
  await server.listen();
});

afterAll(async () => {
  await server.close();
});

describe("Airtable workerd compatibility", () => {
  it("runs client, validation, Web Crypto, and safe errors in workerd", async () => {
    const response = await server.fetch("/");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      error: "Airtable request failed with FIXTURE_ERROR (400).",
      recordId: "recFixture",
    });
  });
});
