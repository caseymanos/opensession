import {
  taskAssignmentSchema,
  taskBackfillPreviewSchema,
  taskCommandResponseSchema,
  taskDefinitionSchema,
  taskReadinessResponseSchema,
  type TaskAcceptanceMaterializationCommand,
  type TaskAssignment,
  type TaskAssignmentTransitionCommand,
  type TaskBackfillPreview,
  type TaskBackfillPreviewRequest,
  type TaskCommandResponse,
  type TaskDefinition,
  type TaskDefinitionCommand,
  type TaskReadinessResponse,
} from "@sessionbox-killer/contracts/tasks";
import {
  applicableTaskAssignments,
  previewTaskBackfill,
  TaskDomainError,
  transitionTaskAssignment,
  type TaskAssignmentDraft as DomainAssignmentDraft,
  type TaskAssignmentIdentity as DomainAssignmentIdentity,
  type TaskTargetingSnapshot,
} from "@sessionbox-killer/domain/tasks";

import {
  AuthorityOutcomeUnknownError,
  parseBaseAuthorityCommand,
  type AuthorityResponse,
  type BaseAuthorityCommand,
} from "../authority/types.js";
import {
  assignmentProviderStatus,
  assignmentResponseJson,
  contractTaskAssignment,
  domainTaskAssignment,
  domainTaskDefinition,
  readinessForAssignments,
  taskAssignmentFromRow,
  taskDefinitionConfigurationFields,
  taskDefinitionFromRow,
  taskDefinitionPolicyJson,
  type TaskAssignmentRow,
  type TaskDefinitionRow,
} from "./model.js";

const maximumAssignments = 5_000;
const maximumDefinitions = 500;
const maximumSpeakers = 5_000;
const receiptLifetimeMilliseconds = 90 * 24 * 60 * 60 * 1_000;

export interface TaskEventScope {
  readonly eventId: string;
  readonly eventRecordId: string;
  readonly organizationId: string;
  readonly slug: string;
  readonly timezone: string;
}

export interface TaskCommandActor {
  readonly actorId: string | null;
  readonly auditActorType: "api_key" | "portal" | "system" | "user";
  readonly domainActorType: "organizer" | "speaker" | "system";
}

interface TaskAuthority {
  execute(value: unknown): Promise<AuthorityResponse>;
}

interface TaskServiceOptions {
  readonly authority: TaskAuthority | (() => TaskAuthority);
  readonly database: D1Database;
  readonly now?: () => Date;
}

interface EventContactRow {
  contact_id: string;
  display_name: string;
  email_normalized: string;
  roles_json: string;
  source_record_id: string;
}

interface SessionRow {
  format_id: string | null;
  id: string;
  source_record_id: string;
  status: "accepted" | "published" | "scheduled";
  track_id: string | null;
}

interface ParticipantRow {
  contact_id: string;
  role: "chair" | "moderator" | "speaker";
  session_id: string;
}

interface SourceRecordRow {
  id: string;
  source_record_id: string;
}

interface TaskPlanReceiptRow {
  original_response_json: string | null;
  request_hash: string;
  status:
    "committed" | "committed_with_repair" | "failed" | "pending" | "unknown";
}

interface StoredTaskPlan {
  boundaryId: string;
  operations: BaseAuthorityCommand[];
  repairPending: boolean;
  result: {
    assignment_ids: string[];
    boundary_id: string;
    created_count: number;
  };
  version: 1;
}

export class TaskNotFoundError extends Error {
  constructor(entity: string) {
    super(`${entity} was not found in this event.`);
    this.name = "TaskNotFoundError";
  }
}

export class TaskVersionConflictError extends Error {
  readonly actualVersion: number | null;
  readonly expectedVersion: number;

  constructor(expectedVersion: number, actualVersion: number | null) {
    super(
      actualVersion === null
        ? `Task version conflict at the business-data authority; refresh version ${expectedVersion} before retrying.`
        : `Task version conflict: expected ${expectedVersion}, found ${actualVersion}.`,
    );
    this.name = "TaskVersionConflictError";
    this.actualVersion = actualVersion;
    this.expectedVersion = expectedVersion;
  }
}

export class TaskIdempotencyConflictError extends Error {
  constructor(commandId: string) {
    super(`Task command ${commandId} was reused with a different request.`);
    this.name = "TaskIdempotencyConflictError";
  }
}

export class TaskPreviewConflictError extends Error {
  constructor() {
    super("Task targeting changed after the backfill preview was created.");
    this.name = "TaskPreviewConflictError";
  }
}

export class TaskAuthorityPendingError extends Error {
  readonly retryable = true;

  constructor(commandId: string) {
    super(`Task authority command ${commandId} has an unresolved outcome.`);
    this.name = "TaskAuthorityPendingError";
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Value is not serializable.");
  return encoded;
}

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(value)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function parseRoles(value: string): ("chair" | "moderator" | "speaker")[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Task contact roles are invalid.");
  }
  if (!Array.isArray(parsed))
    throw new Error("Task contact roles are invalid.");
  return parsed.filter(
    (role): role is "chair" | "moderator" | "speaker" =>
      role === "chair" || role === "moderator" || role === "speaker",
  );
}

