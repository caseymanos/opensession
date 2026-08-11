import {
  decisionHistoryEntrySchema,
  decisionWorkspaceResponseSchema,
  reviewAssignmentSchema,
  reviewDraftSchema,
  type DecisionHistoryEntry,
  type DecisionWorkspaceResponse,
} from "@sessionbox-killer/contracts";

interface DecisionScope {
  actor: string;
  eventId: string;
  eventName: string;
  organizationId: string;
}

interface SubmissionRow {
  format: string | null;
  friendly_id: string;
  id: string;
  source_version: number;
  speaker_count: number;
  status: string;
  title: string;
  track_name: string | null;
}

interface ReviewRow {
  conflict: number;
  conflict_note: string | null;
  display_name: string;
  id: string;
  reviewer_note: string | null;
  rubric_snapshot_json: string | null;
  score_snapshot_json: string;
  status: string;
  submission_id: string;
  submitted_at: string | null;
}

interface AuditRow {
  actor_display_name: string;
  created_at: string;
  entity_id: string;
  safe_diff_json: string;
}

interface SideEffectsRow {
  error_code: string | null;
  id: string;
  status:
    "canceled" | "complete" | "failed" | "queued" | "running" | "sleeping";
  submission_id: string;
  updated_at: string;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function decisionState(status: string) {
  return status === "accepted" ||
    status === "waitlisted" ||
    status === "declined"
    ? status
    : "undecided";
}

function historyEntry(row: AuditRow): DecisionHistoryEntry {
  let value: unknown;
  try {
    value = JSON.parse(row.safe_diff_json) as unknown;
  } catch {
    value = null;
  }
  if (!value || typeof value !== "object") {
    throw new Error("Decision audit details are unavailable.");
  }
  return decisionHistoryEntrySchema.parse({
    ...value,
    actor: row.actor_display_name,
    at: row.created_at,
  });
}

export class D1DecisionRepository {
  readonly #database: D1Database;

  constructor(database: D1Database) {
    this.#database = database;
  }

