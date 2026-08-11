import {
  publicScheduleProjectionSchema,
  type PublicScheduleProjection,
} from "@sessionbox-killer/contracts";

import type { PublicScheduleReadResult } from "./projection.js";

export const PUBLIC_SCHEDULE_BROWSER_CACHE_CONTROL =
  "public, max-age=0, must-revalidate";
export const PUBLIC_SCHEDULE_EDGE_CACHE_CONTROL =
  "public, max-age=60, stale-while-revalidate=300, stale-if-error=900";

export interface PublicScheduleCacheInvalidationMessageV1 {
  event_id: string;
  kind: "public_schedule.cache.invalidate";
  version: 1;
}

export interface PublicScheduleCacheInvalidationMessageV2 {
  event_id: string;
  invalidation_version: number;
  kind: "public_schedule.cache.invalidate";
  organization_id: string;
  version: 2;
}

export interface PublicScheduleCacheInvalidationMessageV3 {
  event_id: string;
  invalidation_version: number;
  kind: "public_schedule.cache.invalidate";
  organization_id: string;
  publication_version: number;
  surfaces: readonly ["schedule", "gallery", "feed"];
  version: 3;
}

export type PublicScheduleCacheInvalidationMessage =
  | PublicScheduleCacheInvalidationMessageV1
  | PublicScheduleCacheInvalidationMessageV2
  | PublicScheduleCacheInvalidationMessageV3;

export function isPublicScheduleCacheInvalidationMessage(
  value: unknown,
): value is PublicScheduleCacheInvalidationMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "public_schedule.cache.invalidate" &&
    "event_id" in value &&
    typeof value.event_id === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.event_id) &&
    "version" in value &&
    (value.version === 1 ||
      ((value.version === 2 || value.version === 3) &&
        "organization_id" in value &&
        typeof value.organization_id === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.organization_id) &&
        "invalidation_version" in value &&
        typeof value.invalidation_version === "number" &&
        Number.isSafeInteger(value.invalidation_version) &&
        value.invalidation_version > 0 &&
        (value.version === 2 ||
          ("publication_version" in value &&
            typeof value.publication_version === "number" &&
            Number.isSafeInteger(value.publication_version) &&
            value.publication_version > 0 &&
            "surfaces" in value &&
            Array.isArray(value.surfaces) &&
            value.surfaces.length === 3 &&
            value.surfaces[0] === "schedule" &&
            value.surfaces[1] === "gallery" &&
            value.surfaces[2] === "feed"))))
  );
}

export async function markPublicScheduleInvalidationProcessed(
  database: D1Database,
  message:
    | PublicScheduleCacheInvalidationMessageV2
    | PublicScheduleCacheInvalidationMessageV3,
): Promise<boolean> {
  const now = new Date().toISOString();
  const completed = await database
    .prepare(
      `UPDATE authority_cache_invalidations
       SET status = 'processed', processed_at = ?, updated_at = ?,
           last_error_code = NULL
       WHERE organization_id = ? AND event_id = ?
         AND invalidation_version = ?
         AND status IN ('pending', 'published', 'enqueued')`,
    )
    .bind(
      now,
      now,
      message.organization_id,
      message.event_id,
      message.invalidation_version,
    )
    .run();
  return completed.meta.changes === 1;
}

export async function processPublicScheduleCacheInvalidation(
  executionContext: ExecutionContext,
  environment: Pick<Env, "APP_ENV" | "DB">,
  message: PublicScheduleCacheInvalidationMessage,
): Promise<void> {
  const purged = await purgePublicScheduleCache(
    executionContext,
    message.event_id,
  );
  if (!purged && environment.APP_ENV !== "local") {
    throw new Error("Worker cache invalidation is unavailable.");
  }
  if (message.version === 2 || message.version === 3) {
    await markPublicScheduleInvalidationProcessed(environment.DB, message);
  }
}

function eventCacheTag(eventId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(eventId)) {
    throw new Error("Event ID cannot be represented as a safe cache tag.");
  }
  return `event-${eventId}`;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function projectionEntityTag(
  projection: PublicScheduleProjection,
): Promise<{ body: string; etag: string }> {
  const body = JSON.stringify(publicScheduleProjectionSchema.parse(projection));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body),
  );
  return { body, etag: `"${bytesToHex(digest)}"` };
}

function weakEntityTag(value: string): string {
  return value.startsWith("W/") ? value.slice(2) : value;
}

export function ifNoneMatchIncludes(
  headerValue: string | null,
  entityTag: string,
): boolean {
  if (!headerValue) {
    return false;
  }
  return headerValue
    .split(",")
    .map((value) => value.trim())
    .some(
      (candidate) =>
        candidate === "*" || weakEntityTag(candidate) === entityTag,
    );
}

function projectionHeaders(eventId: string, etag: string): Headers {
  return new Headers({
    "Cache-Control": PUBLIC_SCHEDULE_BROWSER_CACHE_CONTROL,
    "Cache-Tag": `public-schedule,${eventCacheTag(eventId)}`,
    "Cloudflare-CDN-Cache-Control": PUBLIC_SCHEDULE_EDGE_CACHE_CONTROL,
    "Content-Type": "application/json; charset=utf-8",
    ETag: etag,
  });
}

export async function publicScheduleResponse(
  request: Request,
  result: PublicScheduleReadResult,
): Promise<Response> {
  const { body, etag } = await projectionEntityTag(result.projection);
  const headers = projectionHeaders(result.eventId, etag);
  if (ifNoneMatchIncludes(request.headers.get("If-None-Match"), etag)) {
    headers.delete("Content-Type");
    return new Response(null, { headers, status: 304 });
  }
  return new Response(body, { headers, status: 200 });
}

export async function purgePublicScheduleCache(
  executionContext: Pick<ExecutionContext, "cache">,
  eventId: string,
): Promise<boolean> {
  if (!executionContext.cache) {
    return false;
  }
  const result = await executionContext.cache.purge({
    tags: [eventCacheTag(eventId)],
  });
  if (!result.success) {
    throw new Error("Cloudflare rejected public schedule cache invalidation.");
  }
  return true;
}
