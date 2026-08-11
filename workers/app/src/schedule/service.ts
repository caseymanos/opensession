import {
  previewSchedulePublication,
  scheduleCommandSchema,
  scheduleCommandResultSchema,
  scheduleSnapshotSchema,
  ScheduleAuthorityPendingError,
  ScheduleIdempotencyConflictError,
  type ScheduleCommand,
  type ScheduleCommandPort,
  type ScheduleCommandResult,
  type SchedulePublicationPreview,
  type ScheduleSession,
  type ScheduleSlot,
  type ScheduleSnapshot,
} from "@sessionbox-killer/contracts";
import {
  applyScheduleCommand,
  evaluateScheduleConflicts,
} from "@sessionbox-killer/domain";

import {
  AuthorityOutcomeUnknownError,
  parseBaseAuthorityCommand,
  type AuthorityCommandInspection,
  type AuthorityResponse,
  type BaseAuthorityCommand,
} from "../authority/types.js";
import { D1ScheduleProjectionRepository } from "./d1-repository.js";
import { D1SchedulePublicationRepository } from "./publication-repository.js";

interface ScheduleServiceOptions {
  actorId: string;
  authority: ScheduleAuthority;
  database: D1Database;
  onCommitted?: ((result: ScheduleCommandResult) => void) | undefined;
  requestId: string;
}

interface ScheduleAuthority {
  execute(value: unknown): Promise<AuthorityResponse>;
  inspect(
    organizationId: string,
    operation: string,
    commandId: string,
  ):
    | AuthorityCommandInspection
    | null
    | Promise<AuthorityCommandInspection | null>;
  recoverPending(): Promise<number>;
}

interface EventPersistenceRow {
  id: string;
  organization_id: string;
  source_record_id: string;
  source_version: number;
}

interface EntityPersistenceRow {
  id: string;
  source_record_id: string;
  source_version: number;
}

interface SlotPersistenceRow extends EntityPersistenceRow {
  session_id: string;
}

interface PersistenceContext {
  event: EventPersistenceRow;
  rooms: ReadonlyMap<string, EntityPersistenceRow>;
  sessions: ReadonlyMap<string, EntityPersistenceRow>;
  slotsBySession: ReadonlyMap<string, SlotPersistenceRow>;
}

interface CommandReceiptRow {
  command_id: string;
  command_hash: string;
  event_id: string;
  operations_json: string;
  result_json: string;
  state: "applying" | "complete";
}

interface StoredReceipt {
  actorId: string | null;
  command: ScheduleCommand | null;
  previousSnapshot: ScheduleSnapshot | null;
  requestId: string | null;
  result: ScheduleCommandResult;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new TypeError("Value is not JSON serializable.");
  return encoded;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function stableSubcommandId(
  commandId: string,
  operationKey: string,
): Promise<string> {
  return `schedule_${(await sha256Hex(`${commandId}:${operationKey}`)).slice(0, 48)}`;
}

async function stableSlotId(sessionId: string): Promise<string> {
  return `schedule_slot_${(await sha256Hex(sessionId)).slice(0, 40)}`;
}

function sessionProviderState(state: ScheduleSession["state"]): string {
  return state === "accepted_unscheduled" ? "accepted" : state;
}

function changedSlot(
  previous: ScheduleSlot | null,
  next: ScheduleSlot | null,
): next is ScheduleSlot {
  return next !== null && canonicalJson(previous) !== canonicalJson(next);
}

function rowsById<T extends EntityPersistenceRow>(
  rows: readonly T[],
): ReadonlyMap<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

function parseStoredReceipt(value: unknown): StoredReceipt {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "version" in value &&
    value.version === 3 &&
    "actorId" in value &&
    typeof value.actorId === "string" &&
    "requestId" in value &&
    typeof value.requestId === "string" &&
    "command" in value &&
    "previousSnapshot" in value &&
    "result" in value
  ) {
    return {
      actorId: value.actorId,
      command: scheduleCommandSchema.parse(value.command),
      previousSnapshot: scheduleSnapshotSchema.parse(value.previousSnapshot),
      requestId: value.requestId,
      result: scheduleCommandResultSchema.parse(value.result),
    };
  }
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "version" in value &&
    value.version === 2 &&
    "command" in value &&
    "previousSnapshot" in value &&
    "result" in value
  ) {
    return {
      actorId: null,
      command: scheduleCommandSchema.parse(value.command),
      previousSnapshot: scheduleSnapshotSchema.parse(value.previousSnapshot),
      requestId: null,
      result: scheduleCommandResultSchema.parse(value.result),
    };
  }
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "version" in value &&
    value.version === 1 &&
    "result" in value
  ) {
    return {
      actorId: null,
      command: null,
      previousSnapshot:
        "previousSnapshot" in value
          ? scheduleSnapshotSchema.parse(value.previousSnapshot)
          : null,
      requestId: null,
      result: scheduleCommandResultSchema.parse(value.result),
    };
  }
  const current = scheduleCommandResultSchema.safeParse(value);
  if (current.success) {
    return {
      actorId: null,
      command: null,
      previousSnapshot: null,
      requestId: null,
      result: current.data,
    };
  }
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !("analysis" in value) &&
    "snapshot" in value
  ) {
    const snapshot = scheduleSnapshotSchema.parse(value.snapshot);
    return {
      actorId: null,
      command: null,
      previousSnapshot: null,
      requestId: null,
      result: scheduleCommandResultSchema.parse({
        ...value,
        analysis: evaluateScheduleConflicts(snapshot),
        snapshot,
      }),
    };
  }
  return {
    actorId: null,
    command: null,
    previousSnapshot: null,
    requestId: null,
    result: scheduleCommandResultSchema.parse(value),
  };
}

