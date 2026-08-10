import { z } from "zod";

import {
  AirtableAmbiguousWriteError,
  AirtableError,
  AirtablePartialWriteError,
  AirtableResponseError,
} from "./errors.js";
import { AirtableRateLimiter } from "./rate-limiter.js";
import {
  systemClock,
  type AirtableBaseSchema,
  type AirtableClock,
  type AirtableFetcher,
  type AirtableFields,
  type AirtableListOptions,
  type AirtableRecord,
} from "./types.js";

const fieldsSchema = z.record(z.string(), z.unknown());
const recordSchema = z.object({
  id: z.string(),
  createdTime: z.string(),
  fields: fieldsSchema,
});
const recordsResponseSchema = z.object({
  records: z.array(recordSchema),
  createdRecords: z.array(z.string()).optional(),
  updatedRecords: z.array(z.string()).optional(),
  offset: z.string().optional(),
  details: z
    .object({
      message: z.string(),
      reasons: z.array(z.string()).optional(),
    })
    .optional(),
});
const deletedRecordsResponseSchema = z.object({
  records: z.array(
    z.object({
      deleted: z.literal(true),
      id: z.string(),
    }),
  ),
});
const webhookPayloadsResponseSchema = z.object({
  cursor: z.number().int().nonnegative(),
  mightHaveMore: z.boolean(),
  payloads: z.array(
    z
      .object({
        baseTransactionNumber: z.number().int().optional(),
        changedTablesById: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough(),
  ),
});
const fieldSchema = z.object({
  description: z.string().optional(),
  id: z.string(),
  name: z.string(),
  type: z.string(),
  options: z.record(z.string(), z.unknown()).optional(),
});
const tableSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  primaryFieldId: z.string(),
  fields: z.array(fieldSchema),
});
const baseSchema = z.object({ tables: z.array(tableSchema) });

const retryableStatuses = new Set([429, 500, 502, 503, 504]);
const maximumBatchSize = 10;

export interface AirtableClientOptions {
  apiUrl?: string;
  baseId: string;
  clock?: AirtableClock;
  createTimeoutSignal?: (milliseconds: number) => AbortSignal;
  fetcher?: AirtableFetcher;
  maximumAttempts?: number;
  random?: () => number;
  rateLimiter?: AirtableRateLimiter;
  requestTimeoutMilliseconds?: number;
  token: string;
}

export interface AirtableFieldWrite {
  description?: string | undefined;
  name: string;
  options?: Record<string, unknown> | undefined;
  type: string;
}

export interface AirtableTableWrite {
  description?: string | undefined;
  fields: readonly AirtableFieldWrite[];
  name: string;
}

interface AirtableRequestOptions {
  body?: unknown;
  method?: "DELETE" | "GET" | "PATCH" | "POST";
  operation: string;
  query?: URLSearchParams;
  retryMode?: "read" | "write";
}

export interface AirtableWebhookPayloadPage {
  cursor: number;
  mightHaveMore: boolean;
  payloads: readonly {
    baseTransactionNumber?: number | undefined;
    changedTableIds: readonly string[];
  }[];
}

interface AirtableResponsePayload {
  status: number;
  value: unknown;
}

function getProviderCode(value: unknown, status: number): string {
  const parsed = z
    .object({
      error: z
        .union([
          z.string(),
          z.object({ type: z.string().optional() }).passthrough(),
        ])
        .optional(),
    })
    .safeParse(value);

  if (!parsed.success || parsed.data.error === undefined) {
    return `http_${status}`;
  }

  const candidate =
    typeof parsed.data.error === "string"
      ? parsed.data.error
      : (parsed.data.error.type ?? `http_${status}`);
  return /^[A-Z0-9_]+$/.test(candidate) ? candidate : `http_${status}`;
}

function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) {
    return null;
  }

  const seconds = Number(value);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null;
}

