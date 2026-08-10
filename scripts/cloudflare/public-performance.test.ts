import { describe, expect, it } from "vitest";

import {
  capturePublicPerformance,
  parsePublicPerformanceOptions,
} from "./public-performance";

const entityTag = `"${"a".repeat(64)}"`;
const projection = JSON.stringify({
  event: { slug: "ai-engineer-summit" },
  generatedAt: "2026-08-09T18:00:00.000Z",
  sessions: [{ id: "opening" }],
  version: 4,
});

function createCacheFetch({ changeEtag = false } = {}) {
  let request = 0;
  return async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (headers.has("if-none-match")) {
      return new Response(null, {
        headers: { "CF-Cache-Status": "HIT", ETag: entityTag },
        status: 304,
      });
    }

    request += 1;
    return new Response(projection, {
      headers: {
        "Cache-Control": "public, max-age=0, must-revalidate",
        "CF-Cache-Status": request === 1 ? "MISS" : "HIT",
        "CF-Ray": "request-SJC",
        "Content-Type": "application/json; charset=utf-8",
        ETag: changeEtag && request > 1 ? `"${"b".repeat(64)}"` : entityTag,
      },
      status: 200,
    });
  };
}

describe("public performance capture", () => {
  it("records a cold miss, warm hits, p95, and cached conditional response", async () => {
    const result = await capturePublicPerformance({
      build: "version-1",
      environment: "preview",
      eventSlug: "ai-engineer-summit",
      fetchImplementation: createCacheFetch(),
      readActiveBuild: async () => "version-1",
      seed: "public-v4",
      url: "https://preview.example/api/v1/public/events/ai-engineer-summit/schedule",
    });

    expect(result).toMatchObject({
      build: "version-1",
      cold: { cacheStatus: "MISS", colo: "SJC", status: 200 },
      conditional: { bodyBytes: 0, cacheStatus: "HIT", status: 304 },
      projection: {
        generatedAt: "2026-08-09T18:00:00.000Z",
        sessions: 1,
        version: 4,
      },
      route: "/api/v1/public/events/:slug/schedule",
      schemaVersion: 1,
      seed: "public-v4",
      warm: { cacheStatuses: { HIT: 30 }, requests: 30 },
    });
    expect(result.warm.p95TtfbMs).toBeLessThan(200);
  });

  it("fails when the public representation changes during the warm run", async () => {
    await expect(
      capturePublicPerformance({
        build: "version-1",
        environment: "preview",
        eventSlug: "ai-engineer-summit",
        fetchImplementation: createCacheFetch({ changeEtag: true }),
        readActiveBuild: async () => "version-1",
        seed: "public-v4",
        url: "https://preview.example/api/v1/public/events/ai-engineer-summit/schedule",
      }),
    ).rejects.toThrow("ETag changed");
  });

  it("rejects a stale inventory version before making public requests", async () => {
    let publicRequests = 0;
    await expect(
      capturePublicPerformance({
        build: "version-1",
        environment: "preview",
        eventSlug: "ai-engineer-summit",
        fetchImplementation: async () => {
          publicRequests += 1;
          return new Response();
        },
        readActiveBuild: async () => "version-2",
        seed: "public-v4",
        url: "https://preview.example/api/v1/public/events/ai-engineer-summit/schedule",
      }),
    ).rejects.toThrow("does not match expected build version-1 before capture");
    expect(publicRequests).toBe(0);
  });

  it("discards evidence when the active version changes during capture", async () => {
    let versionReads = 0;
    await expect(
      capturePublicPerformance({
        build: "version-1",
        environment: "preview",
        eventSlug: "ai-engineer-summit",
        fetchImplementation: createCacheFetch(),
        readActiveBuild: async () => {
          versionReads += 1;
          return versionReads === 1 ? "version-1" : "version-2";
        },
        seed: "public-v4",
        url: "https://preview.example/api/v1/public/events/ai-engineer-summit/schedule",
      }),
    ).rejects.toThrow("does not match expected build version-1 after capture");
    expect(versionReads).toBe(2);
  });

  it("requires explicit production confirmation and bounded identifiers", () => {
    expect(() =>
      parsePublicPerformanceOptions([
        "--",
        "--environment",
        "production",
        "--event-slug",
        "ai-engineer-summit",
        "--seed",
        "public-v4",
      ]),
    ).toThrow("--confirm-production");

    expect(
      parsePublicPerformanceOptions([
        "--environment",
        "preview",
        "--event-slug",
        "ai-engineer-summit",
        "--seed",
        "public-v4",
      ]),
    ).toMatchObject({
      environment: "preview",
      eventSlug: "ai-engineer-summit",
      seed: "public-v4",
    });
  });
});
