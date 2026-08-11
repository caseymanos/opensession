import type { PublicScheduleProjection } from "@sessionbox-killer/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  isPublicScheduleCacheInvalidationMessage,
  ifNoneMatchIncludes,
  markPublicScheduleInvalidationProcessed,
  PUBLIC_SCHEDULE_BROWSER_CACHE_CONTROL,
  PUBLIC_SCHEDULE_EDGE_CACHE_CONTROL,
  processPublicScheduleCacheInvalidation,
  publicScheduleResponse,
  purgePublicScheduleCache,
} from "../src/public-schedule/cache.js";
import { shouldInvalidatePublicSchedule } from "../src/authority/projector.js";

const projection: PublicScheduleProjection = {
  event: {
    dates: "August 18, 2026",
    location: "Fort Mason Center · San Francisco",
    name: "AI Engineer Summit",
    slug: "ai-engineer-summit",
    summary: "A public program.",
    timezone: "America/Los_Angeles",
  },
  generatedAt: "2026-08-09T04:45:30.000Z",
  sessions: [],
  version: 4,
};

describe("public schedule cache contract", () => {
  it("invalidates coordinated schedules only at the event version commit", () => {
    expect(
      shouldInvalidatePublicSchedule({
        operation: "schedule.place_session.schedule_slots",
        table: "schedule_slots",
      }),
    ).toBe(false);
    expect(
      shouldInvalidatePublicSchedule({
        operation: "schedule.place_session.sessions",
        table: "sessions",
      }),
    ).toBe(false);
    expect(
      shouldInvalidatePublicSchedule({
        operation: "schedule.place_session.events",
        table: "events",
      }),
    ).toBe(true);
    expect(
      shouldInvalidatePublicSchedule({
        operation: "rooms.update",
        table: "rooms",
      }),
    ).toBe(true);
  });

  it("accepts only bounded versioned invalidation messages", () => {
    expect(
      isPublicScheduleCacheInvalidationMessage({
        event_id: "event_ai_summit",
        kind: "public_schedule.cache.invalidate",
        version: 1,
      }),
    ).toBe(true);
    expect(
      isPublicScheduleCacheInvalidationMessage({
        event_id: "event_ai_summit",
        invalidation_version: 3,
        kind: "public_schedule.cache.invalidate",
        organization_id: "org_public",
        version: 2,
      }),
    ).toBe(true);
    expect(
      isPublicScheduleCacheInvalidationMessage({
        event_id: "../../other-event",
        invalidation_version: 3,
        kind: "public_schedule.cache.invalidate",
        organization_id: "org_public",
        version: 2,
      }),
    ).toBe(false);
    expect(
      isPublicScheduleCacheInvalidationMessage({
        event_id: "event_ai_summit",
        invalidation_version: 3,
        kind: "email.send",
        organization_id: "org_public",
        version: 2,
      }),
    ).toBe(false);
    expect(
      isPublicScheduleCacheInvalidationMessage({
        event_id: "event_ai_summit",
        invalidation_version: 0,
        kind: "public_schedule.cache.invalidate",
        organization_id: "org_public",
        version: 2,
      }),
    ).toBe(false);
    expect(isPublicScheduleCacheInvalidationMessage(null)).toBe(false);
    expect(
      isPublicScheduleCacheInvalidationMessage({
        event_id: "event_ai_summit",
        invalidation_version: 3,
        kind: "public_schedule.cache.invalidate",
        organization_id: "../../other-org",
        version: 2,
      }),
    ).toBe(false);
    expect(
      isPublicScheduleCacheInvalidationMessage({
        event_id: "event_ai_summit",
        invalidation_version: Number.MAX_SAFE_INTEGER + 1,
        kind: "public_schedule.cache.invalidate",
        organization_id: "org_public",
        version: 2,
      }),
    ).toBe(false);
  });

  it("purges both protocol versions and completes only an exact v2 generation", async () => {
    const purge = vi.fn(async () => ({ errors: [], success: true }));
    const run = vi
      .fn<() => Promise<{ meta: { changes: number } }>>()
      .mockResolvedValueOnce({ meta: { changes: 1 } })
      .mockResolvedValueOnce({ meta: { changes: 0 } });
    const bind = vi.fn(() => ({ run }));
    const prepare = vi.fn(() => ({ bind }));
    const database = { prepare } as unknown as D1Database;
    const v2Message = {
      event_id: "event_ai_summit",
      invalidation_version: 3,
      kind: "public_schedule.cache.invalidate" as const,
      organization_id: "org_public",
      version: 2 as const,
    };

    await expect(
      processPublicScheduleCacheInvalidation(
        { cache: { purge } } as unknown as ExecutionContext,
        { APP_ENV: "production", DB: database },
        { ...v2Message, version: 1 },
      ),
    ).resolves.toBeUndefined();
    expect(prepare).not.toHaveBeenCalled();

    await expect(
      processPublicScheduleCacheInvalidation(
        { cache: { purge } } as unknown as ExecutionContext,
        { APP_ENV: "production", DB: database },
        v2Message,
      ),
    ).resolves.toBeUndefined();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(bind).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      "org_public",
      "event_ai_summit",
      3,
    );
    await expect(
      markPublicScheduleInvalidationProcessed(database, v2Message),
    ).resolves.toBe(false);
  });

  it("fails closed without purge support outside local development", async () => {
    const database = { prepare: vi.fn() } as unknown as D1Database;
    const message = {
      event_id: "event_ai_summit",
      kind: "public_schedule.cache.invalidate" as const,
      version: 1 as const,
    };

    await expect(
      processPublicScheduleCacheInvalidation(
        {} as ExecutionContext,
        { APP_ENV: "local", DB: database },
        message,
      ),
    ).resolves.toBeUndefined();
    await expect(
      processPublicScheduleCacheInvalidation(
        {} as ExecutionContext,
        { APP_ENV: "production", DB: database },
        message,
      ),
    ).rejects.toThrow("Worker cache invalidation is unavailable.");
  });

  it("returns a bounded browser policy and edge-only stale revalidation", async () => {
    const response = await publicScheduleResponse(
      new Request(
        "https://opensession.example/api/v1/public/events/ai-engineer-summit/schedule",
      ),
      { eventId: "event_ai_summit", projection },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      PUBLIC_SCHEDULE_BROWSER_CACHE_CONTROL,
    );
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe(
      PUBLIC_SCHEDULE_EDGE_CACHE_CONTROL,
    );
    expect(response.headers.get("cache-tag")).toBe(
      "public-schedule,event-event_ai_summit",
    );
    expect(response.headers.get("etag")).toMatch(/^"[a-f\d]{64}"$/);
    await expect(response.json()).resolves.toEqual(projection);
  });

  it("uses weak If-None-Match comparison for cacheable GET responses", async () => {
    const first = await publicScheduleResponse(
      new Request(
        "https://opensession.example/api/v1/public/events/ai-engineer-summit/schedule",
      ),
      { eventId: "event_ai_summit", projection },
    );
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(ifNoneMatchIncludes(`"other", W/${etag}`, etag ?? "")).toBe(true);

    const conditional = await publicScheduleResponse(
      new Request(
        "https://opensession.example/api/v1/public/events/ai-engineer-summit/schedule",
        { headers: { "If-None-Match": `"other", W/${etag}` } },
      ),
      { eventId: "event_ai_summit", projection },
    );

    expect(conditional.status).toBe(304);
    expect(conditional.headers.get("etag")).toBe(etag);
    expect(await conditional.text()).toBe("");
  });

  it("purges only the event-specific cache tag", async () => {
    const purge = vi.fn(async () => ({ errors: [], success: true }));

    await expect(
      purgePublicScheduleCache({ cache: { purge } }, "event_ai_summit"),
    ).resolves.toBe(true);
    expect(purge).toHaveBeenCalledWith({ tags: ["event-event_ai_summit"] });
    await expect(purgePublicScheduleCache({}, "event_ai_summit")).resolves.toBe(
      false,
    );
    await expect(
      purgePublicScheduleCache(
        {
          cache: {
            purge: vi.fn(async () => ({
              errors: [{ code: 1000, message: "rejected" }],
              success: false,
            })),
          },
        },
        "event_ai_summit",
      ),
    ).rejects.toThrow(
      "Cloudflare rejected public schedule cache invalidation.",
    );
    await expect(
      purgePublicScheduleCache({ cache: { purge } }, "../../other-event"),
    ).rejects.toThrow("Event ID cannot be represented as a safe cache tag.");
  });
});
