import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", async (importOriginal) => {
  const original = (await importOriginal()) as object;
  return {
    ...original,
    WorkflowEntrypoint: class {
      readonly __workflowEntrypoint = true;
    },
  };
});

import { app } from "../src/index";
import { authoritySchemaVersion } from "../src/authority/base-authority";
import {
  durableOperationalEventStatement,
  elapsedMilliseconds,
  emitOperationalLog,
  pruneExpiredOperationalEvents,
  requestOutcome,
  roundedDuration,
} from "../src/observability";

afterEach(() => {
  vi.restoreAllMocks();
});

function createEnvironment(appEnvironment: Env["APP_ENV"] | "invalid") {
  const writeDataPoint = vi.fn<AnalyticsEngineDataset["writeDataPoint"]>();

  return {
    environment: {
      APP_ENV: appEnvironment,
      OBSERVABILITY: { writeDataPoint },
    } as unknown as Env,
    writeDataPoint,
  };
}

function createReadinessEnvironment(schemaVersion: number) {
  const ready = vi.fn().mockResolvedValue({ schemaVersion });
  const writeDataPoint = vi.fn<AnalyticsEngineDataset["writeDataPoint"]>();

  return {
    environment: {
      AGENDA_COORDINATOR: {},
      AIRTABLE_BASE_ID: "app12345678",
      AIRTABLE_PAT: "configured",
      APP_ENV: "local",
      AUTH_HASH_PEPPER: "p".repeat(32),
      BASE_AUTHORITY: {
        getByName: vi.fn(() => ({ ready })),
      },
      DB: {
        prepare: vi.fn(() => ({
          first: vi.fn().mockResolvedValue({ count: 0 }),
        })),
      },
      EMAIL_DELIVERY_CONFIG: {
        allowlist: [],
        authFrom: "OpenSession <auth@local.opensession.test>",
        authReplyTo: "hello@local.opensession.test",
        mode: "sink",
      },
      EMAIL_QUEUE: {},
      FEATURE_FLAGS: {
        ai: false,
        embeds: false,
        email: false,
        integrations: false,
        webhooks: false,
        writes: true,
      },
      INTEGRATION_EXPORT_QUEUE: {},
      OBSERVABILITY: { writeDataPoint },
      PROJECTION_REPAIR_QUEUE: {},
      TASK_REMINDER_WORKFLOW: {},
      UPLOADS: {},
      WEBHOOK_DELIVERY_QUEUE: {},
    } as unknown as Env,
    ready,
  };
}

function readEntries(
  writeDataPoint: ReturnType<typeof createEnvironment>["writeDataPoint"],
): Record<string, unknown>[] {
  return writeDataPoint.mock.calls.map(([dataPoint]) =>
    JSON.parse(String(dataPoint?.blobs?.[0])),
  ) as Record<string, unknown>[];
}

