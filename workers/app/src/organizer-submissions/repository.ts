import {
  organizerSubmissionDetailSchema,
  organizerSubmissionListResponseSchema,
  organizerSubmissionStatusSchema,
  type OrganizerSubmissionDetail,
  type OrganizerSubmissionListQuery,
  type OrganizerSubmissionListResponse,
  type OrganizerSubmissionListRow,
  type OrganizerSubmissionProjection,
  type OrganizerSubmissionStatus,
} from "@sessionbox-killer/contracts";

import { allowedSubmissionCommands } from "./policy.js";

interface RepositoryScope {
  eventId: string;
  organizationId: string;
}

interface ListRow {
  aggregate_score: number | null;
  assigned_reviews: number;
  friendly_id: string;
  id: string;
  route_key: string | null;
  source_version: number;
  status: string;
  submitted_reviews: number;
  submitter_company: string | null;
  submitter_display_name: string;
  submitter_email: string;
  submitter_id: string;
  submitter_title: string | null;
  title: string;
  track_id: string | null;
  track_name: string | null;
  updated_at: string;
  default_reviewer_group_id: string | null;
}

interface CursorPayload {
  filters: {
    search: string | null;
    status: OrganizerSubmissionStatus | null;
    track: string | null;
  };
  id: string;
  updatedAt: string;
  version: 1;
}

interface ProjectionRow {
  as_of: string;
  authority_ready_at: string | null;
  full_scan_required: number | null;
  pending_repairs: number;
  watermark_count: number;
  webhook_status: string | null;
}

const listProjectionTables = [
  "contacts",
  "event_contacts",
  "reviews",
  "review_scores",
  "submissions",
  "tracks",
] as const;
const detailProjectionTables = [
  ...listProjectionTables,
  "criteria",
  "submission_answers",
  "submission_notes",
  "submission_participants",
] as const;

export class OrganizerSubmissionProjectionUnavailableError extends Error {
  constructor(message = "The organizer submission projection is unavailable.") {
    super(message);
    this.name = "OrganizerSubmissionProjectionUnavailableError";
  }
}

export class OrganizerSubmissionCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrganizerSubmissionCursorError";
  }
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string): string {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const normalized = padded.padEnd(Math.ceil(padded.length / 4) * 4, "=");
  const binary = atob(normalized);
  return new TextDecoder(undefined, { fatal: true }).decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  );
}

function cursorFilters(query: OrganizerSubmissionListQuery) {
  return {
    search: query.search ?? null,
    status: query.status ?? null,
    track: query.track ?? null,
  };
}

function parseCursor(
  value: string,
  query: OrganizerSubmissionListQuery,
): CursorPayload {
  try {
    const candidate = JSON.parse(
      decodeBase64Url(value),
    ) as Partial<CursorPayload>;
    if (
      candidate.version !== 1 ||
      typeof candidate.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(candidate.updatedAt)) ||
      typeof candidate.id !== "string" ||
      !candidate.filters ||
      JSON.stringify(candidate.filters) !== JSON.stringify(cursorFilters(query))
    ) {
      throw new Error("invalid");
    }
    return candidate as CursorPayload;
  } catch {
    throw new OrganizerSubmissionCursorError(
      "The pagination cursor is invalid for these filters.",
    );
  }
}

function serializeCursor(
  row: Pick<ListRow, "id" | "updated_at">,
  query: OrganizerSubmissionListQuery,
): string {
  return encodeBase64Url(
    JSON.stringify({
      filters: cursorFilters(query),
      id: row.id,
      updatedAt: row.updated_at,
      version: 1,
    } satisfies CursorPayload),
  );
}

