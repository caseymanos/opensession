import {
  reviewAssignmentSchema,
  reviewCriteriaSchema,
  reviewDraftSchema,
  reviewOperationsResponseSchema,
  reviewerAssignmentListResponseSchema,
  reviewerGroupSchema,
  type ReviewAssignment,
  type ReviewCriterion,
  type ReviewOperationsResponse,
  type ReviewRubric,
  type ReviewerAssignmentListResponse,
} from "@sessionbox-killer/contracts";

import type { D1QueryExecutor } from "../database.js";

import { safeSpeakerPortalBrand } from "../portal/brand.js";

interface ReviewScope {
  eventId: string;
  organizationId: string;
}

interface RubricRow {
  criteria_snapshot_json: string;
  id: string;
  name: string;
  rubric_version: number;
  source_version: number;
}

interface CriterionRow {
  guidance: string | null;
  id: string;
  label: string;
  sort_order: number;
  weight: number;
}

interface ReviewerRow {
  display_name: string;
  id: string;
}

interface GroupRow {
  id: string;
  member_ids_json: string;
  name: string;
  route_key: string;
  source_version: number;
  status: "active" | "archived";
}

interface AssignmentRow {
  assigned_at: string | null;
  conflict: number;
  conflict_note: string | null;
  friendly_id: string;
  id: string;
  reviewer_display_name: string;
  reviewer_group_id: string | null;
  reviewer_id: string;
  rubric_snapshot_json: string | null;
  rubric_version: number | null;
  score_snapshot_json: string;
  scoring_required: number;
  source_version: number;
  status: "assigned" | "draft" | "submitted" | "withdrawn";
  submission_id: string;
  submitted_at: string | null;
  title: string;
  track_name: string | null;
  updated_at: string;
  reviewer_note: string | null;
}

interface EventRow {
  brand_json: string;
  id: string;
  name: string;
  review_closes_at: string | null;
  slug: string;
  timezone: string;
}

interface SubmissionAnswerRow {
  field_stable_key: string;
  submission_id: string;
  value_json: string;
}

interface AssignmentAuditRow {
  action: ReviewAssignment["audit"][number]["action"];
  actor_display_name: string;
  created_at: string;
  entity_id: string;
  id: string;
  safe_diff_json: string;
}

interface ProposalRow {
  default_reviewer_group_id: string;
  friendly_id: string;
  id: string;
  route_key: string;
  title: string;
  track_name: string | null;
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;

export class ReviewOperationsProjectionUnavailableError extends Error {
  constructor(message = "The review operations projection is incomplete.") {
    super(message);
    this.name = "ReviewOperationsProjectionUnavailableError";
  }
}

function parseMemberIds(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new ReviewOperationsProjectionUnavailableError();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > 256 ||
    parsed.some(
      (entry) => typeof entry !== "string" || !identifierPattern.test(entry),
    ) ||
    new Set(parsed).size !== parsed.length
  ) {
    throw new ReviewOperationsProjectionUnavailableError();
  }
  return parsed;
}

function assignmentStatus(row: AssignmentRow): ReviewAssignment["status"] {
  if (row.conflict === 1) return "conflict";
  if (row.status === "withdrawn") return "removed";
  if (row.status === "draft") return "in_progress";
  if (row.status === "submitted") return "submitted";
  return "pending";
}

function parseAssignmentRubric(
  row: AssignmentRow,
): Omit<ReviewRubric, "sourceVersion"> {
  if (!row.rubric_snapshot_json || !row.rubric_version) {
    throw new ReviewOperationsProjectionUnavailableError(
      `Review assignment ${row.id} does not have an immutable rubric snapshot.`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(row.rubric_snapshot_json) as unknown;
  } catch {
    throw new ReviewOperationsProjectionUnavailableError();
  }
  const parsed = reviewAssignmentSchema.shape.rubric.safeParse(value);
  if (!parsed.success || parsed.data.version !== row.rubric_version) {
    throw new ReviewOperationsProjectionUnavailableError();
  }
  return parsed.data;
}

function parsedAnswer(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new ReviewOperationsProjectionUnavailableError(
      "A reviewer proposal answer is invalid.",
    );
  }
}

function textAnswer(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function listAnswer(value: unknown): string[] {
  const candidates = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\r?\n/u)
      : [];
  return candidates
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 20);
}

