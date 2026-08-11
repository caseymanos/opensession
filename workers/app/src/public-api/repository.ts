import {
  publicApiEventListSchema,
  publicApiEventSchema,
  publicApiExportRunListSchema,
  publicApiExportRunSchema,
  publicApiScheduleSchema,
  publicApiSessionListSchema,
  publicApiSessionSchema,
  publicApiSpeakerListSchema,
  publicApiSpeakerSchema,
  publicApiSubmissionListSchema,
  publicApiSubmissionSchema,
  publicApiTaskListSchema,
  publicApiTaskSchema,
  type PublicApiEvent,
  type PublicApiExportRun,
  type PublicApiPaginationQuery,
  type PublicApiSession,
  type PublicApiSpeaker,
  type PublicApiSubmission,
  type PublicApiTask,
} from "@sessionbox-killer/contracts/public-api";

import { constantTimeEqual, fingerprint, sha256Hex } from "../auth/crypto.js";
import { D1PublicScheduleProjectionReader } from "../public-schedule/projection.js";
import {
  taskAssignmentFromRow,
  type TaskAssignmentRow,
} from "../tasks/model.js";
import type { AuthenticatedApiKey } from "./key-service.js";

interface CursorPayload {
  id: string;
  resource: string;
  scope: string;
  sort: string;
  v: 1;
}

interface EventRow {
  ends_at: string | null;
  id: string;
  name: string;
  slug: string;
  source_version: number;
  starts_at: string | null;
  status: PublicApiEvent["status"];
  timezone: string;
  updated_at: string;
  venue: string | null;
}

interface SubmissionRow {
  friendly_id: string;
  id: string;
  source_version: number;
  status: PublicApiSubmission["status"];
  submitted_at: string | null;
  title: string;
  track_id: string | null;
  updated_at: string;
}

interface SessionRow {
  abstract: string | null;
  duration_minutes: number | null;
  format_id: string | null;
  friendly_id: string;
  id: string;
  is_public: number;
  source_version: number;
  status: PublicApiSession["status"];
  title: string;
  track_id: string | null;
  updated_at: string;
}

interface SpeakerRow {
  bio: string | null;
  company: string | null;
  display_name: string;
  id: string;
  overdue_count: number;
  required_complete: number;
  required_total: number;
  speaker_ready: number;
  title: string | null;
  updated_at: string;
}

interface TaskRow extends TaskAssignmentRow {
  definition_name: string;
  definition_type: "ack" | "file" | "form" | "link";
  updated_at: string;
}

interface ExportRunRow {
  counts_json: string;
  created_at: string;
  error_code: string | null;
  finished_at: string | null;
  id: string;
  mode: PublicApiExportRun["mode"];
  provider: string;
  started_at: string | null;
  status: PublicApiExportRun["status"];
}

interface SortableRow {
  id: string;
  updated_at?: string;
}

const cursorNamespace = "opensession.public-api-cursor.v1";
const cursorSignaturePattern = /^[0-9a-f]{64}$/;

export class PublicApiCursorError extends Error {
  constructor() {
    super("The pagination cursor is invalid for this resource and scope.");
    this.name = "PublicApiCursorError";
  }
}

function bytesToBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlToString(value: string): string {
  const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat((4 - (value.length % 4)) % 4)}`;
  const binary = atob(padded);
  return new TextDecoder().decode(
    Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0),
  );
}

function isCursorPayload(value: unknown): value is CursorPayload {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "v" in value &&
    value.v === 1 &&
    "resource" in value &&
    typeof value.resource === "string" &&
    "scope" in value &&
    typeof value.scope === "string" &&
    "sort" in value &&
    typeof value.sort === "string" &&
    "id" in value &&
    typeof value.id === "string"
  );
}

async function decodeCursor(
  value: string | undefined,
  resource: string,
  scope: string,
  hashPepper: string,
): Promise<CursorPayload | null> {
  if (!value) return null;
  try {
    const [encoded, signature, ...remainder] = value.split(".");
    if (
      !encoded ||
      !signature ||
      remainder.length > 0 ||
      !cursorSignaturePattern.test(signature)
    ) {
      throw new PublicApiCursorError();
    }
    const expected = await fingerprint(encoded, hashPepper, cursorNamespace);
    if (!constantTimeEqual(signature, expected)) {
      throw new PublicApiCursorError();
    }
    const parsed: unknown = JSON.parse(base64UrlToString(encoded));
    if (
      !isCursorPayload(parsed) ||
      parsed.resource !== resource ||
      parsed.scope !== scope
    ) {
      throw new PublicApiCursorError();
    }
    return parsed;
  } catch (error) {
    if (error instanceof PublicApiCursorError) throw error;
    throw new PublicApiCursorError();
  }
}

async function encodeCursor(
  resource: string,
  scope: string,
  sort: string,
  id: string,
  hashPepper: string,
): Promise<string> {
  const encoded = bytesToBase64Url(
    JSON.stringify({ id, resource, scope, sort, v: 1 }),
  );
  const signature = await fingerprint(encoded, hashPepper, cursorNamespace);
  return `${encoded}.${signature}`;
}

async function listPage<T extends SortableRow, R>(
  rows: readonly T[],
  query: PublicApiPaginationQuery,
  resource: string,
  scope: string,
  map: (row: T) => R,
  sort: (row: T) => string,
  hashPepper: string,
): Promise<{
  data: R[];
  page: { limit: number; next_cursor: string | null };
}> {
  const hasNext = rows.length > query.limit;
  const selected = rows.slice(0, query.limit);
  const last = selected.at(-1);
  return {
    data: selected.map(map),
    page: {
      limit: query.limit,
      next_cursor:
        hasNext && last
          ? await encodeCursor(resource, scope, sort(last), last.id, hashPepper)
          : null,
    },
  };
}

function eventView(row: EventRow): PublicApiEvent {
  return publicApiEventSchema.parse({
    ends_at: row.ends_at,
    id: row.id,
    name: row.name,
    slug: row.slug,
    starts_at: row.starts_at,
    status: row.status,
    timezone: row.timezone,
    updated_at: row.updated_at,
    venue: row.venue,
    version: row.source_version,
  });
}

function submissionView(row: SubmissionRow): PublicApiSubmission {
  return publicApiSubmissionSchema.parse({
    id: row.id,
    reference: row.friendly_id,
    status: row.status,
    submitted_at: row.submitted_at,
    title: row.title,
    track_id: row.track_id,
    updated_at: row.updated_at,
    version: row.source_version,
  });
}

function sessionView(row: SessionRow): PublicApiSession {
  return publicApiSessionSchema.parse({
    abstract: row.abstract,
    duration_minutes: row.duration_minutes,
    format_id: row.format_id,
    id: row.id,
    is_public: row.is_public === 1,
    reference: row.friendly_id,
    status: row.status,
    title: row.title,
    track_id: row.track_id,
    updated_at: row.updated_at,
    version: row.source_version,
  });
}

function speakerView(row: SpeakerRow): PublicApiSpeaker {
  return publicApiSpeakerSchema.parse({
    bio: row.bio,
    company: row.company,
    display_name: row.display_name,
    id: row.id,
    readiness: {
      overdue: row.overdue_count,
      ready: row.speaker_ready === 1,
      required_complete: row.required_complete,
      required_total: row.required_total,
    },
    title: row.title,
    updated_at: row.updated_at,
  });
}

function taskView(row: TaskRow): PublicApiTask {
  const assignment = taskAssignmentFromRow(row);
  return publicApiTaskSchema.parse({
    contact_id: row.contact_id,
    definition: {
      id: row.definition_id,
      name: row.definition_name,
      type: row.definition_type,
    },
    due_at: row.due_at,
    id: row.id,
    required: row.required === 1,
    session_id: row.session_id,
    state: assignment.state,
    updated_at: row.updated_at,
    version: assignment.version,
  });
}

function exportRunView(row: ExportRunRow): PublicApiExportRun {
  let counts: unknown;
  try {
    counts = JSON.parse(row.counts_json) as unknown;
  } catch {
    throw new Error("Export run count storage is invalid.");
  }
  return publicApiExportRunSchema.parse({
    counts,
    created_at: row.created_at,
    error_code: row.error_code,
    finished_at: row.finished_at,
    id: row.id,
    mode: row.mode,
    provider: row.provider,
    started_at: row.started_at,
    status: row.status,
  });
}

function scopeKey(key: AuthenticatedApiKey, eventId = "*"): string {
  return `${key.organizationId}:${key.eventId ?? eventId}`;
}

export function resourceEntityTag(resource: string, version: number): string {
  return `"opensession-${resource}-v${version}"`;
}

export class PublicApiRepository {
  readonly #database: D1Database;
  readonly #hashPepper: string;

  constructor(database: D1Database, hashPepper: string) {
    if (hashPepper.length < 32) {
      throw new Error("AUTH_HASH_PEPPER must contain at least 32 characters.");
    }
    this.#database = database;
    this.#hashPepper = hashPepper;
  }

  async listEvents(key: AuthenticatedApiKey, query: PublicApiPaginationQuery) {
    const scope = scopeKey(key);
    const cursor = await decodeCursor(
      query.cursor,
      "events",
      scope,
      this.#hashPepper,
    );
    const result = await this.#database
      .prepare(
        `SELECT event.id, event.name, event.slug, event.timezone,
                event.starts_at, event.ends_at, event.venue, event.status,
                event.source_version,
                COALESCE(event.source_changed_at, event.projected_at) AS updated_at
         FROM p_events AS event
         JOIN tenant_registry AS tenant
           ON tenant.organization_id = event.organization_id
          AND tenant.status = 'active'
          AND tenant.authority_ready_at IS NOT NULL
         WHERE event.organization_id = ?1
           AND (?2 IS NULL OR event.id = ?2)
           AND event.source_deleted_at IS NULL
           AND (
             ?3 IS NULL OR
             COALESCE(event.source_changed_at, event.projected_at) < ?3 OR
             (COALESCE(event.source_changed_at, event.projected_at) = ?3
               AND event.id < ?4)
           )
         ORDER BY updated_at DESC, event.id DESC LIMIT ?5`,
      )
      .bind(
        key.organizationId,
        key.eventId,
        cursor?.sort ?? null,
        cursor?.id ?? null,
        query.limit + 1,
      )
      .all<EventRow>();
    return publicApiEventListSchema.parse(
      await listPage(
        result.results,
        query,
        "events",
        scope,
        eventView,
        (row) => row.updated_at,
        this.#hashPepper,
      ),
    );
  }

  async event(
    key: AuthenticatedApiKey,
    eventId: string,
  ): Promise<PublicApiEvent | null> {
    const row = await this.#database
      .prepare(
        `SELECT event.id, event.name, event.slug, event.timezone,
                event.starts_at, event.ends_at, event.venue, event.status,
                event.source_version,
                COALESCE(event.source_changed_at, event.projected_at) AS updated_at
         FROM p_events AS event
         JOIN tenant_registry AS tenant
           ON tenant.organization_id = event.organization_id
          AND tenant.status = 'active'
          AND tenant.authority_ready_at IS NOT NULL
         WHERE event.organization_id = ?1 AND event.id = ?2
           AND event.source_deleted_at IS NULL LIMIT 1`,
      )
      .bind(key.organizationId, eventId)
      .first<EventRow>();
    return row ? eventView(row) : null;
  }

  async listSubmissions(
    key: AuthenticatedApiKey,
    eventId: string,
    query: PublicApiPaginationQuery,
  ) {
    const scope = scopeKey(key, eventId);
    const cursor = await decodeCursor(
      query.cursor,
      "submissions",
      scope,
      this.#hashPepper,
    );
    const result = await this.#database
      .prepare(
        `SELECT id, friendly_id, title, status, track_id, submitted_at,
                updated_at, source_version
         FROM p_submissions
         WHERE organization_id = ?1 AND event_id = ?2
           AND source_deleted_at IS NULL
           AND (
             ?3 IS NULL OR updated_at < ?3 OR
             (updated_at = ?3 AND id < ?4)
           )
         ORDER BY updated_at DESC, id DESC LIMIT ?5`,
      )
      .bind(
        key.organizationId,
        eventId,
        cursor?.sort ?? null,
        cursor?.id ?? null,
        query.limit + 1,
      )
      .all<SubmissionRow>();
    return publicApiSubmissionListSchema.parse(
      await listPage(
        result.results,
        query,
        "submissions",
        scope,
        submissionView,
        (row) => row.updated_at,
        this.#hashPepper,
      ),
    );
  }

  async submission(
    key: AuthenticatedApiKey,
    eventId: string,
    submissionId: string,
  ): Promise<PublicApiSubmission | null> {
    const row = await this.#database
      .prepare(
        `SELECT id, friendly_id, title, status, track_id, submitted_at,
                updated_at, source_version
         FROM p_submissions
         WHERE organization_id = ?1 AND event_id = ?2 AND id = ?3
           AND source_deleted_at IS NULL LIMIT 1`,
      )
      .bind(key.organizationId, eventId, submissionId)
      .first<SubmissionRow>();
    return row ? submissionView(row) : null;
  }

  async listSessions(
    key: AuthenticatedApiKey,
    eventId: string,
    query: PublicApiPaginationQuery,
  ) {
    const scope = scopeKey(key, eventId);
    const cursor = await decodeCursor(
      query.cursor,
      "sessions",
      scope,
      this.#hashPepper,
    );
    const result = await this.#database
      .prepare(
        `SELECT id, friendly_id, title, abstract, status, track_id, format_id,
                duration_minutes, is_public, updated_at, source_version
         FROM p_sessions
         WHERE organization_id = ?1 AND event_id = ?2
           AND source_deleted_at IS NULL
           AND (
             ?3 IS NULL OR updated_at < ?3 OR
             (updated_at = ?3 AND id < ?4)
           )
         ORDER BY updated_at DESC, id DESC LIMIT ?5`,
      )
      .bind(
        key.organizationId,
        eventId,
        cursor?.sort ?? null,
        cursor?.id ?? null,
        query.limit + 1,
      )
      .all<SessionRow>();
    return publicApiSessionListSchema.parse(
      await listPage(
        result.results,
        query,
        "sessions",
        scope,
        sessionView,
        (row) => row.updated_at,
        this.#hashPepper,
      ),
    );
  }

  async session(
    key: AuthenticatedApiKey,
    eventId: string,
    sessionId: string,
  ): Promise<PublicApiSession | null> {
    const row = await this.#database
      .prepare(
        `SELECT id, friendly_id, title, abstract, status, track_id, format_id,
                duration_minutes, is_public, updated_at, source_version
         FROM p_sessions
         WHERE organization_id = ?1 AND event_id = ?2 AND id = ?3
           AND source_deleted_at IS NULL LIMIT 1`,
      )
      .bind(key.organizationId, eventId, sessionId)
      .first<SessionRow>();
    return row ? sessionView(row) : null;
  }

  async listSpeakers(
    key: AuthenticatedApiKey,
    eventId: string,
    query: PublicApiPaginationQuery,
  ) {
    const scope = scopeKey(key, eventId);
    const cursor = await decodeCursor(
      query.cursor,
      "speakers",
      scope,
      this.#hashPepper,
    );
    const result = await this.#database
      .prepare(
        `SELECT contact.id, contact.display_name, contact.title,
                contact.company, contact.bio,
                event_contact.required_total, event_contact.required_complete,
                event_contact.overdue_count, event_contact.speaker_ready,
                MAX(contact.projected_at, event_contact.projected_at) AS updated_at
         FROM p_event_contacts AS event_contact
         JOIN p_contacts AS contact
           ON contact.organization_id = event_contact.organization_id
          AND contact.id = event_contact.contact_id
          AND contact.source_deleted_at IS NULL
         WHERE event_contact.organization_id = ?1
           AND event_contact.event_id = ?2
           AND event_contact.source_deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM json_each(event_contact.roles_json)
             WHERE json_each.value = 'speaker'
           )
           AND (
             ?3 IS NULL OR
             MAX(contact.projected_at, event_contact.projected_at) < ?3 OR
             (MAX(contact.projected_at, event_contact.projected_at) = ?3
               AND contact.id < ?4)
           )
         ORDER BY updated_at DESC, contact.id DESC LIMIT ?5`,
      )
      .bind(
        key.organizationId,
        eventId,
        cursor?.sort ?? null,
        cursor?.id ?? null,
        query.limit + 1,
      )
      .all<SpeakerRow>();
    return publicApiSpeakerListSchema.parse(
      await listPage(
        result.results,
        query,
        "speakers",
        scope,
        speakerView,
        (row) => row.updated_at,
        this.#hashPepper,
      ),
    );
  }

  async speaker(
    key: AuthenticatedApiKey,
    eventId: string,
    speakerId: string,
  ): Promise<PublicApiSpeaker | null> {
    const row = await this.#database
      .prepare(
        `SELECT contact.id, contact.display_name, contact.title,
                contact.company, contact.bio,
                event_contact.required_total, event_contact.required_complete,
                event_contact.overdue_count, event_contact.speaker_ready,
                MAX(contact.projected_at, event_contact.projected_at) AS updated_at
         FROM p_event_contacts AS event_contact
         JOIN p_contacts AS contact
           ON contact.organization_id = event_contact.organization_id
          AND contact.id = event_contact.contact_id
          AND contact.source_deleted_at IS NULL
         WHERE event_contact.organization_id = ?1
           AND event_contact.event_id = ?2 AND contact.id = ?3
           AND event_contact.source_deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM json_each(event_contact.roles_json)
             WHERE json_each.value = 'speaker'
           ) LIMIT 1`,
      )
      .bind(key.organizationId, eventId, speakerId)
      .first<SpeakerRow>();
    return row ? speakerView(row) : null;
  }

  async listTasks(
    key: AuthenticatedApiKey,
    eventId: string,
    query: PublicApiPaginationQuery,
  ) {
    const scope = scopeKey(key, eventId);
    const cursor = await decodeCursor(
      query.cursor,
      "tasks",
      scope,
      this.#hashPepper,
    );
    const result = await this.#database
      .prepare(
        `SELECT assignment.id, assignment.event_id,
                assignment.definition_id, assignment.contact_id,
                assignment.session_id, assignment.due_at,
                assignment.required, assignment.status,
                assignment.completed_at, assignment.approved_at,
                assignment.response_json, assignment.source_record_id,
                assignment.source_version, assignment.updated_at,
                definition.name AS definition_name,
                definition.type AS definition_type,
                definition.approval_required
         FROM p_task_assignments AS assignment
         JOIN p_task_definitions AS definition
           ON definition.organization_id = assignment.organization_id
          AND definition.event_id = assignment.event_id
          AND definition.id = assignment.definition_id
          AND definition.source_deleted_at IS NULL
         WHERE assignment.organization_id = ?1
           AND assignment.event_id = ?2
           AND assignment.source_deleted_at IS NULL
           AND (
             ?3 IS NULL OR assignment.updated_at < ?3 OR
             (assignment.updated_at = ?3 AND assignment.id < ?4)
           )
         ORDER BY assignment.updated_at DESC, assignment.id DESC LIMIT ?5`,
      )
      .bind(
        key.organizationId,
        eventId,
        cursor?.sort ?? null,
        cursor?.id ?? null,
        query.limit + 1,
      )
      .all<TaskRow>();
    return publicApiTaskListSchema.parse(
      await listPage(
        result.results,
        query,
        "tasks",
        scope,
        taskView,
        (row) => row.updated_at,
        this.#hashPepper,
      ),
    );
  }

  async task(
    key: AuthenticatedApiKey,
    eventId: string,
    taskId: string,
  ): Promise<PublicApiTask | null> {
    const row = await this.#database
      .prepare(
        `SELECT assignment.id, assignment.event_id,
                assignment.definition_id, assignment.contact_id,
                assignment.session_id, assignment.due_at,
                assignment.required, assignment.status,
                assignment.completed_at, assignment.approved_at,
                assignment.response_json, assignment.source_record_id,
                assignment.source_version, assignment.updated_at,
                definition.name AS definition_name,
                definition.type AS definition_type,
                definition.approval_required
         FROM p_task_assignments AS assignment
         JOIN p_task_definitions AS definition
           ON definition.organization_id = assignment.organization_id
          AND definition.event_id = assignment.event_id
          AND definition.id = assignment.definition_id
          AND definition.source_deleted_at IS NULL
         WHERE assignment.organization_id = ?1
           AND assignment.event_id = ?2 AND assignment.id = ?3
           AND assignment.source_deleted_at IS NULL LIMIT 1`,
      )
      .bind(key.organizationId, eventId, taskId)
      .first<TaskRow>();
    return row ? taskView(row) : null;
  }

  async schedule(key: AuthenticatedApiKey, eventId: string) {
    const event = await this.event(key, eventId);
    if (!event) return null;
    const result = await new D1PublicScheduleProjectionReader(
      this.#database,
    ).readLiveByEventId(eventId);
    if (!result) return null;
    const data = publicApiScheduleSchema.parse({ data: result.projection });
    const etag = `"${await sha256Hex(JSON.stringify(data.data))}"`;
    return { data, etag };
  }

  async listExportRuns(
    key: AuthenticatedApiKey,
    eventId: string,
    query: PublicApiPaginationQuery,
  ) {
    const scope = scopeKey(key, eventId);
    const cursor = await decodeCursor(
      query.cursor,
      "export-runs",
      scope,
      this.#hashPepper,
    );
    const result = await this.#database
      .prepare(
        `SELECT id, provider, mode, status, counts_json, created_at,
                started_at, finished_at, error_code
         FROM integration_runs
         WHERE organization_id = ?1 AND event_id = ?2
           AND (
             ?3 IS NULL OR created_at < ?3 OR
             (created_at = ?3 AND id < ?4)
           )
         ORDER BY created_at DESC, id DESC LIMIT ?5`,
      )
      .bind(
        key.organizationId,
        eventId,
        cursor?.sort ?? null,
        cursor?.id ?? null,
        query.limit + 1,
      )
      .all<ExportRunRow>();
    return publicApiExportRunListSchema.parse(
      await listPage(
        result.results,
        query,
        "export-runs",
        scope,
        exportRunView,
        (row) => row.created_at,
        this.#hashPepper,
      ),
    );
  }

  async exportRun(
    key: AuthenticatedApiKey,
    eventId: string,
    runId: string,
  ): Promise<PublicApiExportRun | null> {
    const row = await this.#database
      .prepare(
        `SELECT id, provider, mode, status, counts_json, created_at,
                started_at, finished_at, error_code
         FROM integration_runs
         WHERE organization_id = ?1 AND event_id = ?2 AND id = ?3 LIMIT 1`,
      )
      .bind(key.organizationId, eventId, runId)
      .first<ExportRunRow>();
    return row ? exportRunView(row) : null;
  }
}
