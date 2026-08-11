import { describe, expect, it, vi } from "vitest";

import type { TaskAssignmentDetail } from "@sessionbox-killer/contracts/tasks";

import { createTaskCompletionPort } from "./taskCompletionClient";

const detail: TaskAssignmentDetail = {
  assignment: {
    approval_required: false,
    assignment_id: "assignment_profile",
    contact_id: "contact_speaker",
    definition_id: "definition_profile",
    due_at: "2026-08-09T18:00:00.000Z",
    event_id: "event_summit",
    history: [],
    required: true,
    session_id: null,
    state: "incomplete",
    version: 1,
  },
  current_response: null,
  definition: {
    approval_required: false,
    configuration: {
      acknowledgement_label: "I confirm my profile",
      kind: "ack",
    },
    description: "Confirm the public profile.",
    due: null,
    event_id: "event_summit",
    id: "definition_profile",
    name: "Confirm profile",
    required: true,
    target: {
      assignment_scope: "contact",
      contact: {
        exclude_contact_ids: [],
        include_contact_ids: [],
        roles: ["speaker"],
      },
      session: null,
    },
    version: 1,
  },
  event: {
    id: "event_summit",
    name: "AI Summit",
    slug: "ai-summit",
    timezone: "UTC",
  },
  files: [],
  generated_at: "2026-08-10T18:00:00.000Z",
  organization_id: "organization_one",
  overdue: true,
  permissions: { can_review: false, can_submit: true },
  readiness: {
    configuration: "configured",
    explanation: "One task remains.",
    next_due: {
      at: "2026-08-09T18:00:00.000Z",
      local_date: "2026-08-09",
      local_time: "18:00",
      timezone: "UTC",
    },
    outstanding_count: 1,
    overdue_count: 1,
    ratio: { complete: 0, percent: 0, total: 1 },
    status: "overdue",
  },
  response_history: [],
  session: null,
  speaker: {
    contact_id: "contact_speaker",
    display_name: "Sam Speaker",
    email: "sam@example.test",
  },
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

describe("task completion client", () => {
  it("reads scoped detail and sends versioned submissions with CSRF", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(detail))
      .mockResolvedValueOnce(
        json({
          ok: true,
          repair_pending: false,
          replayed: false,
          result: {
            audit: {
              action: "tasks.assignment.submit",
              id: "audit_submit_profile",
              recorded_at: "2026-08-10T18:01:00.000Z",
            },
            detail,
          },
        }),
      );
    const port = createTaskCompletionPort(fetcher, () => "csrf-task-token");

    await expect(
      port.detail("ai-summit", "assignment_profile"),
    ).resolves.toEqual(detail);
    await expect(
      port.submit("ai-summit", "assignment_profile", {
        command_id: "command_submit_profile",
        expected_version: 1,
        response: { acknowledged: true, kind: "ack" },
        type: "submit_assignment",
      }),
    ).resolves.toMatchObject({
      receipt: { audit: { id: "audit_submit_profile" } },
      repairPending: false,
      replayed: false,
    });
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/events/ai-summit/task-assignments/assignment_profile/submissions",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-CSRF-Token": "csrf-task-token",
        }),
        method: "POST",
      }),
    );
  });

  it("preserves projection-repair state instead of presenting stale detail as durable", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(
      json(
        {
          ok: true,
          repair_pending: true,
          replayed: false,
          result: {
            audit: {
              action: "tasks.assignment.submit",
              id: "audit_submit_repair",
              recorded_at: "2026-08-10T18:01:00.000Z",
            },
            detail,
          },
        },
        202,
      ),
    );
    const port = createTaskCompletionPort(fetcher, () => "csrf-task-token");

    await expect(
      port.submit("ai-summit", "assignment_profile", {
        command_id: "command_submit_repair",
        expected_version: 1,
        response: { acknowledged: true, kind: "ack" },
        type: "submit_assignment",
      }),
    ).resolves.toMatchObject({
      receipt: { audit: { id: "audit_submit_repair" } },
      repairPending: true,
      replayed: false,
    });
  });
});
