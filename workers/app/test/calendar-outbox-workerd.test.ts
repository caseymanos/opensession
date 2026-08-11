import { buildCalendarInvitation } from "@sessionbox-killer/calendar";
import {
  calendarChangeIntentSchema,
  calendarInvitationRequestedSchema,
  scheduleSnapshotFixture,
  type CalendarChangeIntent,
} from "@sessionbox-killer/contracts";
import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type CalendarOutboxRuntime from "./fixtures/calendar-outbox-runtime";
import type { CalendarInvitationOutboxContext } from "../src/calendar/outbox";

const occurredAt = "2026-08-10T18:00:00.000Z";
const contentHash = "a".repeat(64);
const server = createTestHarness({
  workers: [
    {
      configPath:
        "workers/app/test/fixtures/calendar-outbox-runtime.wrangler.jsonc",
    },
  ],
});
const worker = server.getWorker<
  { DB: D1Database },
  { default: typeof CalendarOutboxRuntime }
>("opensession-calendar-outbox-runtime");
let runtime: Awaited<ReturnType<typeof worker.getExport>>;
let database: D1Database;

const change: CalendarChangeIntent = {
  actor: { id: "user_program_lead", type: "user" },
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

const context: CalendarInvitationOutboxContext = {
  actor: { id: "user_program_lead", type: "user" },
  commandId: "command_invite_opening",
  occurredAt,
  organizationId: "org_open_session",
  requestId: "request_invite_opening",
};

beforeAll(async () => {
  await server.listen();
  await worker.applyD1Migrations("DB");
  runtime = await worker.getExport();
  database = (await worker.getEnv()).DB;
  await database.batch([
    database
      .prepare(
        `INSERT INTO tenant_registry (
           organization_id, base_key, source_record_id, status, created_at, updated_at
         ) VALUES (?, ?, ?, 'active', ?, ?)`,
      )
      .bind(
        "org_open_session",
        "base_calendar",
        "rec_org_calendar",
        occurredAt,
        occurredAt,
      ),
    database
      .prepare(
        `INSERT INTO p_events (
           id, organization_id, name, slug, timezone, status, source_record_id,
           source_version, source_content_hash, projected_at
         ) VALUES (?, ?, ?, ?, ?, 'open', ?, 1, ?, ?)`,
      )
      .bind(
        "event_ai_engineering_summit",
        "org_open_session",
        "AI Engineer World's Fair",
        "ai-engineering-summit",
        "America/Los_Angeles",
        "rec_event_calendar",
        contentHash,
        occurredAt,
      ),
  ]);
});

afterAll(async () => {
  await server.close();
});

describe("calendar D1 outbox handoff in workerd", () => {
  it("atomically records provider-neutral changes and exact invitation replays", async () => {
    const invitation = await buildCalendarInvitation({
      attendee: { email: "alex@example.test", name: "Alex Chen" },
      eventLocation: "Fort Mason Center, San Francisco",
      eventName: "AI Engineer World's Fair",
      occurredAt,
      organizationId: "org_open_session",
      organizer: {
        email: "program@example.test",
        name: "OpenSession Program Team",
      },
      publicUrl: "https://events.example.test/ai-engineering-summit",
      schedule: scheduleSnapshotFixture,
      sessionId: "session_opening",
      uidDomain: "calendar.example.test",
    });

    const [firstChange, replayedChange] = await Promise.all([
      runtime.enqueueChange(change),
      runtime.enqueueChange(change),
    ]);
    const [firstInvite, replayedInvite] = await Promise.all([
      runtime.enqueueInvitation(invitation.intent, context),
      runtime.enqueueInvitation(invitation.intent, context),
    ]);

    expect(
      [firstChange.disposition, replayedChange.disposition].sort(),
    ).toEqual(["enqueued", "replayed"]);
    expect(
      [firstInvite.disposition, replayedInvite.disposition].sort(),
    ).toEqual(["enqueued", "replayed"]);
    const rows = await database
      .prepare(
        `SELECT event_type, payload_json FROM outbox_events
         WHERE organization_id = ? ORDER BY event_type`,
      )
      .bind("org_open_session")
      .all<{ event_type: string; payload_json: string }>();
    expect(rows.results).toHaveLength(2);
    const [changeRow, invitationRow] = rows.results;
    if (!changeRow || !invitationRow) {
      throw new Error("Calendar outbox fixture rows are missing.");
    }
    expect(
      calendarChangeIntentSchema.parse(JSON.parse(changeRow.payload_json)),
    ).toEqual(change);
    const requested = calendarInvitationRequestedSchema.parse(
      JSON.parse(invitationRow.payload_json),
    );
    expect(requested.intent).toEqual(invitation.intent);
    expect(requested.intent.attachment.content).toContain("METHOD:REQUEST");

    const audits = await database
      .prepare(
        `SELECT safe_diff_json, metadata_json FROM audit_events
         WHERE organization_id = ? ORDER BY action`,
      )
      .bind("org_open_session")
      .all<{ metadata_json: string; safe_diff_json: string }>();
    expect(audits.results).toHaveLength(2);
    expect(JSON.stringify(audits.results)).not.toContain("alex@example.test");
    expect(JSON.stringify(audits.results)).not.toContain(
      "program@example.test",
    );
  });

  it("rejects integrity failures before the handoff", async () => {
    const invitation = await buildCalendarInvitation({
      attendee: { email: "other@example.test", name: "Other Speaker" },
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
    const corrupted = {
      ...invitation.intent,
      attachment: {
        ...invitation.intent.attachment,
        content: invitation.intent.attachment.content.replace(
          "STATUS:CONFIRMED",
          "STATUS:CANCELLED",
        ),
      },
    };

    await expect(async () =>
      runtime.enqueueInvitation(corrupted, context),
    ).rejects.toThrow("failed its integrity check");
  });

  it("detects a command id reused for a different change", async () => {
    const conflicting = { ...change, changeType: "canceled" as const };
    await expect(async () =>
      runtime.enqueueChange(conflicting),
    ).rejects.toThrow("idempotency key was reused with different content");
  });
});
