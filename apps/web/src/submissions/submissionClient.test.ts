import { describe, expect, it, vi } from "vitest";

import {
  createOrganizerSubmissionPort,
  OrganizerSubmissionApiError,
} from "./submissionClient";

const projection = {
  asOf: "2026-08-10T19:00:00.000Z",
  pendingRepairs: 0,
  reasons: [],
  state: "current",
} as const;

const row = {
  id: "submission_alpha",
  lastActivityAt: "2026-08-10T19:00:00.000Z",
  reference: "AI-1042",
  reviews: { aggregateScore: 4.5, assigned: 2, submitted: 1 },
  routing: { reviewerGroupId: "group_systems", routeKey: "reliability" },
  status: "in_review",
  submitter: {
    company: "Northstar Labs",
    displayName: "Mina Okafor",
    email: "mina@example.com",
    id: "contact_mina",
    title: "Principal Engineer",
  },
  title: "Durable agent systems",
  track: { id: "track_reliability", name: "Reliability" },
  version: 2,
} as const;

describe("organizer submission client", () => {
  it("validates list responses and sends canonical query keys", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        eventId: "evt_alpha",
        items: [row],
        nextCursor: null,
        projection,
      }),
    );
    const port = createOrganizerSubmissionPort(fetcher);

    await expect(
      port.list("ai-engineer-summit", {
        cursor: "cursor_next",
        pageSize: 25,
        search: "durable agents",
        status: "in_review",
        track: "track_reliability",
      }),
    ).resolves.toMatchObject({ items: [{ id: "submission_alpha" }] });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/events/ai-engineer-summit/submissions?q=durable+agents&status=in_review&track=track_reliability&cursor=cursor_next&page_size=25",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("fails closed on invalid list payloads", async () => {
    const port = createOrganizerSubmissionPort(
      vi.fn(async () => Response.json({ items: [{ id: "provider_record" }] })),
    );

    await expect(
      port.list("evt_alpha", { pageSize: 50 }),
    ).rejects.toMatchObject({
      code: "invalid_submission_response",
    });
  });

  it("executes commands with CSRF and retries a rotated token once", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: "invalid_csrf",
              message: "Refresh the request token.",
            },
            request_id: "request_first",
          },
          { status: 403 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          result: {
            appliedAt: "2026-08-10T19:01:00.000Z",
            commandId: "command_review",
            note: null,
            outcome: "applied",
            projection: "durable",
            status: "in_review",
            submissionId: "submission_alpha",
            version: 3,
          },
        }),
      );
    const csrfReader = vi
      .fn<() => string | null>()
      .mockReturnValueOnce("old-token")
      .mockReturnValueOnce("new-token");
    const port = createOrganizerSubmissionPort(fetcher, csrfReader);

    await expect(
      port.execute("evt_alpha", {
        commandId: "command_review",
        expectedVersion: 2,
        reason: "Eligibility review is complete.",
        submissionId: "submission_alpha",
        type: "start_review",
      }),
    ).resolves.toMatchObject({ status: "in_review", version: 3 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ "X-CSRF-Token": "new-token" }),
      }),
    );
  });

  it("exposes typed command conflicts and missing CSRF", async () => {
    const conflictPort = createOrganizerSubmissionPort(
      vi.fn(async () =>
        Response.json(
          {
            error: {
              actualVersion: 4,
              code: "submission_version_conflict",
              expectedVersion: 2,
              message: "The submission changed.",
            },
            ok: false,
          },
          { status: 409 },
        ),
      ),
      () => "csrf",
    );
    const command = {
      commandId: "command_review",
      expectedVersion: 2,
      reason: "Eligibility review is complete.",
      submissionId: "submission_alpha",
      type: "start_review",
    } as const;

    const conflict = await conflictPort
      .execute("evt_alpha", command)
      .catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(OrganizerSubmissionApiError);
    expect(conflict).toMatchObject({
      code: "submission_version_conflict",
      domainError: { actualVersion: 4 },
      status: 409,
    });

    const missingPort = createOrganizerSubmissionPort(vi.fn(), () => null);
    await expect(
      missingPort.execute("evt_alpha", command),
    ).rejects.toMatchObject({ code: "missing_csrf", status: 0 });
  });
});