export class AirtableScheduleCommandService implements ScheduleCommandPort {
  readonly #actorId: string;
  readonly #authority: ScheduleAuthority;
  readonly #database: D1Database;
  readonly #onCommitted: ((result: ScheduleCommandResult) => void) | undefined;
  readonly #projection: D1ScheduleProjectionRepository;
  readonly #requestId: string;

  constructor(options: ScheduleServiceOptions) {
    this.#actorId = options.actorId;
    this.#authority = options.authority;
    this.#database = options.database;
    this.#onCommitted = options.onCommitted;
    this.#projection = new D1ScheduleProjectionRepository(options.database);
    this.#requestId = options.requestId;
  }

  read(eventId: string): Promise<ScheduleSnapshot | null> {
    return this.#projection.read(eventId);
  }

  async previewPublication(
    eventId: string,
  ): Promise<SchedulePublicationPreview> {
    const snapshot = await this.read(eventId);
    if (!snapshot) throw new ScheduleNotFoundError(eventId);
    return previewSchedulePublication(snapshot);
  }

  async execute(command: ScheduleCommand): Promise<ScheduleCommandResult> {
    const commandHash = await sha256Hex(canonicalJson(command));
    const existing = await this.#readReceipt(
      command.eventId,
      command.commandId,
    );
    if (existing) {
      if (existing.command_hash !== commandHash) {
        throw new ScheduleIdempotencyConflictError(command.commandId);
      }
      return this.#resumeReceipt(existing, existing.state === "complete");
    }

    const applying = await this.#readApplyingReceipt(command.eventId);
    if (applying) {
      await this.#resumeReceipt(applying, false);
    }

