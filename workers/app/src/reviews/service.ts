import {
  reviewCriteriaSchema,
  reviewAssignmentSchema,
  reviewDraftSchema,
  reviewOperationsCommandResultSchema,
  type ReviewOperationsCommand,
  type ReviewOperationsCommandResult,
  type ReviewScoringCommand,
} from "@sessionbox-killer/contracts";

import type { BaseAuthority } from "../authority/base-authority.js";
import {
  AuthorityCommandFailedError,
  AuthorityIdempotencyConflictError,
  hashAuthorityValue,
  parseBaseAuthorityCommand,
  type BaseAuthorityCommand,
} from "../authority/types.js";
import {
  ReviewOperationsIdempotencyConflictError,
  ReviewOperationsNotFoundError,
  ReviewOperationsValidationError,
  ReviewOperationsVersionConflictError,
} from "./policy.js";

interface ReviewOperationsServiceOptions {
  actorId: string;
  authority: Pick<BaseAuthority, "execute">;
  database: D1Database;
  eventId: string;
  organizationId: string;
  permittedReviewerId?: string;
  requestId: string;
}

interface ReceiptRow {
  command_hash: string;
  command_id: string;
  created_at: string;
  entity_id: string;
  operation_json: string | null;
  result_json: string | null;
  state: "applying" | "complete";
}

interface EntityRow {
  source_record_id: string;
  source_version: number;
}

interface RubricRow extends EntityRow {
  criteria_snapshot_json: string;
  id: string;
  name: string;
  rubric_version: number;
  status: "active" | "archived" | "draft";
}

interface GroupRow extends EntityRow {
  id: string;
  member_ids_json: string;
  route_key: string;
  status: "active" | "archived";
}

interface AssignmentRow extends EntityRow {
  conflict: number;
  id: string;
  reviewer_id: string;
  rubric_snapshot_json: string | null;
  scoring_required: number;
  status: "assigned" | "draft" | "submitted" | "withdrawn";
  submission_id: string;
}

interface SubmissionRow extends EntityRow {
  default_reviewer_group_id: string | null;
  route_key: string | null;
}

interface ReviewerRow extends EntityRow {
  id: string;
}

function errorName(error: unknown): string | null {
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9]+$/u.test(error.name)
    ? error.name
    : null;
}

function authorityConflict(error: unknown): boolean {
  if (error instanceof AuthorityIdempotencyConflictError) return true;
  if (error instanceof AuthorityCommandFailedError) return error.status === 409;
  return new Set([
    "AirtableIdempotencyConflictError",
    "AirtableManualEditError",
    "AirtableVersionConflictError",
    "AuthorityIdempotencyConflictError",
  ]).has(errorName(error) ?? "");
}

function entityType(
  operation: BaseAuthorityCommand,
): "assignment" | "group" | "rubric" {
  if (operation.table === "reviews") return "assignment";
  if (operation.table === "reviewer_groups") return "group";
  return "rubric";
}

function parseMemberIds(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => typeof item !== "string")
  ) {
    throw new ReviewOperationsValidationError(
      "reviewerGroupId",
      "The reviewer group membership projection is invalid.",
    );
  }
  return parsed;
}

export class AirtableReviewOperationsCommandService {
  readonly #actorId: string;
  readonly #authority: Pick<BaseAuthority, "execute">;
  readonly #database: D1Database;
  readonly #eventId: string;
  readonly #organizationId: string;
  readonly #permittedReviewerId: string | undefined;
  readonly #requestId: string;

  constructor(options: ReviewOperationsServiceOptions) {
    this.#actorId = options.actorId;
    this.#authority = options.authority;
    this.#database = options.database;
    this.#eventId = options.eventId;
    this.#organizationId = options.organizationId;
    this.#permittedReviewerId = options.permittedReviewerId;
    this.#requestId = options.requestId;
  }