export class D1ReviewOperationsRepository {
  readonly #database: D1QueryExecutor;

  constructor(database: D1QueryExecutor) {
    this.#database = database;
  }

  async operations(scope: ReviewScope): Promise<ReviewOperationsResponse> {
    const [
      activeRubric,
      reviewers,
      groupRows,
      assignmentRows,
      assignmentAudit,
      proposals,
    ] = await Promise.all([
      this.#activeRubric(scope),
      this.#reviewers(scope),
      this.#groups(scope),
      this.#assignments(scope),
      this.#assignmentAudit(scope),
      this.#proposals(scope),
    ]);
    const reviewerById = new Map(
      reviewers.map((reviewer) => [reviewer.id, reviewer]),
    );
    const groups = groupRows.map((row) =>
      reviewerGroupSchema.parse({
        id: row.id,
        members: parseMemberIds(row.member_ids_json).map((id) => {
          const reviewer = reviewerById.get(id);
          if (!reviewer) {
            throw new ReviewOperationsProjectionUnavailableError(
              `Reviewer group ${row.id} contains an unavailable reviewer.`,
            );
          }
          return reviewer;
        }),
        name: row.name,
        routeKey: row.route_key,
        sourceVersion: row.source_version,
        status: row.status,
      }),
    );
    return reviewOperationsResponseSchema.parse({
      activeRubric,
      assignments: assignmentRows.map((row) =>
        this.#assignmentView(row, assignmentAudit.get(row.id) ?? []),
      ),
      eventId: scope.eventId,
      groups,
      proposals: proposals.map((proposal) => ({
        id: proposal.id,
        reference: proposal.friendly_id,
        reviewerGroupId: proposal.default_reviewer_group_id,
        routeKey: proposal.route_key,
        title: proposal.title,
        track: proposal.track_name,
      })),
      reviewers,
    });
  }

