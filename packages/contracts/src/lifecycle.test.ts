import { describe, expect, it } from "vitest";

import {
  taskReminderCommandResponseSchema,
  taskReminderControlCommandSchema,
  taskReminderScheduleCommandSchema,
} from "./lifecycle";

describe("task reminder contracts", () => {
  it("accepts bounded scheduling and operator commands", () => {
    expect(
      taskReminderScheduleCommandSchema.parse({
        command_id: "command_reminder",
        definition_id: "definition_slides",
        lead_minutes: 1_440,
        type: "schedule",
      }),
    ).toMatchObject({ lead_minutes: 1_440 });
    expect(
      taskReminderControlCommandSchema.parse({
        command_id: "command_retry",
        type: "retry",
      }),
    ).toMatchObject({ type: "retry" });
    expect(() =>
      taskReminderScheduleCommandSchema.parse({
        command_id: "command_reminder",
        definition_id: "definition_slides",
        lead_minutes: 43_201,
        type: "schedule",
      }),
    ).toThrow();
  });

  it("rejects ambiguous job results and unknown fields", () => {
    const response = {
      job: {
        created_at: "2026-08-11T15:00:00.000Z",
        definition_id: "definition_slides",
        event_id: "event_summit",
        id: "trw_reminder",
        lead_minutes: 60,
        next_wake_at: null,
        provider_instance_id: "trw_reminder",
        results: [
          {
            assignment_id: "assignment_slides",
            contact_id: "contact_speaker",
            disposition: "queued",
            evaluated_at: "2026-08-11T15:00:00.000Z",
            message_id: "email_message",
            reason: "queued",
          },
        ],
        status: "complete",
        timezone: "America/Los_Angeles",
        updated_at: "2026-08-11T15:00:00.000Z",
      },
      ok: true,
      replayed: false,
    };
    expect(taskReminderCommandResponseSchema.parse(response)).toEqual(response);
    expect(() =>
      taskReminderCommandResponseSchema.parse({ ...response, extra: true }),
    ).toThrow();
  });
});