  async execute(
    command: ReviewOperationsCommand | ReviewScoringCommand,
  ): Promise<ReviewOperationsCommandResult> {
    const commandHash = await hashAuthorityValue({
      actorId: this.#actorId,
      command,
      eventId: this.#eventId,
      organizationId: this.#organizationId,
    });
    const existing = await this.#receipt(command.commandId);
    if (existing) return this.#resume(existing, commandHash);

    const operation = await this.#operation(command);
    const now = new Date().toISOString();
    try {
      await this.#database
        .prepare(
          `INSERT INTO review_operation_command_receipts (
             organization_id, event_id, entity_id, command_id, command_hash,
             state, operation_json, result_json, created_at, updated_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, 'applying', ?6, NULL, ?7, ?7)`,
        )
        .bind(
          this.#organizationId,
          this.#eventId,
          operation.entityId,
          command.commandId,
          commandHash,
          JSON.stringify(operation),
          now,
        )
        .run();
    } catch (error) {
      const winner = await this.#receipt(command.commandId);
      if (winner) return this.#resume(winner, commandHash);
      throw error;
    }
    return this.#apply(command.commandId, operation, now, false);
  }

  async #receipt(commandId: string): Promise<ReceiptRow | null> {
    return this.#database
      .prepare(
        `SELECT command_id, entity_id, command_hash, state, operation_json,
                result_json, created_at
         FROM review_operation_command_receipts
         WHERE organization_id = ?1 AND event_id = ?2 AND command_id = ?3`,
      )
      .bind(this.#organizationId, this.#eventId, commandId)
      .first<ReceiptRow>();
  }