function definitionRowQuery(): string {
  return `SELECT id, event_id, name, type, description, required_default,
                 approval_required, target_rule_json, form_schema_json,
                 file_policy_json, source_record_id, source_version
          FROM p_task_definitions
          WHERE organization_id = ?1 AND event_id = ?2
            AND source_deleted_at IS NULL`;
}

function assignmentRowQuery(): string {
  return `SELECT assignment.id, assignment.event_id, assignment.definition_id,
                 assignment.contact_id, assignment.session_id,
                 assignment.due_at, assignment.required, assignment.status,
                 assignment.completed_at, assignment.approved_at,
                 assignment.response_json, assignment.source_record_id,
                 assignment.source_version,
                 definition.approval_required
          FROM p_task_assignments assignment
          JOIN p_task_definitions definition
            ON definition.organization_id = assignment.organization_id
           AND definition.event_id = assignment.event_id
           AND definition.id = assignment.definition_id
           AND definition.source_deleted_at IS NULL
          WHERE assignment.organization_id = ?1 AND assignment.event_id = ?2
            AND assignment.source_deleted_at IS NULL`;
}

function assignmentIdentity(
  assignment: TaskAssignment,
): DomainAssignmentIdentity {
  return {
    assignmentId: assignment.assignment_id,
    contactId: assignment.contact_id,
    definitionId: assignment.definition_id,
    eventId: assignment.event_id,
    sessionId: assignment.session_id,
  };
}

function identityKey(
  identity: Pick<
    DomainAssignmentIdentity,
    "contactId" | "definitionId" | "sessionId"
  >,
): string {
  return `${identity.definitionId}:${identity.contactId}:${identity.sessionId ?? ""}`;
}

function draftContract(draft: DomainAssignmentDraft) {
  return {
    approval_required: draft.approvalRequired,
    assignment_id: draft.assignmentId,
    contact_id: draft.contactId,
    definition_id: draft.definitionId,
    due_at: draft.dueAt,
    event_id: draft.eventId,
    required: draft.required,
    session_id: draft.sessionId,
    state: draft.state,
  };
}

function identityContract(identity: DomainAssignmentIdentity) {
  return {
    assignment_id: identity.assignmentId,
    contact_id: identity.contactId,
    definition_id: identity.definitionId,
    event_id: identity.eventId,
    session_id: identity.sessionId,
  };
}

function storedPlan(value: string | null): StoredTaskPlan {
  if (!value) throw new Error("Task plan receipt is incomplete.");
  const parsed = JSON.parse(value) as Partial<StoredTaskPlan>;
  if (
    parsed.version !== 1 ||
    typeof parsed.boundaryId !== "string" ||
    !Array.isArray(parsed.operations) ||
    typeof parsed.repairPending !== "boolean" ||
    !parsed.result
  ) {
    throw new Error("Task plan receipt is invalid.");
  }
  return {
    boundaryId: parsed.boundaryId,
    operations: parsed.operations.map(parseBaseAuthorityCommand),
    repairPending: parsed.repairPending,
    result: parsed.result,
    version: 1,
  };
}

function providerFailure(
  error: unknown,
  commandId: string,
  expectedVersion: number,
): never {
  const name = error instanceof Error ? error.name : null;
  if (
    error instanceof AuthorityOutcomeUnknownError ||
    name === "AuthorityOutcomeUnknownError"
  ) {
    throw new TaskAuthorityPendingError(commandId);
  }
  if (name === "AirtableVersionConflictError") {
    throw new TaskVersionConflictError(expectedVersion, null);
  }
  if (
    name === "AirtableIdempotencyConflictError" ||
    name === "AuthorityIdempotencyConflictError"
  ) {
    throw new TaskIdempotencyConflictError(commandId);
  }
  throw error;
}

export class TaskReadService {
  readonly #database: D1Database;
  readonly #now: () => Date;

  constructor(database: D1Database, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#now = now;
  }

  async definitions(event: TaskEventScope): Promise<TaskDefinition[]> {
    const result = await this.#database
      .prepare(`${definitionRowQuery()} ORDER BY name, id LIMIT ?3`)
      .bind(event.organizationId, event.eventId, maximumDefinitions + 1)
      .all<TaskDefinitionRow>();
    if (result.results.length > maximumDefinitions) {
      throw new Error("Task definition projection exceeds its bounded limit.");
    }
    return result.results.map(taskDefinitionFromRow);
  }

  async assignments(
    event: TaskEventScope,
    contactId?: string,
  ): Promise<TaskAssignment[]> {
    const result = await this.#database
      .prepare(
        `${assignmentRowQuery()}
         ${contactId ? "AND assignment.contact_id = ?3" : ""}
         ORDER BY assignment.due_at, assignment.id LIMIT ?${contactId ? 4 : 3}`,
      )
      .bind(
        event.organizationId,
        event.eventId,
        ...(contactId
          ? [contactId, maximumAssignments + 1]
          : [maximumAssignments + 1]),
      )
      .all<TaskAssignmentRow>();
    if (result.results.length > maximumAssignments) {
      throw new Error("Task assignment projection exceeds its bounded limit.");
    }
    return result.results.map(taskAssignmentFromRow);
  }

