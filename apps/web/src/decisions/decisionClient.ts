import {
  decisionWorkspaceResponseSchema,
  recordDecisionCommandSchema,
  reviewOperationsCommandResponseSchema,
  type DecisionWorkspaceResponse,
  type RecordDecisionCommand,
  type ReviewOperationsCommandResult,
} from "@sessionbox-killer/contracts";

import { readCsrfToken } from "../auth/authClient";

type Fetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export class DecisionApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "DecisionApiError";
    this.code = code;
    this.status = status;
  }
}

export interface DecisionPort {
  execute(
    eventKey: string,
    command: RecordDecisionCommand,
  ): Promise<ReviewOperationsCommandResult>;
  load(
    eventKey: string,
    signal?: AbortSignal,
  ): Promise<DecisionWorkspaceResponse>;
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function error(response: Response, value: unknown): DecisionApiError {
  if (value && typeof value === "object" && "error" in value) {
    const detail = value.error;
    if (
      detail &&
      typeof detail === "object" &&
      "code" in detail &&
      typeof detail.code === "string" &&
      "message" in detail &&
      typeof detail.message === "string"
    ) {
      return new DecisionApiError(detail.code, detail.message, response.status);
    }
  }
  return new DecisionApiError(
    "invalid_decision_response",
    "The decision service returned an invalid response.",
    response.status,
  );
}

export function createDecisionPort(
  fetcher: Fetch = window.fetch.bind(window),
  csrfReader: () => string | null = () => readCsrfToken(document.cookie),
): DecisionPort {
  async function execute(
    eventKey: string,
    command: RecordDecisionCommand,
    csrfRetried: boolean,
  ): Promise<ReviewOperationsCommandResult> {
    const csrf = csrfReader();
    if (!csrf) {
      throw new DecisionApiError(
        "missing_csrf",
        "Refresh the page before recording a decision.",
        0,
      );
    }
    const response = await fetcher(
      `/api/events/${encodeURIComponent(eventKey)}/decisions/${encodeURIComponent(command.submissionId)}/commands`,
      {
        body: JSON.stringify(command),
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf,
        },
        method: "POST",
      },
    );
    const value = await json(response);
    const parsed = reviewOperationsCommandResponseSchema.safeParse(value);
    if (parsed.success) {
      if (parsed.data.ok && response.ok) return parsed.data.result;
      if (!parsed.data.ok) {
        if (!csrfRetried && parsed.data.error.code === "invalid_csrf") {
          return execute(eventKey, command, true);
        }
        throw new DecisionApiError(
          parsed.data.error.code,
          parsed.data.error.message,
          response.status,
        );
      }
    }
    const failure = error(response, value);
    if (!csrfRetried && failure.code === "invalid_csrf") {
      return execute(eventKey, command, true);
    }
    throw failure;
  }

  return {
    async execute(eventKey, input) {
      return execute(eventKey, recordDecisionCommandSchema.parse(input), false);
    },
    async load(eventKey, signal) {
      const response = await fetcher(
        `/api/events/${encodeURIComponent(eventKey)}/decisions`,
        {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          ...(signal ? { signal } : {}),
        },
      );
      const value = await json(response);
      if (!response.ok) throw error(response, value);
      const parsed = decisionWorkspaceResponseSchema.safeParse(value);
      if (!parsed.success) throw error(response, value);
      return parsed.data;
    },
  };
}