  async #resume(
    receipt: ReceiptRow,
    commandHash: string,
  ): Promise<ReviewOperationsCommandResult> {
    if (receipt.command_hash !== commandHash) {
      throw new ReviewOperationsIdempotencyConflictError(receipt.command_id);
    }
    if (receipt.state === "complete") {
      if (!receipt.result_json)
        throw new Error("Complete review receipt is malformed.");
      const result = reviewOperationsCommandResultSchema.parse(
        JSON.parse(receipt.result_json) as unknown,
      );
      return { ...result, outcome: "replayed" };
    }
    if (!receipt.operation_json)
      throw new Error("Applying review receipt is malformed.");
    const operation = parseBaseAuthorityCommand(
      JSON.parse(receipt.operation_json) as unknown,
    );
    if (receipt.entity_id !== operation.entityId) {
      throw new Error("Applying review receipt has an invalid entity.");
    }
    return this.#apply(receipt.command_id, operation, receipt.created_at, true);
  }

  async #apply(
    commandId: string,
    operation: BaseAuthorityCommand,
    appliedAt: string,
    replayed: boolean,
  ): Promise<ReviewOperationsCommandResult> {
    let response;
    try {
      response = await this.#authority.execute(operation);
    } catch (error) {
      if (error instanceof AuthorityIdempotencyConflictError) {
        throw new ReviewOperationsIdempotencyConflictError(commandId);
      }
      if (authorityConflict(error)) {
        const current = await this.#entityVersion(
          operation.table,
          operation.entityId,
        );
        throw new ReviewOperationsVersionConflictError(
          operation.expectedVersion,
          current ?? operation.expectedVersion,
        );
      }
      throw error;
    }
    const result = reviewOperationsCommandResultSchema.parse({
      appliedAt,
      commandId,
      entityId: operation.entityId,
      entityType: entityType(operation),
      outcome: replayed ? "replayed" : "applied",
      projection: response.projection,
      version: response.authority.sourceVersion,
    });
    const completed = await this.#database
      .prepare(
        `UPDATE review_operation_command_receipts
         SET state = 'complete', operation_json = NULL, result_json = ?4,
             updated_at = ?5
         WHERE organization_id = ?1 AND event_id = ?2 AND command_id = ?3
           AND state = 'applying'`,
      )
      .bind(
        this.#organizationId,
        this.#eventId,
        commandId,
        JSON.stringify({ ...result, outcome: "applied" }),
        new Date().toISOString(),
      )
      .run();
    if (completed.meta.changes !== 1) {
      const winner = await this.#receipt(commandId);
      if (winner?.state === "complete" && winner.result_json) {
        const stored = reviewOperationsCommandResultSchema.parse(
          JSON.parse(winner.result_json) as unknown,
        );
        return { ...stored, outcome: "replayed" };
      }
      throw new Error("Review command completion was not durable.");
    }
    return result;
  }

  async #operation(
    command: ReviewOperationsCommand | ReviewScoringCommand,
  ): Promise<BaseAuthorityCommand> {
    if (command.type === "publish_rubric") return this.#publishRubric(command);
    if (command.type === "upsert_group") return this.#upsertGroup(command);
    if (command.type === "assign_reviewer")
      return this.#assignReviewer(command);
    if (command.type === "remove_assignment")
      return this.#removeAssignment(command);
    if (command.type === "disclose_conflict")
      return this.#discloseConflict(command);
    if (command.type === "save_review_draft")
      return this.#writeReview(command, false);
    if (command.type === "submit_review")
      return this.#writeReview(command, true);
    return this.#reopenReview(command);
  }

  async #publishRubric(
    command: Extract<ReviewOperationsCommand, { type: "publish_rubric" }>,
  ): Promise<BaseAuthorityCommand> {
    const rubric = await this.#rubric(command.rubricId);
    if (!rubric || rubric.status !== "active") {
      throw new ReviewOperationsNotFoundError(
        "The active rubric does not exist.",
      );
    }
    this.#version(command.expectedVersion, rubric.source_version);
    const criteria = reviewCriteriaSchema.parse(command.criteria);
    const nextVersion = rubric.rubric_version + 1;
    return this.#authorityCommand(
      command.commandId,
      command.rubricId,
      command.expectedVersion,
      {
        "Criteria snapshot JSON": JSON.stringify(criteria),
        Name: command.name,
        Status: "active",
        Version: nextVersion,
      },
      "reviews.rubric.publish",
      "rubrics",
      {
        criterionCount: criteria.length,
        fromVersion: rubric.rubric_version,
        rubricId: rubric.id,
        toVersion: nextVersion,
      },
    );
  }

  async #upsertGroup(
    command: Extract<ReviewOperationsCommand, { type: "upsert_group" }>,
  ): Promise<BaseAuthorityCommand> {
    const [group, event] = await Promise.all([
      this.#group(command.groupId),
      this.#event(),
    ]);
    this.#version(command.expectedVersion, group?.source_version ?? 0);
    const route = await this.#database
      .prepare(
        `SELECT 1 AS valid FROM p_tracks
         WHERE organization_id = ?1 AND event_id = ?2 AND route_key = ?3
           AND default_reviewer_group_id = ?4 AND source_deleted_at IS NULL
         LIMIT 1`,
      )
      .bind(
        this.#organizationId,
        this.#eventId,
        command.routeKey,
        command.groupId,
      )
      .first<{ valid: number }>();
    if (!route) {
      throw new ReviewOperationsValidationError(
        "routeKey",
        "The reviewer group must match a canonical CFP route and its configured group ID.",
      );
    }
    await this.#validateReviewers(command.memberIds);
    return this.#authorityCommand(
      command.commandId,
      command.groupId,
      command.expectedVersion,
      {
        ...(group ? {} : { Event: [event.source_record_id] }),
        "Member IDs JSON": JSON.stringify(command.memberIds),
        Name: command.name,
        "Route key": command.routeKey,
        Status: command.status,
      },
      "reviews.group.upsert",
      "reviewer_groups",
      {
        groupId: command.groupId,
        memberCount: command.memberIds.length,
        routeKey: command.routeKey,
        status: command.status,
      },
    );
  }

  async #assignReviewer(
    command: Extract<ReviewOperationsCommand, { type: "assign_reviewer" }>,
  ): Promise<BaseAuthorityCommand> {
    const [existing, submission, reviewer, group, rubric] = await Promise.all([
      this.#assignment(command.assignmentId),
      this.#submission(command.submissionId),
      this.#reviewer(command.reviewerId),
      this.#group(command.reviewerGroupId),
      this.#activeRubric(),
    ]);
    if (!submission)
      throw new ReviewOperationsNotFoundError("The submission does not exist.");
    if (!reviewer)
      throw new ReviewOperationsNotFoundError("The reviewer does not exist.");
    if (!group || group.status !== "active") {
      throw new ReviewOperationsNotFoundError(
        "The reviewer group does not exist.",
      );
    }
    this.#version(command.expectedVersion, existing?.source_version ?? 0);
    if (
      existing &&
      (existing.submission_id !== command.submissionId ||
        existing.reviewer_id !== command.reviewerId)
    ) {
      throw new ReviewOperationsValidationError(
        "assignmentId",
        "An assignment ID cannot be reused for another reviewer or submission.",
      );
    }
    if (existing?.status === "submitted") {
      throw new ReviewOperationsValidationError(
        "assignmentId",
        "A submitted assignment cannot be replaced or restored.",
      );
    }
    if (
      submission.default_reviewer_group_id !== command.reviewerGroupId ||
      submission.route_key !== group.route_key
    ) {
      throw new ReviewOperationsValidationError(
        "reviewerGroupId",
        "The assignment group does not match the submission's canonical CFP route.",
      );
    }
    if (!parseMemberIds(group.member_ids_json).includes(command.reviewerId)) {
      throw new ReviewOperationsValidationError(
        "reviewerId",
        "The reviewer is not an active member of the routed reviewer group.",
      );
    }
    const duplicate = await this.#database
      .prepare(
        `SELECT id FROM p_reviews
         WHERE organization_id = ?1 AND event_id = ?2
           AND submission_id = ?3 AND reviewer_id = ?4
           AND id != ?5 AND source_deleted_at IS NULL LIMIT 1`,
      )
      .bind(
        this.#organizationId,
        this.#eventId,
        command.submissionId,
        command.reviewerId,
        command.assignmentId,
      )
      .first<{ id: string }>();
    if (duplicate) {
      throw new ReviewOperationsValidationError(
        "reviewerId",
        "This reviewer already has an assignment for the submission.",
      );
    }
    const assignedAt = new Date().toISOString();
    const rubricSnapshot = {
      criteria: await this.#rubricCriteria(rubric),
      id: rubric.id,
      name: rubric.name,
      version: rubric.rubric_version,
    };
    return this.#authorityCommand(
      command.commandId,
      command.assignmentId,
      command.expectedVersion,
      {
        ...(existing
          ? {}
          : {
              Submission: [submission.source_record_id],
              "Reviewer membership": [reviewer.source_record_id],
            }),
        "Assigned at": assignedAt,
        Conflict: false,
        "Conflict note": "",
        "Reviewer group ID": command.reviewerGroupId,
        "Rubric snapshot JSON": JSON.stringify(rubricSnapshot),
        "Rubric version": rubric.rubric_version,
        "Scoring required": true,
        "Score snapshot JSON": "[]",
        "Reviewer note": "",
        Status: "assigned",
        "Submitted at": null,
      },
      existing ? "reviews.assignment.restore" : "reviews.assignment.create",
      "reviews",
      {
        assignmentId: command.assignmentId,
        reviewerGroupId: command.reviewerGroupId,
        reviewerId: command.reviewerId,
        rubricVersion: rubric.rubric_version,
        submissionId: command.submissionId,
      },
    );
  }

  async #removeAssignment(
    command: Extract<ReviewOperationsCommand, { type: "remove_assignment" }>,
  ): Promise<BaseAuthorityCommand> {
    const assignment = await this.#assignment(command.assignmentId);
    if (!assignment) throw new ReviewOperationsNotFoundError();
    this.#version(command.expectedVersion, assignment.source_version);
    if (assignment.status === "submitted") {
      throw new ReviewOperationsValidationError(
        "assignmentId",
        "A submitted assignment cannot be removed.",
      );
    }
    return this.#authorityCommand(
      command.commandId,
      command.assignmentId,
      command.expectedVersion,
      {
        "Scoring required": false,
        Status: "withdrawn",
      },
      "reviews.assignment.remove",
      "reviews",
      {
        assignmentId: command.assignmentId,
        reviewerId: assignment.reviewer_id,
        submissionId: assignment.submission_id,
      },
    );
  }

  async #discloseConflict(
    command: Extract<ReviewOperationsCommand, { type: "disclose_conflict" }>,
  ): Promise<BaseAuthorityCommand> {
    const assignment = await this.#assignment(command.assignmentId);
    if (!assignment) throw new ReviewOperationsNotFoundError();
    if (
      this.#permittedReviewerId !== undefined &&
      assignment.reviewer_id !== this.#permittedReviewerId
    ) {
      throw new ReviewOperationsNotFoundError();
    }
    this.#version(command.expectedVersion, assignment.source_version);
    if (assignment.status === "submitted") {
      throw new ReviewOperationsValidationError(
        "assignmentId",
        "A conflict cannot replace a submitted review.",
      );
    }
    return this.#authorityCommand(
      command.commandId,
      command.assignmentId,
      command.expectedVersion,
      {
        Conflict: true,
        "Conflict note": command.note,
        "Scoring required": false,
        Status: "withdrawn",
      },
      "reviews.assignment.conflict",
      "reviews",
      {
        assignmentId: command.assignmentId,
        noteLength: command.note.length,
        organizerAlerted: true,
        reviewerId: assignment.reviewer_id,
        submissionId: assignment.submission_id,
      },
    );
  }

  async #writeReview(
    command: Extract<
      ReviewScoringCommand,
      { type: "save_review_draft" | "submit_review" }
    >,
    submit: boolean,
  ): Promise<BaseAuthorityCommand> {
    const assignment = await this.#assignment(command.assignmentId);
    if (!assignment) throw new ReviewOperationsNotFoundError();
    if (
      this.#permittedReviewerId === undefined ||
      assignment.reviewer_id !== this.#permittedReviewerId
    ) {
      throw new ReviewOperationsNotFoundError();
    }
    this.#version(command.expectedVersion, assignment.source_version);
    if (
      assignment.status === "withdrawn" ||
      assignment.conflict === 1 ||
      assignment.scoring_required !== 1
    ) {
      throw new ReviewOperationsValidationError(
        "assignmentId",
        "This assignment no longer accepts a review.",
      );
    }
    if (assignment.status === "submitted") {
      throw new ReviewOperationsValidationError(
        "assignmentId",
        "A submitted review is read-only until an organizer reopens it.",
      );
    }
    if (!assignment.rubric_snapshot_json) {
      throw new ReviewOperationsValidationError(
        "assignmentId",
        "The assignment rubric snapshot is unavailable.",
      );
    }
    let rubric;
    try {
      rubric = reviewAssignmentSchema.shape.rubric.parse(
        JSON.parse(assignment.rubric_snapshot_json) as unknown,
      );
    } catch {
      throw new ReviewOperationsValidationError(
        "assignmentId",
        "The assignment rubric snapshot is unavailable.",
      );
    }
    const draft = reviewDraftSchema.parse(command.draft);
    const criterionIds = new Set(rubric.criteria.map(({ id }) => id));
    if (
      draft.scores.some(({ criterionId }) => !criterionIds.has(criterionId))
    ) {
      throw new ReviewOperationsValidationError(
        "draft.scores",
        "Scores must use the assignment's rubric snapshot.",
      );
    }
    if (submit && draft.scores.length !== criterionIds.size) {
      throw new ReviewOperationsValidationError(
        "draft.scores",
        "Score every rubric criterion before submitting the review.",
      );
    }
    const hasDraft = draft.note.length > 0 || draft.scores.length > 0;
    const submittedAt = submit ? new Date().toISOString() : null;
    return this.#authorityCommand(
      command.commandId,
      command.assignmentId,
      command.expectedVersion,
      {
        "Reviewer note": draft.note,
        "Score snapshot JSON": JSON.stringify(draft.scores),
        Status: submit ? "submitted" : hasDraft ? "draft" : "assigned",
        "Submitted at": submittedAt,
      },
      submit ? "reviews.review.submit" : "reviews.review.draft",
      "reviews",
      {
        assignmentId: command.assignmentId,
        complete: draft.scores.length === criterionIds.size,
        noteLength: draft.note.length,
        scoredCriterionCount: draft.scores.length,
        ...(submittedAt ? { submittedAt } : {}),
      },
    );
  }

  async #reopenReview(
    command: Extract<ReviewScoringCommand, { type: "reopen_review" }>,
  ): Promise<BaseAuthorityCommand> {
    if (this.#permittedReviewerId !== undefined) {
      throw new ReviewOperationsNotFoundError();
    }
    const assignment = await this.#assignment(command.assignmentId);
    if (!assignment) throw new ReviewOperationsNotFoundError();
    this.#version(command.expectedVersion, assignment.source_version);
    if (assignment.status !== "submitted") {
      throw new ReviewOperationsValidationError(
        "assignmentId",
        "Only a submitted review can be reopened.",
      );
    }
    return this.#authorityCommand(
      command.commandId,
      command.assignmentId,
      command.expectedVersion,
      {
        Status: "draft",
        "Submitted at": null,
      },
      "reviews.review.reopen",
      "reviews",
      {
        assignmentId: command.assignmentId,
        reason: command.reason,
        reviewerId: assignment.reviewer_id,
        submissionId: assignment.submission_id,
      },
    );
  }

  #authorityCommand(
    commandId: string,
    entityId: string,
    expectedVersion: number,
    fields: BaseAuthorityCommand["fields"],
    operation: string,
    table: BaseAuthorityCommand["table"],
    safeDiff: Record<string, unknown>,
  ): BaseAuthorityCommand {
    return {
      audit: {
        action: operation,
        actorId: this.#actorId,
        actorType: "user",
        eventId: this.#eventId,
        requestId: this.#requestId,
        safeDiff,
      },
      commandId,
      entityId,
      expectedVersion,
      fields,
      operation,
      organizationId: this.#organizationId,
      table,
    };
  }

  #version(expected: number, actual: number): void {
    if (expected !== actual)
      throw new ReviewOperationsVersionConflictError(expected, actual);
  }

  async #event(): Promise<EntityRow> {
    const row = await this.#database
      .prepare(
        `SELECT source_record_id, source_version FROM p_events
         WHERE organization_id = ?1 AND id = ?2 AND source_deleted_at IS NULL LIMIT 1`,
      )
      .bind(this.#organizationId, this.#eventId)
      .first<EntityRow>();
    if (!row)
      throw new ReviewOperationsNotFoundError("The event does not exist.");
    return row;
  }

  async #rubric(id: string): Promise<RubricRow | null> {
    return this.#database
      .prepare(
        `SELECT id, name, status, rubric_version, criteria_snapshot_json,
                source_record_id, source_version
         FROM p_rubrics WHERE organization_id = ?1 AND event_id = ?2 AND id = ?3
           AND source_deleted_at IS NULL LIMIT 1`,
      )
      .bind(this.#organizationId, this.#eventId, id)
      .first<RubricRow>();
  }

  async #activeRubric(): Promise<RubricRow> {
    const rows = await this.#database
      .prepare(
        `SELECT id, name, status, rubric_version, criteria_snapshot_json,
                source_record_id, source_version
         FROM p_rubrics WHERE organization_id = ?1 AND event_id = ?2
           AND status = 'active' AND source_deleted_at IS NULL
         ORDER BY rubric_version DESC, id DESC LIMIT 2`,
      )
      .bind(this.#organizationId, this.#eventId)
      .all<RubricRow>();
    if (rows.results.length !== 1 || !rows.results[0]) {
      throw new ReviewOperationsValidationError(
        "rubricId",
        "The event must have exactly one active rubric.",
      );
    }
    return rows.results[0];
  }

  async #rubricCriteria(rubric: RubricRow) {
    try {
      return reviewCriteriaSchema.parse(
        JSON.parse(rubric.criteria_snapshot_json) as unknown,
      );
    } catch {
      const result = await this.#database
        .prepare(
          `SELECT id, label, guidance, weight
           FROM p_criteria
           WHERE organization_id = ?1 AND event_id = ?2 AND rubric_id = ?3
             AND source_deleted_at IS NULL
           ORDER BY sort_order, id LIMIT 6`,
        )
        .bind(this.#organizationId, this.#eventId, rubric.id)
        .all<{
          guidance: string | null;
          id: string;
          label: string;
          weight: number;
        }>();
      return reviewCriteriaSchema.parse(
        result.results.map((criterion) => ({
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
  }

  async #group(id: string): Promise<GroupRow | null> {
    return this.#database
      .prepare(
        `SELECT id, route_key, member_ids_json, status, source_record_id, source_version
         FROM p_reviewer_groups
         WHERE organization_id = ?1 AND event_id = ?2 AND id = ?3
           AND source_deleted_at IS NULL LIMIT 1`,
      )
      .bind(this.#organizationId, this.#eventId, id)
      .first<GroupRow>();
  }

  async #submission(id: string): Promise<SubmissionRow | null> {
    return this.#database
      .prepare(
        `SELECT source_record_id, source_version, default_reviewer_group_id, route_key
         FROM p_submissions
         WHERE organization_id = ?1 AND event_id = ?2 AND id = ?3
           AND source_deleted_at IS NULL LIMIT 1`,
      )
      .bind(this.#organizationId, this.#eventId, id)
      .first<SubmissionRow>();
  }

  async #reviewer(id: string): Promise<ReviewerRow | null> {
    return this.#database
      .prepare(
        `SELECT membership.id, membership.source_record_id, membership.source_version
         FROM p_event_contacts AS membership
         WHERE membership.organization_id = ?1 AND membership.event_id = ?2
           AND membership.id = ?3 AND membership.source_deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM json_each(membership.roles_json)
             WHERE json_each.value = 'reviewer'
           ) LIMIT 1`,
      )
      .bind(this.#organizationId, this.#eventId, id)
      .first<ReviewerRow>();
  }

  async #validateReviewers(ids: readonly string[]): Promise<void> {
    const result = await this.#database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM p_event_contacts AS membership
         WHERE membership.organization_id = ?1 AND membership.event_id = ?2
           AND membership.id IN (SELECT value FROM json_each(?3))
           AND membership.source_deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM json_each(membership.roles_json)
             WHERE json_each.value = 'reviewer'
           )`,
      )
      .bind(this.#organizationId, this.#eventId, JSON.stringify(ids))
      .first<{ count: number }>();
    if (result?.count !== ids.length) {
      throw new ReviewOperationsValidationError(
        "memberIds",
        "Every reviewer group member must be an active reviewer for this event.",
      );
    }
  }

  async #assignment(id: string): Promise<AssignmentRow | null> {
    return this.#database
      .prepare(
        `SELECT id, submission_id, reviewer_id, status, conflict,
                rubric_snapshot_json, scoring_required,
                source_record_id, source_version
         FROM p_reviews
         WHERE organization_id = ?1 AND event_id = ?2 AND id = ?3
           AND source_deleted_at IS NULL LIMIT 1`,
      )
      .bind(this.#organizationId, this.#eventId, id)
      .first<AssignmentRow>();
  }

  async #entityVersion(
    table: BaseAuthorityCommand["table"],
    id: string,
  ): Promise<number | null> {
    const projectedTable =
      table === "reviews"
        ? "p_reviews"
        : table === "reviewer_groups"
          ? "p_reviewer_groups"
          : "p_rubrics";
    const row = await this.#database
      .prepare(
        `SELECT source_version FROM ${projectedTable}
         WHERE organization_id = ?1 AND event_id = ?2 AND id = ?3
           AND source_deleted_at IS NULL LIMIT 1`,
      )
      .bind(this.#organizationId, this.#eventId, id)
      .first<{ source_version: number }>();
    return row?.source_version ?? null;
  }
}
