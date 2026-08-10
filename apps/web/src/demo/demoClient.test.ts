import { afterEach, describe, expect, it, vi } from "vitest";

import { DemoResetApiError, resetDemoEvent } from "./demoClient";

const receipt = {
  audit_event_id: "audit_demo_reset",
  digest: "a".repeat(64),
  operation_count: 134,
  outcome: "applied" as const,
  reset_run_id: "demo_reset_request",
  snapshot_id: `snapshot_${"b".repeat(24)}`,
};

describe("demo reset client", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends the exact CSRF, confirmation, and idempotency contract", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ receipt }));

    await expect(
      resetDemoEvent("ai-engineer-summit", "RESET AI ENGINEER SUMMIT 2026", {
        cookie: "__Host-opensession-csrf=csrf-demo-token",
        fetcher,
        idempotencyKey: "demo_reset_request",
      }),
    ).resolves.toEqual({ receipt });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/events/ai-engineer-summit/demo/reset",
      expect.objectContaining({
        body: JSON.stringify({
          confirmation: "RESET AI ENGINEER SUMMIT 2026",
        }),
        credentials: "same-origin",
        headers: expect.objectContaining({
          "Idempotency-Key": "demo_reset_request",
          "X-CSRF-Token": "csrf-demo-token",
        }),
        method: "POST",
      }),
    );
  });

  it("fails locally without a CSRF cookie", async () => {
    const fetcher = vi.fn<typeof fetch>();

    await expect(
      resetDemoEvent("ai-engineer-summit", "RESET AI ENGINEER SUMMIT 2026", {
        cookie: "",
        fetcher,
        idempotencyKey: "demo_reset_request",
      }),
    ).rejects.toMatchObject({ code: "missing_csrf", status: 0 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves a structured server failure for actionable UI feedback", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          error: {
            code: "not_privileged",
            message: "Demo reset requires an organization owner.",
          },
        },
        { status: 403 },
      ),
    );

    await expect(
      resetDemoEvent("ai-engineer-summit", "RESET AI ENGINEER SUMMIT 2026", {
        cookie: "__Host-opensession-csrf=csrf-demo-token",
        fetcher,
        idempotencyKey: "demo_reset_request",
      }),
    ).rejects.toEqual(
      new DemoResetApiError(
        "not_privileged",
        "Demo reset requires an organization owner.",
        403,
      ),
    );
  });
});
