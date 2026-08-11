const DEFAULT_BASE_URL = "https://api.accelevents.com";
const DEFAULT_MAXIMUM_ATTEMPTS = 3;
const DEFAULT_MAXIMUM_PAGES = 100;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_RESPONSE_LIMIT_BYTES = 1024 * 1024;
const MAXIMUM_OPERATIONS = 100;
const SESSION_DESCRIPTION_LIMIT = 65_024;
const SESSION_TITLE_LIMIT = 255;

export type AcceleventsAuthenticationHeader = "Authorization" | "Key";
export type AcceleventsFetcher = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;
export type AcceleventsSleeper = (milliseconds: number) => Promise<void>;

export interface AcceleventsClientOptions {
  apiKey: string;
  authenticationHeader?: AcceleventsAuthenticationHeader;
  eventId: number;
  eventUrl: string;
  fetcher?: AcceleventsFetcher;
  maximumAttempts?: number;
  maximumPages?: number;
  pageSize?: number;
  responseLimitBytes?: number;
  sleep?: AcceleventsSleeper;
}

export interface AcceleventsSessionSummary {
  description: string;
  endTime: string;
  format: AcceleventsSessionFormat;
  location: string;
  sessionId: number;
  startTime: string;
  status: "DRAFT" | "HIDDEN" | "VISIBLE";
  title: string;
}

export interface AcceleventsSpeakerSummary {
  email: string;
  firstName: string;
  lastName: string;
  speakerId: number;
}

export type AcceleventsSessionFormat =
  | "BREAK"
  | "BREAKOUT_SESSION"
  | "EXPO"
  | "MAIN_STAGE"
  | "MEET_UP"
  | "OTHER"
  | "WORKSHOP";

export interface AcceleventsSessionWrite {
  description?: string;
  endTime: string;
  format: AcceleventsSessionFormat;
  location?: string;
  sessionTypeFormat: "HYBRID" | "IN_PERSON" | "VIRTUAL";
  sessionVisibilityType?: "PRIVATE" | "PUBLIC";
  startTime: string;
  status?: "DRAFT" | "HIDDEN" | "VISIBLE";
  tag?: readonly AcceleventsTagReference[];
  ticketTypesThatCanBeRegistered?: readonly number[];
  title: string;
}

export interface AcceleventsSpeakerWrite {
  bio?: string;
  company?: string;
  email: string;
  firstName: string;
  lastName: string;
  pronouns?: string;
  title?: string;
}

export interface AcceleventsTagReference {
  color?: string;
  description?: string;
  id: number;
  name: string;
}

export interface AcceleventsTrackWrite {
  color?: string;
  description?: string;
  name: string;
  position?: number;
  type: "TAG" | "TRACK";
}

export type AcceleventsMutation =
  | {
      operationId: string;
      type: "create-session";
      value: AcceleventsSessionWrite;
    }
  | {
      operationId: string;
      type: "create-speaker";
      value: AcceleventsSpeakerWrite;
    }
  | {
      operationId: string;
      type: "create-track";
      value: AcceleventsTrackWrite;
    }
  | {
      operationId: string;
      sessionId: number;
      type: "update-session";
      value: AcceleventsSessionWrite;
    };

export interface AcceleventsMutationReceipt {
  code: string | null;
  operationId: string;
  providerId: number | null;
  retryable: boolean;
  status: "failed" | "succeeded";
}

export interface AcceleventsBatchReceipt {
  failed: number;
  results: readonly AcceleventsMutationReceipt[];
  succeeded: number;
}

export class AcceleventsProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(code: string, status: number | null, retryable: boolean) {
    super(
      `Accelevents request failed (status=${status ?? "network"}, code=${code}).`,
    );
    this.name = "AcceleventsProviderError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

interface PageEnvelope {
  data: readonly unknown[];
  recordsTotal: number;
}

const sessionFormats = new Set<AcceleventsSessionFormat>([
  "BREAK",
  "BREAKOUT_SESSION",
  "EXPO",
  "MAIN_STAGE",
  "MEET_UP",
  "OTHER",
  "WORKSHOP",
]);

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireBoundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new TypeError(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return resolved;
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return value;
}

function requireText(
  value: string,
  name: string,
  maximumLength: number,
): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximumLength) {
    throw new TypeError(
      `${name} must contain between 1 and ${maximumLength} characters.`,
    );
  }
  return normalized;
}

function validateEventUrl(value: string): string {
  const normalized = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(normalized)) {
    throw new TypeError("eventUrl must be a provider event slug.");
  }
  return normalized;
}

function validateProviderDate(value: string, name: string): string {
  if (!/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/.test(value)) {
    throw new TypeError(`${name} must use yyyy/MM/dd HH:mm.`);
  }
  return value;
}

function validateEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  ) {
    throw new TypeError("speaker email is invalid.");
  }
  return normalized;
}

function validateSessionWrite(
  value: AcceleventsSessionWrite,
): Record<string, unknown> {
  const startTime = validateProviderDate(value.startTime, "startTime");
  const endTime = validateProviderDate(value.endTime, "endTime");
  if (endTime <= startTime) {
    throw new TypeError("endTime must be after startTime.");
  }
  if (!sessionFormats.has(value.format)) {
    throw new TypeError("format is not supported by Accelevents.");
  }

  const result: Record<string, unknown> = {
    endTime,
    format: value.format,
    sessionTypeFormat: value.sessionTypeFormat,
    startTime,
    title: requireText(value.title, "title", SESSION_TITLE_LIMIT),
  };
  if (value.description !== undefined) {
    result.description = requireText(
      value.description,
      "description",
      SESSION_DESCRIPTION_LIMIT,
    );
  }
  if (value.location !== undefined) {
    result.location = requireText(value.location, "location", 255);
  }
  if (value.sessionVisibilityType !== undefined) {
    result.sessionVisibilityType = value.sessionVisibilityType;
  }
  if (value.status !== undefined) result.status = value.status;
  if (value.ticketTypesThatCanBeRegistered !== undefined) {
    result.ticketTypesThatCanBeRegistered =
      value.ticketTypesThatCanBeRegistered.map((id) =>
        requirePositiveInteger(id, "ticket type ID"),
      );
  }
  if (value.tag !== undefined) {
    result.tag = value.tag.map((tag) => ({
      ...(tag.color === undefined ? {} : { color: tag.color }),
      ...(tag.description === undefined
        ? {}
        : {
            description: requireText(tag.description, "tag description", 1_000),
          }),
      id: requirePositiveInteger(tag.id, "tag ID"),
      name: requireText(tag.name, "tag name", 255),
    }));
  }
  return result;
}

function validateSpeakerWrite(
  value: AcceleventsSpeakerWrite,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    email: validateEmail(value.email),
    firstName: requireText(value.firstName, "firstName", 255),
    lastName: requireText(value.lastName, "lastName", 255),
  };
  for (const [name, maximum] of [
    ["bio", 10_000],
    ["company", 255],
    ["pronouns", 80],
    ["title", 255],
  ] as const) {
    const field = value[name];
    if (field !== undefined) result[name] = requireText(field, name, maximum);
  }
  return result;
}

function validateTrackWrite(
  value: AcceleventsTrackWrite,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    name: requireText(value.name, "track name", 255),
    type: value.type,
  };
  if (value.color !== undefined) {
    if (!/^#[0-9a-fA-F]{6}$/.test(value.color)) {
      throw new TypeError("track color must be a six-digit hex color.");
    }
    result.color = value.color.toUpperCase();
  }
  if (value.description !== undefined) {
    result.description = requireText(
      value.description,
      "track description",
      1_000,
    );
  }
  if (value.position !== undefined) {
    if (!Number.isFinite(value.position) || value.position < 0) {
      throw new TypeError("track position must be a non-negative number.");
    }
    result.position = value.position;
  }
  return result;
}

function parseProviderCode(value: unknown): string {
  const object = asObject(value);
  const nestedError = asObject(object?.error);
  for (const candidate of [
    object?.code,
    object?.errorCode,
    nestedError?.code,
    nestedError?.errorCode,
  ]) {
    if (
      (typeof candidate === "string" || typeof candidate === "number") &&
      String(candidate).length <= 80
    ) {
      return String(candidate);
    }
  }
  return "provider_error";
}

function parseProviderId(value: unknown): number {
  const object = asObject(value);
  const candidate =
    typeof value === "number"
      ? value
      : (object?.id ?? object?.sessionId ?? object?.speakerId);
  if (typeof candidate !== "number") {
    throw new AcceleventsProviderError("invalid_response", 200, false);
  }
  return requirePositiveInteger(candidate, "provider ID");
}

function parsePage(value: unknown): PageEnvelope {
  const object = asObject(value);
  if (!object || !Array.isArray(object.data)) {
    throw new AcceleventsProviderError("invalid_response", 200, false);
  }
  const total = object.recordsTotal;
  if (typeof total !== "number" || !Number.isInteger(total) || total < 0) {
    throw new AcceleventsProviderError("invalid_response", 200, false);
  }
  return { data: object.data, recordsTotal: total };
}

