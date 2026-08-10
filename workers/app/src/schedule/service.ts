import {
  scheduleCommandResultSchema,
  ScheduleIdempotencyConflictError,
  type ScheduleCommand,
  type ScheduleCommandPort,
  type ScheduleCommandResult,
  type ScheduleSession,
  type ScheduleSlot,
  type ScheduleSnapshot,
} from "@sessionbox-killer/contracts";
import { applyScheduleCommand } from "@sessionbox-killer/domain";

import type { BaseAuthority } from "../authority/base-authority.js";
import {
  parseBaseAuthorityCommand,
  type BaseAuthorityCommand,
} from "../authority/types.js";
import { D1ScheduleProjectionRepository } from "./d1-repository.js";

interface ScheduleServiceOptions {
  actorId: string;
  authority: Pick<DurableObjectStub<BaseAuthority>, "execute">;
  database: D1Database;
  requestId: string;
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
  command_hash: string;
  operations_json: string;
  result_json: string;
  state: "applying" | "complete";
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

export class AirtableScheduleCommandService implements ScheduleCommandPort {
  readonly #actorId: string;
  readonly #authority: Pick<DurableObjectStub<BaseAuthority>, "execute">;
  readonly #database: D1Database;
  readonly #projection: D1ScheduleProjectionRepository;
  readonly #requestId: string;

  constructor(options: ScheduleServiceOptions) {
    this.#actorId = options.actorId;
    this.#authority = options.authority;
    this.#database = options.database;
    this.#projection = new D1ScheduleProjectionRepository(options.database);
    this.#requestId = options.requestId;
  }

  read(eventId: string): Promise<ScheduleSnapshot | null> {
    return this.#projection.read(eventId);
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
        JSON.stringify(result),
        now,
      )
      .run();

    return this.#applyReceipt(
      command.eventId,
      command.commandId,
      operations,
      result,
      false,
    );
  }

  async #readReceipt(
    eventId: string,
    commandId: string,
  ): Promise<CommandReceiptRow | null> {
    return this.#database
      .prepare(
        `SELECT command_hash, state, operations_json, result_json
         FROM schedule_command_receipts
         WHERE event_id = ?1 AND command_id = ?2`,
      )
      .bind(eventId, commandId)
      .first<CommandReceiptRow>();
  }

  async #resumeReceipt(
    receipt: CommandReceiptRow,
    complete: boolean,
  ): Promise<ScheduleCommandResult> {
    const result = scheduleCommandResultSchema.parse(
      JSON.parse(receipt.result_json) as unknown,
    );
    if (complete) return { ...result, replayed: true };
    const operations = (JSON.parse(receipt.operations_json) as unknown[]).map(
      parseBaseAuthorityCommand,
    );
    return this.#applyReceipt(
      result.snapshot.event.eventId,
      result.commandId,
      operations,
      result,
      true,
    );
  }

  async #applyReceipt(
    eventId: string,
    commandId: string,
    operations: readonly BaseAuthorityCommand[],
    result: ScheduleCommandResult,
    replayed: boolean,
  ): Promise<ScheduleCommandResult> {
    for (const operation of operations) {
      await this.#authority.execute(operation);
    }
    await this.#database
      .prepare(
        `UPDATE schedule_command_receipts
         SET state = 'complete', updated_at = ?3
         WHERE event_id = ?1 AND command_id = ?2`,
      )
      .bind(eventId, commandId, new Date().toISOString())
      .run();
    return { ...result, replayed };
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
              "Override reason": null,
              "Published version": nextSession.slot.publicationVersion,
              Room: [room.source_record_id],
              Session: [sessionRecord.source_record_id],
              "Start UTC": nextSession.slot.startAt,
              Version: nextSession.slot.version,
            },
          ),
        );
      }

      if (previousSession.state !== nextSession.state) {
        operations.push(
          await this.#operation(
            command,
            persistence.event.organization_id,
            "sessions",
            sessionId,
            sessionRecord.source_version,
            {
              Public: nextSession.state === "published",
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