describe("Worker observability", () => {
  it("correlates a handled failure without logging its URL", async () => {
    const { environment, writeDataPoint } = createEnvironment("invalid");
    const response = await app.request(
      "https://local.test/health/live?token=must-not-appear",
      undefined,
      environment,
    );
    const requestId = response.headers.get("x-request-id");
    const entries = readEntries(writeDataPoint);

    expect(response.status).toBe(500);
    expect(requestId).toBeTruthy();
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "internal_error",
        message: "The request could not be completed.",
      },
      request_id: requestId,
    });
    expect(entries).toEqual([
      expect.objectContaining({
        event: "request.failed",
        request_id: requestId,
        route: "/health/live",
      }),
      expect.objectContaining({
        event: "request.completed",
        request_id: requestId,
        route: "/health/live",
        status: 500,
      }),
    ]);
    expect(JSON.stringify(entries)).not.toContain("must-not-appear");
  });

  it("uses a fixed route label for unmatched paths", async () => {
    const { environment } = createEnvironment("local");
    const warningLog = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    await app.request(
      "https://local.test/api/v1/private-object-key?email=must-not-appear",
      undefined,
      environment,
    );

    expect(warningLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "request.completed",
        route: "unmatched",
        status: 404,
      }),
    );
    expect(JSON.stringify(warningLog.mock.calls)).not.toContain(
      "private-object-key",
    );
    expect(JSON.stringify(warningLog.mock.calls)).not.toContain(
      "must-not-appear",
    );
  });

  it("returns the documented readiness failure when telemetry is absent", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await app.request(
      "https://local.test/health/ready",
      undefined,
      {
        APP_ENV: "local",
        DB: {},
        EMAIL_QUEUE: {},
        FEATURE_FLAGS: {
          ai: false,
          embeds: false,
          email: false,
          integrations: false,
          webhooks: false,
          writes: true,
        },
        INTEGRATION_EXPORT_QUEUE: {},
        PROJECTION_REPAIR_QUEUE: {},
        UPLOADS: {},
        WEBHOOK_DELIVERY_QUEUE: {},
      } as unknown as Env,
    );
    const requestId = response.headers.get("x-request-id");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "service_unavailable",
        message: "One or more required service dependencies are unavailable.",
      },
      request_id: requestId,
    });
  });

  it("accepts the current authority schema in readiness", async () => {
    const { environment, ready } = createReadinessEnvironment(
      authoritySchemaVersion,
    );
    const response = await app.request(
      "https://local.test/health/ready",
      undefined,
      environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      environment: "local",
      service: "sessionbox-killer",
      status: "ready",
    });
    expect(ready).toHaveBeenCalledOnce();
  });

  it("fails readiness when the auth pepper is below its runtime minimum", async () => {
    const { writeDataPoint } = createEnvironment("local");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await app.request(
      "https://local.test/health/ready",
      undefined,
      {
        AIRTABLE_BASE_ID: "app12345678",
        AIRTABLE_PAT: "configured",
        APP_ENV: "local",
        AUTH_HASH_PEPPER: "too-short",
        BASE_AUTHORITY: {},
        DB: {},
        EMAIL_QUEUE: {},
        FEATURE_FLAGS: {
          ai: false,
          embeds: false,
          email: false,
          integrations: false,
          webhooks: false,
          writes: true,
        },
        INTEGRATION_EXPORT_QUEUE: {},
        OBSERVABILITY: { writeDataPoint },
        PROJECTION_REPAIR_QUEUE: {},
        UPLOADS: {},
        WEBHOOK_DELIVERY_QUEUE: {},
      } as unknown as Env,
    );

    expect(response.status).toBe(503);
  });

  it("does not claim an email was sent when delivery is disabled", async () => {
    const { environment } = createEnvironment("local");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await app.request(
      "https://local.test/api/auth/magic-links",
      {
        body: JSON.stringify({
          email: "judge@example.test",
          purpose: "sign_in",
          redirect_path: "/",
          turnstile_action: "sign_in",
          turnstile_token: "XXXX.DUMMY.TOKEN.XXXX",
        }),
        headers: {
          "Content-Type": "application/json",
          Origin: "https://local.test",
          "Sec-Fetch-Site": "same-origin",
        },
        method: "POST",
      },
      {
        ...environment,
        FEATURE_FLAGS: {
          ai: false,
          embeds: false,
          email: false,
          integrations: false,
          webhooks: false,
          writes: true,
        },
      } as Env,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "email_delivery_unavailable",
        message: "Email sign-in is not available in this environment.",
      },
    });
  });

  it("writes structured allowlisted fields to Analytics Engine", () => {
    const { environment, writeDataPoint } = createEnvironment("preview");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    emitOperationalLog("info", environment, {
      duration_ms: 12.34,
      event: "request.completed",
      method: "GET",
      outcome: "success",
      request_id: "request-id",
      route: "/health/live",
      status: 200,
      version_id: "version-id",
    });

    expect(log).not.toHaveBeenCalled();
    expect(writeDataPoint).toHaveBeenCalledOnce();
    expect(writeDataPoint).toHaveBeenCalledWith({
      blobs: [
        expect.any(String),
        "sessionbox-killer",
        "preview",
        "info",
        "request.completed",
        "success",
        "request-id",
        "/health/live",
        "GET",
        "version-id",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
      ],
      doubles: [200, 12.34, 0, 0, 0],
      indexes: ["request-id"],
    });
    expect(readEntries(writeDataPoint)).toEqual([
      {
        duration_ms: 12.34,
        environment: "preview",
        event: "request.completed",
        level: "info",
        method: "GET",
        outcome: "success",
        request_id: "request-id",
        route: "/health/live",
        service: "sessionbox-killer",
        status: 200,
        timestamp: expect.any(String),
        version_id: "version-id",
      },
    ]);
  });

  it("does not fail the request path when telemetry rejects a write", () => {
    const environment = {
      APP_ENV: "preview",
      OBSERVABILITY: {
        writeDataPoint: () => {
          throw new Error("unavailable");
        },
      },
    } as Pick<Env, "APP_ENV" | "OBSERVABILITY">;

    expect(() =>
      emitOperationalLog("error", environment, {
        event: "request.failed",
        outcome: "failure",
        request_id: "request-id",
      }),
    ).not.toThrow();
  });

  it("rejects uncorrelated or identifying fields before preparing a durable event", () => {
    const database = {} as D1Database;

    expect(() =>
      durableOperationalEventStatement(database, {
        dedupe_key: "request:completed",
        event: "request.completed",
        outcome: "success",
      }),
    ).toThrow("requires a correlation identifier");
    expect(() =>
      durableOperationalEventStatement(database, {
        dedupe_key: "request:unsafe-route",
        event: "request.completed",
        outcome: "success",
        request_id: "request_safe",
        route: "/users/judge@example.test?token=private",
      }),
    ).toThrow("Route template is not safe");
    expect(() =>
      durableOperationalEventStatement(database, {
        dedupe_key: "request:unsafe-error",
        error_type: "Provider failed for judge@example.test",
        event: "request.failed",
        outcome: "failure",
        request_id: "request_safe",
      }),
    ).toThrow("Error code is not safe");
  });

  it("bounds retention cleanup and stops after a partial batch", async () => {
    const run = vi
      .fn<D1PreparedStatement["run"]>()
      .mockResolvedValueOnce({ meta: { changes: 100 } } as D1Result)
      .mockResolvedValueOnce({ meta: { changes: 7 } } as D1Result);
    const bind = vi.fn(() => ({ run }) as unknown as D1PreparedStatement);
    const prepare = vi.fn(() => ({ bind }) as unknown as D1PreparedStatement);

    await expect(
      pruneExpiredOperationalEvents(
        { prepare } as unknown as D1Database,
        new Date("2026-08-09T00:00:00.000Z"),
      ),
    ).resolves.toBe(107);
    expect(run).toHaveBeenCalledTimes(2);
    expect(bind).toHaveBeenCalledWith("2026-08-09T00:00:00.000Z");
  });

  it("classifies HTTP outcomes for metrics and alerts", () => {
    expect(requestOutcome(204)).toBe("success");
    expect(requestOutcome(404)).toBe("client_error");
    expect(requestOutcome(503)).toBe("server_error");
  });

  it("reports bounded millisecond durations", () => {
    expect(roundedDuration(10, 12.345)).toBe(2.35);
    expect(roundedDuration(12, 10)).toBe(0);
  });

  it("reports bounded projection lag from a validated timestamp", () => {
    expect(
      elapsedMilliseconds("2026-08-09T19:00:00.000Z", 1_786_302_003_500),
    ).toBe(3_500);
    expect(
      elapsedMilliseconds("2026-08-09T19:00:04.000Z", 1_786_302_003_500),
    ).toBe(0);
    expect(() => elapsedMilliseconds("not-a-timestamp")).toThrow(
      "Operational timestamp must be valid",
    );
  });
});
