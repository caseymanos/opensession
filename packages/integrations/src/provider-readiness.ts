import {
  AcceleventsClient,
  AcceleventsProviderError,
  readBoundedJson,
  type AcceleventsAuthenticationHeader,
  type AcceleventsFetcher,
} from "./accelevents.js";

const PROBE_RESPONSE_LIMIT = 256 * 1024;

export interface ProviderReadinessReceipt {
  provider: "accelevents" | "airtable" | "resend";
  resourcesObserved: number;
}

export class ProviderReadinessError extends Error {
  readonly code: string;
  readonly provider: ProviderReadinessReceipt["provider"];

  constructor(provider: ProviderReadinessReceipt["provider"], code: string) {
    super(`${provider} readiness probe failed (code=${code}).`);
    this.name = "ProviderReadinessError";
    this.provider = provider;
    this.code = code;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireSecret(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 2_048) {
    throw new TypeError(`${name} is required.`);
  }
  return normalized;
}

async function probeJson(
  provider: ProviderReadinessReceipt["provider"],
  fetcher: AcceleventsFetcher,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, init);
  } catch {
    throw new ProviderReadinessError(provider, "network_error");
  }
  let value: unknown;
  try {
    value = await readBoundedJson(response, PROBE_RESPONSE_LIMIT);
  } catch (error) {
    if (error instanceof AcceleventsProviderError) {
      throw new ProviderReadinessError(provider, error.code);
    }
    throw error;
  }
  if (!response.ok) {
    throw new ProviderReadinessError(provider, `http_${response.status}`);
  }
  return value;
}

export async function probeAirtableReadiness(options: {
  baseId: string;
  fetcher?: AcceleventsFetcher;
  token: string;
}): Promise<ProviderReadinessReceipt> {
  const baseId = options.baseId.trim();
  if (!/^app[a-zA-Z0-9]{8,}$/.test(baseId)) {
    throw new TypeError("AIRTABLE_BASE_ID is invalid.");
  }
  const value = await probeJson(
    "airtable",
    options.fetcher ?? fetch,
    `https://api.airtable.com/v0/meta/bases/${encodeURIComponent(baseId)}/tables`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${requireSecret(options.token, "AIRTABLE_PAT")}`,
      },
      method: "GET",
    },
  );
  const tables = asObject(value)?.tables;
  if (!Array.isArray(tables)) {
    throw new ProviderReadinessError("airtable", "invalid_response");
  }
  return { provider: "airtable", resourcesObserved: tables.length };
}

export async function probeResendReadiness(options: {
  apiKey: string;
  fetcher?: AcceleventsFetcher;
}): Promise<ProviderReadinessReceipt> {
  const value = await probeJson(
    "resend",
    options.fetcher ?? fetch,
    "https://api.resend.com/domains?limit=1",
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${requireSecret(options.apiKey, "RESEND_API_KEY")}`,
        "User-Agent": "opensession-provider-readiness/1.0",
      },
      method: "GET",
    },
  );
  const object = asObject(value);
  if (object?.object !== "list" || !Array.isArray(object.data)) {
    throw new ProviderReadinessError("resend", "invalid_response");
  }
  return { provider: "resend", resourcesObserved: object.data.length };
}

export async function probeAcceleventsReadiness(options: {
  apiKey: string;
  authenticationHeader: AcceleventsAuthenticationHeader;
  eventId: number;
  eventUrl: string;
  fetcher?: AcceleventsFetcher;
}): Promise<ProviderReadinessReceipt> {
  const client = new AcceleventsClient({
    apiKey: options.apiKey,
    authenticationHeader: options.authenticationHeader,
    eventId: options.eventId,
    eventUrl: options.eventUrl,
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    maximumAttempts: 2,
    maximumPages: 20,
    pageSize: 100,
  });
  try {
    const [sessions, speakers] = await Promise.all([
      client.listSessions(),
      client.listSpeakers(),
    ]);
    return {
      provider: "accelevents",
      resourcesObserved: sessions.length + speakers.length,
    };
  } catch (error) {
    if (error instanceof AcceleventsProviderError) {
      throw new ProviderReadinessError("accelevents", error.code);
    }
    throw error;
  }
}
