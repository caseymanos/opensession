import {
  apiKeyCreateRequestSchema,
  apiKeyCreateResponseSchema,
  apiKeyListResponseSchema,
  apiKeyRevokeResponseSchema,
  publicApiProblemSchema,
  type ApiKeyCreateRequest,
  type ApiKeyCreateResponse,
  type ApiKeyMetadata,
} from "@sessionbox-killer/contracts/public-api";

import { readCsrfToken } from "../auth/authClient";

type Fetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface ApiKeyPort {
  create(input: ApiKeyCreateRequest): Promise<ApiKeyCreateResponse>;
  list(): Promise<ApiKeyMetadata[]>;
  revoke(keyId: string): Promise<ApiKeyMetadata>;
}

export class ApiKeyClientError extends Error {
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
    this.name = "ApiKeyClientError";
    this.code = options.code;
    this.requestId = options.requestId;
    this.status = options.status;
  }
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function responseError(response: Response, value: unknown): ApiKeyClientError {
  const problem = publicApiProblemSchema.safeParse(value);
  return new ApiKeyClientError({
    code: problem.success ? problem.data.code : "invalid_api_key_response",
    message: problem.success
      ? problem.data.detail
      : "The API key service returned an invalid response.",
    requestId: problem.success ? problem.data.request_id : undefined,
    status: response.status,
  });
}

function mutationKey(operation: "create" | "revoke"): string {
  return `api-key-${operation}-${crypto.randomUUID()}`;
}

export function createApiKeyPort(
  eventKey: string,
  fetcher: Fetch = window.fetch.bind(window),
  csrfReader: () => string | null = () => readCsrfToken(document.cookie),
): ApiKeyPort {
  const baseUrl = `/api/events/${encodeURIComponent(eventKey)}/api-keys`;
  let pendingCreation:
    { idempotencyKey: string; requestJson: string } | undefined;
  const pendingRevocations = new Map<string, string>();

  async function mutate(
    url: string,
    method: "DELETE" | "POST",
    body: unknown,
    idempotencyKey: string,
  ): Promise<{ response: Response; value: unknown }> {
    const csrf = csrfReader();
    if (!csrf) {
      throw new ApiKeyClientError({
        code: "missing_csrf",
        message: "Refresh the page before changing API keys.",
        status: 0,
      });
    }
    const response = await fetcher(url, {
      body: JSON.stringify(body),
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
        "X-CSRF-Token": csrf,
      },
      method,
    });
    return { response, value: await responseJson(response) };
  }

  return {
    async create(input) {
      const validated = apiKeyCreateRequestSchema.parse(input);
      const requestJson = JSON.stringify(validated);
      if (pendingCreation?.requestJson !== requestJson) {
        pendingCreation = {
          idempotencyKey: mutationKey("create"),
          requestJson,
        };
      }
      const { response, value } = await mutate(
        baseUrl,
        "POST",
        validated,
        pendingCreation.idempotencyKey,
      );
      if (!response.ok) throw responseError(response, value);
      const parsed = apiKeyCreateResponseSchema.safeParse(value);
      if (!parsed.success) throw responseError(response, value);
      pendingCreation = undefined;
      return parsed.data;
    },
    async list() {
      const response = await fetcher(baseUrl, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      const value = await responseJson(response);
      if (!response.ok) throw responseError(response, value);
      const parsed = apiKeyListResponseSchema.safeParse(value);
      if (!parsed.success) throw responseError(response, value);
      return parsed.data.data;
    },
    async revoke(keyId) {
      const idempotencyKey =
        pendingRevocations.get(keyId) ?? mutationKey("revoke");
      pendingRevocations.set(keyId, idempotencyKey);
      const { response, value } = await mutate(
        `${baseUrl}/${encodeURIComponent(keyId)}`,
        "DELETE",
        {},
        idempotencyKey,
      );
      if (!response.ok) throw responseError(response, value);
      const parsed = apiKeyRevokeResponseSchema.safeParse(value);
      if (!parsed.success) throw responseError(response, value);
      pendingRevocations.delete(keyId);
      return parsed.data.data;
    },
  };
}
