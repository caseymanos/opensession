import {
  reviewAssignmentSchema,
  reviewCriteriaSchema,
  reviewOperationsResponseSchema,
  reviewerAssignmentListResponseSchema,
  reviewerGroupSchema,
  type ReviewAssignment,
  type ReviewCriterion,
  type ReviewOperationsResponse,
  type ReviewRubric,
  type ReviewerAssignmentListResponse,
} from "@sessionbox-killer/contracts";

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
  scoring_required: number;
  source_version: number;
  status: "assigned" | "draft" | "submitted" | "withdrawn";
  submission_id: string;
  title: string;
  track_name: string | null;
  updated_at: string;
}

interface AssignmentAuditRow {
  action: ReviewAssignment["audit"][number]["action"];
  actor_display_name: string;
  created_at: string;
  entity_id: string;
  id: string;
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

export class D1ReviewOperationsRepository {
  readonly #database: D1Database;

  constructor(database: D1Database) {
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
    const [assignmentRows, assignmentAudit] = await Promise.all([
      this.#assignments(scope, reviewerId),
      this.#assignmentAudit(scope, reviewerId),
    ]);
    const assignments = assignmentRows
      .filter((row) => row.status !== "withdrawn" && row.conflict !== 1)
      .map((row) =>
        this.#assignmentView(row, assignmentAudit.get(row.id) ?? []),
      );
    return reviewerAssignmentListResponseSchema.parse({
      assignments,
      eventId: scope.eventId,
      reviewer,
    });
  }

  async reviewerIdForEmail(
    scope: ReviewScope,
    email: string,
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
           AND contact.email_normalized = ?3 COLLATE NOCASE
           AND membership.source_deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM json_each(membership.roles_json)
             WHERE json_each.value = 'reviewer'
           )
         LIMIT 1`,
      )
      .bind(scope.organizationId, scope.eventId, email)
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
                review.scoring_required, review.assigned_at, review.status,
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

  async #assignmentAudit(scope: ReviewScope, reviewerId?: string) {
    const result = await this.#database
      .prepare(
        `SELECT audit.id, audit.entity_id, audit.action, audit.created_at,
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
             'reviews.assignment.restore'
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
}