  async readiness(event: TaskEventScope): Promise<TaskReadinessResponse> {
    const now = this.#now();
    const [contactResult, assignments, participantResult] = await Promise.all([
      this.#database
        .prepare(
          `SELECT event_contact.contact_id, event_contact.roles_json,
                  contact.display_name, contact.email_normalized,
                  contact.source_record_id
           FROM p_event_contacts event_contact
           JOIN p_contacts contact
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
           ORDER BY contact.display_name, event_contact.contact_id LIMIT ?3`,
        )
        .bind(event.organizationId, event.eventId, maximumSpeakers + 1)
        .all<EventContactRow>(),
      this.assignments(event),
      this.#database
        .prepare(
          `SELECT contact_id, session_id, role
           FROM p_session_participants
           WHERE organization_id = ?1 AND event_id = ?2
             AND confirmed_state != 'declined' AND source_deleted_at IS NULL
           ORDER BY contact_id, session_id LIMIT ?3`,
        )
        .bind(event.organizationId, event.eventId, maximumAssignments + 1)
        .all<ParticipantRow>(),
    ]);
    if (
      contactResult.results.length > maximumSpeakers ||
      participantResult.results.length > maximumAssignments
    ) {
      throw new Error("Task readiness projection exceeds its bounded limit.");
    }
    const assignmentsByContact = new Map<string, TaskAssignment[]>();
    for (const assignment of assignments) {
      const current = assignmentsByContact.get(assignment.contact_id) ?? [];
      current.push(assignment);
      assignmentsByContact.set(assignment.contact_id, current);
    }
    const sessionsByContact = new Map<string, Set<string>>();
    for (const participant of participantResult.results) {
      const current =
        sessionsByContact.get(participant.contact_id) ?? new Set();
      current.add(participant.session_id);
      sessionsByContact.set(participant.contact_id, current);
    }
    return taskReadinessResponseSchema.parse({
      event_id: event.eventId,
      generated_at: now.toISOString(),
      speakers: contactResult.results.map((contact) => {
        const contactAssignments =
          assignmentsByContact.get(contact.contact_id) ?? [];
        return {
          assignments: contactAssignments,
          contact_id: contact.contact_id,
          display_name: contact.display_name,
          email: contact.email_normalized,
          readiness: readinessForAssignments(
            contactAssignments,
            event.timezone,
            now,
          ),
          session_ids: [
            ...(sessionsByContact.get(contact.contact_id) ?? []),
          ].sort(),
        };
      }),
      timezone: event.timezone,
    });
  }
}

export class TaskAuthorityService {
  readonly #authority: () => TaskAuthority;
  readonly #database: D1Database;
  readonly #now: () => Date;
  readonly #reads: TaskReadService;

  constructor(options: TaskServiceOptions) {
    const authority = options.authority;
    this.#authority =
      typeof authority === "function" ? authority : () => authority;
    this.#database = options.database;
    this.#now = options.now ?? (() => new Date());
    this.#reads = new TaskReadService(options.database, this.#now);
  }

  reads(): TaskReadService {
    return this.#reads;
  }

  async previewBackfill(
    event: TaskEventScope,
    request: TaskBackfillPreviewRequest,
  ): Promise<TaskBackfillPreview> {
    const current = await this.#definitionRow(event, request.definition.id);
    const actualVersion = current?.source_version ?? 0;
    if (actualVersion !== request.expected_version) {
      throw new TaskVersionConflictError(
        request.expected_version,
        actualVersion,
      );
    }
    const proposed = taskDefinitionSchema.parse({
      ...request.definition,
      event_id: event.eventId,
      version: request.expected_version + 1,
    });
    const [snapshot, existing] = await Promise.all([
      this.#targetingSnapshot(event),
      this.#reads.assignments(event),
    ]);
    const preview = await previewTaskBackfill(
      [domainTaskDefinition(proposed)],
      snapshot,
      event.timezone,
      existing
        .filter(({ definition_id }) => definition_id === proposed.id)
        .map(assignmentIdentity),
    );
    return taskBackfillPreviewSchema.parse({
      create: preview.create.map(draftContract),
      no_longer_targeted: preview.noLongerTargeted.map(identityContract),
      policy: preview.policy,
      preserve: preview.preserve.map(identityContract),
      preview_id: preview.previewId,
    });
  }

