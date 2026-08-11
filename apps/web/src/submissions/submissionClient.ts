import {
  organizerSubmissionCommandResponseSchema,
  organizerSubmissionCommandSchema,
  organizerSubmissionDetailSchema,
  organizerSubmissionErrorResponseSchema,
  organizerSubmissionListQuerySchema,
  organizerSubmissionListResponseSchema,
  type OrganizerSubmissionCommand,
  type OrganizerSubmissionCommandError,
  type OrganizerSubmissionCommandResult,
  type OrganizerSubmissionDetail,
  type OrganizerSubmissionListQuery,
  type OrganizerSubmissionListResponse,
} from "@sessionbox-killer/contracts";

import { readCsrfToken } from "../auth/authClient";

type Fetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface OrganizerSubmissionPort {
  detail(
    eventKey: string,
    submissionId: string,
    signal?: AbortSignal,
  ): Promise<OrganizerSubmissionDetail>;
  execute(
    eventKey: string,
    command: OrganizerSubmissionCommand,
  ): Promise<OrganizerSubmissionCommandResult>;
  list(
    eventKey: string,
    query: OrganizerSubmissionListQuery,
    signal?: AbortSignal,
  ): Promise<OrganizerSubmissionListResponse>;
}

export class OrganizerSubmissionApiError extends Error {
  readonly code: string;
  readonly domainError: OrganizerSubmissionCommandError | undefined;
  readonly requestId: string | undefined;
  readonly status: number;

  constructor(options: {
    code: string;
    domainError?: OrganizerSubmissionCommandError | undefined;
    message: string;
    requestId?: string | undefined;
    status: number;
  }) {
    super(options.message);
    this.name = "OrganizerSubmissionApiError";
    this.code = options.code;
    this.domainError = options.domainError;
    this.requestId = options.requestId;
    this.status = options.status;
  }
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function responseError(
  response: Response,
  body: unknown,
): OrganizerSubmissionApiError {
  const parsed = organizerSubmissionErrorResponseSchema.safeParse(body);
  if (parsed.success) {
    return new OrganizerSubmissionApiError({
      code: parsed.data.error.code,
      message: parsed.data.error.message,
      requestId: parsed.data.request_id,
      status: response.status,
    });
  }
  return new OrganizerSubmissionApiError({
    code: "invalid_submission_response",
    message:
      "The submission service returned an invalid response. Please try again.",
    status: response.status,
  });
}

function eventUrl(eventKey: string): string {
  return `/api/events/${encodeURIComponent(eventKey)}/submissions`;
}

function listUrl(eventKey: string, query: OrganizerSubmissionListQuery) {
  const params = new URLSearchParams();
  if (query.search) params.set("q", query.search);
  if (query.status) params.set("status", query.status);
  if (query.track) params.set("track", query.track);
  if (query.cursor) params.set("cursor", query.cursor);
  params.set("page_size", String(query.pageSize));
  return `${eventUrl(eventKey)}?${params.toString()}`;
}

export function createOrganizerSubmissionPort(
  fetcher: Fetch = window.fetch.bind(window),
  csrfReader: () => string | null = () => readCsrfToken(document.cookie),
): OrganizerSubmissionPort {
  async function execute(
    eventKey: string,
    command: OrganizerSubmissionCommand,
    retryCsrf: boolean,
  ): Promise<OrganizerSubmissionCommandResult> {
    const csrf = csrfReader();
    if (!csrf) {
      throw new OrganizerSubmissionApiError({
        code: "missing_csrf",
        message: "Refresh the page before changing this submission.",
        status: 0,
      });
    }
    const response = await fetcher(`${eventUrl(eventKey)}/commands`, {
      body: JSON.stringify(command),
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
      },
      method: "POST",
    });
    const body = await json(response);
    const parsed = organizerSubmissionCommandResponseSchema.safeParse(body);
    if (parsed.success) {
      if (parsed.data.ok && response.ok) return parsed.data.result;
      if (!parsed.data.ok) {
        throw new OrganizerSubmissionApiError({
          code: parsed.data.error.code,
          domainError: parsed.data.error,
          message: parsed.data.error.message,
          status: response.status,
        });
      }
    }
    const error = responseError(response, body);
    if (!retryCsrf && error.code === "invalid_csrf") {
      return execute(eventKey, command, true);
    }
    throw error;
  }

  return {
    async detail(eventKey, submissionId, signal) {
      const response = await fetcher(
        `${eventUrl(eventKey)}/${encodeURIComponent(submissionId)}`,
        {
          cache: "no-store",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          ...(signal ? { signal } : {}),
        },
      );
      const body = await json(response);
      if (!response.ok) throw responseError(response, body);
      const parsed = organizerSubmissionDetailSchema.safeParse(body);
      if (!parsed.success) throw responseError(response, body);
      return parsed.data;
    },

    async execute(eventKey, input) {
      const command = organizerSubmissionCommandSchema.parse(input);
      return execute(eventKey, command, false);
    },

    async list(eventKey, input, signal) {
      const query = organizerSubmissionListQuerySchema.parse(input);
      const response = await fetcher(listUrl(eventKey, query), {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        ...(signal ? { signal } : {}),
      });
      const body = await json(response);
      if (!response.ok) throw responseError(response, body);
      const parsed = organizerSubmissionListResponseSchema.safeParse(body);
      if (!parsed.success) throw responseError(response, body);
      return parsed.data;
    },
  };
}