  async reviewerAssignments(
    scope: ReviewScope,
    reviewerId: string,
  ): Promise<ReviewerAssignmentListResponse> {
    const reviewer = (await this.#reviewers(scope)).find(
      ({ id }) => id === reviewerId,
    );
    if (!reviewer) {
      throw new ReviewOperationsProjectionUnavailableError(
        "The reviewer identity is not available for this event.",
      );
    }
    const [event, assignmentRows, assignmentAudit, answerRows] =
      await Promise.all([
        this.#event(scope),
        this.#assignments(scope, reviewerId),
        this.#assignmentAudit(scope, reviewerId),
        this.#reviewerAnswers(scope, reviewerId),
      ]);
    const answersBySubmission = new Map<string, Map<string, unknown>>();
    for (const answer of answerRows) {
      const answers =
        answersBySubmission.get(answer.submission_id) ?? new Map();
      answers.set(answer.field_stable_key, parsedAnswer(answer.value_json));
      answersBySubmission.set(answer.submission_id, answers);
    }
    const assignments = assignmentRows
      .filter((row) => row.status !== "withdrawn" && row.conflict !== 1)
      .map((row) => {
        const assignment = this.#assignmentView(
          row,
          assignmentAudit.get(row.id) ?? [],
        );
        const answers = answersBySubmission.get(row.submission_id) ?? new Map();
        let draft;
        try {
          draft = reviewDraftSchema.parse({
            note: row.reviewer_note ?? "",
            scores: JSON.parse(row.score_snapshot_json) as unknown,
          });
        } catch {
          throw new ReviewOperationsProjectionUnavailableError(
            `Review assignment ${row.id} has an invalid score snapshot.`,
          );
        }
        return {
          assignment,
          context: {
            abstract: textAnswer(answers.get("abstract")),
            audience: textAnswer(answers.get("audience")),
            format: textAnswer(answers.get("format")),
            outcomes: listAnswer(answers.get("outcomes")),
          },
          draft,
          submittedAt: row.submitted_at,
        };
      });
    return reviewerAssignmentListResponseSchema.parse({
      assignments,
      event: {
        brand: safeSpeakerPortalBrand(event.brand_json),
        id: event.id,
        name: event.name,
        reviewDueAt: event.review_closes_at,
        slug: event.slug,
        timezone: event.timezone,
      },
      reviewer,
    });
  }

  async #event(scope: ReviewScope): Promise<EventRow> {
    const event = await this.#database
      .prepare(
        `SELECT id, name, slug, timezone, brand_json, review_closes_at
         FROM p_events
         WHERE organization_id = ?1 AND id = ?2 AND source_deleted_at IS NULL
         LIMIT 1`,
      )
      .bind(scope.organizationId, scope.eventId)
      .first<EventRow>();
    if (!event) {
      throw new ReviewOperationsProjectionUnavailableError(
        "The review event is unavailable.",
      );
    }
    return event;
  }

  async reviewerIdForIdentity(
    scope: ReviewScope,
    email: string,
    userId: string,
  ): Promise<string | null> {
    const row = await this.#database
      .prepare(
        `SELECT membership.id
         FROM p_event_contacts AS membership
         JOIN p_contacts AS contact
           ON contact.organization_id = membership.organization_id
          AND contact.id = membership.contact_id
          AND contact.source_deleted_at IS NULL
         WHERE membership.organization_id = ?1 AND membership.event_id = ?2
           AND (
             contact.email_normalized = ?3 COLLATE NOCASE
             OR EXISTS (
               SELECT 1 FROM event_memberships identity_membership
               WHERE identity_membership.organization_id = membership.organization_id
                 AND identity_membership.event_id = membership.event_id
                 AND identity_membership.user_id = ?4
                 AND identity_membership.contact_id = membership.contact_id
                 AND identity_membership.role = 'reviewer'
                 AND identity_membership.revoked_at IS NULL
             )
           )
           AND membership.source_deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM json_each(membership.roles_json)
             WHERE json_each.value = 'reviewer'
           )
         LIMIT 1`,
      )
      .bind(scope.organizationId, scope.eventId, email, userId)
      .first<{ id: string }>();
    return row?.id ?? null;
  }

  async #activeRubric(scope: ReviewScope): Promise<ReviewRubric> {
    const row = await this.#database
      .prepare(
        `SELECT id, name, rubric_version, criteria_snapshot_json, source_version
         FROM p_rubrics
         WHERE organization_id = ?1 AND event_id = ?2
           AND status = 'active' AND source_deleted_at IS NULL
         ORDER BY rubric_version DESC, id DESC LIMIT 2`,
      )
      .bind(scope.organizationId, scope.eventId)
      .all<RubricRow>();
    if (row.results.length !== 1 || !row.results[0]) {
      throw new ReviewOperationsProjectionUnavailableError(
        "The event must have exactly one active rubric.",
      );
    }
    const rubric = row.results[0];
    let criteria: ReviewCriterion[];
    try {
      criteria = reviewCriteriaSchema.parse(
        JSON.parse(rubric.criteria_snapshot_json) as unknown,
      );
    } catch {
      const legacy = await this.#database
        .prepare(
          `SELECT id, label, guidance, weight, sort_order
           FROM p_criteria
           WHERE organization_id = ?1 AND event_id = ?2 AND rubric_id = ?3
             AND source_deleted_at IS NULL
           ORDER BY sort_order, id LIMIT 6`,
        )
        .bind(scope.organizationId, scope.eventId, rubric.id)
        .all<CriterionRow>();
      criteria = reviewCriteriaSchema.parse(
        legacy.results.map((criterion) => ({
          guidance: criterion.guidance ?? "No guidance provided.",
          id: criterion.id,
          label: criterion.label,
          weight:
            criterion.weight <= 1
              ? Math.round(criterion.weight * 100)
              : Math.round(criterion.weight),
        })),
      );
    }
    return {
      criteria,
      id: rubric.id,
      name: rubric.name,
      sourceVersion: rubric.source_version,
      version: rubric.rubric_version,
    };
  }

  async #reviewers(scope: ReviewScope) {
    const result = await this.#database
      .prepare(
        `SELECT membership.id, contact.display_name
         FROM p_event_contacts AS membership
         JOIN p_contacts AS contact
           ON contact.organization_id = membership.organization_id
          AND contact.id = membership.contact_id
          AND contact.source_deleted_at IS NULL
         WHERE membership.organization_id = ?1 AND membership.event_id = ?2
           AND membership.source_deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM json_each(membership.roles_json)
             WHERE json_each.value = 'reviewer'
           )
         ORDER BY contact.display_name COLLATE NOCASE, membership.id
         LIMIT 2001`,
      )
      .bind(scope.organizationId, scope.eventId)
      .all<ReviewerRow>();
    if (result.results.length > 2_000) {
      throw new ReviewOperationsProjectionUnavailableError();
    }
    return result.results.map((row) => ({
      displayName: row.display_name,
      id: row.id,
    }));
  }

  async #groups(scope: ReviewScope) {
    const result = await this.#database
      .prepare(
        `SELECT id, name, route_key, member_ids_json, status, source_version
         FROM p_reviewer_groups
         WHERE organization_id = ?1 AND event_id = ?2
           AND status = 'active'
           AND source_deleted_at IS NULL
         ORDER BY status, name COLLATE NOCASE, id LIMIT 129`,
      )
      .bind(scope.organizationId, scope.eventId)
      .all<GroupRow>();
    if (result.results.length === 0 || result.results.length > 128) {
      throw new ReviewOperationsProjectionUnavailableError();
    }
    return result.results;
  }

  async #assignments(scope: ReviewScope, reviewerId?: string) {
    const result = await this.#database
      .prepare(
        `SELECT review.id, review.reviewer_id, review.reviewer_group_id,
                review.rubric_version, review.rubric_snapshot_json,
                review.score_snapshot_json, review.reviewer_note,
                review.scoring_required, review.assigned_at, review.submitted_at,
                review.status,
                review.conflict, review.conflict_note, review.updated_at,
                review.source_version, submission.id AS submission_id,
                submission.friendly_id, submission.title,
                contact.display_name AS reviewer_display_name,
                track.name AS track_name
         FROM p_reviews AS review
         JOIN p_submissions AS submission
           ON submission.organization_id = review.organization_id
          AND submission.event_id = review.event_id
          AND submission.id = review.submission_id
          AND submission.source_deleted_at IS NULL
         JOIN p_event_contacts AS membership
           ON membership.organization_id = review.organization_id
          AND membership.event_id = review.event_id
          AND membership.id = review.reviewer_id
          AND membership.source_deleted_at IS NULL
         JOIN p_contacts AS contact
           ON contact.organization_id = membership.organization_id
          AND contact.id = membership.contact_id
          AND contact.source_deleted_at IS NULL
         LEFT JOIN p_tracks AS track
           ON track.organization_id = submission.organization_id
          AND track.event_id = submission.event_id
          AND track.id = submission.track_id
          AND track.source_deleted_at IS NULL
         WHERE review.organization_id = ?1 AND review.event_id = ?2
           AND (?3 IS NULL OR review.reviewer_id = ?3)
           AND review.source_deleted_at IS NULL
         ORDER BY review.updated_at DESC, review.id DESC LIMIT 2001`,
      )
      .bind(scope.organizationId, scope.eventId, reviewerId ?? null)
      .all<AssignmentRow>();
    if (result.results.length > 2_000) {
      throw new ReviewOperationsProjectionUnavailableError();
    }
    return result.results;
  }

  async #reviewerAnswers(scope: ReviewScope, reviewerId: string) {
    const result = await this.#database
      .prepare(
        `SELECT answer.submission_id, answer.field_stable_key, answer.value_json
         FROM p_submission_answers AS answer
         WHERE answer.organization_id = ?1 AND answer.event_id = ?2
           AND answer.source_deleted_at IS NULL
           AND answer.field_stable_key IN ('abstract', 'audience', 'format', 'outcomes')
           AND EXISTS (
             SELECT 1 FROM p_reviews AS review
             WHERE review.organization_id = answer.organization_id
               AND review.event_id = answer.event_id
               AND review.submission_id = answer.submission_id
               AND review.reviewer_id = ?3
               AND review.status <> 'withdrawn'
               AND review.conflict = 0
               AND review.source_deleted_at IS NULL
           )
         ORDER BY answer.submission_id, answer.sort_order, answer.id
         LIMIT 40001`,
      )
      .bind(scope.organizationId, scope.eventId, reviewerId)
      .all<SubmissionAnswerRow>();
    if (result.results.length > 40_000) {
      throw new ReviewOperationsProjectionUnavailableError();
    }
    return result.results;
  }

  async #assignmentAudit(scope: ReviewScope, reviewerId?: string) {
    const result = await this.#database
      .prepare(
        `SELECT audit.id, audit.entity_id, audit.action, audit.created_at,
                audit.safe_diff_json,
                COALESCE(user.display_name, 'OpenSession automation') AS actor_display_name
         FROM audit_events AS audit
         LEFT JOIN users AS user ON user.id = audit.actor_id
         WHERE audit.organization_id = ?1 AND audit.event_id = ?2
           AND audit.entity_type = 'reviews'
           AND (
             ?3 IS NULL OR EXISTS (
               SELECT 1 FROM p_reviews AS review
               WHERE review.organization_id = audit.organization_id
                 AND review.event_id = audit.event_id
                 AND review.id = audit.entity_id
                 AND review.reviewer_id = ?3
                 AND review.source_deleted_at IS NULL
             )
           )
           AND audit.action IN (
             'reviews.assignment.conflict',
             'reviews.assignment.create',
             'reviews.assignment.remove',
             'reviews.assignment.restore',
             'reviews.review.reopen',
             'reviews.review.submit'
           )
         ORDER BY audit.created_at DESC, audit.id DESC LIMIT 4000`,
      )
      .bind(scope.organizationId, scope.eventId, reviewerId ?? null)
      .all<AssignmentAuditRow>();
    const byAssignment = new Map<string, AssignmentAuditRow[]>();
    for (const entry of result.results) {
      const entries = byAssignment.get(entry.entity_id) ?? [];
      if (entries.length < 50) entries.push(entry);
      byAssignment.set(entry.entity_id, entries);
    }
    return byAssignment;
  }

  async #proposals(scope: ReviewScope) {
    const result = await this.#database
      .prepare(
        `SELECT submission.id, submission.friendly_id, submission.title,
                submission.route_key, submission.default_reviewer_group_id,
                track.name AS track_name
         FROM p_submissions AS submission
         LEFT JOIN p_tracks AS track
           ON track.organization_id = submission.organization_id
          AND track.event_id = submission.event_id
          AND track.id = submission.track_id
          AND track.source_deleted_at IS NULL
         JOIN p_reviewer_groups AS reviewer_group
           ON reviewer_group.organization_id = submission.organization_id
          AND reviewer_group.event_id = submission.event_id
          AND reviewer_group.id = submission.default_reviewer_group_id
          AND reviewer_group.route_key = submission.route_key
          AND reviewer_group.status = 'active'
          AND reviewer_group.source_deleted_at IS NULL
         WHERE submission.organization_id = ?1 AND submission.event_id = ?2
           AND submission.status IN ('submitted', 'in_review')
           AND submission.source_deleted_at IS NULL
         ORDER BY submission.friendly_id COLLATE NOCASE, submission.id LIMIT 2001`,
      )
      .bind(scope.organizationId, scope.eventId)
      .all<ProposalRow>();
    if (result.results.length > 2_000) {
      throw new ReviewOperationsProjectionUnavailableError();
    }
    return result.results;
  }

  #assignmentView(
    row: AssignmentRow,
    audit: AssignmentAuditRow[],
  ): ReviewAssignment {
    if (!row.reviewer_group_id || !row.assigned_at) {
      throw new ReviewOperationsProjectionUnavailableError(
        `Review assignment ${row.id} is missing assignment metadata.`,
      );
    }
    return reviewAssignmentSchema.parse({
      assignedAt: row.assigned_at,
      audit: audit.map((entry) => ({
        action: entry.action,
        actorDisplayName: entry.actor_display_name,
        at: entry.created_at,
        id: entry.id,
        ...(entry.action === "reviews.review.reopen"
          ? { reason: this.#reopenReason(entry.safe_diff_json) }
          : {}),
      })),
      conflictNote: row.conflict_note?.trim() || null,
      id: row.id,
      reviewer: { displayName: row.reviewer_display_name, id: row.reviewer_id },
      reviewerGroupId: row.reviewer_group_id,
      rubric: parseAssignmentRubric(row),
      scoringRequired: row.scoring_required === 1,
      sourceVersion: row.source_version,
      status: assignmentStatus(row),
      submission: {
        id: row.submission_id,
        reference: row.friendly_id,
        title: row.title,
        track: row.track_name,
      },
      updatedAt: row.updated_at,
    });
  }

  #reopenReason(value: string): string {
    try {
      const parsed: unknown = JSON.parse(value);
      if (
        parsed &&
        typeof parsed === "object" &&
        "reason" in parsed &&
        typeof parsed.reason === "string" &&
        parsed.reason.trim()
      ) {
        return parsed.reason.trim();
      }
    } catch {
      // Invalid audit details fall back to a safe, non-sensitive summary.
    }
    return "Review reopened by an organizer.";
  }
}
