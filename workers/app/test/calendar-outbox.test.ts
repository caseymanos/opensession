import { buildCalendarInvitation } from "@sessionbox-killer/calendar";
import {
  scheduleSnapshotFixture,
  type CalendarChangeIntent,
} from "@sessionbox-killer/contracts";
import { describe, expect, it } from "vitest";

import {
  CalendarOutboxIdempotencyConflictError,
  D1CalendarIntentOutbox,
} from "../src/calendar/outbox";

interface FakeStatement {
  query: string;
  values: unknown[];
}

interface FakeStoredOutbox {
  aggregate_id: string;
  aggregate_type: string;
  event_type: string;
  id: string;
  payload_json: string;
}

class FakeD1 {
  readonly batches: FakeStatement[][] = [];
  readonly events = new Map<string, FakeStoredOutbox>();
  omitSelectedRow = false;

  prepare(query: string): D1PreparedStatement {
    return {
      bind: (...values: unknown[]) => ({ query, values }) as FakeStatement,
    } as unknown as D1PreparedStatement;
  }

  async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const fakeStatements = statements as unknown as FakeStatement[];
    this.batches.push(fakeStatements);
    const insert = fakeStatements[0];
    const select = fakeStatements[2];
    if (!insert || !select) throw new Error("Fake D1 batch is incomplete.");
    const [
      id,
      organizationId,
      ,
      aggregateType,
      aggregateId,
      eventType,
      key,
      payload,
    ] = insert.values as string[];
    const storageKey = `${organizationId}:${key}`;
    const existing = this.events.get(storageKey);
    let changes = 0;
    if (!existing) {
      if (!id || !aggregateType || !aggregateId || !eventType || !payload) {
        throw new Error("Fake D1 insert values are incomplete.");
      }
      this.events.set(storageKey, {
        aggregate_id: aggregateId,
        aggregate_type: aggregateType,
        event_type: eventType,
        id,
        payload_json: payload,
      });
      changes = 1;
    }
    const selected = this.events.get(
      `${String(select.values[0])}:${String(select.values[1])}`,
    );
    return [
      { meta: { changes }, results: [] },
      { meta: { changes: 1 }, results: [] },
      {
        meta: { changes: 0 },
        results:
          this.omitSelectedRow || !selected ? [] : [selected as unknown as T],
      },
    ] as unknown as D1Result<T>[];
  }
}

const occurredAt = "2026-08-10T18:00:00.000Z";
const change: CalendarChangeIntent = {
  actor: { id: null, type: "system" },
  changeType: "rescheduled",
  commandId: "command_reschedule_opening",
  eventId: "event_ai_engineering_summit",
  kind: "calendar.change",
  occurredAt,
  organizationId: "org_open_session",
  previousPlacement: {
    endAt: "2026-09-15T17:30:00.000Z",
    roomId: "room_cowell",
    startAt: "2026-09-15T17:00:00.000Z",
  },
  requestId: "request_reschedule_opening",
  sessionId: "session_opening",
  sourcePublicationVersion: 5,
  version: 1,
};

async function invitation() {
  return buildCalendarInvitation({
    attendee: { email: "alex@example.test", name: "Alex Chen" },
    eventLocation: "Fort Mason Center, San Francisco",
    eventName: "AI Engineer World's Fair",
    occurredAt,
    organizationId: "org_open_session",
    organizer: {
      email: "program@example.test",
      name: "OpenSession Program Team",
    },
    schedule: scheduleSnapshotFixture,
    sessionId: "session_opening",
    uidDomain: "calendar.example.test",
  });
}

describe("D1CalendarIntentOutbox", () => {
  it("records one normalized acceptance intent and replays it", async () => {
    const database = new FakeD1();
    const outbox = new D1CalendarIntentOutbox(
      database as unknown as D1Database,
    );
    const input = {
      actor: { id: "user_program_lead", type: "user" } as const,
      commandId: "command_accept_submission",
      contactIds: [
        "contact_speaker_b",
        "contact_speaker_a",
        "contact_speaker_b",
      ],
      eventId: "event_ai_engineering_summit",
      occurredAt,
      organizationId: "org_open_session",
      requestId: "request_accept_submission",
      sessionId: "session_accepted_submission",
      workflowId: "workflow_accept_submission",
    };

    const first = await outbox.enqueueAcceptance(input);
    const replay = await outbox.enqueueAcceptance(input);

    expect(first.disposition).toBe("enqueued");
    expect(replay).toEqual({
      disposition: "replayed",
      outboxId: first.outboxId,
    });
    expect(database.events).toHaveLength(1);
    expect(
      JSON.parse(database.events.values().next().value?.payload_json ?? "{}")
        .contactIds,
    ).toEqual(["contact_speaker_a", "contact_speaker_b"]);
    expect(database.batches[0]?.[1]?.values[4]).toBe("user_program_lead");
  });

  it("records and replays a system-authored change", async () => {
    const database = new FakeD1();
    const outbox = new D1CalendarIntentOutbox(
      database as unknown as D1Database,
    );

    const first = await outbox.enqueueChange(change);
    const replay = await outbox.enqueueChange(change);

    expect(first.disposition).toBe("enqueued");
    expect(replay).toEqual({
      disposition: "replayed",
      outboxId: first.outboxId,
    });
    expect(database.events).toHaveLength(1);
    expect(database.batches[0]?.[1]?.values[4]).toBeNull();
  });

  it("records an integrity-checked invitation and user audit context", async () => {
    const database = new FakeD1();
    const outbox = new D1CalendarIntentOutbox(
      database as unknown as D1Database,
    );
    const built = await invitation();

    const result = await outbox.enqueueInvitation(built.intent, {
      actor: { id: "user_program_lead", type: "user" },
      commandId: "command_invite_opening",
      occurredAt,
      organizationId: "org_open_session",
      requestId: "request_invite_opening",
    });

    expect(result.disposition).toBe("enqueued");
    expect(database.batches[0]?.[1]?.values[4]).toBe("user_program_lead");
    expect(database.events.values().next().value?.payload_json).toContain(
      "calendar.invitation.requested",
    );
  });

  it("detects conflicting content and a missing persisted row", async () => {
    const database = new FakeD1();
    const outbox = new D1CalendarIntentOutbox(
      database as unknown as D1Database,
    );
    await outbox.enqueueChange(change);

    await expect(
      outbox.enqueueChange({ ...change, changeType: "canceled" }),
    ).rejects.toBeInstanceOf(CalendarOutboxIdempotencyConflictError);
    database.omitSelectedRow = true;
    await expect(outbox.enqueueChange(change)).rejects.toThrow(
      "Calendar outbox write did not persist",
    );
  });

  it("rejects malformed changes and corrupted invitation snapshots", async () => {
    const database = new FakeD1();
    const outbox = new D1CalendarIntentOutbox(
      database as unknown as D1Database,
    );
    await expect(
      outbox.enqueueChange({ ...change, sourcePublicationVersion: 0 }),
    ).rejects.toThrow();
    const built = await invitation();
    await expect(
      outbox.enqueueInvitation(
        { ...built.intent, snapshotHash: "b".repeat(64) },
        {
          actor: { id: null, type: "system" },
          commandId: "command_invalid_invite",
          occurredAt,
          organizationId: "org_open_session",
          requestId: "request_invalid_invite",
        },
      ),
    ).rejects.toThrow("failed its integrity check");
  });
});
