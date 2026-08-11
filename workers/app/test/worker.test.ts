import { publicScheduleProjectionSchema } from "@sessionbox-killer/contracts";
import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const server = createTestHarness({
  workers: [{ configPath: "workers/app/wrangler.jsonc" }],
});

beforeAll(async () => {
  await server.listen();
  await server.getWorker<Env>().applyD1Migrations("DB");
});

afterAll(async () => {
  await server.close();
});

describe("Worker health", () => {
  it("reports a live local service", async () => {
    const response = await server.fetch("/health/live");
    const requestId = response.headers.get("x-request-id");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(requestId).toMatch(/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i);
    await expect(response.json()).resolves.toMatchObject({
      environment: "local",
      service: "sessionbox-killer",
      status: "ok",
    });
  });

  it("reports unavailable until Airtable authority credentials are configured", async () => {
    const response = await server.fetch("/health/ready");
    const requestId = response.headers.get("x-request-id");

    expect(response.status).toBe(503);
    expect(requestId).toBeTruthy();
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "service_unavailable",
        message: "One or more required service dependencies are unavailable.",
      },
      request_id: requestId,
    });
  });

  it("returns a structured not-found response for unknown API routes", async () => {
    const response = await server.fetch("/api/v1/missing");
    const requestId = response.headers.get("x-request-id");

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    expect(requestId).toBeTruthy();
    await expect(response.json()).resolves.toEqual({
      code: "public_api_route_not_found",
      detail: "The requested public API v1 route does not exist.",
      request_id: requestId,
      status: 404,
      title: "Public API route not found",
      type: "https://opensessionboard.com/problems/public_api_route_not_found",
    });
  });
});

