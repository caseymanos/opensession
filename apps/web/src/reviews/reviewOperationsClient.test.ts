import { describe, expect, it, vi } from "vitest";

import type { ReviewOperationsCommand } from "@sessionbox-killer/contracts";

import { createReviewOperationsPort } from "./reviewOperationsClient";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

const command = {
  assignmentId: "assignment_one",
  commandId: "command_assignment_one",
  expectedVersion: 1,
  type: "remove_assignment",
} satisfies ReviewOperationsCommand;

describe("review operations client", () => {
  it("retries a rotated CSRF token once with the exact command body", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json(
          {
            error: { code: "invalid_csrf", message: "Refresh CSRF." },
            request_id: "request_one",
          },
          403,
        ),
      )
      .mockResolvedValueOnce(
        json({
          ok: true,
          result: {
            appliedAt: "2026-08-11T12:00:00.000Z",
            commandId: command.commandId,
            entityId: command.assignmentId,
            entityType: "assignment",
            outcome: "applied",
            projection: "durable",
            version: 2,
          },
        }),
      );
    const csrf = vi.fn().mockReturnValueOnce("old").mockReturnValueOnce("new");
    const port = createReviewOperationsPort(fetcher, csrf);

    await expect(port.execute("event_one", command)).resolves.toMatchObject({
      outcome: "applied",
      version: 2,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(
      fetcher.mock.calls[1]?.[1]?.body,
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual(
      command,
    );
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      "X-CSRF-Token": "old",
    });
    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({
      "X-CSRF-Token": "new",
    });
  });

  it("rejects provider details and malformed success payloads", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      json({
        ok: true,
        providerRecordId: "rec_private",
        result: { commandId: command.commandId },
      }),
    );
    const port = createReviewOperationsPort(fetcher, () => "csrf");
    await expect(port.execute("event_one", command)).rejects.toMatchObject({
      code: "invalid_review_operations_response",
    });
  });
});
