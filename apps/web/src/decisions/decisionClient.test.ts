import { describe, expect, it, vi } from "vitest";

import { createDecisionPort } from "./decisionClient";

describe("decision client", () => {
  it("retries a CSRF refresh with the exact frozen decision body", async () => {
    const bodies: string[] = [];
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(String(init?.body));
        if (bodies.length === 1) {
          return new Response(
            JSON.stringify({
              error: { code: "invalid_csrf", message: "Refresh CSRF." },
              request_id: "request_decision_csrf",
            }),
            { status: 403 },
          );
        }
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              appliedAt: "2026-08-11T12:00:00.000Z",
              commandId: "decision_command_alpha",
              entityId: "submission_alpha",
              entityType: "submission",
              outcome: "applied",
              projection: "durable",
              version: 2,
            },
          }),
          { status: 200 },
        );
      },
    );
    let token = 0;
    const port = createDecisionPort(fetcher, () => `csrf-${++token}`);
    await expect(
      port.execute("event_alpha", {
        audience: "Primary speaker",
        commandId: "decision_command_alpha",
        decision: "accepted",
        expectedVersion: 1,
        messageMode: "recorded_only",
        privateNote: "",
        reason: "Strong program fit",
        submissionId: "submission_alpha",
        template: null,
        type: "record_decision",
      }),
    ).resolves.toMatchObject({ entityType: "submission", version: 2 });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
  });
});