function parseSession(value: unknown): AcceleventsSessionSummary {
  const object = asObject(value);
  if (!object) {
    throw new AcceleventsProviderError("invalid_response", 200, false);
  }
  const format = object.format;
  const status = object.status;
  if (
    typeof object.sessionId !== "number" ||
    typeof object.title !== "string" ||
    typeof object.startTime !== "string" ||
    typeof object.endTime !== "string" ||
    typeof format !== "string" ||
    !sessionFormats.has(format as AcceleventsSessionFormat) ||
    (status !== "DRAFT" && status !== "HIDDEN" && status !== "VISIBLE")
  ) {
    throw new AcceleventsProviderError("invalid_response", 200, false);
  }
  return {
    description:
      typeof object.description === "string" ? object.description : "",
    endTime: object.endTime,
    format: format as AcceleventsSessionFormat,
    location: typeof object.location === "string" ? object.location : "",
    sessionId: requirePositiveInteger(object.sessionId, "session ID"),
    startTime: object.startTime,
    status,
    title: object.title,
  };
}

function parseSpeaker(value: unknown): AcceleventsSpeakerSummary {
  const object = asObject(value);
  if (
    !object ||
    typeof object.speakerId !== "number" ||
    typeof object.email !== "string" ||
    typeof object.firstName !== "string" ||
    typeof object.lastName !== "string"
  ) {
    throw new AcceleventsProviderError("invalid_response", 200, false);
  }
  return {
    email: validateEmail(object.email),
    firstName: object.firstName,
    lastName: object.lastName,
    speakerId: requirePositiveInteger(object.speakerId, "speaker ID"),
  };
}

export async function readBoundedJson(
  response: Response,
  maximumBytes = DEFAULT_RESPONSE_LIMIT_BYTES,
): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    Number.isFinite(Number(contentLength)) &&
    Number(contentLength) > maximumBytes
  ) {
    throw new AcceleventsProviderError(
      "response_too_large",
      response.status,
      false,
    );
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new AcceleventsProviderError(
          "response_too_large",
          response.status,
          false,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (total === 0) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new AcceleventsProviderError("invalid_json", response.status, false);
  }
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, 5_000);
  }
  return Math.min(250 * 2 ** (attempt - 1), 2_000);
}

export class AcceleventsClient {
  private readonly apiKey: string;
  private readonly authenticationHeader: AcceleventsAuthenticationHeader;
  private readonly baseUrl: string;
  private readonly eventId: number;
  private readonly eventUrl: string;
  private readonly fetcher: AcceleventsFetcher;
  private readonly maximumAttempts: number;
  private readonly maximumPages: number;
  private readonly pageSize: number;
  private readonly responseLimitBytes: number;
  private readonly sleep: AcceleventsSleeper;

