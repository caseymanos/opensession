import {
  speakerPortalBootstrapResponseSchema,
  speakerPortalInvitationRequestSchema,
  speakerPortalSlugSchema,
  type SpeakerPortalBootstrapResponse,
} from "@sessionbox-killer/contracts/portal";
import { magicLinkAcceptedResponseSchema } from "@sessionbox-killer/contracts";

type Fetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export class SpeakerPortalApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "SpeakerPortalApiError";
    this.code = code;
    this.status = status;
  }
}

async function responseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function responseError(response: Response, body: unknown) {
  const error =
    body && typeof body === "object" && "error" in body
      ? (body.error as Record<string, unknown> | null)
      : null;
  return new SpeakerPortalApiError(
    typeof error?.code === "string" ? error.code : "invalid_portal_response",
    typeof error?.message === "string"
      ? error.message
      : "The speaker portal returned an invalid response.",
    response.status,
  );
}

export async function readSpeakerPortal(
  eventSlug: string,
  fetcher: Fetch = window.fetch.bind(window),
  signal?: AbortSignal,
): Promise<SpeakerPortalBootstrapResponse> {
  const slug = speakerPortalSlugSchema.parse(eventSlug);
  const response = await fetcher(
    `/api/portal/${encodeURIComponent(slug)}/bootstrap`,
    {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      ...(signal ? { signal } : {}),
    },
  );
  const body = await responseBody(response);
  if (!response.ok) throw responseError(response, body);
  const parsed = speakerPortalBootstrapResponseSchema.safeParse(body);
  if (!parsed.success) throw responseError(response, body);
  return parsed.data;
}

export async function requestSpeakerPortalLink(
  eventSlug: string,
  email: string,
  turnstileToken: string,
  fetcher: Fetch = window.fetch.bind(window),
) {
  const slug = speakerPortalSlugSchema.parse(eventSlug);
  const request = speakerPortalInvitationRequestSchema.parse({
    email,
    turnstile_action: "sign_in",
    turnstile_token: turnstileToken,
  });
  const response = await fetcher(
    `/api/portal/${encodeURIComponent(slug)}/invitations`,
    {
      body: JSON.stringify(request),
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      method: "POST",
    },
  );
  const body = await responseBody(response);
  if (!response.ok) throw responseError(response, body);
  const parsed = magicLinkAcceptedResponseSchema.safeParse(body);
  if (!parsed.success) throw responseError(response, body);
  return parsed.data;
}
