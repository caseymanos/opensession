import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AbuseProtectionService } from "../src/security/abuse";

const pepper = "test-abuse-pepper-with-at-least-32-characters";
const server = createTestHarness({
  workers: [{ configPath: "workers/app/wrangler.jsonc" }],
});

beforeAll(async () => {
  await server.listen();
  await server.getWorker<Env>().applyD1Migrations("DB");
});

afterAll(async () => server.close());

describe("AbuseProtectionService", () => {
  it("blocks layered account attempts and stores only hashed keys", async () => {
    const environment = await server.getWorker<Env>().getEnv();
    const service = new AbuseProtectionService({
      database: environment.DB,
      hashPepper: pepper,
      now: () => new Date("2026-08-09T12:00:00.000Z"),
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await expect(
        service.consume("account", {
          event: "ai-engineer-summit",
          ip: "203.0.113.44",
        }),
      ).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
    }
    await expect(
      service.consume("account", {
        event: "ai-engineer-summit",
        ip: "203.0.113.44",
      }),
    ).resolves.toEqual({ allowed: false, retryAfterSeconds: 1_800 });

    const rows = await environment.DB.prepare(
      "SELECT scope, key_hash FROM abuse_rate_limits ORDER BY scope",
    ).all<{ key_hash: string; scope: string }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results.map(({ scope }) => scope)).toEqual([
      "account:event",
      "account:ip",
    ]);
    expect(JSON.stringify(rows.results)).not.toContain("203.0.113.44");
    expect(JSON.stringify(rows.results)).not.toContain("ai-engineer-summit");
  });
});
