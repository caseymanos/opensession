import { describe, expect, it, vi } from "vitest";

import {
  parseDemoSmokeOptions,
  readSmokeCredentials,
  runDemoSmoke,
  type DemoSmokeManifest,
} from "./demo-smoke";

const requestIds = Array.from(
  { length: 9 },
  (_, index) =>
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
);
function fixtureRequestId(index: number): string {
  return requestIds[index] ?? "00000000-0000-4000-8000-000000000099";
}
const manifest: DemoSmokeManifest = {
  assetCount: 4,
  digest: "a".repeat(64),
  eventId: "evt_ai_engineer_summit_2026",
  operationCount: 139,
  organizationId: "org_ai_engineer_summit",
  schemaVersion: 1,
  seedVersion: 1,
  snapshotId: `snapshot_${"a".repeat(24)}`,
};
const credentials = {
  apiKey: `osk_key_${"a".repeat(20)}.${"b".repeat(32)}`,
  ownerCookie: `__Host-opensession-session=${"s".repeat(48)}`,
};

function response(
  body: unknown,
  requestId: string,
  options: { headers?: Record<string, string>; status?: number } = {},
) {
  return Response.json(body, {
    headers: { "X-Request-Id": requestId, ...options.headers },
    status: options.status ?? 200,
  });
}

function fixtureFetch() {
  let requestIndex = 0;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    expect(init?.method).toBe("GET");
    const url = new URL(String(input));
    const requestId = fixtureRequestId(requestIndex++);
    if (url.pathname === "/health/live") {
      return response({ environment: "preview", status: "ok" }, requestId);
    }
    if (url.pathname === "/health/ready") {
      return response({ environment: "preview", status: "ready" }, requestId);
    }
    if (url.pathname.endsWith("/cfp")) {
      return response(
        {
          event: { slug: "ai-engineer-summit" },
          form: {
            fields: [
              {
                key: "workshop_prerequisites",
                rules: [{ effect: "show" }, { effect: "require" }],
              },
            ],
          },
        },
        requestId,
      );
    }
    if (url.pathname.endsWith("/integrations/airtable/health")) {
      expect(new Headers(init?.headers).get("cookie")).toBe(
        credentials.ownerCookie,
      );
      return response(
        {
          authority: { schema_version: 10 },
          judge_trace: [
            { kind: "proposal", projected_count: 12 },
            { kind: "session", projected_count: 6 },
            { kind: "task_assignment", projected_count: 8 },
          ],
          projection: {
            last_reconcile: { status: "succeeded" },
            repair_backlog: { dead: 0, failed: 0, pending: 0 },
          },
        },
        requestId,
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (url.pathname.endsWith("/schedule")) {
      return response(
        {
          event: { slug: "ai-engineer-summit" },
          sessions: [{ id: "session_01" }],
          version: 3,
        },
        requestId,
      );
    }
    if (url.pathname === "/api/v1/events") {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${credentials.apiKey}`,
      );
      return response(
        { data: [{ id: "evt_ai_engineer_summit_2026" }] },
        requestId,
      );
    }
    if (url.pathname === "/api/uploads/asset_headshot_01") {
      const authenticated = new Headers(init?.headers).has("cookie");
      return authenticated
        ? new Response(new Uint8Array([1, 2, 3]), {
            headers: {
              "Cache-Control": "private, no-store",
              "Content-Type": "image/png",
              "X-Request-Id": requestId,
            },
          })
        : response({ error: { code: "unauthorized" } }, requestId, {
            status: 401,
          });
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  });
  return fetcher;
}

describe("combined demo synthetic smoke", () => {
  it("covers every read-only component and emits no credentials", async () => {
    const fetcher = fixtureFetch();
    const transcript = await runDemoSmoke({
      baseUrl: "https://preview.opensessionboard.com",
      confirmProduction: false,
      credentials,
      environment: "preview",
      eventId: manifest.eventId,
      eventSlug: "ai-engineer-summit",
      fetchImplementation: fetcher,
      fileId: "asset_headshot_01",
      manifest,
      now: () => new Date("2026-08-11T21:00:00.000Z"),
      resetRunId: "demo_reset_preflight_one",
    });

    expect(transcript).toMatchObject({
      airtable: {
        judgeTrace: { proposal: 12, session: 6, task_assignment: 8 },
        repairBacklog: { dead: 0, failed: 0, pending: 0 },
        schemaVersion: 10,
      },
      api: { eventId: manifest.eventId },
      cfp: { conditionalFields: ["workshop_prerequisites"] },
      reset: {
        digest: manifest.digest,
        runId: "demo_reset_preflight_one",
        snapshotId: manifest.snapshotId,
      },
      schedule: { sessions: 1, version: 3 },
      upload: { contentType: "image/png", fileId: "asset_headshot_01" },
    });
    expect(transcript.checks).toHaveLength(8);
    expect(fetcher).toHaveBeenCalledTimes(8);
    expect(JSON.stringify(transcript)).not.toContain(credentials.apiKey);
    expect(JSON.stringify(transcript)).not.toContain(credentials.ownerCookie);
  });

  it("fails when the conditional CFP is not ready", async () => {
    const fetcher = fixtureFetch();
    fetcher.mockImplementationOnce(async () =>
      response({ environment: "preview", status: "ok" }, fixtureRequestId(0)),
    );
    fetcher.mockImplementationOnce(async () =>
      response(
        { environment: "preview", status: "ready" },
        fixtureRequestId(1),
      ),
    );
    fetcher.mockImplementationOnce(async () =>
      response(
        {
          event: { slug: "ai-engineer-summit" },
          form: { fields: [] },
        },
        fixtureRequestId(2),
      ),
    );

    await expect(
      runDemoSmoke({
        baseUrl: "https://preview.opensessionboard.com",
        confirmProduction: false,
        credentials,
        environment: "preview",
        eventId: manifest.eventId,
        eventSlug: "ai-engineer-summit",
        fetchImplementation: fetcher,
        fileId: "asset_headshot_01",
        manifest,
        resetRunId: "demo_reset_preflight_two",
      }),
    ).rejects.toThrow("did not expose a conditional field");
  });

  it("requires exact production confirmation and private credentials", () => {
    const arguments_ = [
      "--environment",
      "production",
      "--base-url",
      "https://opensessionboard.com",
      "--event-id",
      manifest.eventId,
      "--event-slug",
      "ai-engineer-summit",
      "--file-id",
      "asset_headshot_01",
      "--reset-run-id",
      "demo_reset_production_one",
    ];
    expect(() => parseDemoSmokeOptions(arguments_, {})).toThrow(
      "Production smoke requires",
    );
    expect(
      parseDemoSmokeOptions([...arguments_, "--confirm-production"], {
        DEMO_PRODUCTION_CONFIRM: "production",
      }),
    ).toMatchObject({
      baseUrl: "https://opensessionboard.com",
      environment: "production",
    });
    expect(() => readSmokeCredentials({})).toThrow("DEMO_SMOKE_OWNER_COOKIE");
    expect(
      readSmokeCredentials({
        DEMO_SMOKE_API_KEY: credentials.apiKey,
        DEMO_SMOKE_OWNER_COOKIE: credentials.ownerCookie,
      }),
    ).toEqual(credentials);
  });
});
