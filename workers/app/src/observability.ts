import type { D1QueryExecutor } from "./database.js";

export type OperationalLogLevel = "error" | "info" | "warn";
export type OperationalOutcome =
  "accepted" | "client_error" | "failure" | "server_error" | "success";

export interface OperationalLogFields {
  readonly attempt?: number;
  readonly cache_status?: "bypass" | "hit" | "miss";
  readonly command_id?: string;
  readonly delivery_id?: string;
  readonly duration_ms?: number;
  readonly error_type?: string;
  readonly event: string;
  readonly event_id?: string;
  readonly job_id?: string;
  readonly method?: string;
  readonly organization_id?: string;
  readonly outcome: OperationalOutcome;
  readonly projection_lag_ms?: number;
  readonly queue?: string;
  readonly queue_age_ms?: number;
  readonly request_id?: string;
  readonly route?: string;
  readonly status?: number;
  readonly version_id?: string;
}

export interface DurableOperationalEventFields extends OperationalLogFields {
  readonly dedupe_key: string;
  readonly occurred_at?: string;
}

interface OperationalLog extends OperationalLogFields {
  readonly environment: Env["APP_ENV"];
  readonly level: OperationalLogLevel;
  readonly service: "sessionbox-killer";
  readonly timestamp: string;
}

type OperationalLogEnvironment = Pick<Env, "APP_ENV"> &
  Partial<Pick<Env, "OBSERVABILITY">>;

const durableRetentionMilliseconds = 30 * 24 * 60 * 60 * 1_000;
const expiredEventBatchSize = 100;
const eventTypePattern = /^[a-z][a-z0-9._-]{2,127}$/;
const dedupeKeyPattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{2,254}$/;
const stableIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const errorCodePattern = /^[A-Za-z][A-Za-z0-9._-]{0,79}$/;
const queuePattern = /^[a-z][a-z0-9_-]{2,63}$/;
const routeTemplatePattern = /^(?:unmatched|\/[A-Za-z0-9_:/.*-]+)$/;
const methods = new Set([
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
]);

function assertPattern(
  value: string | undefined,
  pattern: RegExp,
  label: string,
): void {
  if (value !== undefined && !pattern.test(value)) {
    throw new TypeError(`${label} is not safe for operational telemetry.`);
  }
}

function assertNonNegative(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new TypeError(`${label} must be a finite non-negative number.`);
  }
}

function assertDurableEvent(fields: DurableOperationalEventFields): void {
  assertPattern(fields.dedupe_key, dedupeKeyPattern, "Dedupe key");
  assertPattern(fields.event, eventTypePattern, "Event type");
  assertPattern(fields.organization_id, stableIdPattern, "Organization ID");
  assertPattern(fields.event_id, stableIdPattern, "Event ID");
  assertPattern(fields.request_id, stableIdPattern, "Request ID");
  assertPattern(fields.job_id, stableIdPattern, "Job ID");
  assertPattern(fields.delivery_id, stableIdPattern, "Delivery ID");
  assertPattern(fields.command_id, stableIdPattern, "Command ID");
  assertPattern(fields.queue, queuePattern, "Queue name");
  assertPattern(fields.error_type, errorCodePattern, "Error code");
  assertPattern(fields.route, routeTemplatePattern, "Route template");
  assertNonNegative(fields.duration_ms, "Duration");
  assertNonNegative(fields.projection_lag_ms, "Projection lag");
  assertNonNegative(fields.queue_age_ms, "Queue age");

  if (
    fields.attempt !== undefined &&
    (!Number.isInteger(fields.attempt) || fields.attempt < 0)
  ) {
    throw new TypeError("Attempt count must be a non-negative integer.");
  }

  if (fields.method !== undefined && !methods.has(fields.method)) {
    throw new TypeError("HTTP method is not safe for operational telemetry.");
  }
  if (
    fields.status !== undefined &&
    (!Number.isInteger(fields.status) ||
      fields.status < 100 ||
      fields.status > 599)
  ) {
    throw new TypeError("HTTP status is not valid for operational telemetry.");
  }
  if (
    !fields.request_id &&
    !fields.job_id &&
    !fields.delivery_id &&
    !fields.command_id &&
    !fields.event_id
  ) {
    throw new TypeError(
      "Durable operational telemetry requires a correlation identifier.",
    );
  }
}