  async upsertDefinition(
    event: TaskEventScope,
    command: TaskDefinitionCommand,
    actor: TaskCommandActor,
    requestId: string,
  ): Promise<TaskCommandResponse> {
    const configuration = taskDefinitionConfigurationFields(command.definition);
    const authorityCommand = {
      audit: {
        action: "tasks.definition.upsert",
        ...(actor.actorId ? { actorId: actor.actorId } : {}),
        actorType: actor.auditActorType,
        eventId: event.eventId,
        requestId,
        safeDiff: {
          approvalRequired: command.definition.approval_required,
          assignmentScope: command.definition.target.assignment_scope,
          backfillPolicy: "additive_preserve_existing",
          backfillPreviewId: command.backfill_preview_id,
          kind: command.definition.configuration.kind,
          required: command.definition.required,
          targetChangePreviewed: command.backfill_preview_id !== null,
        },
      },
      commandId: command.command_id,
      entityId: command.definition.id,
      expectedVersion: command.expected_version,
      fields: {
        "Approval required": command.definition.approval_required,
        Description: command.definition.description,
        Event: [event.eventRecordId],
        "File policy JSON": configuration.filePolicyJson,
        "Form schema JSON": configuration.formSchemaJson,
        Name: command.definition.name,
        "Required default": command.definition.required,
        "Target rule JSON": taskDefinitionPolicyJson(command.definition),
        Type: command.definition.configuration.kind,
      },
      operation: "tasks.definition.upsert",
      organizationId: event.organizationId,
      table: "task_definitions",
    } satisfies BaseAuthorityCommand;
    const authorityReceipt = await this.#hasIdempotencyReceipt(
      event,
      authorityCommand.operation,
      authorityCommand.commandId,
    );
    let response: AuthorityResponse;
    let preview: TaskBackfillPreview;
    if (authorityReceipt) {
      try {
        response = await this.#authority().execute(authorityCommand);
      } catch (error) {
        providerFailure(
          error,
          authorityCommand.commandId,
          authorityCommand.expectedVersion,
        );
      }
      if (
        await this.#hasIdempotencyReceipt(
          event,
          "tasks.definition.backfill",
          command.command_id,
        )
      ) {
        const plan = await this.#executePlan(
          event,
          "tasks.definition.backfill",
          command.command_id,
          command,
          command.backfill_preview_id ?? command.definition.id,
          [],
          [],
        );
        return taskCommandResponseSchema.parse({
          ok: true,
          repair_pending:
            response.projection === "repair_pending" || plan.repairPending,
          replayed: true,
          result: {
            ...command.definition,
            event_id: event.eventId,
            version: response.authority.sourceVersion,
          },
        });
      }
      const proposed = taskDefinitionSchema.parse({
        ...command.definition,
        event_id: event.eventId,
        version: response.authority.sourceVersion,
      });
      const [snapshot, existing] = await Promise.all([
        this.#targetingSnapshot(event),
        this.#reads.assignments(event),
      ]);
      const resumedPreview = await previewTaskBackfill(
        [domainTaskDefinition(proposed)],
        snapshot,
        event.timezone,
        existing
          .filter(({ definition_id }) => definition_id === proposed.id)
          .map(assignmentIdentity),
      );
      preview = taskBackfillPreviewSchema.parse({
        create: resumedPreview.create.map(draftContract),
        no_longer_targeted:
          resumedPreview.noLongerTargeted.map(identityContract),
        policy: resumedPreview.policy,
        preserve: resumedPreview.preserve.map(identityContract),
        preview_id: resumedPreview.previewId,
      });
    } else {
      const current = await this.#definitionRow(event, command.definition.id);
      const actualVersion = current?.source_version ?? 0;
      if (actualVersion !== command.expected_version) {
        throw new TaskVersionConflictError(
          command.expected_version,
          actualVersion,
        );
      }
      preview = await this.previewBackfill(event, {
        definition: command.definition,
        expected_version: command.expected_version,
      });
      const currentTarget = current
        ? canonicalJson(taskDefinitionFromRow(current).target)
        : null;
      const targetChanged =
        currentTarget !== null &&
        currentTarget !== canonicalJson(command.definition.target);
      if (targetChanged && command.backfill_preview_id !== preview.preview_id) {
        throw new TaskPreviewConflictError();
      }
      try {
        response = await this.#authority().execute(authorityCommand);
      } catch (error) {
        providerFailure(
          error,
          authorityCommand.commandId,
          authorityCommand.expectedVersion,
        );
      }
    }
    const result = taskDefinitionSchema.parse({
      ...command.definition,
      event_id: event.eventId,
      version: response.authority.sourceVersion,
    });

    let backfillRepairPending = false;
    let backfillReplayed = false;
    if (preview.create.length > 0) {
      const sourceMaps = await this.#sourceMaps(event);
      const operations = await Promise.all(
        preview.create.map((draft) =>
          this.#assignmentOperation(
            event,
            {
              approvalRequired: draft.approval_required,
              assignmentId: draft.assignment_id,
              contactId: draft.contact_id,
              definitionId: draft.definition_id,
              dueAt: draft.due_at,
              eventId: draft.event_id,
              required: draft.required,
              sessionId: draft.session_id,
              state: "incomplete",
            },
            response.authority.recordId,
            sourceMaps,
            `${command.command_id}:${draft.assignment_id}`,
            actor,
            requestId,
          ),
        ),
      );
      const plan = await this.#executePlan(
        event,
        "tasks.definition.backfill",
        command.command_id,
        command,
        preview.preview_id,
        operations,
        preview.create.map(({ assignment_id }) => assignment_id),
      );
      backfillRepairPending = plan.repairPending;
      backfillReplayed = plan.replayed;
    }
    return taskCommandResponseSchema.parse({
      ok: true,
      repair_pending:
        response.projection === "repair_pending" || backfillRepairPending,
      replayed: response.authority.replayed || backfillReplayed,
      result,
    });
  }

  async materializeAcceptance(
    event: TaskEventScope,
    command: TaskAcceptanceMaterializationCommand,
    actor: TaskCommandActor,
    requestId: string,
  ): Promise<TaskCommandResponse> {
    if (
      await this.#hasIdempotencyReceipt(
        event,
        "tasks.materialize.plan",
        command.command_id,
      )
    ) {
      const replay = await this.#executePlan(
        event,
        "tasks.materialize.plan",
        command.command_id,
        command,
        command.acceptance_id,
        [],
        [],
      );
      return taskCommandResponseSchema.parse({
        ok: true,
        repair_pending: replay.repairPending,
        replayed: true,
        result: replay.result,
      });
    }
    const [definitions, snapshot, existing, sourceMaps] = await Promise.all([
      this.#reads.definitions(event),
      this.#targetingSnapshot(event, command.session_ids),
      this.#reads.assignments(event),
      this.#sourceMaps(event),
    ]);
    const applicable = await applicableTaskAssignments(
      definitions.map(domainTaskDefinition),
      snapshot,
      event.timezone,
    );
    const existingKeys = new Set(
      existing.map((value) => identityKey(assignmentIdentity(value))),
    );
    const create = applicable.filter(
      (draft) => !existingKeys.has(identityKey(draft)),
    );
    const definitionsById = new Map(
      (await this.#definitionRows(event)).map((row) => [row.id, row]),
    );
    const operations = await Promise.all(
      create.map(async (draft) => {
        const definition = definitionsById.get(draft.definitionId);
        if (!definition) throw new TaskNotFoundError("Task definition");
        return this.#assignmentOperation(
          event,
          draft,
          definition.source_record_id,
          sourceMaps,
          `${command.command_id}:${draft.assignmentId}`,
          actor,
          requestId,
        );
      }),
    );
    const plan = await this.#executePlan(
      event,
      "tasks.materialize.plan",
      command.command_id,
      command,
      command.acceptance_id,
      operations,
      applicable.map(({ assignmentId }) => assignmentId),
    );
    return taskCommandResponseSchema.parse({
      ok: true,
      repair_pending: plan.repairPending,
      replayed: plan.replayed,
      result: plan.result,
    });
  }

  async transitionAssignment(
    event: TaskEventScope,
    assignmentId: string,
    command: TaskAssignmentTransitionCommand,
    actor: TaskCommandActor,
    requestId: string,
  ): Promise<TaskCommandResponse> {
    const row = await this.#assignmentRow(event, assignmentId);
    if (!row) throw new TaskNotFoundError("Task assignment");
    const current = taskAssignmentFromRow(row);
    const replayEntry = current.history.find(
      ({ command_id }) => command_id === command.command_id,
    );
    if (replayEntry) {
      const normalizedReason = command.reason?.trim() || null;
      if (
        replayEntry.version !== command.expected_version + 1 ||
        replayEntry.to !== command.to ||
        replayEntry.reason !== normalizedReason ||
        replayEntry.actor_id !== actor.actorId ||
        replayEntry.actor_type !== actor.domainActorType
      ) {
        throw new TaskIdempotencyConflictError(command.command_id);
      }
      const original = taskAssignmentSchema.parse({
        ...current,
        history: current.history.filter(
          ({ version }) => version <= replayEntry.version,
        ),
        state: replayEntry.to,
        version: replayEntry.version,
      });
      return taskCommandResponseSchema.parse({
        ok: true,
        repair_pending: false,
        replayed: true,
        result: original,
      });
    }
    const transitionAt = this.#now().toISOString();
    let next;
    try {
      next = transitionTaskAssignment(domainTaskAssignment(current), {
        actorId: actor.actorId,
        actorType: actor.domainActorType,
        at: transitionAt,
        commandId: command.command_id,
        expectedVersion: command.expected_version,
        reason: command.reason,
        to: command.to,
      });
    } catch (error) {
      if (
        error instanceof TaskDomainError &&
        error.code === "version_conflict"
      ) {
        throw new TaskVersionConflictError(
          command.expected_version,
          current.version,
        );
      }
      throw error;
    }
    let response: AuthorityResponse;
    try {
      response = await this.#authority().execute({
        audit: {
          action: "tasks.assignment.transition",
          ...(actor.actorId ? { actorId: actor.actorId } : {}),
          actorType: actor.auditActorType,
          eventId: event.eventId,
          requestId,
          safeDiff: {
            from: current.state,
            reasonPresent: command.reason !== null,
            to: next.state,
            version: next.version,
          },
        },
        commandId: command.command_id,
        entityId: assignmentId,
        expectedVersion: command.expected_version,
        fields: {
          "Approved at": next.state === "approved" ? transitionAt : null,
          "Approved by": [],
          "Completed at":
            next.state === "complete" || next.state === "approved"
              ? transitionAt
              : null,
          "Response JSON": assignmentResponseJson(next),
          Status: assignmentProviderStatus(next.state),
        },
        operation: "tasks.assignment.transition",
        organizationId: event.organizationId,
        table: "task_assignments",
      } satisfies BaseAuthorityCommand);
    } catch (error) {
      providerFailure(error, command.command_id, command.expected_version);
    }
    const result = taskAssignmentSchema.parse({
      ...contractTaskAssignment(next),
      version: response.authority.sourceVersion,
    });
    return taskCommandResponseSchema.parse({
      ok: true,
      repair_pending: response.projection === "repair_pending",
      replayed: response.authority.replayed,
      result,
    });
  }

  async assignmentBelongsToContact(
    event: TaskEventScope,
    assignmentId: string,
    contactId: string,
  ): Promise<boolean> {
    const row = await this.#database
      .prepare(
        `SELECT 1 AS allowed FROM p_task_assignments
         WHERE organization_id = ?1 AND event_id = ?2 AND id = ?3
           AND contact_id = ?4 AND source_deleted_at IS NULL LIMIT 1`,
      )
      .bind(event.organizationId, event.eventId, assignmentId, contactId)
      .first<{ allowed: number }>();
    return row?.allowed === 1;
  }

  async #definitionRows(event: TaskEventScope): Promise<TaskDefinitionRow[]> {
    const result = await this.#database
      .prepare(`${definitionRowQuery()} ORDER BY id LIMIT ?3`)
      .bind(event.organizationId, event.eventId, maximumDefinitions + 1)
      .all<TaskDefinitionRow>();
    if (result.results.length > maximumDefinitions) {
      throw new Error("Task definition projection exceeds its bounded limit.");
    }
    return result.results;
  }

  async #definitionRow(
    event: TaskEventScope,
    id: string,
  ): Promise<TaskDefinitionRow | null> {
    return this.#database
      .prepare(`${definitionRowQuery()} AND id = ?3 LIMIT 1`)
      .bind(event.organizationId, event.eventId, id)
      .first<TaskDefinitionRow>();
  }

  async #assignmentRow(
    event: TaskEventScope,
    id: string,
  ): Promise<TaskAssignmentRow | null> {
    return this.#database
      .prepare(`${assignmentRowQuery()} AND assignment.id = ?3 LIMIT 1`)
      .bind(event.organizationId, event.eventId, id)
      .first<TaskAssignmentRow>();
  }

  async #hasIdempotencyReceipt(
    event: TaskEventScope,
    operation: string,
    commandId: string,
  ): Promise<boolean> {
    const result = await this.#database
      .prepare(
        `SELECT 1 AS present FROM idempotency_keys
         WHERE tenant_key = ?1 AND operation = ?2 AND command_id = ?3 LIMIT 1`,
      )
      .bind(event.organizationId, operation, commandId)
      .first<{ present: number }>();
    return result?.present === 1;
  }

  async #targetingSnapshot(
    event: TaskEventScope,
    sessionIds?: readonly string[],
  ): Promise<TaskTargetingSnapshot> {
    const sessionFilter = sessionIds
      ? "AND session.id IN (SELECT value FROM json_each(?3))"
      : "";
    const sessionResult = await this.#database
      .prepare(
        `SELECT session.id, session.status, session.track_id,
                session.format_id, session.source_record_id
         FROM p_sessions session
         WHERE session.organization_id = ?1 AND session.event_id = ?2
           AND session.status IN ('accepted', 'scheduled', 'published')
           AND session.source_deleted_at IS NULL ${sessionFilter}
         ORDER BY session.id LIMIT ?${sessionIds ? 4 : 3}`,
      )
      .bind(
        event.organizationId,
        event.eventId,
        ...(sessionIds
          ? [JSON.stringify([...sessionIds]), maximumAssignments + 1]
          : [maximumAssignments + 1]),
      )
      .all<SessionRow>();
    if (
      sessionIds &&
      sessionResult.results.length !== new Set(sessionIds).size
    ) {
      throw new TaskNotFoundError("Accepted session");
    }
    const selectedSessionIds = sessionResult.results.map(({ id }) => id);
    const [participantResult, contactResult] = await Promise.all([
      selectedSessionIds.length === 0
        ? Promise.resolve({ results: [] as ParticipantRow[] })
        : this.#database
            .prepare(
              `SELECT contact_id, session_id, role
               FROM p_session_participants
               WHERE organization_id = ?1 AND event_id = ?2
                 AND session_id IN (SELECT value FROM json_each(?3))
                 AND confirmed_state != 'declined' AND source_deleted_at IS NULL
               ORDER BY session_id, sort_order, contact_id LIMIT ?4`,
            )
            .bind(
              event.organizationId,
              event.eventId,
              JSON.stringify(selectedSessionIds),
              maximumAssignments + 1,
            )
            .all<ParticipantRow>(),
      this.#database
        .prepare(
          `SELECT event_contact.contact_id, event_contact.roles_json,
                  contact.display_name, contact.email_normalized,
                  contact.source_record_id
           FROM p_event_contacts event_contact
           JOIN p_contacts contact
             ON contact.organization_id = event_contact.organization_id
            AND contact.id = event_contact.contact_id
            AND contact.source_deleted_at IS NULL
           WHERE event_contact.organization_id = ?1
             AND event_contact.event_id = ?2
             AND event_contact.source_deleted_at IS NULL
           ORDER BY event_contact.contact_id LIMIT ?3`,
        )
        .bind(event.organizationId, event.eventId, maximumSpeakers + 1)
        .all<EventContactRow>(),
    ]);
    if (
      sessionResult.results.length > maximumAssignments ||
      participantResult.results.length > maximumAssignments ||
      contactResult.results.length > maximumSpeakers
    ) {
      throw new Error("Task targeting projection exceeds its bounded limit.");
    }
    const acceptedContactIds = sessionIds
      ? new Set(participantResult.results.map(({ contact_id }) => contact_id))
      : null;
    const participantsBySession = new Map<string, ParticipantRow[]>();
    for (const participant of participantResult.results) {
      const current = participantsBySession.get(participant.session_id) ?? [];
      current.push(participant);
      participantsBySession.set(participant.session_id, current);
    }
    return {
      contacts: contactResult.results
        .filter(
          ({ contact_id }) =>
            acceptedContactIds === null || acceptedContactIds.has(contact_id),
        )
        .map((contact) => ({
          contactId: contact.contact_id,
          roles: parseRoles(contact.roles_json),
        })),
      eventId: event.eventId,
      sessions: sessionResult.results.map((session) => ({
        formatId: session.format_id,
        participants: (participantsBySession.get(session.id) ?? []).map(
          (participant) => ({
            contactId: participant.contact_id,
            role: participant.role,
          }),
        ),
        sessionId: session.id,
        state: session.status,
        trackId: session.track_id,
      })),
    };
  }

  async #sourceMaps(event: TaskEventScope): Promise<{
    contacts: ReadonlyMap<string, string>;
    sessions: ReadonlyMap<string, string>;
  }> {
    const [contacts, sessions] = await Promise.all([
      this.#database
        .prepare(
          `SELECT contact.id, contact.source_record_id
           FROM p_contacts contact
           JOIN p_event_contacts event_contact
             ON event_contact.organization_id = contact.organization_id
            AND event_contact.contact_id = contact.id
            AND event_contact.event_id = ?2
            AND event_contact.source_deleted_at IS NULL
           WHERE contact.organization_id = ?1 AND contact.source_deleted_at IS NULL
           ORDER BY contact.id LIMIT ?3`,
        )
        .bind(event.organizationId, event.eventId, maximumSpeakers + 1)
        .all<SourceRecordRow>(),
      this.#database
        .prepare(
          `SELECT id, source_record_id FROM p_sessions
           WHERE organization_id = ?1 AND event_id = ?2
             AND source_deleted_at IS NULL ORDER BY id LIMIT ?3`,
        )
        .bind(event.organizationId, event.eventId, maximumAssignments + 1)
        .all<SourceRecordRow>(),
    ]);
    return {
      contacts: new Map(
        contacts.results.map((row) => [row.id, row.source_record_id]),
      ),
      sessions: new Map(
        sessions.results.map((row) => [row.id, row.source_record_id]),
      ),
    };
  }

  async #assignmentOperation(
    event: TaskEventScope,
    draft: DomainAssignmentDraft,
    definitionRecordId: string,
    sources: {
      contacts: ReadonlyMap<string, string>;
      sessions: ReadonlyMap<string, string>;
    },
    commandSeed: string,
    actor: TaskCommandActor,
    requestId: string,
  ): Promise<BaseAuthorityCommand> {
    const contactRecordId = sources.contacts.get(draft.contactId);
    const sessionRecordId = draft.sessionId
      ? sources.sessions.get(draft.sessionId)
      : null;
    if (!contactRecordId || (draft.sessionId && !sessionRecordId)) {
      throw new TaskNotFoundError("Task assignment target");
    }
    const commandId = `tmat_${(await sha256(commandSeed)).slice(0, 40)}`;
    return {
      audit: {
        action: "tasks.assignment.materialize",
        ...(actor.actorId ? { actorId: actor.actorId } : {}),
        actorType: actor.auditActorType,
        eventId: event.eventId,
        requestId,
        safeDiff: {
          approvalRequired: draft.approvalRequired,
          assignmentScope: draft.sessionId ? "session" : "contact",
          required: draft.required,
          state: "incomplete",
        },
      },
      commandId,
      entityId: draft.assignmentId,
      expectedVersion: 0,
      fields: {
        "Approved at": null,
        "Approved by": [],
        "Completed at": null,
        Contact: [contactRecordId],
        Definition: [definitionRecordId],
        "Due UTC": draft.dueAt,
        Event: [event.eventRecordId],
        "File object IDs JSON": "[]",
        Required: draft.required,
        "Response JSON": JSON.stringify({
          history: [],
          schema_version: 1,
          state: "incomplete",
          version: 1,
        }),
        Session: sessionRecordId ? [sessionRecordId] : [],
        Status: "not_started",
      },
      operation: "tasks.assignment.materialize",
      organizationId: event.organizationId,
      table: "task_assignments",
    } satisfies BaseAuthorityCommand;
  }

  async #executePlan(
    event: TaskEventScope,
    operation: string,
    commandId: string,
    request: unknown,
    boundaryId: string,
    operations: readonly BaseAuthorityCommand[],
    assignmentIds: readonly string[],
  ): Promise<{
    repairPending: boolean;
    replayed: boolean;
    result: StoredTaskPlan["result"];
  }> {
    const requestHash = await sha256(request);
    const initial: StoredTaskPlan = {
      boundaryId,
      operations: [...operations],
      repairPending: false,
      result: {
        assignment_ids: [...assignmentIds].sort(),
        boundary_id: boundaryId,
        created_count: operations.length,
      },
      version: 1,
    };
    const now = this.#now();
    const inserted = await this.#database
      .prepare(
        `INSERT OR IGNORE INTO idempotency_keys (
           tenant_key, operation, command_id, request_hash, status,
           entity_type, entity_id, original_response_json,
           created_at, updated_at, expires_at
         ) VALUES (?1, ?2, ?3, ?4, 'pending', 'task_boundary', ?5, ?6,
                   ?7, ?7, ?8)`,
      )
      .bind(
        event.organizationId,
        operation,
        commandId,
        requestHash,
        boundaryId,
        JSON.stringify(initial),
        now.toISOString(),
        new Date(now.getTime() + receiptLifetimeMilliseconds).toISOString(),
      )
      .run();
    const receipt = await this.#database
      .prepare(
        `SELECT request_hash, status, original_response_json
         FROM idempotency_keys
         WHERE tenant_key = ?1 AND operation = ?2 AND command_id = ?3`,
      )
      .bind(event.organizationId, operation, commandId)
      .first<TaskPlanReceiptRow>();
    if (!receipt) throw new Error("Task plan receipt was not persisted.");
    if (receipt.request_hash !== requestHash) {
      throw new TaskIdempotencyConflictError(commandId);
    }
    const plan = storedPlan(receipt.original_response_json);
    const replayed = inserted.meta.changes === 0;
    if (
      receipt.status === "committed" ||
      receipt.status === "committed_with_repair"
    ) {
      return {
        repairPending: receipt.status === "committed_with_repair",
        replayed: true,
        result: plan.result,
      };
    }
    let repairPending = plan.repairPending;
    for (const child of plan.operations) {
      try {
        const response = await this.#authority().execute(child);
        repairPending ||= response.projection === "repair_pending";
      } catch (error) {
        if (
          error instanceof AuthorityOutcomeUnknownError ||
          (error instanceof Error &&
            error.name === "AuthorityOutcomeUnknownError")
        ) {
          await this.#database
            .prepare(
              `UPDATE idempotency_keys
               SET status = 'unknown', error_code = ?4, updated_at = ?5
               WHERE tenant_key = ?1 AND operation = ?2 AND command_id = ?3`,
            )
            .bind(
              event.organizationId,
              operation,
              commandId,
              error.name,
              this.#now().toISOString(),
            )
            .run();
          throw new TaskAuthorityPendingError(commandId);
        }
        await this.#database
          .prepare(
            `UPDATE idempotency_keys
             SET status = 'failed', error_code = ?4, updated_at = ?5
             WHERE tenant_key = ?1 AND operation = ?2 AND command_id = ?3`,
          )
          .bind(
            event.organizationId,
            operation,
            commandId,
            error instanceof Error ? error.name : "UnknownError",
            this.#now().toISOString(),
          )
          .run();
        providerFailure(error, child.commandId, child.expectedVersion);
      }
    }
    const completed: StoredTaskPlan = { ...plan, repairPending };
    await this.#database
      .prepare(
        `UPDATE idempotency_keys
         SET status = ?4, original_response_status = ?5,
             original_response_json = ?6, error_code = NULL, updated_at = ?7
         WHERE tenant_key = ?1 AND operation = ?2 AND command_id = ?3`,
      )
      .bind(
        event.organizationId,
        operation,
        commandId,
        repairPending ? "committed_with_repair" : "committed",
        repairPending ? 202 : 200,
        JSON.stringify(completed),
        this.#now().toISOString(),
      )
      .run();
    return { repairPending, replayed, result: completed.result };
  }
}
