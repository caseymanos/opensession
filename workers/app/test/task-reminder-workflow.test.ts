import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CampaignEmailQueueMessage } from "../src/email/messages";
import {
  TaskReminderCoordinator,
  TaskReminderExecutionService,
} from "../src/lifecycle/task-reminders";

const timestamp = "2026-08-11T15:00:00.000Z";
const hash = "a".repeat(64);
const organizationId = "org_task_reminder";
const eventId = "event_task_reminder";
const definitionId = "definition_task_reminder";
const workflowId = "trw_task_reminder_demo";

const server = createTestHarness({
  workers: [{ configPath: "workers/app/wrangler.jsonc" }],
});

function assignment(
  id: string,
  contactId: string,
  options: { dueAt: string | null; required?: boolean; status?: string },
) {
  return {
    contactId,
    dueAt: options.dueAt,
    id,
    required: options.required ?? true,
    status: options.status ?? "not_started",
  };
}

beforeAll(async () => {
  await server.listen();
  const worker = server.getWorker<Env>();
  await worker.applyD1Migrations("DB");
  const { DB } = await worker.getEnv();
  await DB.batch([
    DB.prepare(
      `INSERT INTO tenant_registry (
         organization_id, base_key, source_record_id, status, authority_ready_at,
         created_at, updated_at
       ) VALUES (?1, 'base_task_reminder', 'rec_org_task_reminder', 'active',
                 ?2, ?2, ?2)`,
    ).bind(organizationId, timestamp),
    DB.prepare(
      `INSERT INTO p_events (
         id, organization_id, name, slug, timezone, status, source_record_id,
         source_version, source_content_hash, projected_at
       ) VALUES (?1, ?2, 'Workflow Summit', 'workflow-summit',
                 'America/Los_Angeles', 'open', 'rec_event_task_reminder',
                 1, ?3, ?4)`,
    ).bind(eventId, organizationId, hash, timestamp),
    DB.prepare(
      `INSERT INTO p_task_definitions (
         id, organization_id, event_id, name, type, required_default,
         approval_required, target_rule_json, form_schema_json,
         file_policy_json, source_record_id, source_version,
         source_content_hash, projected_at
       ) VALUES (?1, ?2, ?3, 'Upload slides', 'file', 1, 0, '{}', '{}', '{}',
                 'rec_definition_task_reminder', 1, ?4, ?5)`,
    ).bind(definitionId, organizationId, eventId, hash, timestamp),
  ]);
  const assignments = [
    assignment("assignment_remains", "contact_remains", {
      dueAt: "2026-08-11T14:55:00.000Z",
    }),
    assignment("assignment_completed", "contact_completed", {
      dueAt: "2026-08-11T14:55:00.000Z",
      status: "complete",
    }),
    assignment("assignment_optional", "contact_optional", {
      dueAt: "2026-08-11T14:55:00.000Z",
      required: false,
    }),
    assignment("assignment_no_due", "contact_no_due", { dueAt: null }),
    assignment("assignment_missing_email", "contact_missing_email", {
      dueAt: "2026-08-11T14:55:00.000Z",
    }),
    assignment("assignment_suppressed", "contact_suppressed", {
      dueAt: "2026-08-11T14:55:00.000Z",
    }),
  ];
  for (const [index, value] of assignments.entries()) {
    await DB.batch([
      DB.prepare(
        `INSERT INTO p_contacts (
           id, organization_id, email_normalized, display_name, first_name,
           source_record_id, source_version, source_content_hash, projected_at
         ) VALUES (?1, ?2, ?3, ?4, ?4, ?5, 1, ?6, ?7)`,
      ).bind(
        value.contactId,
        organizationId,
        value.contactId === "contact_missing_email"
          ? ""
          : `${value.contactId}@example.test`,
        `Speaker ${index}`,
        `rec_${value.contactId}`,
        hash,
        timestamp,
      ),
      DB.prepare(
        `INSERT INTO p_task_assignments (
           id, organization_id, event_id, definition_id, contact_id, due_at,
           required, status, response_json, file_object_ids_json, updated_at,
           source_record_id, source_version, source_content_hash, projected_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '{}', '[]', ?9,
                   ?10, 1, ?11, ?9)`,
      ).bind(
        value.id,
        organizationId,
        eventId,
        definitionId,
        value.contactId,
        value.dueAt,
        value.required ? 1 : 0,
        value.status,
        timestamp,
        `rec_${value.id}`,
        hash,
      ),
    ]);
  }
  const suppressedHash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode("contact_suppressed@example.test"),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  await DB.prepare(
    `INSERT INTO email_suppressions (
       organization_id, recipient_hash, reason, created_at, updated_at
     ) VALUES (?1, ?2, 'manual', ?3, ?3)`,
  )
    .bind(organizationId, suppressedHash, timestamp)
    .run();
  await DB.prepare(
    `INSERT INTO workflow_runs (
       id, organization_id, event_id, workflow_type, provider_instance_id,
       idempotency_key, status, input_json, checkpoint_json, created_at,
       updated_at
     ) VALUES (?1, ?2, ?3, 'task_due_reminder', ?1,
               'task-reminder:test:demo', 'queued', ?4, ?5, ?6, ?6)`,
  )
    .bind(
      workflowId,
      organizationId,
      eventId,
      JSON.stringify({
        command_id: "command_task_reminder_demo",
        definition_id: definitionId,
        event_id: eventId,
        lead_minutes: 0,
        organization_id: organizationId,
        request_id: "request_task_reminder_demo",
        timezone: "America/Los_Angeles",
        version: 1,
        workflow_id: workflowId,
      }),
      JSON.stringify({
        last_control_command_id: null,
        next_wake_at: null,
        retry_count: 0,
      }),
      timestamp,
    )
    .run();
});

