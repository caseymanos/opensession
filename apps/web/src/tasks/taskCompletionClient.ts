import {
  taskAssignmentDetailSchema,
  taskAssignmentMutationResponseSchema,
  taskAssignmentReviewCommandSchema,
  taskAssignmentSubmissionCommandSchema,
  type TaskAssignmentDetail,
  type TaskAssignmentMutationReceipt,
  type TaskAssignmentReviewCommand,
  type TaskAssignmentSubmissionCommand,
} from "@sessionbox-killer/contracts/tasks";

import { readCsrfToken } from "../auth/authClient";

type Fetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export class TaskCompletionApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "TaskCompletionApiError";
    this.code = code;
    this.status = status;
  }
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function responseError(response: Response, body: unknown) {
  const candidate =
    body && typeof body === "object" && "error" in body
      ? (body.error as Record<string, unknown> | null)
      : null;
  return new TaskCompletionApiError(
    typeof candidate?.code === "string"
      ? candidate.code
      : "invalid_task_response",
    typeof candidate?.message === "string"
      ? candidate.message
      : "The task service returned an invalid response.",
    response.status,
  );
}

function csrfToken(reader: () => string | null): string {
  const token = reader();
  if (!token) {
    throw new TaskCompletionApiError(
      "missing_csrf",
      "Refresh the page before changing this task.",
      0,
    );
  }
  return token;
}

function assignmentUrl(eventKey: string, assignmentId: string): string {
  return `/api/events/${encodeURIComponent(eventKey)}/task-assignments/${encodeURIComponent(assignmentId)}`;
}

export interface TaskCompletionPort {
  detail(
    eventKey: string,
    assignmentId: string,
    signal?: AbortSignal,
  ): Promise<TaskAssignmentDetail>;
  review(
    eventKey: string,
    assignmentId: string,
    command: TaskAssignmentReviewCommand,
  ): Promise<TaskCompletionMutation>;
  submit(
    eventKey: string,
    assignmentId: string,
    command: TaskAssignmentSubmissionCommand,
  ): Promise<TaskCompletionMutation>;
}

export interface TaskCompletionMutation {
  readonly receipt: TaskAssignmentMutationReceipt;
  readonly repairPending: boolean;
  readonly replayed: boolean;
}

export function createTaskCompletionPort(
  fetcher: Fetch = window.fetch.bind(window),
  csrfReader: () => string | null = () => readCsrfToken(document.cookie),
): TaskCompletionPort {
  async function mutate(
    eventKey: string,
    assignmentId: string,
    path: "reviews" | "submissions",
    command: TaskAssignmentReviewCommand | TaskAssignmentSubmissionCommand,
  ) {
    const response = await fetcher(
      `${assignmentUrl(eventKey, assignmentId)}/${path}`,
      {
        body: JSON.stringify(command),
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken(csrfReader),
        },
        method: "POST",
      },
    );
    const body = await json(response);
    const parsed = taskAssignmentMutationResponseSchema.safeParse(body);
    if (parsed.success && parsed.data.ok && response.ok) {
      return {
        receipt: parsed.data.result,
        repairPending: parsed.data.repair_pending,
        replayed: parsed.data.replayed,
      };
    }
    if (parsed.success && !parsed.data.ok) {
      throw new TaskCompletionApiError(
        parsed.data.error.code,
        parsed.data.error.message,
        response.status,
      );
    }
    throw responseError(response, body);
  }

  return {
    async detail(eventKey, assignmentId, signal) {
      const response = await fetcher(assignmentUrl(eventKey, assignmentId), {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        ...(signal ? { signal } : {}),
      });
      const body = await json(response);
      if (!response.ok) throw responseError(response, body);
      const parsed = taskAssignmentDetailSchema.safeParse(body);
      if (!parsed.success) throw responseError(response, body);
      return parsed.data;
    },
    review(eventKey, assignmentId, command) {
      return mutate(
        eventKey,
        assignmentId,
        "reviews",
        taskAssignmentReviewCommandSchema.parse(command),
      );
    },
    submit(eventKey, assignmentId, command) {
      return mutate(
        eventKey,
        assignmentId,
        "submissions",
        taskAssignmentSubmissionCommandSchema.parse(command),
      );
    },
  };
}
