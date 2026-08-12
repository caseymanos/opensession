import { describe, expect, it, vi } from "vitest";

import type {
  ReviewOperationsCommand,
  ReviewScoringCommand,
} from "@sessionbox-killer/contracts";

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
  it("loads the authenticated review workspace without touching either data surface", async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ surface: "reviewer" }));
    const port = createReviewOperationsPort(fetcher);

    await expect(port.workspaceAccess("event one")).resolves.toEqual({
      surface: "reviewer",
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      "/api/events/event%20one/review-workspace",
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      }),
    );
  });

  it("rejects a malformed review workspace decision", async () => {
    const port = createReviewOperationsPort(
      vi.fn().mockResolvedValue(json({ surface: "viewer" })),
    );

    await expect(port.workspaceAccess("event_one")).rejects.toMatchObject({
      code: "invalid_review_operations_response",
    });
  });

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

  it("retries reviewer scoring with the exact frozen command", async () => {
    const scoring = {
      assignmentId: "assignment_one",
      commandId: "command_review_one",
      draft: {
        note: "Useful evidence.",
        scores: [{ criterionId: "criterion_one", score: 4 }],
      },
      expectedVersion: 3,
      type: "save_review_draft",
    } satisfies ReviewScoringCommand;
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
            commandId: scoring.commandId,
            entityId: scoring.assignmentId,
            entityType: "assignment",
            outcome: "applied",
            projection: "durable",
            version: 4,
          },
        }),
      );
    const port = createReviewOperationsPort(
      fetcher,
      vi.fn().mockReturnValueOnce("old").mockReturnValueOnce("new"),
    );

    await expect(
      port.executeReview("event_one", scoring),
    ).resolves.toMatchObject({ version: 4 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(
      fetcher.mock.calls[1]?.[1]?.body,
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual(
      scoring,
    );
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "/api/events/event_one/reviewer-assignments/assignment_one/commands",
    );
  });
});
