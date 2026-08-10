import {
  demoResetResponseSchema,
  type DemoResetResponse,
} from "@sessionbox-killer/contracts";

import { readCsrfToken } from "../auth/authClient";

type Fetch = typeof fetch;

export class DemoResetApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "DemoResetApiError";
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

function apiError(response: Response, body: unknown): DemoResetApiError {
  const candidate = body as {
    error?: { code?: unknown; message?: unknown };
  } | null;
  return new DemoResetApiError(
    typeof candidate?.error?.code === "string"
      ? candidate.error.code
      : "reset_failed",
    typeof candidate?.error?.message === "string"
      ? candidate.error.message
      : "The demo could not be reset. Try again.",
    response.status,
  );
}

export async function resetDemoEvent(
  eventKey: string,
  confirmation: string,
  options: {
    cookie?: string;
    fetcher?: Fetch;
    idempotencyKey: string;
  },
): Promise<DemoResetResponse> {
  const csrf = readCsrfToken(options.cookie ?? document.cookie);
  if (!csrf) {
    throw new DemoResetApiError(
      "missing_csrf",
      "Refresh the page and sign in again before resetting the demo.",
      0,
    );
  }
  const response = await (options.fetcher ?? window.fetch.bind(window))(
    `/api/events/${encodeURIComponent(eventKey)}/demo/reset`,
    {
      body: JSON.stringify({ confirmation }),
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": options.idempotencyKey,
        "X-CSRF-Token": csrf,
      },
      method: "POST",
    },
  );
  const body = await json(response);
  if (!response.ok) throw apiError(response, body);
  const parsed = demoResetResponseSchema.safeParse(body);
  if (!parsed.success) throw apiError(response, body);
  return parsed.data;
}

const operationStoragePrefix = "opensession:demo-reset:";

export async function resetDemoEventFromBrowser(
  eventKey: string,
  confirmation: string,
): Promise<DemoResetResponse> {
  const storageKey = `${operationStoragePrefix}${eventKey}`;
  let idempotencyKey = sessionStorage.getItem(storageKey);
  if (!idempotencyKey) {
    idempotencyKey = `demo_reset_${crypto.randomUUID().replaceAll("-", "")}`;
    sessionStorage.setItem(storageKey, idempotencyKey);
  }
  const response = await resetDemoEvent(eventKey, confirmation, {
    idempotencyKey,
  });
  sessionStorage.removeItem(storageKey);
  return response;
}