afterAll(async () => {
  await server.close();
});

describe("durable task reminder execution", () => {
  it("re-queries current eligibility at wake and sends the remaining recipient once", async () => {
    const base = await server.getWorker<Env>().getEnv();
    const sent: CampaignEmailQueueMessage[] = [];
    const environment = {
      ...base,
      EMAIL_QUEUE: {
        async send(message: CampaignEmailQueueMessage) {
          sent.push(structuredClone(message));
        },
      } as unknown as Queue,
    } as Env;
    const first = await new TaskReminderExecutionService(
      environment,
      () => new Date(timestamp),
    ).execute(workflowId);
    const replay = await new TaskReminderExecutionService(
      environment,
      () => new Date(timestamp),
    ).execute(workflowId);
    expect(first).toEqual({ nextWakeAt: null });
    expect(replay).toEqual({ nextWakeAt: null });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      contact_id: "contact_remains",
      template_id: "template_task_reminder",
    });
    const results = await base.DB.prepare(
      `SELECT assignment_id, disposition, reason, message_id
       FROM task_reminder_results WHERE workflow_id = ?1
       ORDER BY assignment_id`,
    )
      .bind(workflowId)
      .all();
    expect(results.results).toEqual([
      {
        assignment_id: "assignment_completed",
        disposition: "skipped",
        message_id: null,
        reason: "completed",
      },
      {
        assignment_id: "assignment_missing_email",
        disposition: "skipped",
        message_id: null,
        reason: "missing_email",
      },
      {
        assignment_id: "assignment_no_due",
        disposition: "skipped",
        message_id: null,
        reason: "missing_due",
      },
      {
        assignment_id: "assignment_optional",
        disposition: "skipped",
        message_id: null,
        reason: "optional",
      },
      expect.objectContaining({
        assignment_id: "assignment_remains",
        disposition: "queued",
        reason: "queued",
      }),
      {
        assignment_id: "assignment_suppressed",
        disposition: "skipped",
        message_id: null,
        reason: "suppressed",
      },
    ]);
    const workflow = await base.DB.prepare(
      `SELECT status, finished_at FROM workflow_runs WHERE id = ?1`,
    )
      .bind(workflowId)
      .first();
    expect(workflow).toMatchObject({ status: "complete" });
  });

  it("deduplicates starts and exposes cancel and safe retry controls", async () => {
    const base = await server.getWorker<Env>().getEnv();
    let creates = 0;
    let restarts = 0;
    let terminations = 0;
    const instance = {
      id: "trw_operator_controls",
      async restart() {
        restarts += 1;
      },
      async terminate() {
        terminations += 1;
      },
    } as unknown as WorkflowInstance;
    const environment = {
      ...base,
      TASK_REMINDER_WORKFLOW: {
        async create() {
          creates += 1;
          return instance;
        },
        async get() {
          return instance;
        },
      } as unknown as Workflow,
    } as Env;
    const coordinator = new TaskReminderCoordinator(environment);
    const command = {
      command_id: "command_operator_controls",
      definition_id: definitionId,
      lead_minutes: 60,
      type: "schedule" as const,
    };
    const event = {
      id: eventId,
      organization_id: organizationId,
      timezone: "America/Los_Angeles",
    };
    const first = await coordinator.schedule(
      event,
      command,
      "request_controls",
    );
    const replay = await coordinator.schedule(
      event,
      command,
      "request_controls_replay",
    );
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(creates).toBe(1);
    await coordinator.control(organizationId, eventId, first.job.id, {
      command_id: "command_cancel_controls",
      type: "cancel",
    });
    expect(terminations).toBe(1);
    const retried = await coordinator.control(
      organizationId,
      eventId,
      first.job.id,
      { command_id: "command_retry_controls", type: "retry" },
    );
    const retryReplay = await coordinator.control(
      organizationId,
      eventId,
      first.job.id,
      { command_id: "command_retry_controls", type: "retry" },
    );
    expect(restarts).toBe(1);
    expect(retried.job.status).toBe("queued");
    expect(retryReplay.replayed).toBe(true);
    expect(retryReplay.job.results).toEqual([]);
    const retryCheckpoint = await base.DB.prepare(
      `SELECT checkpoint_json FROM workflow_runs WHERE id = ?1`,
    )
      .bind(first.job.id)
      .first<{ checkpoint_json: string }>();
    expect(JSON.parse(retryCheckpoint?.checkpoint_json ?? "null")).toEqual({
      last_control_command_id: "command_retry_controls",
      next_wake_at: null,
      retry_count: 1,
    });
    const outbox = await base.DB.prepare(
      `SELECT status, attempt_count FROM outbox_events
       WHERE event_type = 'task.reminder.requested'
         AND aggregate_id = ?1`,
    )
      .bind(definitionId)
      .first();
    expect(outbox).toEqual({ attempt_count: 1, status: "published" });
  });
});