function appendListOptions(
  query: URLSearchParams,
  options: AirtableListOptions,
) {
  if (options.pageSize !== undefined) {
    if (
      !Number.isInteger(options.pageSize) ||
      options.pageSize < 1 ||
      options.pageSize > 100
    ) {
      throw new Error("Airtable pageSize must be between 1 and 100.");
    }
    query.set("pageSize", String(options.pageSize));
  }

  if (options.maxRecords !== undefined) {
    if (!Number.isInteger(options.maxRecords) || options.maxRecords < 1) {
      throw new Error("Airtable maxRecords must be a positive integer.");
    }
    query.set("maxRecords", String(options.maxRecords));
  }

  if (options.filterByFormula) {
    query.set("filterByFormula", options.filterByFormula);
  }

  for (const field of options.fields ?? []) {
    query.append("fields[]", field);
  }

  for (const [index, sort] of (options.sort ?? []).entries()) {
    query.set(`sort[${index}][field]`, sort.field);
    query.set(`sort[${index}][direction]`, sort.direction ?? "asc");
  }
}

export class AirtableClient {
  readonly baseId: string;
  private readonly apiUrl: string;
  private readonly clock: AirtableClock;
  private readonly createTimeoutSignal: (milliseconds: number) => AbortSignal;
  private readonly fetcher: AirtableFetcher;
  private readonly maximumAttempts: number;
  private readonly random: () => number;
  private readonly rateLimiter: AirtableRateLimiter;
  private readonly requestTimeoutMilliseconds: number;
  private readonly token: string;

  constructor(options: AirtableClientOptions) {
    if (!options.baseId.trim()) {
      throw new Error("Airtable base ID is required.");
    }
    if (!options.token.trim()) {
      throw new Error("Airtable token is required.");
    }

    this.apiUrl = options.apiUrl ?? "https://api.airtable.com";
    this.baseId = options.baseId;
    this.clock = options.clock ?? systemClock;
    this.createTimeoutSignal =
      options.createTimeoutSignal ??
      ((milliseconds) => AbortSignal.timeout(milliseconds));
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.maximumAttempts = options.maximumAttempts ?? 4;
    this.random = options.random ?? Math.random;
    this.rateLimiter =
      options.rateLimiter ?? new AirtableRateLimiter({ clock: this.clock });
    this.requestTimeoutMilliseconds =
      options.requestTimeoutMilliseconds ?? 10_000;
    if (
      !Number.isFinite(this.requestTimeoutMilliseconds) ||
      this.requestTimeoutMilliseconds <= 0
    ) {
      throw new Error("requestTimeoutMilliseconds must be greater than zero.");
    }
    this.token = options.token;
  }

  async getBaseSchema(): Promise<AirtableBaseSchema> {
    const response = await this.request(
      `/v0/meta/bases/${encodeURIComponent(this.baseId)}/tables`,
      { operation: "get base schema" },
    );
    const parsed = baseSchema.safeParse(response.value);

    if (!parsed.success) {
      throw new AirtableResponseError("get base schema");
    }

    return parsed.data;
  }

  async createTable(table: AirtableTableWrite) {
    const response = await this.request(
      `/v0/meta/bases/${encodeURIComponent(this.baseId)}/tables`,
      {
        body: table,
        method: "POST",
        operation: "create table",
        retryMode: "write",
      },
    );
    const parsed = tableSchema.safeParse(response.value);

    if (!parsed.success) {
      throw new AirtableAmbiguousWriteError({
        code: "invalid_success_response",
        status: response.status,
      });
    }

    return parsed.data;
  }

  async createField(tableId: string, field: AirtableFieldWrite) {
    const response = await this.request(
      `/v0/meta/bases/${encodeURIComponent(this.baseId)}/tables/${encodeURIComponent(tableId)}/fields`,
      {
        body: field,
        method: "POST",
        operation: "create field",
        retryMode: "write",
      },
    );
    const parsed = fieldSchema.safeParse(response.value);

    if (!parsed.success) {
      throw new AirtableAmbiguousWriteError({
        code: "invalid_success_response",
        status: response.status,
      });
    }

    return parsed.data;
  }

