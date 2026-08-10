import {
  scheduleCommandSchema,
  scheduleCommandResponseSchema,
  scheduleCommittedEventSchema,
  ScheduleAuthorityPendingError,
  ScheduleHardConflictError,
  ScheduleIdempotencyConflictError,
  ScheduleValidationError,
  ScheduleVersionConflictError,
  type ScheduleCommand,
  type ScheduleCommandResponse,
  type ScheduleCommandResult,
} from "@sessionbox-killer/contracts";
import { DurableObject } from "cloudflare:workers";

import { getBaseAuthority } from "../authority/binding.js";
import { AirtableScheduleCommandService } from "./service.js";

const stableIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const recoveryDelayMilliseconds = 3_000;

export interface AgendaCoordinatorCommand {
  actorId: string;
  command: ScheduleCommand;
  requestId: string;
}

function parseCoordinatorCommand(value: unknown): AgendaCoordinatorCommand {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Agenda coordinator command must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.actorId !== "string" ||
    !stableIdentifierPattern.test(candidate.actorId)
  ) {
    throw new TypeError("Agenda coordinator actor ID is invalid.");
  }
  if (
    typeof candidate.requestId !== "string" ||
    !stableIdentifierPattern.test(candidate.requestId)
  ) {
    throw new TypeError("Agenda coordinator request ID is invalid.");
  }
  return {
    actorId: candidate.actorId,
    command: scheduleCommandSchema.parse(candidate.command),
    requestId: candidate.requestId,
  };
}

export class AgendaCoordinator extends DurableObject<Env> {
  private commandQueue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS coordinator_identity (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          event_id TEXT NOT NULL
        ) STRICT;
      `);
    });
  }

  execute(value: unknown): Promise<ScheduleCommandResponse> {
    const input = parseCoordinatorCommand(value);
    return this.serialize(async () => {
      try {
        const result = await this.executeSerialized(input);
        return scheduleCommandResponseSchema.parse({ ok: true, result });
      } catch (error) {
        if (error instanceof ScheduleAuthorityPendingError) {
          await this.ctx.storage.setAlarm(
            Date.now() + recoveryDelayMilliseconds,
          );
        }
        const failure = this.commandFailure(error);
        if (failure) return failure;
        throw error;
      }
    });
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required.", { status: 426 });
    }
    const eventId = new URL(request.url).searchParams.get("eventId");
    if (!eventId || !stableIdentifierPattern.test(eventId)) {
      return new Response("Event ID is invalid.", { status: 400 });
    }
    this.bindEvent(eventId);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async alarm(): Promise<void> {
    const eventId = this.boundEvent();
    if (!eventId) return;
    try {
      await this.serialize(() =>
        this.service({
          actorId: "agenda_coordinator",
          requestId: "request_agenda_recovery",
        }).resumePending(eventId),
      );
    } catch (error) {
      if (error instanceof ScheduleAuthorityPendingError) {
        await this.ctx.storage.setAlarm(Date.now() + recoveryDelayMilliseconds);
        return;
      }
      throw error;
    }
  }

  protected executeSerialized(
    input: AgendaCoordinatorCommand,
  ): Promise<ScheduleCommandResult> {
    this.bindEvent(input.command.eventId);
    return this.service(input).execute(input.command);
  }

  protected broadcastCommitted(result: ScheduleCommandResult): void {
    const message = JSON.stringify(
      scheduleCommittedEventSchema.parse({
        commandId: result.commandId,
        eventId: result.snapshot.event.eventId,
        kind: "schedule.committed",
        publicationVersion: result.snapshot.event.publicationVersion,
        scheduleVersion: result.snapshot.event.version,
        version: 1,
      }),
    );
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        socket.close(1011, "Schedule update delivery failed.");
      }
    }
  }

  private commandFailure(error: unknown): ScheduleCommandResponse | null {
    if (error instanceof ScheduleAuthorityPendingError) {
      return scheduleCommandResponseSchema.parse({
        error: {
          code: error.code,
          commandId: error.commandId,
          message: error.message,
          retryable: error.retryable,
          state: error.state,
        },
        ok: false,
      });
    }
    if (error instanceof ScheduleHardConflictError) {
      return scheduleCommandResponseSchema.parse({
        error: {
          code: error.code,
          conflicts: error.conflicts,
          message: error.message,
        },
        ok: false,
      });
    }
    if (error instanceof ScheduleValidationError) {
      return scheduleCommandResponseSchema.parse({
        error: {
          code: error.code,
          field: error.field,
          message: error.message,
          reason: error.reason,
        },
        ok: false,
      });
    }
    if (error instanceof ScheduleVersionConflictError) {
      return scheduleCommandResponseSchema.parse({
        error: {
          actualVersion: error.actualVersion,
          code: error.code,
          expectedVersion: error.expectedVersion,
          message: error.message,
        },
        ok: false,
      });
    }
    if (error instanceof ScheduleIdempotencyConflictError) {
      return scheduleCommandResponseSchema.parse({
        error: {
          code: error.code,
          commandId: error.commandId,
          message: error.message,
        },
        ok: false,
      });
    }
    return null;
  }

  private service(input: { actorId: string; requestId: string }) {
    return new AirtableScheduleCommandService({
      actorId: input.actorId,
      authority: getBaseAuthority(this.env),
      database: this.env.DB,
      onCommitted: (result) => this.broadcastCommitted(result),
      requestId: input.requestId,
    });
  }

  private bindEvent(eventId: string): void {
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO coordinator_identity (singleton, event_id)
       VALUES (1, ?)`,
      eventId,
    );
    if (this.boundEvent() !== eventId) {
      throw new Error("Agenda coordinator is already bound to another event.");
    }
  }

  private boundEvent(): string | null {
    return (
      this.ctx.storage.sql
        .exec<{ event_id: string }>(
          "SELECT event_id FROM coordinator_identity WHERE singleton = 1",
        )
        .toArray()[0]?.event_id ?? null
    );
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.commandQueue.then(operation);
    this.commandQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
