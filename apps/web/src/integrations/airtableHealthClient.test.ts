import { describe, expect, it, vi } from "vitest";

import { createAirtableHealthPort } from "./airtableHealthClient";

const plan = {
  confirmation: "RECONCILE ORGANIZATION FOR demo-event",
  counts: { create: 1, missing: 0, unchanged: 3, update: 1 },
  plan_id: "a".repeat(64),
  scope: "organization" as const,
  tables: [
    {
      create: 1,
      key: "submissions" as const,
      missing: 0,
      name: "Submissions",
      unchanged: 3,
      update: 1,
    },
  ],
};

describe("Airtable health client", () => {
  it("uses same-origin CSRF and a stable apply key", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          generated_at: "2026-08-11T20:00:00.000Z",
          mode: "dry_run",
          plan,
        }),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            code: "temporarily_unavailable",
            detail: "Try again.",
            request_id: "request-one",
            status: 503,
            title: "Unavailable",
            type: "https://opensession.invalid/problems/temporarily_unavailable",
          },
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          audit_id: "aud_1234567890abcdef",
          completed_at: "2026-08-11T20:01:00.000Z",
          mode: "apply",
          result: { deleted: 0, projected: 5, table_count: 1 },
        }),
      );
    const port = createAirtableHealthPort("demo-event", fetcher, () => "csrf");
    expect(await port.dryRun()).toEqual(plan);
    await expect(port.apply(plan, plan.confirmation)).rejects.toMatchObject({
      code: "temporarily_unavailable",
      requestId: "request-one",
    });
    await expect(port.apply(plan, plan.confirmation)).resolves.toMatchObject({
      mode: "apply",
    });
    const firstApply = fetcher.mock.calls[1]?.[1] as RequestInit;
    const retryApply = fetcher.mock.calls[2]?.[1] as RequestInit;
    expect(firstApply.credentials).toBe("same-origin");
    expect(firstApply.headers).toMatchObject({ "X-CSRF-Token": "csrf" });
    expect(
      (firstApply.headers as Record<string, string>)["Idempotency-Key"],
    ).toBe((retryApply.headers as Record<string, string>)["Idempotency-Key"]);
  });

  it("rejects unredacted or malformed health responses", async () => {
    const port = createAirtableHealthPort(
      "demo-event",
      vi.fn().mockResolvedValue(
        Response.json({
          base_id: "appSecretFullIdentifier",
          records: [{ fields: { Email: "private@example.com" } }],
        }),
      ),
      () => "csrf",
    );
    await expect(port.health()).rejects.toMatchObject({
      code: "invalid_airtable_response",
    });
  });
});
