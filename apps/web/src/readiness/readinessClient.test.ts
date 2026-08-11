import { describe, expect, it, vi } from "vitest";

import { createReadinessClient } from "./readinessClient";
import type { ReadinessClientError } from "./readinessClient";

const query = {
  due: "all",
  page: 1,
  page_size: 25,
  portal: "all",
  q: "Mina",
  readiness: "overdue",
  task: "all",
  track: "all",
} as const;

describe("readiness client", () => {
  it("sends same-origin credentials and rejects malformed success bodies", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ event: { id: "evt" } }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    );

    await expect(
      createReadinessClient(fetcher).read("event/unsafe", query),
    ).rejects.toMatchObject({
      status: 502,
    } satisfies Partial<ReadinessClientError>);
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/api/events/event%2Funsafe/readiness?"),
      expect.objectContaining({ credentials: "same-origin", method: "GET" }),
    );
    expect(fetcher.mock.calls[0]?.[0]).toContain("readiness=overdue");
    expect(fetcher.mock.calls[0]?.[0]).toContain("q=Mina");
  });

  it("maps authorization failures without trusting an error body", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("not json", { status: 403 }));

    await expect(
      createReadinessClient(fetcher).read("summit", query),
    ).rejects.toMatchObject({
      message: "Organizer access is required to view readiness.",
      status: 403,
    } satisfies Partial<ReadinessClientError>);
  });
});