function escapeLike(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

function status(value: string): OrganizerSubmissionStatus {
  return organizerSubmissionStatusSchema.parse(value);
}

function listRow(row: ListRow): OrganizerSubmissionListRow {
  return {
    id: row.id,
    lastActivityAt: row.updated_at,
    reference: row.friendly_id,
    reviews: {
      aggregateScore: row.aggregate_score,
      assigned: row.assigned_reviews,
      submitted: row.submitted_reviews,
    },
    routing: {
      reviewerGroupId: row.default_reviewer_group_id,
      routeKey: row.route_key,
    },
    status: status(row.status),
    submitter: {
      company: row.submitter_company,
      displayName: row.submitter_display_name,
      email: row.submitter_email,
      id: row.submitter_id,
      title: row.submitter_title,
    },
    title: row.title,
    track:
      row.track_id && row.track_name
        ? { id: row.track_id, name: row.track_name }
        : null,
    version: row.source_version,
  };
}

function parseAnswerValue(
  fieldType: string,
  encoded: string,
): { redacted: boolean; value: boolean | string | string[] | null } {
  if (fieldType === "file") return { redacted: true, value: null };
  try {
    const value = JSON.parse(encoded) as unknown;
    if (typeof value === "string" || typeof value === "boolean") {
      return { redacted: false, value };
    }
    if (
      Array.isArray(value) &&
      value.length <= 128 &&
      value.every((entry) => typeof entry === "string")
    ) {
      return { redacted: false, value };
    }
  } catch {
    throw new OrganizerSubmissionProjectionUnavailableError(
      "A submission answer contains invalid projected JSON.",
    );
  }
  return { redacted: true, value: null };
}

export class D1OrganizerSubmissionRepository {
  readonly #database: D1Database;

  constructor(database: D1Database) {
    this.#database = database;
  }

  async list(
    scope: RepositoryScope,
    query: OrganizerSubmissionListQuery,
  ): Promise<OrganizerSubmissionListResponse> {
    const bindings: unknown[] = [scope.organizationId, scope.eventId];
    const conditions = [
      "submission.organization_id = ?1",
      "submission.event_id = ?2",
      "submission.source_deleted_at IS NULL",
    ];
    if (query.search) {
      bindings.push(`%${escapeLike(query.search)}%`);
      const parameter = `?${bindings.length}`;
      conditions.push(`(
        submission.title LIKE ${parameter} ESCAPE '\\' COLLATE NOCASE OR
        submission.friendly_id LIKE ${parameter} ESCAPE '\\' COLLATE NOCASE OR
        submitter.display_name LIKE ${parameter} ESCAPE '\\' COLLATE NOCASE OR
        submitter.email_normalized LIKE ${parameter} ESCAPE '\\' COLLATE NOCASE
      )`);
    }
    if (query.status) {
      bindings.push(query.status);
      conditions.push(`submission.status = ?${bindings.length}`);
    }
    if (query.track) {
      bindings.push(query.track);
      conditions.push(`submission.track_id = ?${bindings.length}`);
    }
    if (query.cursor) {
      const cursor = parseCursor(query.cursor, query);
      bindings.push(cursor.updatedAt, cursor.id);
      conditions.push(`(
        submission.updated_at < ?${bindings.length - 1} OR
        (submission.updated_at = ?${bindings.length - 1} AND submission.id < ?${bindings.length})
      )`);
    }
    bindings.push(query.pageSize + 1);

    const rows = await this.#database
      .prepare(
        `WITH page AS (
           SELECT submission.id, submission.friendly_id, submission.title,
                  submission.status, submission.route_key,
                  submission.default_reviewer_group_id,
                  submission.updated_at, submission.source_version,
                  submission.track_id, track.name AS track_name,
                  submitter.id AS submitter_id,
                  submitter.display_name AS submitter_display_name,
                  submitter.email_normalized AS submitter_email,
                  submitter.title AS submitter_title,
                  submitter.company AS submitter_company
           FROM p_submissions AS submission
           JOIN p_contacts AS submitter
             ON submitter.organization_id = submission.organization_id
            AND submitter.id = submission.submitter_contact_id
            AND submitter.source_deleted_at IS NULL
           LEFT JOIN p_tracks AS track
             ON track.organization_id = submission.organization_id
            AND track.event_id = submission.event_id
            AND track.id = submission.track_id
            AND track.source_deleted_at IS NULL
           WHERE ${conditions.join(" AND ")}
           ORDER BY submission.updated_at DESC, submission.id DESC
           LIMIT ?${bindings.length}
         ), review_aggregates AS (
           SELECT review.submission_id,
                  COUNT(*) AS assigned_reviews,
                  SUM(CASE WHEN review.status = 'submitted' THEN 1 ELSE 0 END)
                    AS submitted_reviews,
                  AVG(CASE WHEN review.status = 'submitted' THEN (
                    SELECT SUM(score.numeric_score * criterion.weight) /
                           NULLIF(SUM(criterion.weight), 0)
                    FROM p_review_scores AS score
                    JOIN p_criteria AS criterion
                      ON criterion.organization_id = score.organization_id
                     AND criterion.event_id = score.event_id
                     AND criterion.id = score.criterion_id
                     AND criterion.source_deleted_at IS NULL
                    WHERE score.organization_id = review.organization_id
                      AND score.event_id = review.event_id
                      AND score.review_id = review.id
                      AND score.numeric_score IS NOT NULL
                      AND score.source_deleted_at IS NULL
                  ) END) AS aggregate_score
           FROM p_reviews AS review
           JOIN page ON page.id = review.submission_id
           WHERE review.organization_id = ?1 AND review.event_id = ?2
             AND review.status <> 'withdrawn'
             AND review.source_deleted_at IS NULL
           GROUP BY review.submission_id
         )
         SELECT page.*,
                COALESCE(review_aggregates.assigned_reviews, 0) AS assigned_reviews,
                COALESCE(review_aggregates.submitted_reviews, 0) AS submitted_reviews,
                review_aggregates.aggregate_score
         FROM page
         LEFT JOIN review_aggregates ON review_aggregates.submission_id = page.id
         ORDER BY page.updated_at DESC, page.id DESC`,
      )
      .bind(...bindings)
      .all<ListRow>();
    const hasMore = rows.results.length > query.pageSize;
    const page = rows.results.slice(0, query.pageSize);
    const last = page.at(-1);
    const projection = await this.#projection(scope, listProjectionTables);
    return organizerSubmissionListResponseSchema.parse({
      eventId: scope.eventId,
      items: page.map(listRow),
      nextCursor: hasMore && last ? serializeCursor(last, query) : null,
      projection,
    });
  }

  async detail(
    scope: RepositoryScope,
    submissionId: string,
  ): Promise<OrganizerSubmissionDetail | null> {
    const submission = await this.#readListRow(scope, submissionId);
    if (!submission) return null;
    const [answers, participants, reviews, notes, history, projection] =
      await Promise.all([
        this.#database
          .prepare(
            `SELECT field_stable_key, field_label_snapshot, answer_type,
                    form_version_snapshot, value_json, sort_order
             FROM p_submission_answers
             WHERE organization_id = ?1 AND event_id = ?2 AND submission_id = ?3
               AND source_deleted_at IS NULL
             ORDER BY sort_order, id LIMIT 129`,
          )
          .bind(scope.organizationId, scope.eventId, submissionId)
          .all<{
            answer_type: string;
            field_label_snapshot: string;
            field_stable_key: string;
            form_version_snapshot: number;
            sort_order: number;
            value_json: string;
          }>(),
        this.#database
          .prepare(
            `SELECT participant.id, participant.role, participant.sort_order,
                    participant.is_primary, contact.id AS contact_id,
                    contact.display_name, contact.email_normalized,
                    contact.title, contact.company
             FROM p_submission_participants AS participant
             JOIN p_contacts AS contact
               ON contact.organization_id = participant.organization_id
              AND contact.id = participant.contact_id
              AND contact.source_deleted_at IS NULL
             WHERE participant.organization_id = ?1
               AND participant.event_id = ?2
               AND participant.submission_id = ?3
               AND participant.source_deleted_at IS NULL
             ORDER BY participant.sort_order, participant.id LIMIT 33`,
          )
          .bind(scope.organizationId, scope.eventId, submissionId)
          .all<{
            company: string | null;
            contact_id: string;
            display_name: string;
            email_normalized: string;
            id: string;
            is_primary: number;
            role: string;
            sort_order: number;
            title: string | null;
          }>(),
        this.#reviews(scope, submissionId),
        this.#database
          .prepare(
            `SELECT id, body, actor_id, actor_display_name, created_at,
                    source_version
             FROM p_submission_notes
             WHERE organization_id = ?1 AND event_id = ?2 AND submission_id = ?3
               AND source_deleted_at IS NULL
             ORDER BY created_at DESC, id DESC LIMIT 101`,
          )
          .bind(scope.organizationId, scope.eventId, submissionId)
          .all<{
            actor_display_name: string;
            actor_id: string;
            body: string;
            created_at: string;
            id: string;
            source_version: number;
          }>(),
        this.#database
          .prepare(
            `SELECT audit.id, audit.action, audit.actor_id,
                    COALESCE(
                      json_extract(audit.safe_diff_json, '$.commandId'),
                      audit.command_id
                    ) AS command_id,
                    audit.created_at, audit.safe_diff_json,
                    COALESCE(user.display_name, 'OpenSession organizer') AS actor_name
             FROM audit_events AS audit
             LEFT JOIN users AS user ON user.id = audit.actor_id
             WHERE audit.organization_id = ?1 AND audit.event_id = ?2
               AND audit.action IN (
                 'organizer.submission.start_review',
                 'organizer.submission.reopen',
                 'organizer.submission.withdraw',
                 'organizer.submission.add_note'
               )
               AND (
                 (audit.entity_type = 'submissions' AND audit.entity_id = ?3) OR
                 json_extract(audit.safe_diff_json, '$.submissionId') = ?3
               )
             ORDER BY audit.created_at DESC, audit.id DESC LIMIT 201`,
          )
          .bind(scope.organizationId, scope.eventId, submissionId)
          .all<{
            action: string;
            actor_id: string;
            actor_name: string;
            command_id: string;
            created_at: string;
            id: string;
            safe_diff_json: string;
          }>(),
        this.#projection(scope, detailProjectionTables),
      ]);

    if (
      answers.results.length > 128 ||
      participants.results.length > 32 ||
      reviews.length > 256 ||
      notes.results.length > 100 ||
      history.results.length > 200
    ) {
      throw new OrganizerSubmissionProjectionUnavailableError(
        "The submission detail exceeds its bounded projection limits.",
      );
    }
    const submissionStatus = status(submission.status);
    return organizerSubmissionDetailSchema.parse({
      allowedCommands: allowedSubmissionCommands(submissionStatus),
      answerSnapshot: {
        answers: answers.results.map((answer) => ({
          fieldKey: answer.field_stable_key,
          fieldType: answer.answer_type,
          formVersion: answer.form_version_snapshot,
          label: answer.field_label_snapshot,
          order: answer.sort_order,
          ...parseAnswerValue(answer.answer_type, answer.value_json),
        })),
        formVersion: submission.form_version,
        state: submissionStatus === "draft" ? "draft" : "submitted",
      },
      history: history.results.map((entry) => {
        const safeDiff = JSON.parse(entry.safe_diff_json) as {
          fromStatus?: unknown;
          reason?: unknown;
          toStatus?: unknown;
        };
        const action = entry.action.replace("organizer.submission.", "");
        return {
          action,
          actor: { displayName: entry.actor_name, id: entry.actor_id },
          commandId: entry.command_id,
          createdAt: entry.created_at,
          fromStatus:
            typeof safeDiff.fromStatus === "string"
              ? status(safeDiff.fromStatus)
              : null,
          id: entry.id,
          reason: typeof safeDiff.reason === "string" ? safeDiff.reason : null,
          toStatus:
            typeof safeDiff.toStatus === "string"
              ? status(safeDiff.toStatus)
              : null,
        };
      }),
      notes: notes.results.map((note) => ({
        actor: {
          displayName: note.actor_display_name,
          id: note.actor_id,
        },
        body: note.body,
        createdAt: note.created_at,
        id: note.id,
        version: note.source_version,
      })),
      participants: participants.results.map((participant) => ({
        contact: {
          company: participant.company,
          displayName: participant.display_name,
          email: participant.email_normalized,
          id: participant.contact_id,
          title: participant.title,
        },
        id: participant.id,
        isPrimary: participant.is_primary === 1,
        order: participant.sort_order,
        role: participant.role,
      })),
      projection,
      reviews,
      submission: listRow(submission),
      submittedAt: submission.submitted_at,
    });
  }

  async #readListRow(
    scope: RepositoryScope,
    submissionId: string,
  ): Promise<
    (ListRow & { form_version: number; submitted_at: string | null }) | null
  > {
    return this.#database
      .prepare(
        `SELECT submission.id, submission.friendly_id, submission.title,
                submission.status, submission.route_key,
                submission.default_reviewer_group_id,
                submission.updated_at, submission.source_version,
                submission.form_version, submission.submitted_at,
                submission.track_id, track.name AS track_name,
                submitter.id AS submitter_id,
                submitter.display_name AS submitter_display_name,
                submitter.email_normalized AS submitter_email,
                submitter.title AS submitter_title,
                submitter.company AS submitter_company,
                COALESCE(review.assigned_reviews, 0) AS assigned_reviews,
                COALESCE(review.submitted_reviews, 0) AS submitted_reviews,
                review.aggregate_score
         FROM p_submissions AS submission
         JOIN p_contacts AS submitter
           ON submitter.organization_id = submission.organization_id
          AND submitter.id = submission.submitter_contact_id
          AND submitter.source_deleted_at IS NULL
         LEFT JOIN p_tracks AS track
           ON track.organization_id = submission.organization_id
          AND track.event_id = submission.event_id
          AND track.id = submission.track_id
          AND track.source_deleted_at IS NULL
         LEFT JOIN (
           SELECT reviews.submission_id, COUNT(*) AS assigned_reviews,
                  SUM(CASE WHEN reviews.status = 'submitted' THEN 1 ELSE 0 END)
                    AS submitted_reviews,
                  AVG(CASE WHEN reviews.status = 'submitted' THEN (
                    SELECT SUM(score.numeric_score * criterion.weight) /
                           NULLIF(SUM(criterion.weight), 0)
                    FROM p_review_scores AS score
                    JOIN p_criteria AS criterion
                      ON criterion.organization_id = score.organization_id
                     AND criterion.event_id = score.event_id
                     AND criterion.id = score.criterion_id
                     AND criterion.source_deleted_at IS NULL
                    WHERE score.review_id = reviews.id
                      AND score.numeric_score IS NOT NULL
                      AND score.source_deleted_at IS NULL
                  ) END) AS aggregate_score
           FROM p_reviews AS reviews
           WHERE reviews.organization_id = ?1 AND reviews.event_id = ?2
             AND reviews.status <> 'withdrawn'
             AND reviews.source_deleted_at IS NULL
           GROUP BY reviews.submission_id
         ) AS review ON review.submission_id = submission.id
         WHERE submission.organization_id = ?1 AND submission.event_id = ?2
           AND submission.id = ?3 AND submission.source_deleted_at IS NULL
         LIMIT 1`,
      )
      .bind(scope.organizationId, scope.eventId, submissionId)
      .first<ListRow & { form_version: number; submitted_at: string | null }>();
  }

  async #reviews(scope: RepositoryScope, submissionId: string) {
    const rows = await this.#database
      .prepare(
        `SELECT review.id, review.status, review.conflict,
                review.submitted_at, review.updated_at,
                membership.id AS reviewer_id, contact.display_name,
                SUM(score.numeric_score * criterion.weight) /
                  NULLIF(SUM(criterion.weight), 0) AS aggregate_score,
                GROUP_CONCAT(score.comment, '\n') AS summary
         FROM p_reviews AS review
         JOIN p_event_contacts AS membership
           ON membership.organization_id = review.organization_id
          AND membership.event_id = review.event_id
          AND membership.id = review.reviewer_id
          AND membership.source_deleted_at IS NULL
         JOIN p_contacts AS contact
           ON contact.organization_id = membership.organization_id
          AND contact.id = membership.contact_id
          AND contact.source_deleted_at IS NULL
         LEFT JOIN p_review_scores AS score
           ON score.organization_id = review.organization_id
          AND score.event_id = review.event_id
          AND score.review_id = review.id
          AND score.source_deleted_at IS NULL
         LEFT JOIN p_criteria AS criterion
           ON criterion.organization_id = score.organization_id
          AND criterion.event_id = score.event_id
          AND criterion.id = score.criterion_id
          AND criterion.source_deleted_at IS NULL
         WHERE review.organization_id = ?1 AND review.event_id = ?2
           AND review.submission_id = ?3 AND review.source_deleted_at IS NULL
         GROUP BY review.id
         ORDER BY review.updated_at DESC, review.id DESC LIMIT 257`,
      )
      .bind(scope.organizationId, scope.eventId, submissionId)
      .all<{
        aggregate_score: number | null;
        conflict: number;
        display_name: string;
        id: string;
        reviewer_id: string;
        status: "assigned" | "draft" | "submitted" | "withdrawn";
        submitted_at: string | null;
        summary: string | null;
        updated_at: string;
      }>();
    return rows.results.map((review) => ({
      conflict: review.conflict === 1,
      id: review.id,
      reviewer: { displayName: review.display_name, id: review.reviewer_id },
      score: review.aggregate_score,
      status: review.status,
      submittedAt: review.submitted_at,
      summary: review.summary?.slice(0, 4_000) ?? null,
      updatedAt: review.updated_at,
    }));
  }

  async #projection(
    scope: RepositoryScope,
    tables: readonly string[],
  ): Promise<OrganizerSubmissionProjection> {
    const placeholders = tables.map((_, index) => `?${index + 3}`).join(", ");
    const row = await this.#database
      .prepare(
        `SELECT tenant.authority_ready_at,
                COALESCE(MIN(watermark.updated_at), tenant.authority_ready_at,
                         event.projected_at) AS as_of,
                COUNT(DISTINCT watermark.table_key) AS watermark_count,
                webhook.status AS webhook_status,
                webhook.full_scan_required,
                (
                  SELECT COUNT(*) FROM projection_repairs AS repair
                  WHERE repair.organization_id = ?1
                    AND (repair.event_id = ?2 OR repair.event_id IS NULL)
                    AND repair.provider_table_key IN (${placeholders})
                    AND repair.status <> 'complete'
                ) AS pending_repairs
         FROM p_events AS event
         JOIN tenant_registry AS tenant
           ON tenant.organization_id = event.organization_id
          AND tenant.status = 'active'
         LEFT JOIN projection_watermarks AS watermark
           ON watermark.organization_id = event.organization_id
          AND watermark.provider = 'airtable'
          AND watermark.base_key = tenant.base_key
          AND watermark.table_key IN (${placeholders})
         LEFT JOIN airtable_webhooks AS webhook ON webhook.base_key = tenant.base_key
         WHERE event.organization_id = ?1 AND event.id = ?2
           AND event.source_deleted_at IS NULL
         GROUP BY tenant.organization_id
         LIMIT 1`,
      )
      .bind(scope.organizationId, scope.eventId, ...tables)
      .first<ProjectionRow>();
    if (!row) {
      throw new OrganizerSubmissionProjectionUnavailableError();
    }
    const reasons: OrganizerSubmissionProjection["reasons"] = [];
    if (!row.authority_ready_at || row.watermark_count !== tables.length) {
      reasons.push("upstream_rebuilding");
    }
    if (
      row.webhook_status &&
      (row.webhook_status !== "active" || row.full_scan_required === 1)
    ) {
      reasons.push("synchronization_delayed");
    }
    if (row.pending_repairs > 0) reasons.push("repair_pending");
    return {
      asOf: row.as_of,
      pendingRepairs: row.pending_repairs,
      reasons,
      state:
        reasons.includes("upstream_rebuilding") ||
        reasons.includes("repair_pending")
          ? "partial"
          : reasons.length > 0
            ? "stale"
            : "current",
    };
  }
}
