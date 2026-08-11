import {
  readinessDashboardResponseSchema,
  type ReadinessDashboardQuery,
  type ReadinessDashboardResponse,
} from "@sessionbox-killer/contracts/readiness";

export class ReadinessClientError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ReadinessClientError";
    this.status = status;
  }
}

export interface ReadinessClient {
  read(
    eventKey: string,
    query: ReadinessDashboardQuery,
    signal?: AbortSignal,
  ): Promise<ReadinessDashboardResponse>;
}

export function createReadinessClient(
  fetcher: typeof fetch = window.fetch.bind(window),
): ReadinessClient {
  return {
    async read(eventKey, query, signal) {
      const search = new URLSearchParams({
        due: query.due,
        page: String(query.page),
        page_size: String(query.page_size),
        portal: query.portal,
        q: query.q,
        readiness: query.readiness,
        task: query.task,
        track: query.track,
      });
      const response = await fetcher(
        `/api/events/${encodeURIComponent(eventKey)}/readiness?${search}`,
        {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          method: "GET",
          ...(signal ? { signal } : {}),
        },
      );
      if (!response.ok) {
        throw new ReadinessClientError(
          response.status,
          response.status === 403
            ? "Organizer access is required to view readiness."
            : "Readiness data is temporarily unavailable.",
        );
      }
      const parsed = readinessDashboardResponseSchema.safeParse(
        await response.json(),
      );
      if (!parsed.success) {
        throw new ReadinessClientError(
          502,
          "The readiness response did not match the expected contract.",
        );
      }
      return parsed.data;
    },
  };
}
