import {
  apiErrorResponseSchema,
  speakerProfileCommandResponseSchema,
  speakerProfileResponseSchema,
  type SpeakerProfileCommandResponse,
  type SpeakerProfileResponse,
  type SpeakerProfileSaveCommand,
} from "@sessionbox-killer/contracts";

import { readCsrfToken } from "../auth/authClient";

type Fetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export class SpeakerProfileApiError extends Error {
  readonly actualVersion: number | null;
  readonly code: string;
  readonly expectedVersion: number | null;
  readonly retryable: boolean;
  readonly status: number;

  constructor(
    code: string,
    message: string,
    status: number,
    options: {
      actualVersion?: number | undefined;
      expectedVersion?: number | undefined;
      retryable?: boolean | undefined;
    } = {},
  ) {
    super(message);
    this.name = "SpeakerProfileApiError";
    this.actualVersion = options.actualVersion ?? null;
    this.code = code;
    this.expectedVersion = options.expectedVersion ?? null;
    this.retryable = options.retryable ?? false;
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
  const error = apiErrorResponseSchema.safeParse(body);
  if (!error.success) {
    return new SpeakerProfileApiError(
      "invalid_profile_response",
      "The profile service returned an invalid response. Refresh and try again.",
      response.status,
    );
  }
  return new SpeakerProfileApiError(
    error.data.error.code,
    error.data.error.message,
    response.status,
    {
      ...(error.data.error.actual_version === undefined
        ? {}
        : { actualVersion: error.data.error.actual_version }),
      ...(error.data.error.expected_version === undefined
        ? {}
        : { expectedVersion: error.data.error.expected_version }),
      retryable: error.data.error.retryable,
    },
  );
}

function csrfToken(reader: () => string | null): string {
  const token = reader();
  if (!token) {
    throw new SpeakerProfileApiError(
      "missing_csrf",
      "Refresh the page before saving your profile.",
      0,
    );
  }
  return token;
}

export async function readSpeakerProfile(
  eventSlug: string,
  fetcher: Fetch = window.fetch.bind(window),
): Promise<SpeakerProfileResponse> {
  const response = await fetcher(
    `/api/portal/${encodeURIComponent(eventSlug)}/profile`,
    {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    },
  );
  const body = await json(response);
  if (!response.ok) throw responseError(response, body);
  const profile = speakerProfileResponseSchema.safeParse(body);
  if (!profile.success) throw responseError(response, body);
  return profile.data;
}

export async function saveSpeakerProfile(
  eventSlug: string,
  command: SpeakerProfileSaveCommand,
  fetcher: Fetch = window.fetch.bind(window),
  csrfReader: () => string | null = () => readCsrfToken(document.cookie),
): Promise<SpeakerProfileCommandResponse> {
  return saveSpeakerProfileRequest(
    eventSlug,
    command,
    fetcher,
    csrfReader,
    false,
  );
}

async function saveSpeakerProfileRequest(
  eventSlug: string,
  command: SpeakerProfileSaveCommand,
  fetcher: Fetch,
  csrfReader: () => string | null,
  retryCsrf: boolean,
): Promise<SpeakerProfileCommandResponse> {
  const response = await fetcher(
    `/api/portal/${encodeURIComponent(eventSlug)}/profile/commands`,
    {
      body: JSON.stringify(command),
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken(csrfReader),
      },
      method: "PUT",
    },
  );
  const body = await json(response);
  const result = speakerProfileCommandResponseSchema.safeParse(body);
  if (response.status === 200 && result.success) return result.data;

  const error = responseError(response, body);
  if (!retryCsrf && error.code === "invalid_csrf") {
    return saveSpeakerProfileRequest(
      eventSlug,
      command,
      fetcher,
      csrfReader,
      true,
    );
  }
  throw error;
}