    const snapshot = await this.read(command.eventId);
    if (!snapshot) {
      throw new ScheduleNotFoundError(command.eventId);
    }
    const result = applyScheduleCommand(snapshot, command);
    const persistence = await this.#loadPersistenceContext(command.eventId);
    const operations = await this.#buildOperations(
      command,
      snapshot,
      result.snapshot,
      result.changedSessionIds,
      persistence,
    );
    if (command.type === "publish_schedule") {
      await this.#publication(
        this.#actorId,
        this.#requestId,
      ).ensureLegacyBaseline(persistence.event.organization_id, snapshot);
    }
    const now = new Date().toISOString();
    await this.#database
      .prepare(
        `INSERT INTO schedule_command_receipts (
           event_id, command_id, command_hash, state, operations_json,
           result_json, created_at, updated_at
         ) VALUES (?1, ?2, ?3, 'applying', ?4, ?5, ?6, ?6)`,
      )
      .bind(
        command.eventId,
        command.commandId,
        commandHash,
        JSON.stringify(operations),
        JSON.stringify({
          actorId: this.#actorId,
          command,
          previousSnapshot: snapshot,
          requestId: this.#requestId,
          result,
          version: 3,
        }),
        now,
      )
      .run();

    return this.#applyReceipt(
      command.eventId,
      command.commandId,
      operations,
      {
        actorId: this.#actorId,
        command,
        previousSnapshot: snapshot,
        requestId: this.#requestId,
        result,
      },
      false,
      persistence.event.organization_id,
    );
  }

  async #readReceipt(
    eventId: string,
    commandId: string,
  ): Promise<CommandReceiptRow | null> {
    return this.#database
      .prepare(
        `SELECT event_id, command_id, command_hash, state,
                operations_json, result_json
         FROM schedule_command_receipts
         WHERE event_id = ?1 AND command_id = ?2`,
      )
      .bind(eventId, commandId)
      .first<CommandReceiptRow>();
  }

  async #readApplyingReceipt(
    eventId: string,
  ): Promise<CommandReceiptRow | null> {
    return this.#database
      .prepare(
        `SELECT event_id, command_id, command_hash, state,
                operations_json, result_json
         FROM schedule_command_receipts
         WHERE event_id = ?1 AND state = 'applying'
         ORDER BY created_at, command_id
         LIMIT 1`,
      )
      .bind(eventId)
      .first<CommandReceiptRow>();
  }

  async resumePending(eventId: string): Promise<ScheduleCommandResult | null> {
    const receipt = await this.#readApplyingReceipt(eventId);
    return receipt ? this.#resumeReceipt(receipt, false) : null;
  }

  async #resumeReceipt(
    receipt: CommandReceiptRow,
    complete: boolean,
  ): Promise<ScheduleCommandResult> {
    const stored = parseStoredReceipt(
      JSON.parse(receipt.result_json) as unknown,
    );
    if (complete) return { ...stored.result, replayed: true };
    const operations = (JSON.parse(receipt.operations_json) as unknown[]).map(
      parseBaseAuthorityCommand,
    );
    const organizationId = operations[0]?.organizationId;
    if (!organizationId) {
      throw new Error("Applying schedule receipt has no authority operations.");
    }
    return this.#applyReceipt(
      stored.result.snapshot.event.eventId,
      stored.result.commandId,
      operations,
      stored,
      true,
      organizationId,
    );
  }

  async #applyReceipt(
    eventId: string,
    commandId: string,
    operations: readonly BaseAuthorityCommand[],
    stored: StoredReceipt,
    replayed: boolean,
    organizationId: string,
  ): Promise<ScheduleCommandResult> {
    for (const operation of operations) {
      await this.#executeOperation(operation, stored.result.commandId);
    }
    try {
      if (stored.command && stored.previousSnapshot) {
        await this.#publication(
          stored.actorId ?? this.#actorId,
          stored.requestId ?? this.#requestId,
        ).commit({
          command: stored.command,
          organizationId,
          previousSnapshot: stored.previousSnapshot,
          result: stored.result,
        });
      } else {
        await this.#database
          .prepare(
            `UPDATE schedule_command_receipts
             SET state = 'complete', result_json = ?4, updated_at = ?3
             WHERE event_id = ?1 AND command_id = ?2`,
          )
          .bind(
            eventId,
            commandId,
            new Date().toISOString(),
            JSON.stringify(stored.result),
          )
          .run();
      }
    } catch {
      throw new ScheduleAuthorityPendingError(commandId, "projection_pending");
    }
    const committed = { ...stored.result, replayed };
    this.#onCommitted?.(committed);
    await this.#authority.recoverPending();
    return committed;
  }

  #publication(
    actorId: string,
    requestId: string,
  ): D1SchedulePublicationRepository {
    return new D1SchedulePublicationRepository({
      actorId,
      database: this.#database,
      requestId,
    });
  }

  async #executeOperation(
    operation: BaseAuthorityCommand,
    scheduleCommandId: string,
  ): Promise<void> {
    let response: AuthorityResponse;
    try {
      response = await this.#authority.execute(operation);
    } catch (error) {
      if (
        error instanceof AuthorityOutcomeUnknownError ||
        (error instanceof Error &&
          error.name === "AuthorityOutcomeUnknownError")
      ) {
        throw new ScheduleAuthorityPendingError(
          scheduleCommandId,
          "outcome_unknown",
        );
      }
      throw error;
    }
    if (response.projection === "durable") return;
    const inspection = await this.#authority.inspect(
      operation.organizationId,
      operation.operation,
      operation.commandId,
    );
    if (inspection?.state !== "complete") {
      throw new ScheduleAuthorityPendingError(
        scheduleCommandId,
        "projection_pending",
      );
    }
  }

  async #loadPersistenceContext(eventId: string): Promise<PersistenceContext> {
    const event = await this.#database
      .prepare(
        `SELECT id, organization_id, source_record_id, source_version
         FROM p_events
         WHERE id = ?1 AND source_deleted_at IS NULL`,
      )
      .bind(eventId)
      .first<EventPersistenceRow>();
    if (!event) throw new ScheduleNotFoundError(eventId);

    const [sessions, rooms, slots] = await Promise.all([
      this.#database
        .prepare(
          `SELECT id, source_record_id, source_version
           FROM p_sessions
           WHERE organization_id = ?1 AND event_id = ?2
             AND source_deleted_at IS NULL
           LIMIT 2001`,
        )
        .bind(event.organization_id, event.id)
        .all<EntityPersistenceRow>(),
      this.#database
        .prepare(
          `SELECT id, source_record_id, source_version
           FROM p_rooms
           WHERE organization_id = ?1 AND event_id = ?2
             AND source_deleted_at IS NULL
           LIMIT 65`,
        )
        .bind(event.organization_id, event.id)
        .all<EntityPersistenceRow>(),
      this.#database
        .prepare(
          `SELECT id, session_id, source_record_id, source_version
           FROM p_schedule_slots
           WHERE organization_id = ?1 AND event_id = ?2
             AND source_deleted_at IS NULL
           LIMIT 2001`,
        )
        .bind(event.organization_id, event.id)
        .all<SlotPersistenceRow>(),
    ]);
    if (
      sessions.results.length > 2_000 ||
      rooms.results.length > 64 ||
      slots.results.length > 2_000
    ) {
      throw new Error(
        "Schedule persistence context exceeds bounded read limits.",
      );
    }
    return {
      event,
      rooms: rowsById(rooms.results),
      sessions: rowsById(sessions.results),
      slotsBySession: new Map(
        slots.results.map((slot) => [slot.session_id, slot]),
      ),
    };
  }

  async #buildOperations(
    command: ScheduleCommand,
    previous: ScheduleSnapshot,
    next: ScheduleSnapshot,
    changedSessionIds: readonly string[],
    persistence: PersistenceContext,
  ): Promise<readonly BaseAuthorityCommand[]> {
    const operations: BaseAuthorityCommand[] = [];
    const previousSessions = new Map(
      previous.sessions.map((session) => [session.id, session]),
    );
    const nextSessions = new Map(
      next.sessions.map((session) => [session.id, session]),
    );

    for (const sessionId of changedSessionIds) {
      const previousSession = previousSessions.get(sessionId);
      const nextSession = nextSessions.get(sessionId);
      const sessionRecord = persistence.sessions.get(sessionId);
      if (!previousSession || !nextSession || !sessionRecord) {
        throw new Error(`Schedule session ${sessionId} is not persistable.`);
      }

      if (changedSlot(previousSession.slot, nextSession.slot)) {
        const room = persistence.rooms.get(nextSession.slot.roomId);
        if (!room)
          throw new Error(
            `Schedule room ${nextSession.slot.roomId} is not persistable.`,
          );
        const existingSlot = persistence.slotsBySession.get(sessionId);
        const entityId = existingSlot?.id ?? (await stableSlotId(sessionId));
        operations.push(
          await this.#operation(
            command,
            persistence.event.organization_id,
            "schedule_slots",
            entityId,
            existingSlot?.source_version ?? 0,
            {
              "End UTC": nextSession.slot.endAt,
              Event: [persistence.event.source_record_id],
              "Override reason": nextSession.slot.overrideReason ?? null,
              "Published version": nextSession.slot.publicationVersion,
              Room: [room.source_record_id],
              Session: [sessionRecord.source_record_id],
              "Start UTC": nextSession.slot.startAt,
              Version: nextSession.slot.version,
            },
          ),
        );
      }

      if (
        previousSession.state !== nextSession.state ||
        previousSession.durationMinutes !== nextSession.durationMinutes
      ) {
        operations.push(
          await this.#operation(
            command,
            persistence.event.organization_id,
            "sessions",
            sessionId,
            sessionRecord.source_version,
            {
              "Duration minutes": nextSession.durationMinutes,
              Public:
                nextSession.isPublic !== false &&
                nextSession.state === "published",
              Status: sessionProviderState(nextSession.state),
            },
          ),
        );
      }
    }

    operations.push(
      await this.#operation(
        command,
        persistence.event.organization_id,
        "events",
        persistence.event.id,
        persistence.event.source_version,
        {
          "Published version": next.event.publicationVersion,
          "Schedule version": next.event.version,
        },
      ),
    );
    return operations;
  }

  async #operation(
    command: ScheduleCommand,
    organizationId: string,
    table: BaseAuthorityCommand["table"],
    entityId: string,
    expectedVersion: number,
    fields: BaseAuthorityCommand["fields"],
  ): Promise<BaseAuthorityCommand> {
    const operation = `schedule.${command.type}.${table}`;
    return {
      audit: {
        action: operation,
        actorId: this.#actorId,
        actorType: "user",
        eventId: command.eventId,
        requestId: this.#requestId,
        safeDiff: {
          command_type: command.type,
          entity_id: entityId,
          override_reason_provided:
            (command.type === "place_session" ||
              command.type === "reschedule_session") &&
            command.overrideReason !== undefined,
          schedule_version: command.expectedVersion + 1,
        },
      },
      commandId: await stableSubcommandId(
        command.commandId,
        `${table}:${entityId}`,
      ),
      entityId,
      expectedVersion,
      fields,
      operation,
      organizationId,
      table,
    };
  }
}

export class ScheduleNotFoundError extends Error {
  readonly eventId: string;

  constructor(eventId: string) {
    super(`Schedule event ${eventId} was not found.`);
    this.name = "ScheduleNotFoundError";
    this.eventId = eventId;
  }
}