  constructor(options: AcceleventsClientOptions) {
    this.apiKey = requireText(options.apiKey, "apiKey", 1_024);
    this.authenticationHeader = options.authenticationHeader ?? "Key";
    this.baseUrl = DEFAULT_BASE_URL;
    this.eventId = requirePositiveInteger(options.eventId, "eventId");
    this.eventUrl = validateEventUrl(options.eventUrl);
    this.fetcher = options.fetcher ?? fetch;
    this.maximumAttempts = requireBoundedInteger(
      options.maximumAttempts,
      DEFAULT_MAXIMUM_ATTEMPTS,
      5,
      "maximumAttempts",
    );
    this.maximumPages = requireBoundedInteger(
      options.maximumPages,
      DEFAULT_MAXIMUM_PAGES,
      100,
      "maximumPages",
    );
    this.pageSize = requireBoundedInteger(
      options.pageSize,
      DEFAULT_PAGE_SIZE,
      100,
      "pageSize",
    );
    this.responseLimitBytes = requireBoundedInteger(
      options.responseLimitBytes,
      DEFAULT_RESPONSE_LIMIT_BYTES,
      4 * 1024 * 1024,
      "responseLimitBytes",
    );
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async listSessions(): Promise<readonly AcceleventsSessionSummary[]> {
    const values = await this.list("session", "TAG,TRACK,SPEAKER");
    return values.map(parseSession);
  }

  async listSpeakers(): Promise<readonly AcceleventsSpeakerSummary[]> {
    const values = await this.list("speaker", "SPEAKER");
    return values.map(parseSpeaker);
  }

  async createTrack(value: AcceleventsTrackWrite): Promise<number> {
    return this.mutate("key-value", "POST", validateTrackWrite(value));
  }

  async createSession(value: AcceleventsSessionWrite): Promise<number> {
    return this.mutate("session", "POST", validateSessionWrite(value));
  }

  async updateSession(
    sessionId: number,
    value: AcceleventsSessionWrite,
  ): Promise<number> {
    const id = requirePositiveInteger(sessionId, "sessionId");
    await this.request(`session/${id}`, {
      body: JSON.stringify(validateSessionWrite(value)),
      method: "PUT",
      retrySafe: true,
    });
    return id;
  }

  async createSpeaker(value: AcceleventsSpeakerWrite): Promise<number> {
    const normalized = validateSpeakerWrite(value);
    try {
      return await this.mutate("speaker", "POST", normalized);
    } catch (error) {
      if (
        !(error instanceof AcceleventsProviderError) ||
        error.code !== "4068906"
      ) {
        throw error;
      }
      const matching = (await this.listSpeakers()).filter(
        (speaker) => speaker.email === normalized.email,
      );
      const [speaker] = matching;
      if (!speaker || matching.length !== 1) {
        throw new AcceleventsProviderError(
          "duplicate_speaker_unresolved",
          error.status,
          false,
        );
      }
      return speaker.speakerId;
    }
  }

  async applyOperations(
    operations: readonly AcceleventsMutation[],
  ): Promise<AcceleventsBatchReceipt> {
    if (operations.length > MAXIMUM_OPERATIONS) {
      throw new TypeError(
        `Accelevents batches are limited to ${MAXIMUM_OPERATIONS} operations.`,
      );
    }
    const operationIds = new Set<string>();
    for (const operation of operations) {
      const id = requireText(operation.operationId, "operationId", 160);
      if (operationIds.has(id)) {
        throw new TypeError(
          "operationId values must be unique within a batch.",
        );
      }
      operationIds.add(id);
    }

    const results: AcceleventsMutationReceipt[] = [];
    for (const operation of operations) {
      try {
        let providerId: number;
        switch (operation.type) {
          case "create-session":
            providerId = await this.createSession(operation.value);
            break;
          case "create-speaker":
            providerId = await this.createSpeaker(operation.value);
            break;
          case "create-track":
            providerId = await this.createTrack(operation.value);
            break;
          case "update-session":
            providerId = await this.updateSession(
              operation.sessionId,
              operation.value,
            );
            break;
        }
        results.push({
          code: null,
          operationId: operation.operationId,
          providerId,
          retryable: false,
          status: "succeeded",
        });
      } catch (error) {
        const providerError =
          error instanceof AcceleventsProviderError
            ? error
            : new AcceleventsProviderError("validation_error", null, false);
        results.push({
          code: providerError.code,
          operationId: operation.operationId,
          providerId: null,
          retryable: providerError.retryable,
          status: "failed",
        });
      }
    }
    const failed = results.filter(
      (result) => result.status === "failed",
    ).length;
    return { failed, results, succeeded: results.length - failed };
  }

  private async list(
    resource: "session" | "speaker",
    expand: string,
  ): Promise<readonly unknown[]> {
    const values: unknown[] = [];
    for (let page = 0; page < this.maximumPages; page += 1) {
      const query = new URLSearchParams({
        eventId: String(this.eventId),
        expand,
        page: String(page),
        size: String(this.pageSize),
      });
      const envelope = parsePage(
        await this.request(`${resource}?${query.toString()}`, {
          method: "GET",
          retrySafe: true,
        }),
      );
      values.push(...envelope.data);
      if (
        envelope.data.length < this.pageSize ||
        values.length >= envelope.recordsTotal
      ) {
        return values;
      }
    }
    throw new AcceleventsProviderError("page_limit_exceeded", 200, false);
  }

  private async mutate(
    resource: string,
    method: "POST",
    body: Record<string, unknown>,
  ): Promise<number> {
    return parseProviderId(
      await this.request(resource, {
        body: JSON.stringify(body),
        method,
        retrySafe: false,
      }),
    );
  }

  private async request(
    resource: string,
    options: {
      body?: string;
      method: "GET" | "POST" | "PUT";
      retrySafe: boolean;
    },
  ): Promise<unknown> {
    const url = `${this.baseUrl}/rest/host/event/${encodeURIComponent(this.eventUrl)}/${resource}`;
    for (let attempt = 1; attempt <= this.maximumAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetcher(url, {
          ...(options.body === undefined ? {} : { body: options.body }),
          headers: {
            Accept: "application/json",
            ...(options.body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
            [this.authenticationHeader]: this.apiKey,
          },
          method: options.method,
        });
      } catch {
        if (options.retrySafe && attempt < this.maximumAttempts) {
          await this.sleep(Math.min(250 * 2 ** (attempt - 1), 2_000));
          continue;
        }
        throw new AcceleventsProviderError(
          options.retrySafe ? "network_error" : "ambiguous_write",
          null,
          options.retrySafe,
        );
      }

      const value = await readBoundedJson(response, this.responseLimitBytes);
      if (response.ok) return value;

      const code = parseProviderCode(value);
      const retryable =
        response.status === 429 ||
        response.status === 502 ||
        response.status === 503 ||
        response.status === 504;
      if (options.retrySafe && retryable && attempt < this.maximumAttempts) {
        await this.sleep(retryDelay(response, attempt));
        continue;
      }
      throw new AcceleventsProviderError(
        code,
        response.status,
        options.retrySafe && retryable,
      );
    }
    throw new AcceleventsProviderError("attempt_limit", null, false);
  }
}