  async listRecords<TFields extends AirtableFields = AirtableFields>(
    tableIdOrName: string,
    options: AirtableListOptions = {},
  ): Promise<AirtableRecord<TFields>[]> {
    const records: AirtableRecord<TFields>[] = [];
    const seenOffsets = new Set<string>();
    let offset: string | undefined;

    do {
      const query = new URLSearchParams();
      appendListOptions(query, options);
      if (offset) {
        query.set("offset", offset);
      }

      const response = await this.request(
        `/v0/${encodeURIComponent(this.baseId)}/${encodeURIComponent(tableIdOrName)}`,
        { operation: "list records", query },
      );
      const parsed = recordsResponseSchema.safeParse(response.value);

      if (!parsed.success) {
        throw new AirtableResponseError("list records");
      }

      records.push(...(parsed.data.records as AirtableRecord<TFields>[]));
      offset = parsed.data.offset;

      if (offset && seenOffsets.has(offset)) {
        throw new AirtableResponseError("list records pagination");
      }
      if (offset) {
        seenOffsets.add(offset);
      }
    } while (
      offset &&
      (options.maxRecords === undefined || records.length < options.maxRecords)
    );

    return options.maxRecords === undefined
      ? records
      : records.slice(0, options.maxRecords);
  }

  async updateRecords<TFields extends AirtableFields = AirtableFields>(
    tableIdOrName: string,
    records: readonly { fields: Partial<TFields>; id: string }[],
  ): Promise<AirtableRecord<TFields>[]> {
    this.assertBatchSize(records.length);
    return this.writeRecords(
      tableIdOrName,
      { records, typecast: false },
      "PATCH",
    );
  }

  async deleteRecords(
    tableIdOrName: string,
    recordIds: readonly string[],
  ): Promise<readonly string[]> {
    this.assertBatchSize(recordIds.length);
    const query = new URLSearchParams();
    for (const recordId of recordIds) {
      query.append("records[]", recordId);
    }
    const response = await this.request(
      `/v0/${encodeURIComponent(this.baseId)}/${encodeURIComponent(tableIdOrName)}`,
      {
        method: "DELETE",
        operation: "delete records",
        query,
        retryMode: "write",
      },
    );
    const parsed = deletedRecordsResponseSchema.safeParse(response.value);
    if (!parsed.success) {
      throw new AirtableAmbiguousWriteError({
        code: "invalid_success_response",
        status: response.status,
      });
    }
    return parsed.data.records.map(({ id }) => id);
  }

  async getWebhookPayloads(
    webhookId: string,
    cursor: number,
  ): Promise<AirtableWebhookPayloadPage> {
    if (!webhookId.trim() || !Number.isInteger(cursor) || cursor < 1) {
      throw new Error("Airtable webhook ID and positive cursor are required.");
    }
    const query = new URLSearchParams({ cursor: String(cursor) });
    const response = await this.request(
      `/v0/bases/${encodeURIComponent(this.baseId)}/webhooks/${encodeURIComponent(webhookId)}/payloads`,
      { operation: "get webhook payloads", query },
    );
    const parsed = webhookPayloadsResponseSchema.safeParse(response.value);
    if (!parsed.success) {
      throw new AirtableResponseError("get webhook payloads");
    }
    return {
      cursor: parsed.data.cursor,
      mightHaveMore: parsed.data.mightHaveMore,
      payloads: parsed.data.payloads.map((payload) => ({
        ...(payload.baseTransactionNumber === undefined
          ? {}
          : { baseTransactionNumber: payload.baseTransactionNumber }),
        changedTableIds: Object.keys(payload.changedTablesById ?? {}).sort(),
      })),
    };
  }

  async upsertRecords<TFields extends AirtableFields = AirtableFields>(
    tableIdOrName: string,
    records: readonly { fields: TFields }[],
    fieldsToMergeOn: readonly string[],
  ): Promise<AirtableRecord<TFields>[]> {
    this.assertBatchSize(records.length);

    if (fieldsToMergeOn.length < 1 || fieldsToMergeOn.length > 3) {
      throw new Error("Airtable upserts require one to three merge fields.");
    }

    return this.writeRecords(
      tableIdOrName,
      {
        performUpsert: { fieldsToMergeOn },
        records,
        typecast: false,
      },
      "PATCH",
    );
  }