export function durableOperationalEventStatement(
  database: D1QueryExecutor,
  fields: DurableOperationalEventFields,
  now = new Date(),
): D1PreparedStatement {
  assertDurableEvent(fields);
  const occurredAt = fields.occurred_at ?? now.toISOString();
  if (!occurredAt.endsWith("Z") || !Number.isFinite(Date.parse(occurredAt))) {
    throw new TypeError("Operational event timestamp must be UTC.");
  }
  const expiresAt = new Date(
    Date.parse(occurredAt) + durableRetentionMilliseconds,
  ).toISOString();

  return database
    .prepare(
      `INSERT INTO operational_events (
         dedupe_key, event_type, level, outcome, organization_id, event_id,
         request_id, job_id, delivery_id, command_id, route, method,
         response_status, duration_ms, attempt_count, queue_name, cache_status,
         error_code, projection_lag_ms, queue_age_ms, occurred_at, expires_at
       ) VALUES (
         ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
         ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22
       )
       ON CONFLICT (dedupe_key) DO NOTHING`,
    )
    .bind(
      fields.dedupe_key,
      fields.event,
      fields.status !== undefined && fields.status >= 500
        ? "error"
        : fields.status !== undefined && fields.status >= 400
          ? "warn"
          : fields.outcome === "failure" || fields.outcome === "server_error"
            ? "error"
            : "info",
      fields.outcome,
      fields.organization_id ?? null,
      fields.event_id ?? null,
      fields.request_id ?? null,
      fields.job_id ?? null,
      fields.delivery_id ?? null,
      fields.command_id ?? null,
      fields.route ?? null,
      fields.method ?? null,
      fields.status ?? null,
      fields.duration_ms ?? null,
      fields.attempt ?? null,
      fields.queue ?? null,
      fields.cache_status ?? null,
      fields.error_type ?? null,
      fields.projection_lag_ms ?? null,
      fields.queue_age_ms ?? null,
      occurredAt,
      expiresAt,
    );
}

export function expiredOperationalEventsStatement(
  database: D1QueryExecutor,
  now = new Date(),
): D1PreparedStatement {
  return database
    .prepare(
      `DELETE FROM operational_events
       WHERE id IN (
         SELECT id FROM operational_events
         WHERE expires_at <= ?1
         ORDER BY expires_at, id
         LIMIT ${expiredEventBatchSize}
       )`,
    )
    .bind(now.toISOString());
}

export async function pruneExpiredOperationalEvents(
  database: D1QueryExecutor,
  now = new Date(),
  maxBatches = 10,
): Promise<number> {
  if (!Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > 100) {
    throw new TypeError("Operational retention batch count is invalid.");
  }

  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await expiredOperationalEventsStatement(database, now).run();
    const changes = result.meta.changes ?? 0;
    deleted += changes;
    if (changes < expiredEventBatchSize) {
      break;
    }
  }
  return deleted;
}

export function emitOperationalLog(
  level: OperationalLogLevel,
  environment: OperationalLogEnvironment,
  fields: OperationalLogFields,
): void {
  const entry: OperationalLog = {
    environment: environment.APP_ENV,
    level,
    service: "sessionbox-killer",
    timestamp: new Date().toISOString(),
    ...fields,
  };

  try {
    environment.OBSERVABILITY?.writeDataPoint({
      blobs: [
        JSON.stringify(entry),
        entry.service,
        entry.environment,
        entry.level,
        entry.event,
        entry.outcome,
        entry.request_id ?? "",
        entry.route ?? "",
        entry.method ?? "",
        entry.version_id ?? "",
        entry.job_id ?? "",
        entry.delivery_id ?? "",
        entry.command_id ?? "",
        entry.event_id ?? "",
        entry.queue ?? "",
        entry.cache_status ?? "",
        entry.error_type ?? "",
      ],
      doubles: [
        entry.status ?? 0,
        entry.duration_ms ?? 0,
        entry.attempt ?? 0,
        entry.projection_lag_ms ?? 0,
        entry.queue_age_ms ?? 0,
      ],
      indexes: [
        (
          entry.request_id ??
          entry.job_id ??
          entry.delivery_id ??
          entry.command_id ??
          entry.event_id ??
          entry.event
        ).slice(0, 96),
      ],
    });
  } catch {
    if (environment.APP_ENV === "local") {
      console.error({ event: "observability.write_failed" });
    }
  }

  if (environment.APP_ENV !== "local") {
    return;
  }

  if (level === "error") {
    console.error(entry);
  } else if (level === "warn") {
    console.warn(entry);
  } else {
    console.log(entry);
  }
}

export function requestOutcome(status: number): OperationalOutcome {
  if (status >= 500) {
    return "server_error";
  }

  if (status >= 400) {
    return "client_error";
  }

  return "success";
}

export function elapsedMilliseconds(
  occurredAt: string,
  observedAt = Date.now(),
): number {
  const timestamp = Date.parse(occurredAt);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError("Operational timestamp must be valid.");
  }
  return Math.max(0, observedAt - timestamp);
}

export function roundedDuration(
  startedAt: number,
  completedAt: number,
): number {
  return Math.max(0, Math.round((completedAt - startedAt) * 100) / 100);
}
