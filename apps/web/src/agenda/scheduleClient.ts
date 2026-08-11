import {
  scheduleCommandResponseSchema,
  scheduleCommandSchema,
  scheduleEntityTag,
  scheduleSnapshotSchema,
  type ScheduleCommand,
  type ScheduleCommandError,
  type ScheduleCommandPort,
} from "@sessionbox-killer/contracts";

import { readCsrfToken } from "../auth/authClient";

type Fetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface StandardErrorBody {
  error?: {
    code?: unknown;
    message?: unknown;
  };
  request_id?: unknown;
}

function standardError(body: unknown) {
  if (!body || typeof body !== "object") return null;
  const candidate = body as StandardErrorBody;
  if (
    !candidate.error ||
    typeof candidate.error.code !== "string" ||
    typeof candidate.error.message !== "string"
  ) {
    return null;
  }
  return {
    code: candidate.error.code,
    message: candidate.error.message,
    requestId:
      typeof candidate.request_id === "string"
        ? candidate.request_id
        : undefined,
  };
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export class ScheduleApiError extends Error {
  readonly code: string;
  readonly domainError: ScheduleCommandError | undefined;
  readonly requestId: string | undefined;
  readonly status: number;

  constructor(options: {
    code: string;
    domainError?: ScheduleCommandError | undefined;
    message: string;
    requestId?: string | undefined;
    status: number;
  }) {
    super(options.message);
    this.name = "ScheduleApiError";
    this.code = options.code;
    this.domainError = options.domainError;
    this.requestId = options.requestId;
    this.status = options.status;
  }
}

function responseError(response: Response, body: unknown): ScheduleApiError {
  const parsed = standardError(body);
  return new ScheduleApiError({
    code: parsed?.code ?? "invalid_schedule_response",
    message:
      parsed?.message ??
      "The schedule service returned an invalid response. Please try again.",
    requestId: parsed?.requestId,
    status: response.status,
  });
}

function scheduleUrl(eventId: string) {
  return `/api/events/${encodeURIComponent(eventId)}/schedule`;
}

export function createScheduleCommandPort(
  fetcher: Fetch = window.fetch.bind(window),
  csrfReader: () => string | null = () => readCsrfToken(document.cookie),
): ScheduleCommandPort {
  function getCsrfToken(): string {
    const token = csrfReader();
    if (token) return token;
    throw new ScheduleApiError({
      code: "missing_csrf",
      message: "Refresh the page before changing the schedule.",
      status: 0,
    });
  }

  async function send(command: ScheduleCommand, retryCsrf: boolean) {
    const token = getCsrfToken();
    const response = await fetcher(`${scheduleUrl(command.eventId)}/commands`, {
      body: JSON.stringify(command),
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "If-Match": scheduleEntityTag(command.expectedVersion),
        "X-CSRF-Token": token,
      },
      method: "POST",
    });
    const body = await json(response);
    const parsed = scheduleCommandResponseSchema.safeParse(body);

    if (parsed.success) {
      if (parsed.data.ok) return parsed.data.result;
      throw new ScheduleApiError({
        code: parsed.data.error.code,
        domainError: parsed.data.error,
        message: parsed.data.error.message,
        status: response.status,
      });
    }

    const error = responseError(response, body);
    if (!retryCsrf && error.code === "invalid_csrf") {
      return send(command, true);
    }
    throw error;
  }

  return {
    async execute(input) {
      const command = scheduleCommandSchema.parse(input);
      return send(command, false);
    },

    async read(eventId) {
      const response = await fetcher(scheduleUrl(eventId), {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      const body = await json(response);
      if (!response.ok) throw responseError(response, body);
      const parsed = scheduleSnapshotSchema.safeParse(body);
      if (!parsed.success) throw responseError(response, body);
      const entityTag = response.headers.get("ETag");
      if (
        entityTag !== null &&
        entityTag !== scheduleEntityTag(parsed.data.event.version)
      ) {
        throw responseError(response, body);
      }
      return parsed.data;
    },
  };
}
