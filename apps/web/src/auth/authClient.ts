import {
  authSessionResponseSchema,
  magicLinkAcceptedResponseSchema,
  magicLinkExchangeSchema,
  magicLinkRequestSchema,
  protectedMagicLinkRequestSchema,
  type AuthSessionResponse,
  type ProtectedMagicLinkRequest,
} from "@sessionbox-killer/contracts";

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

export type AuthSessionIdentity = Pick<
  AuthSessionResponse,
  "expires_at" | "user"
>;

export interface MagicLinkAcceptedResponse {
  accepted: true;
  message: string;
}

const authSessionIdentitySchema = authSessionResponseSchema.pick({
  expires_at: true,
  user: true,
});

export class AuthApiError extends Error {
  readonly code: string;
  readonly requestId: string | undefined;
  readonly status: number;

  constructor(options: {
    code: string;
    message: string;
    requestId?: string | undefined;
    status: number;
  }) {
    super(options.message);
    this.name = "AuthApiError";
    this.code = options.code;
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

function responseError(response: Response, body: unknown): AuthApiError {
  const candidate =
    body && typeof body === "object" ? (body as StandardErrorBody) : null;
  const code =
    candidate?.error && typeof candidate.error.code === "string"
      ? candidate.error.code
      : "invalid_auth_response";
  const message =
    candidate?.error && typeof candidate.error.message === "string"
      ? candidate.error.message
      : "The authentication service returned an invalid response.";
  return new AuthApiError({
    code,
    message,
    requestId:
      typeof candidate?.request_id === "string"
        ? candidate.request_id
        : undefined,
    status: response.status,
  });
}

export function safeAuthRedirectPath(
  candidate: string | null | undefined,
  fallback = "/",
): string {
  if (!candidate) return fallback;
  const parsed = magicLinkRequestSchema.safeParse({
    email: "return-path@opensession.invalid",
    purpose: "sign_in",
    redirect_path: candidate,
  });
  return parsed.success ? parsed.data.redirect_path : fallback;
}

export function readCsrfToken(cookie: string): string | null {
  const prefix = "__Host-opensession-csrf=";
  const value = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  if (!value) return null;
  try {
    return decodeURIComponent(value.slice(prefix.length));
  } catch {
    return null;
  }
}

export async function requestMagicLink(
  input: ProtectedMagicLinkRequest,
  fetcher: Fetch = window.fetch.bind(window),
): Promise<MagicLinkAcceptedResponse> {
  const request = protectedMagicLinkRequestSchema.parse(input);
  const response = await fetcher("/api/auth/magic-links", {
    body: JSON.stringify(request),
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  const body = await json(response);
  if (!response.ok) throw responseError(response, body);
  const parsed = magicLinkAcceptedResponseSchema.safeParse(body);
  if (!parsed.success) throw responseError(response, body);
  return parsed.data;
}

export async function exchangeMagicLink(
  token: string,
  fetcher: Fetch = window.fetch.bind(window),
  signal?: AbortSignal,
): Promise<AuthSessionResponse> {
  const request = magicLinkExchangeSchema.parse({ token });
  const response = await fetcher("/api/auth/magic-links/exchange", {
    body: JSON.stringify(request),
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    method: "POST",
    ...(signal ? { signal } : {}),
  });
  const body = await json(response);
  if (!response.ok) throw responseError(response, body);
  const parsed = authSessionResponseSchema.safeParse(body);
  if (!parsed.success) throw responseError(response, body);
  return parsed.data;
}

export async function readAuthSession(
  fetcher: Fetch = window.fetch.bind(window),
  signal?: AbortSignal,
): Promise<AuthSessionIdentity> {
  const response = await fetcher("/api/auth/session", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  const body = await json(response);
  if (!response.ok) throw responseError(response, body);
  const parsed = authSessionIdentitySchema.safeParse(body);
  if (!parsed.success) throw responseError(response, body);
  return parsed.data;
}

export async function logoutAuthSession(
  cookie: string,
  fetcher: Fetch = window.fetch.bind(window),
): Promise<void> {
  const csrfToken = readCsrfToken(cookie);
  if (!csrfToken) {
    throw new AuthApiError({
      code: "missing_csrf",
      message: "Refresh the page before signing out.",
      status: 0,
    });
  }
  const response = await fetcher("/api/auth/logout", {
    body: "{}",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    method: "POST",
  });
  if (!response.ok) throw responseError(response, await json(response));
}
