import {
  assertCalendarIntentIntegrity,
  canonicalJson,
  sha256Hex,
} from "@sessionbox-killer/calendar";
import {
  calendarChangeIntentSchema,
  calendarInvitationHandoffContextSchema,
  calendarInvitationRequestedSchema,
  type CalendarActor,
  type CalendarChangeIntent,
  type CalendarInvitationHandoffContext,
  type CalendarInvitationIntent,
} from "@sessionbox-killer/contracts";

interface StoredOutboxEvent {
  aggregate_id: string;
  aggregate_type: string;
  event_type: string;
  id: string;
  payload_json: string;
}

interface CalendarOutboxRecord {
  actor: CalendarActor;
  aggregateId: string;
  aggregateType: "calendar_invitation" | "session";
  auditAction: "calendar.change.queued" | "calendar.invitation.queued";
  commandId: string;
  eventId: string;
  eventType: "calendar.change.requested" | "calendar.invitation.requested";
  idempotencyKey: string;
  metadata: Readonly<Record<string, string | number>>;
  occurredAt: string;
  organizationId: string;
  payload: unknown;
  requestId: string;
  safeDiff: Readonly<Record<string, string | number>>;
}

export type CalendarInvitationOutboxContext = CalendarInvitationHandoffContext;

export interface CalendarOutboxResult {
  disposition: "enqueued" | "replayed";
  outboxId: string;
}

export class CalendarOutboxIdempotencyConflictError extends Error {
  constructor() {
    super("Calendar outbox idempotency key was reused with different content.");
    this.name = "CalendarOutboxIdempotencyConflictError";
  }
}

function actorId(actor: CalendarActor): string | null {
  return actor.type === "system" ? null : actor.id;
}

function assertStoredEvent(
  stored: StoredOutboxEvent | undefined,
  expected: Pick<
    CalendarOutboxRecord,
    "aggregateId" | "aggregateType" | "eventType"
  > & { payloadJson: string },
): StoredOutboxEvent {
  if (!stored) throw new Error("Calendar outbox write did not persist.");
  if (
    stored.aggregate_id !== expected.aggregateId ||
    stored.aggregate_type !== expected.aggregateType ||
    stored.event_type !== expected.eventType ||
    stored.payload_json !== expected.payloadJson
  ) {
    throw new CalendarOutboxIdempotencyConflictError();
  }
  return stored;
}

export class D1CalendarIntentOutbox {
  readonly #database: D1Database;

  constructor(database: D1Database) {
    this.#database = database;
  }

  async enqueueChange(
    input: CalendarChangeIntent,
  ): Promise<CalendarOutboxResult> {
    const change = calendarChangeIntentSchema.parse(input);
    return this.#record({
      actor: change.actor,
      aggregateId: change.sessionId,
      aggregateType: "session",
      auditAction: "calendar.change.queued",
      commandId: change.commandId,
      eventId: change.eventId,
      eventType: "calendar.change.requested",
      idempotencyKey: [
        "calendar-change:v1",
        change.organizationId,
        change.eventId,
        change.sessionId,
        change.commandId,
      ].join(":"),
      metadata: {
        sourcePublicationVersion: change.sourcePublicationVersion,
      },
      occurredAt: change.occurredAt,
      organizationId: change.organizationId,
      payload: change,
      requestId: change.requestId,
      safeDiff: { changeType: change.changeType },
    });
  }

  async enqueueInvitation(
    input: CalendarInvitationIntent,
    contextInput: CalendarInvitationOutboxContext,
  ): Promise<CalendarOutboxResult> {
    const context = calendarInvitationHandoffContextSchema.parse(contextInput);
    const intent = await assertCalendarIntentIntegrity(input);
    const payload = calendarInvitationRequestedSchema.parse({
      eventId: intent.snapshot.eventId,
      intent,
      kind: "calendar.invitation.requested",
      organizationId: context.organizationId,
      sessionId: intent.snapshot.sessionId,
      version: 1,
    });
    return this.#record({
      actor: context.actor,
      aggregateId: intent.snapshot.seriesId,
      aggregateType: "calendar_invitation",
      auditAction: "calendar.invitation.queued",
      commandId: context.commandId,
      eventId: intent.snapshot.eventId,
      eventType: "calendar.invitation.requested",
      idempotencyKey: intent.idempotencyKey,
      metadata: {
        sequence: intent.snapshot.sequence,
        snapshotHash: intent.snapshotHash,
      },
      occurredAt: context.occurredAt,
      organizationId: context.organizationId,
      payload,
      requestId: context.requestId,
      safeDiff: {
        method: intent.snapshot.method,
        sequence: intent.snapshot.sequence,
      },
    });
  }

  async #record(input: CalendarOutboxRecord): Promise<CalendarOutboxResult> {
    const payloadJson = canonicalJson(input.payload);
    const outboxHash = await sha256Hex(
      `calendar-outbox\u0000${input.organizationId}\u0000${input.idempotencyKey}`,
    );
    const auditHash = await sha256Hex(
      `calendar-audit\u0000${input.organizationId}\u0000${input.idempotencyKey}`,
    );
    const outboxId = `out_${outboxHash.slice(0, 26)}`;
    const results = await this.#database.batch<StoredOutboxEvent>([
      this.#database
        .prepare(
          `INSERT INTO outbox_events (
             id, organization_id, event_id, aggregate_type, aggregate_id,
             event_type, idempotency_key, payload_json, status, available_at,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
           ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
        )
        .bind(
          outboxId,
          input.organizationId,
          input.eventId,
          input.aggregateType,
          input.aggregateId,
          input.eventType,
          input.idempotencyKey,
          payloadJson,
          input.occurredAt,
          input.occurredAt,
          input.occurredAt,
        ),
      this.#database
        .prepare(
          `INSERT INTO audit_events (
             id, organization_id, event_id, actor_type, actor_id, action,
             entity_type, entity_id, request_id, command_id, redaction_version,
             safe_diff_json, metadata_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
           ON CONFLICT (id) DO NOTHING`,
        )
        .bind(
          `aud_${auditHash.slice(0, 26)}`,
          input.organizationId,
          input.eventId,
          input.actor.type,
          actorId(input.actor),
          input.auditAction,
          input.aggregateType,
          input.aggregateId,
          input.requestId,
          input.commandId,
          canonicalJson(input.safeDiff),
          canonicalJson(input.metadata),
          input.occurredAt,
        ),
      this.#database
        .prepare(
          `SELECT id, aggregate_type, aggregate_id, event_type, payload_json
           FROM outbox_events
           WHERE organization_id = ? AND idempotency_key = ?`,
        )
        .bind(input.organizationId, input.idempotencyKey),
    ]);
    const stored = assertStoredEvent(results[2]?.results[0], {
      aggregateId: input.aggregateId,
      aggregateType: input.aggregateType,
      eventType: input.eventType,
      payloadJson,
    });
    return {
      disposition:
        (results[0]?.meta.changes ?? 0) > 0 ? "enqueued" : "replayed",
      outboxId: stored.id,
    };
  }
}