  async workspace(scope: DecisionScope): Promise<DecisionWorkspaceResponse> {
    const [submissionResult, reviewResult, auditResult, sideEffectsResult] =
      await Promise.all([
        this.#database
          .prepare(
            `SELECT submission.id, submission.friendly_id, submission.title,
                  submission.status, submission.source_version,
                  track.name AS track_name,
                  (SELECT CASE WHEN json_type(answer.value_json) = 'text'
                               THEN json_extract(answer.value_json, '$') END
                   FROM p_submission_answers AS answer
                   WHERE answer.organization_id = submission.organization_id
                     AND answer.event_id = submission.event_id
                     AND answer.submission_id = submission.id
                     AND answer.field_stable_key = 'format'
                     AND answer.source_deleted_at IS NULL LIMIT 1) AS format,
                  (SELECT COUNT(*) FROM p_submission_participants AS participant
                   WHERE participant.organization_id = submission.organization_id
                     AND participant.event_id = submission.event_id
                     AND participant.submission_id = submission.id
                     AND participant.source_deleted_at IS NULL) AS speaker_count
           FROM p_submissions AS submission
           LEFT JOIN p_tracks AS track
             ON track.organization_id = submission.organization_id
            AND track.event_id = submission.event_id
            AND track.id = submission.track_id
            AND track.source_deleted_at IS NULL
           WHERE submission.organization_id = ?1 AND submission.event_id = ?2
             AND submission.status IN ('submitted', 'in_review', 'accepted', 'waitlisted', 'declined')
             AND submission.source_deleted_at IS NULL
           ORDER BY submission.updated_at DESC, submission.id DESC LIMIT 2001`,
          )
          .bind(scope.organizationId, scope.eventId)
          .all<SubmissionRow>(),
        this.#database
          .prepare(
            `SELECT review.id, review.submission_id, review.status, review.conflict,
                  review.conflict_note, review.submitted_at,
                  review.rubric_snapshot_json, review.score_snapshot_json,
                  review.reviewer_note,
                  COALESCE(contact.display_name, 'Former reviewer') AS display_name
           FROM p_reviews AS review
           JOIN p_submissions AS submission
             ON submission.organization_id = review.organization_id
            AND submission.event_id = review.event_id
            AND submission.id = review.submission_id
            AND submission.status IN ('submitted', 'in_review', 'accepted', 'waitlisted', 'declined')
            AND submission.source_deleted_at IS NULL
           LEFT JOIN p_event_contacts AS membership
             ON membership.organization_id = review.organization_id
            AND membership.event_id = review.event_id
            AND membership.id = review.reviewer_id
           LEFT JOIN p_contacts AS contact
             ON contact.organization_id = membership.organization_id
            AND contact.id = membership.contact_id
           WHERE review.organization_id = ?1 AND review.event_id = ?2
             AND review.status <> 'withdrawn' AND review.source_deleted_at IS NULL
           ORDER BY review.submission_id, review.updated_at DESC, review.id DESC
           LIMIT 40001`,
          )
          .bind(scope.organizationId, scope.eventId)
          .all<ReviewRow>(),
        this.#database
          .prepare(
            `SELECT audit.entity_id, audit.created_at, audit.safe_diff_json,
                  COALESCE(user.display_name, 'OpenSession organizer') AS actor_display_name
           FROM audit_events AS audit
           LEFT JOIN users AS user ON user.id = audit.actor_id
           WHERE audit.organization_id = ?1 AND audit.event_id = ?2
             AND audit.action = 'submissions.decision.record'
           ORDER BY audit.created_at, audit.id LIMIT 10001`,
          )
          .bind(scope.organizationId, scope.eventId)
          .all<AuditRow>(),
        this.#database
          .prepare(
            `SELECT id, status, error_code, updated_at,
                  json_extract(input_json, '$.command.submissionId') AS submission_id
           FROM workflow_runs
           WHERE organization_id = ?1 AND event_id = ?2
             AND workflow_type = 'decision_acceptance'
           ORDER BY updated_at DESC, id DESC LIMIT 2001`,
          )
          .bind(scope.organizationId, scope.eventId)
          .all<SideEffectsRow>(),
      ]);
    if (
      submissionResult.results.length > 2_000 ||
      reviewResult.results.length > 40_000 ||
      auditResult.results.length > 10_000 ||
      sideEffectsResult.results.length > 2_000
    ) {
      throw new Error("Decision workspace exceeds its bounded read limits.");
    }

    const reviewsBySubmission = new Map<string, ReviewRow[]>();
    for (const review of reviewResult.results) {
      const reviews = reviewsBySubmission.get(review.submission_id) ?? [];
      reviews.push(review);
      reviewsBySubmission.set(review.submission_id, reviews);
    }
    const historyBySubmission = new Map<string, DecisionHistoryEntry[]>();
    for (const audit of auditResult.results) {
      const history = historyBySubmission.get(audit.entity_id) ?? [];
      history.push(historyEntry(audit));
      historyBySubmission.set(audit.entity_id, history);
    }
    const sideEffectsBySubmission = new Map<string, SideEffectsRow>();
    for (const effect of sideEffectsResult.results) {
      if (!sideEffectsBySubmission.has(effect.submission_id)) {
        sideEffectsBySubmission.set(effect.submission_id, effect);
      }
    }

    return decisionWorkspaceResponseSchema.parse({
      actor: scope.actor,
      eventId: scope.eventId,
      eventName: scope.eventName,
      submissions: submissionResult.results.map((submission) => {
        const reviews = (reviewsBySubmission.get(submission.id) ?? []).map(
          (review) => {
            let criteria: {
              criterionId: string;
              label: string;
              score: number;
              weight: number;
            }[] = [];
            if (
              review.status === "submitted" &&
              review.conflict !== 1 &&
              review.rubric_snapshot_json
            ) {
              const rubric = reviewAssignmentSchema.shape.rubric.parse(
                JSON.parse(review.rubric_snapshot_json) as unknown,
              );
              const draft = reviewDraftSchema.parse({
                note: review.reviewer_note ?? "",
                scores: JSON.parse(review.score_snapshot_json) as unknown,
              });
              const scores = new Map(
                draft.scores.map(({ criterionId, score }) => [
                  criterionId,
                  score,
                ]),
              );
              criteria = rubric.criteria.flatMap((criterion) => {
                const score = scores.get(criterion.id);
                return score === undefined
                  ? []
                  : [
                      {
                        criterionId: criterion.id,
                        label: criterion.label,
                        score,
                        weight: criterion.weight,
                      },
                    ];
              });
            }
            const totalWeight = criteria.reduce(
              (total, criterion) => total + criterion.weight,
              0,
            );
            const overallScore =
              review.status === "submitted" && totalWeight > 0
                ? rounded(
                    criteria.reduce(
                      (total, criterion) =>
                        total + criterion.score * criterion.weight,
                      0,
                    ) / totalWeight,
                  )
                : null;
            return {
              conflictReason: review.conflict_note,
              criteria,
              id: review.id,
              note: review.reviewer_note,
              overallScore,
              reviewer: review.display_name,
              status:
                review.conflict === 1
                  ? "conflict"
                  : review.status === "submitted"
                    ? "submitted"
                    : "pending",
              submittedAt: review.submitted_at,
            };
          },
        );
        const scores = reviews.flatMap((review) =>
          review.status === "submitted" && review.overallScore !== null
            ? [review.overallScore]
            : [],
        );
        const sideEffects = sideEffectsBySubmission.get(submission.id);
        return {
          aggregateScore:
            scores.length > 0
              ? rounded(
                  scores.reduce((total, score) => total + score, 0) /
                    scores.length,
                )
              : null,
          decision: decisionState(submission.status),
          format: submission.format,
          history: historyBySubmission.get(submission.id) ?? [],
          id: submission.id,
          reference: submission.friendly_id,
          reviews,
          sideEffects: sideEffects
            ? {
                errorCode: sideEffects.error_code,
                status:
                  sideEffects.status === "complete"
                    ? "complete"
                    : sideEffects.status === "failed" ||
                        sideEffects.status === "canceled"
                      ? "failed"
                      : "pending",
                updatedAt: sideEffects.updated_at,
                workflowId: sideEffects.id,
              }
            : null,
          sourceVersion: submission.source_version,
          speakerCount: submission.speaker_count,
          title: submission.title,
          track: submission.track_name,
        };
      }),
    });
  }
}