  async upsertRecordsInBatches<TFields extends AirtableFields = AirtableFields>(
    tableIdOrName: string,
    records: readonly { fields: TFields }[],
    fieldsToMergeOn: readonly string[],
  ): Promise<AirtableRecord<TFields>[]> {
    const written: AirtableRecord<TFields>[] = [];

    for (let index = 0; index < records.length; index += maximumBatchSize) {
      const batch = records.slice(index, index + maximumBatchSize);

      try {
        written.push(
          ...(await this.upsertRecords(tableIdOrName, batch, fieldsToMergeOn)),
        );
      } catch (error) {
        throw new AirtablePartialWriteError({
          cause: error,
          completedCount: written.length,
          failedBatchIndex: Math.floor(index / maximumBatchSize),
          totalCount: records.length,
        });
      }
    }

    return written;
  }

  private assertBatchSize(size: number) {
    if (!Number.isInteger(size) || size < 1 || size > maximumBatchSize) {
      throw new Error("Airtable writes require batches of 1 to 10 records.");
    }
  }

  private async writeRecords<TFields extends AirtableFields>(
    tableIdOrName: string,
    body: unknown,
    method: "PATCH" | "POST" = "POST",
  ): Promise<AirtableRecord<TFields>[]> {
    const response = await this.request(
      `/v0/${encodeURIComponent(this.baseId)}/${encodeURIComponent(tableIdOrName)}`,
      { body, method, operation: "write records", retryMode: "write" },
    );
    const parsed = recordsResponseSchema.safeParse(response.value);

    if (!parsed.success) {
      throw new AirtableAmbiguousWriteError({
        code: "invalid_success_response",
        status: response.status,
      });
    }

    return parsed.data.records as AirtableRecord<TFields>[];
  }

  private async request(
    path: string,
    options: AirtableRequestOptions,
  ): Promise<AirtableResponsePayload> {
    const url = new URL(path, this.apiUrl);
    if (options.query) {
      url.search = options.query.toString();
    }
    const retryMode = options.retryMode ?? "read";

    for (let attempt = 1; attempt <= this.maximumAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.rateLimiter.schedule(() => {
          const request: RequestInit = {
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${this.token}`,
              ...(options.body === undefined
                ? {}
                : { "Content-Type": "application/json" }),
            },
            method: options.method ?? "GET",
            signal: this.createTimeoutSignal(this.requestTimeoutMilliseconds),
            ...(options.body === undefined
              ? {}
              : { body: JSON.stringify(options.body) }),
          };
          return this.fetcher(url, request);
        });
      } catch {
        if (retryMode === "write") {
          throw new AirtableAmbiguousWriteError({
            code: "network_error",
            status: 0,
          });
        }
        const error = new AirtableError({
          code: "network_error",
          retryable: true,
          status: 0,
        });
        if (attempt === this.maximumAttempts) {
          throw error;
        }
        const delay = Math.min(5_000, 250 * 2 ** (attempt - 1));
        await this.rateLimiter.pause(delay);
        continue;
      }

      const value = await response.json().catch(() => null);

      if (response.ok) {
        return { status: response.status, value };
      }

      const retryable = retryableStatuses.has(response.status);
      const error = new AirtableError({
        code: getProviderCode(value, response.status),
        requestId:
          response.headers.get("x-request-id") ??
          response.headers.get("x-airtable-request-id") ??
          undefined,
        retryable,
        status: response.status,
      });

      const canRetry =
        response.status === 429 ||
        (retryMode === "read" && retryableStatuses.has(response.status));
      if (retryMode === "write" && response.status >= 500) {
        throw new AirtableAmbiguousWriteError({
          code: error.code,
          requestId: error.requestId,
          status: error.status,
        });
      }
      if (!canRetry || attempt === this.maximumAttempts) {
        throw error;
      }

      const retryAfter = parseRetryAfter(
        response.headers.get("retry-after"),
        this.clock.now(),
      );
      const baseDelay =
        response.status === 429
          ? Math.max(30_000, retryAfter ?? 0)
          : (retryAfter ?? Math.min(5_000, 250 * 2 ** (attempt - 1)));
      const jitter = Math.floor(
        Math.min(1_000, baseDelay * 0.1) * this.random(),
      );
      await this.rateLimiter.pause(baseDelay + jitter);
    }

    throw new AirtableResponseError(options.operation);
  }
}
