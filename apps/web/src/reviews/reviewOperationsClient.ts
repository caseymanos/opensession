import {
  reviewOperationsCommandResponseSchema,
  reviewOperationsCommandSchema,
  reviewOperationsResponseSchema,
  reviewWorkspaceAccessResponseSchema,
  reviewerAssignmentListResponseSchema,
  reviewScoringCommandSchema,
  type ReviewOperationsCommand,
  type ReviewOperationsCommandResult,
  type ReviewOperationsResponse,
  type ReviewerAssignmentListResponse,
  type ReviewScoringCommand,
  type ReviewWorkspaceAccessResponse,
} from "@sessionbox-killer/contracts";

import { readCsrfToken } from "../auth/authClient";

type Fetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface ReviewOperationsPort {
  execute(
    eventKey: string,
    command: ReviewOperationsCommand,
  ): Promise<ReviewOperationsCommandResult>;
  load(
    eventKey: string,
    signal?: AbortSignal,
  ): Promise<ReviewOperationsResponse>;
  reviewerAssignments(
    eventKey: string,
    signal?: AbortSignal,
  ): Promise<ReviewerAssignmentListResponse>;
  workspaceAccess(
    eventKey: string,
    signal?: AbortSignal,
  ): Promise<ReviewWorkspaceAccessResponse>;
  executeReview(
    eventKey: string,
    command: ReviewScoringCommand,
  ): Promise<ReviewOperationsCommandResult>;
}

export class ReviewOperationsApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ReviewOperationsApiError";
    this.code = code;
    this.status = status;
  }
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function genericError(
  response: Response,
  value: unknown,
): ReviewOperationsApiError {
  if (value && typeof value === "object" && "error" in value) {
    const error = value.error;
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string" &&
      "message" in error &&
      typeof error.message === "string"
    ) {
      return new ReviewOperationsApiError(
        error.code,
        error.message,
        response.status,
      );
    }
  }
  return new ReviewOperationsApiError(
    "invalid_review_operations_response",
    "The review operations service returned an invalid response.",
    response.status,
  );
}

function baseUrl(eventKey: string): string {
  return `/api/events/${encodeURIComponent(eventKey)}/review-operations`;
}

export function createReviewOperationsPort(
  fetcher: Fetch = window.fetch.bind(window),
  csrfReader: () => string | null = () => readCsrfToken(document.cookie),
): ReviewOperationsPort {
  async function execute(
    eventKey: string,
    command: ReviewOperationsCommand,
    csrfRetried: boolean,
  ): Promise<ReviewOperationsCommandResult> {
    const csrf = csrfReader();
    if (!csrf) {
      throw new ReviewOperationsApiError(
        "missing_csrf",
        "Refresh the page before changing review operations.",
        0,
      );
    }
    const response = await fetcher(`${baseUrl(eventKey)}/commands`, {
      body: JSON.stringify(command),
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
      },
      method: "POST",
    });
    const value = await responseJson(response);
    const parsed = reviewOperationsCommandResponseSchema.safeParse(value);
    if (parsed.success) {
      if (parsed.data.ok && response.ok) return parsed.data.result;
      if (!parsed.data.ok) {
        if (!csrfRetried && parsed.data.error.code === "invalid_csrf") {
          return execute(eventKey, command, true);
        }
        throw new ReviewOperationsApiError(
          parsed.data.error.code,
          parsed.data.error.message,
          response.status,
        );
      }
    }
    const error = genericError(response, value);
    if (!csrfRetried && error.code === "invalid_csrf") {
      return execute(eventKey, command, true);
    }
    throw error;
  }

  async function executeReview(
    eventKey: string,
    command: ReviewScoringCommand,
    csrfRetried: boolean,
  ): Promise<ReviewOperationsCommandResult> {
    const csrf = csrfReader();
    if (!csrf) {
      throw new ReviewOperationsApiError(
        "missing_csrf",
        "Refresh the page before saving this review.",
        0,
      );
    }
    const reviewerPath = `/api/events/${encodeURIComponent(eventKey)}/reviewer-assignments/${encodeURIComponent(command.assignmentId)}/commands`;
    const organizerPath = `/api/events/${encodeURIComponent(eventKey)}/review-operations/reviews/${encodeURIComponent(command.assignmentId)}/commands`;
    const response = await fetcher(
      command.type === "reopen_review" ? organizerPath : reviewerPath,
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
    const value = await responseJson(response);
    const parsed = reviewOperationsCommandResponseSchema.safeParse(value);
    if (parsed.success) {
      if (parsed.data.ok && response.ok) return parsed.data.result;
      if (!parsed.data.ok) {
        if (!csrfRetried && parsed.data.error.code === "invalid_csrf") {
          return executeReview(eventKey, command, true);
        }
        throw new ReviewOperationsApiError(
          parsed.data.error.code,
          parsed.data.error.message,
          response.status,
        );
      }
    }
    const error = genericError(response, value);
    if (!csrfRetried && error.code === "invalid_csrf") {
      return executeReview(eventKey, command, true);
    }
    throw error;
  }

  return {
    async executeReview(eventKey, input) {
      const command = reviewScoringCommandSchema.parse(input);
      return executeReview(eventKey, command, false);
    },
    async execute(eventKey, input) {
      const command = reviewOperationsCommandSchema.parse(input);
      return execute(eventKey, command, false);
    },
    async load(eventKey, signal) {
      const response = await fetcher(baseUrl(eventKey), {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        ...(signal ? { signal } : {}),
      });
      const value = await responseJson(response);
      if (!response.ok) throw genericError(response, value);
      const parsed = reviewOperationsResponseSchema.safeParse(value);
      if (!parsed.success) throw genericError(response, value);
      return parsed.data;
    },
    async reviewerAssignments(eventKey, signal) {
      const response = await fetcher(
        `/api/events/${encodeURIComponent(eventKey)}/reviewer-assignments`,
        {
          cache: "no-store",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          ...(signal ? { signal } : {}),
        },
      );
      const value = await responseJson(response);
      if (!response.ok) throw genericError(response, value);
      const parsed = reviewerAssignmentListResponseSchema.safeParse(value);
      if (!parsed.success) throw genericError(response, value);
      return parsed.data;
    },
    async workspaceAccess(eventKey, signal) {
      const response = await fetcher(
        `/api/events/${encodeURIComponent(eventKey)}/review-workspace`,
        {
          cache: "no-store",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          ...(signal ? { signal } : {}),
        },
      );
      const value = await responseJson(response);
      if (!response.ok) throw genericError(response, value);
      const parsed = reviewWorkspaceAccessResponseSchema.safeParse(value);
      if (!parsed.success) throw genericError(response, value);
      return parsed.data;
    },
  };
}
