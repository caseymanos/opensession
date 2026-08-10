import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertAuthorizationWrite,
  assertManifest,
  authorizationCommand,
  customDomainOrigin,
  parseArguments,
} from "./demo-bootstrap";

const root = process.cwd();
const wrangler = resolve(root, "node_modules/.bin/wrangler");
const config = resolve(root, "workers/app/wrangler.jsonc");
const baseId = `app${"A".repeat(14)}`;
const manifest = {
  assetCount: 4,
  digest: "a".repeat(64),
  eventId: "evt_demo",
  operationCount: 134,
  organizationId: "org_demo",
  schemaVersion: 1 as const,
  seedVersion: 1,
  snapshotId: `snapshot_${"b".repeat(24)}`,
};
const state = {
  authorizationExpiresAt: null,
  baseId,
  environment: "preview" as const,
  eventRecordId: `rec${"E".repeat(14)}`,
  manifestDigest: manifest.digest,
  operationId: "demo_bootstrap_test_resume",
  organizationRecordId: `rec${"O".repeat(14)}`,
  token: "t".repeat(48),
};
const tokenHash = "c".repeat(64);
let persistence = "";

function execute(sql: string) {
  const output = execFileSync(
    wrangler,
    [
      "d1",
      "execute",
      "DB",
      "--local",
      "--persist-to",
      persistence,
      "--command",
      sql,
      "--config",
      config,
      "--json",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CI: "1", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return JSON.parse(output) as Parameters<typeof assertAuthorizationWrite>[0];
}

function command(
  now: string,
  expiresAt: string,
  restartFailed = false,
): string {
  return authorizationCommand({
    baseId,
    environment: "preview",
    expiresAt,
    manifest,
    now,
    restartFailed,
    state,
    tokenHash,
  });
}

beforeAll(() => {
  persistence = mkdtempSync(resolve(tmpdir(), "opensession-demo-bootstrap-"));
  execFileSync(
    wrangler,
    [
      "d1",
      "execute",
      "DB",
      "--local",
      "--persist-to",
      persistence,
      "--file",
      resolve(root, "migrations/0015_demo_bootstrap_authorization.sql"),
      "--config",
      config,
    ],
    {
      cwd: root,
      env: { ...process.env, CI: "1", NO_COLOR: "1" },
      stdio: "ignore",
    },
  );
});

afterAll(() => {
  if (persistence) rmSync(persistence, { force: true, recursive: true });
});

describe("demo bootstrap operator protocol", () => {
  it("requires an explicit environment and guarded failed restart", () => {
    expect(parseArguments(["--environment", "preview"])).toEqual({
      confirmProduction: false,
      environment: "preview",
      restartFailed: false,
    });
    expect(
      parseArguments(["--environment", "production", "--restart-failed"]),
    ).toMatchObject({ environment: "production", restartFailed: true });
    expect(() => parseArguments([])).toThrow("--environment");
  });

  it("accepts only a validated custom-domain origin and seed manifest", () => {
    expect(
      customDomainOrigin({
        routes: [
          { custom_domain: true, pattern: "preview.opensessionboard.com" },
        ],
      }).href,
    ).toBe("https://preview.opensessionboard.com/");
    expect(() => customDomainOrigin({ routes: [] })).toThrow("custom domain");
    expect(() =>
      customDomainOrigin({
        routes: [{ custom_domain: true, pattern: "example.test/path" }],
      }),
    ).toThrow("invalid");
    expect(() => assertManifest(manifest)).not.toThrow();
    expect(() => assertManifest({ ...manifest, operationCount: 0 })).toThrow(
      "manifest is invalid",
    );
  });

  it("renews the same operation after an interrupted authorization expires", () => {
    const initialNow = "2026-08-10T20:00:00.000Z";
    const initialExpiry = "2026-08-10T20:15:00.000Z";
    assertAuthorizationWrite(
      execute(command(initialNow, initialExpiry)),
      state,
      initialExpiry,
    );
    execute(`UPDATE demo_bootstrap_authorizations
      SET status = 'leased', lease_expires_at = '2026-08-10T20:05:00.000Z'
      WHERE operation_id = '${state.operationId}';
      SELECT changes() AS authorization_changes;`);

    const resumedNow = "2026-08-10T20:20:00.000Z";
    const resumedExpiry = "2026-08-10T20:35:00.000Z";
    const resumed = execute(command(resumedNow, resumedExpiry));

    expect(() =>
      assertAuthorizationWrite(resumed, state, resumedExpiry),
    ).not.toThrow();
    expect(resumed.at(-1)?.results).toEqual([
      {
        authorization_changes: 1,
        expires_at: resumedExpiry,
        operation_id: state.operationId,
        status: "pending",
      },
    ]);
  });

  it("reads a completed lost-response operation without mutating it", () => {
    execute(`UPDATE demo_bootstrap_authorizations
      SET status = 'complete', completed_at = '2026-08-10T20:21:00.000Z',
          result_json = '{"receipt":{"outcome":"applied"}}',
          lease_expires_at = NULL
      WHERE operation_id = '${state.operationId}';
      SELECT changes() AS authorization_changes;`);
    const replayExpiry = "2026-08-10T20:50:00.000Z";
    const readback = execute(command("2026-08-10T20:35:00.000Z", replayExpiry));

    expect(() =>
      assertAuthorizationWrite(readback, state, replayExpiry),
    ).not.toThrow();
    expect(readback.at(-1)?.results?.[0]).toMatchObject({
      authorization_changes: 0,
      status: "complete",
    });
  });

  it("requires an explicit restart to renew an exact failed operation", () => {
    execute(`UPDATE demo_bootstrap_authorizations
      SET status = 'failed', completed_at = NULL, result_json = NULL
      WHERE operation_id = '${state.operationId}';
      SELECT changes() AS authorization_changes;`);
    const expiresAt = "2026-08-10T21:15:00.000Z";

    expect(() =>
      assertAuthorizationWrite(
        execute(command("2026-08-10T21:00:00.000Z", expiresAt)),
        state,
        expiresAt,
      ),
    ).toThrow("not written exactly once");
    expect(() =>
      assertAuthorizationWrite(
        execute(command("2026-08-10T21:00:00.000Z", expiresAt, true)),
        state,
        expiresAt,
      ),
    ).not.toThrow();
  });
});