async function seedPublicSchedule() {
  const environment = await server.getWorker<Env>().getEnv();
  const projectedAt = "2026-08-09T05:00:00.000Z";
  const sourceHash = "a".repeat(64);

  await environment.DB.batch([
    environment.DB.prepare(
      `INSERT INTO tenant_registry (
         organization_id, base_key, source_record_id, status, created_at, updated_at
       ) VALUES (?, ?, ?, 'active', ?, ?)`,
    ).bind(
      "org_public",
      "local:app_public",
      "rec_tenant_public",
      projectedAt,
      projectedAt,
    ),
    environment.DB.prepare(
      `INSERT INTO p_events (
         id, organization_id, name, slug, timezone, starts_at, ends_at, venue,
         status, brand_json, published_version, is_demo, source_record_id,
         source_version, source_content_hash, projected_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, 4, 1, ?, 4, ?, ?)`,
    ).bind(
      "event_ai_summit",
      "org_public",
      "AI Engineer Summit",
      "ai-engineer-summit",
      "America/Los_Angeles",
      "2026-08-18T16:00:00.000Z",
      "2026-08-20T00:00:00.000Z",
      "Fort Mason Center · San Francisco",
      JSON.stringify({
        publicSummary: "Two focused days for people building AI systems.",
      }),
      "rec_event_public",
      sourceHash,
      projectedAt,
    ),
    environment.DB.prepare(
      `INSERT INTO p_tracks (
         id, organization_id, event_id, name, sort_order, source_record_id,
         source_version, source_content_hash, projected_at
       ) VALUES (?, ?, ?, ?, 1, ?, 1, ?, ?)`,
    ).bind(
      "track_ai",
      "org_public",
      "event_ai_summit",
      "AI Engineering",
      "rec_track_ai",
      sourceHash,
      projectedAt,
    ),
    environment.DB.prepare(
      `INSERT INTO p_formats (
         id, organization_id, event_id, name, default_duration_minutes,
         sort_order, source_record_id, source_version, source_content_hash,
         projected_at
       ) VALUES (?, ?, ?, ?, 30, 1, ?, 1, ?, ?)`,
    ).bind(
      "format_talk",
      "org_public",
      "event_ai_summit",
      "Talk",
      "rec_format_talk",
      sourceHash,
      projectedAt,
    ),
    environment.DB.prepare(
      `INSERT INTO p_rooms (
         id, organization_id, event_id, name, capacity, sort_order,
         source_record_id, source_version, source_content_hash, projected_at
       ) VALUES (?, ?, ?, ?, 500, 1, ?, 1, ?, ?)`,
    ).bind(
      "cowell",
      "org_public",
      "event_ai_summit",
      "Cowell Theater",
      "rec_room_cowell",
      sourceHash,
      projectedAt,
    ),
    environment.DB.prepare(
      `INSERT INTO p_sessions (
         id, organization_id, event_id, friendly_id, title, abstract, status,
         track_id, format_id, duration_minutes, is_public, updated_at,
         source_record_id, source_version, source_content_hash, projected_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'published', ?, ?, 30, 1, ?, ?, 4, ?, ?)`,
    ).bind(
      "session_opening",
      "org_public",
      "event_ai_summit",
      "opening-state-ai-engineering",
      "Opening & State of AI Engineering",
      "A practical opening for the published program.",
      "track_ai",
      "format_talk",
      projectedAt,
      "rec_session_opening",
      sourceHash,
      projectedAt,
    ),
    environment.DB.prepare(
      `INSERT INTO p_sessions (
         id, organization_id, event_id, friendly_id, title, abstract, status,
         track_id, format_id, duration_minutes, is_public, updated_at,
         source_record_id, source_version, source_content_hash, projected_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'published', ?, ?, 30, 1, ?, ?, 3, ?, ?)`,
    ).bind(
      "session_superseded",
      "org_public",
      "event_ai_summit",
      "superseded-session",
      "Superseded session",
      "This placement belongs to an older publication.",
      "track_ai",
      "format_talk",
      projectedAt,
      "rec_session_superseded",
      sourceHash,
      projectedAt,
    ),
    environment.DB.prepare(
      `INSERT INTO p_sessions (
         id, organization_id, event_id, friendly_id, title, abstract, status,
         track_id, format_id, duration_minutes, is_public, updated_at,
         source_record_id, source_version, source_content_hash, projected_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'canceled', ?, ?, 30, 1, ?, ?, 4, ?, ?)`,
    ).bind(
      "session_canceled",
      "org_public",
      "event_ai_summit",
      "canceled-session",
      "Canceled session",
      "This session must not be public.",
      "track_ai",
      "format_talk",
      projectedAt,
      "rec_session_canceled",
      sourceHash,
      projectedAt,
    ),
    environment.DB.prepare(
      `INSERT INTO p_contacts (
         id, organization_id, email_normalized, display_name, title, company,
         source_record_id, source_version, source_content_hash, projected_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).bind(
      "contact_casey",
      "org_public",
      "casey@example.test",
      "Casey Manos",
      "Conference chair",
      "OpenSession",
      "rec_contact_casey",
      sourceHash,
      projectedAt,
    ),
    environment.DB.prepare(
      `INSERT INTO p_session_participants (
         id, organization_id, event_id, session_id, contact_id, role,
         sort_order, confirmed_state, source_record_id, source_version,
         source_content_hash, projected_at
       ) VALUES (?, ?, ?, ?, ?, 'speaker', 1, 'confirmed', ?, 1, ?, ?)`,
    ).bind(
      "participant_casey",
      "org_public",
      "event_ai_summit",
      "session_opening",
      "contact_casey",
      "rec_participant_casey",
      sourceHash,
      projectedAt,
    ),
    environment.DB.prepare(
      `INSERT INTO p_schedule_slots (
         id, organization_id, event_id, session_id, room_id, starts_at,
         ends_at, version, published_version, source_record_id, source_version,
         source_content_hash, projected_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 4, 4, ?, 4, ?, ?)`,
    ).bind(
      "slot_opening",
      "org_public",
      "event_ai_summit",
      "session_opening",
      "cowell",
      "2026-08-18T16:00:00.000Z",
      "2026-08-18T16:30:00.000Z",
      "rec_slot_opening",
      sourceHash,
      projectedAt,
    ),
    environment.DB.prepare(
      `INSERT INTO p_schedule_slots (
         id, organization_id, event_id, session_id, room_id, starts_at,
         ends_at, version, published_version, source_record_id, source_version,
         source_content_hash, projected_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 3, 3, ?, 3, ?, ?)`,
    ).bind(
      "slot_superseded",
      "org_public",
      "event_ai_summit",
      "session_superseded",
      "cowell",
      "2026-08-18T17:00:00.000Z",
      "2026-08-18T17:30:00.000Z",
      "rec_slot_superseded",
      sourceHash,
      projectedAt,
    ),
    environment.DB.prepare(
      `INSERT INTO p_schedule_slots (
         id, organization_id, event_id, session_id, room_id, starts_at,
         ends_at, version, published_version, source_record_id, source_version,
         source_content_hash, projected_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 4, 4, ?, 4, ?, ?)`,
    ).bind(
      "slot_canceled",
      "org_public",
      "event_ai_summit",
      "session_canceled",
      "cowell",
      "2026-08-18T18:00:00.000Z",
      "2026-08-18T18:30:00.000Z",
      "rec_slot_canceled",
      sourceHash,
      projectedAt,
    ),
  ]);
}

describe("Public schedule projection", () => {
  beforeAll(async () => {
    await seedPublicSchedule();
  });

  it("serves only the current D1 publication with conditional caching", async () => {
    const response = await server.fetch(
      "/api/v1/public/events/ai-engineer-summit/schedule",
    );
    const etag = response.headers.get("etag");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=0, must-revalidate",
    );
    expect(etag).toMatch(/^"[a-f\d]{64}"$/);
    const projection = publicScheduleProjectionSchema.parse(
      await response.json(),
    );
    expect(projection).toMatchObject({
      event: {
        name: "AI Engineer Summit",
        slug: "ai-engineer-summit",
      },
      sessions: [
        {
          day: "2026-08-18",
          id: "opening-state-ai-engineering",
          publicationStatus: "published",
          publicationVersion: 4,
          speakers: [{ name: "Casey Manos" }],
        },
      ],
      version: 4,
    });
    expect(projection.sessions.map((session) => session.id)).toEqual([
      "opening-state-ai-engineering",
    ]);

    const conditional = await server.fetch(
      "/api/v1/public/events/ai-engineer-summit/schedule",
      { headers: { "If-None-Match": etag ?? "" } },
    );
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get("etag")).toBe(etag);
  });

  it("does not expose unknown or unpublished event slugs", async () => {
    const response = await server.fetch(
      "/api/v1/public/events/not-published/schedule",
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps the warm local projection below the runaway guard", async () => {
    const localRunawayGuardMs = 1_000;
    const latencies: number[] = [];
    for (let request = 0; request < 30; request += 1) {
      const startedAt = performance.now();
      const response = await server.fetch(
        "/api/v1/public/events/ai-engineer-summit/schedule",
      );
      await response.arrayBuffer();
      expect(response.status).toBe(200);
      latencies.push(performance.now() - startedAt);
    }
    latencies.sort((left, right) => left - right);
    const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1];
    expect(p95).toBeDefined();
    expect(p95).toBeLessThan(localRunawayGuardMs);
    console.info(
      JSON.stringify({
        artifact: "ral-69-public-api-warm-local",
        budgetMilliseconds: localRunawayGuardMs,
        environment: "workerd-local",
        p95Milliseconds: Math.round((p95 ?? 0) * 100) / 100,
        requests: latencies.length,
        seed: "public-schedule-v1",
      }),
    );
  });
});
