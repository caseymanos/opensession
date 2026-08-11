import {
  taskReminderCommandResponseSchema,
  taskReminderJobSchema,
  type TaskReminderControlCommand,
  type TaskReminderJob,
  type TaskReminderScheduleCommand,
} from "@sessionbox-killer/contracts/lifecycle";
import {
  createCampaignMessageKey,
  createSeedEmailTemplates,
  renderEmailTemplate,
  type EmailMergeValues,
} from "@sessionbox-killer/email";
import { sha256Hex } from "../auth/crypto.js";
import { parseEmailDeliveryConfig } from "../email/config.js";
import { CampaignEmailCoordinator } from "../email/delivery.js";
import type { CampaignEmailQueueMessage } from "../email/messages.js";
import { D1EmailTemplateProjectionRepository } from "../email-templates/repository.js";

export interface TaskReminderWorkflowInput {
  readonly definition_id: string;
  readonly event_id: string;
  readonly organization_id: string;
  readonly request_id: string;
  readonly version: 1;
  readonly workflow_id: string;
}

interface WorkflowInput extends TaskReminderWorkflowInput {
  readonly command_id: string;
  readonly lead_minutes: number;
  readonly timezone: string;
}

interface WorkflowRow {
  checkpoint_json: string | null;
  created_at: string;
  input_json: string;
  provider_instance_id: string | null;
  status: TaskReminderJob["status"];
  updated_at: string;
}

interface ReminderAssignmentRow {
  approval_required: number;
  assignment_id: string;
  contact_id: string;
  display_name: string;
  due_at: string | null;
  email_normalized: string;
  first_name: string | null;
  name: string;
  required: number;
  status: string;
}

interface ReminderCheckpoint {
  last_control_command_id: string | null;
  next_wake_at: string | null;
  retry_count: number;
}

interface EventRow {
  id: string;
  name: string;
  organization_id: string;
  slug: string;
  timezone: string;
}

const maximumAssignments = 5_000;
export const taskReminderMaximumWakeCycles = 100;

function input(value: string): WorkflowInput {
  const parsed = JSON.parse(value) as Partial<WorkflowInput>;
  if (
    parsed.version !== 1 ||
    typeof parsed.workflow_id !== "string" ||
    typeof parsed.organization_id !== "string" ||
    typeof parsed.event_id !== "string" ||
    typeof parsed.definition_id !== "string" ||
    typeof parsed.command_id !== "string" ||
    typeof parsed.request_id !== "string" ||
    typeof parsed.timezone !== "string" ||
    !Number.isInteger(parsed.lead_minutes) ||
    (parsed.lead_minutes ?? -1) < 0
  ) {
    throw new TypeError("Task reminder workflow input is invalid.");
  }
  return parsed as WorkflowInput;
}

function checkpoint(value: string | null): ReminderCheckpoint {
  if (!value) {
    return {
      last_control_command_id: null,
      next_wake_at: null,
      retry_count: 0,
    };
  }
  const parsed = JSON.parse(value) as Partial<ReminderCheckpoint>;
  if (
    (parsed.last_control_command_id !== null &&
      parsed.last_control_command_id !== undefined &&
      typeof parsed.last_control_command_id !== "string") ||
    (parsed.next_wake_at !== null &&
      (typeof parsed.next_wake_at !== "string" ||
        !Number.isFinite(Date.parse(parsed.next_wake_at)))) ||
    !Number.isInteger(parsed.retry_count) ||
    (parsed.retry_count ?? -1) < 0
  ) {
    throw new Error("Task reminder checkpoint is invalid.");
  }
  return {
    last_control_command_id: parsed.last_control_command_id ?? null,
    next_wake_at: parsed.next_wake_at ?? null,
    retry_count: parsed.retry_count ?? 0,
  };
}

function firstName(row: ReminderAssignmentRow): string {
  return (
    row.first_name?.trim() ||
    row.display_name.trim().split(/\s+/u)[0] ||
    "there"
  );
}

function origin(environment: Env["APP_ENV"]): string {
  if (environment === "production") return "https://opensessionboard.com";
  if (environment === "preview") return "https://preview.opensessionboard.com";
  return "https://localhost";
}

function dueDisplay(dueAt: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "long",
    timeZone: timezone,
    timeZoneName: "short",
  }).format(new Date(dueAt));
}

function reminderAt(dueAt: string, leadMinutes: number): number {
  return Date.parse(dueAt) - leadMinutes * 60_000;
}

function resultId(workflowId: string, assignmentId: string): string {
  return `trr_${workflowId.slice(-40)}_${assignmentId.slice(-40)}`.slice(
    0,
    128,
  );
}

async function saveCheckpoint(
  database: D1Database,
  workflowId: string,
  status: WorkflowRow["status"],
  value: ReminderCheckpoint,
  now: string,
): Promise<void> {
  await database
    .prepare(
      `UPDATE workflow_runs
       SET status = ?2, checkpoint_json = ?3, updated_at = ?4,
           error_code = NULL
       WHERE id = ?1 AND workflow_type = 'task_due_reminder'
         AND status <> 'canceled'`,
    )
    .bind(workflowId, status, JSON.stringify(value), now)
    .run();
}

async function recordResult(
  database: D1Database,
  workflow: WorkflowInput,
  assignment: ReminderAssignmentRow,
  disposition: "queued" | "skipped",
  reason:
    | "already_queued"
    | "completed"
    | "missing_due"
    | "missing_email"
    | "optional"
    | "queued"
    | "suppressed",
  messageId: string | null,
  now: string,
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO task_reminder_results (
         id, organization_id, event_id, workflow_id, assignment_id,
         contact_id, disposition, reason, message_id, evaluated_at,
         created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?10)
       ON CONFLICT (organization_id, workflow_id, assignment_id) DO NOTHING`,
    )
    .bind(
      resultId(workflow.workflow_id, assignment.assignment_id),
      workflow.organization_id,
      workflow.event_id,
      workflow.workflow_id,
      assignment.assignment_id,
      assignment.contact_id,
      disposition,
      reason,
      messageId,
      now,
    )
    .run();
}

export class TaskReminderExecutionService {
  readonly #environment: Env;
  readonly #now: () => Date;

  constructor(environment: Env, now: () => Date = () => new Date()) {
    this.#environment = environment;
    this.#now = now;
  }

  async execute(workflowId: string): Promise<{ nextWakeAt: string | null }> {
    const row = await this.#environment.DB.prepare(
      `SELECT input_json, checkpoint_json, status, provider_instance_id,
              created_at, updated_at
       FROM workflow_runs WHERE id = ?1 AND workflow_type = 'task_due_reminder'
       LIMIT 1`,
    )
      .bind(workflowId)
      .first<WorkflowRow>();
    if (!row) throw new Error("Task reminder workflow does not exist.");
    if (row.status === "canceled") return { nextWakeAt: null };
    const workflow = input(row.input_json);
    const currentCheckpoint = checkpoint(row.checkpoint_json);
    const event = await this.#environment.DB.prepare(
      `SELECT id, name, organization_id, slug, timezone
       FROM p_events WHERE organization_id = ?1 AND id = ?2
         AND source_deleted_at IS NULL LIMIT 1`,
    )
      .bind(workflow.organization_id, workflow.event_id)
      .first<EventRow>();
    if (!event || event.timezone !== workflow.timezone) {
      throw new Error("Task reminder event snapshot is unavailable.");
    }
    const assignmentRows = await this.#environment.DB.prepare(
      `SELECT assignment.id AS assignment_id, assignment.contact_id,
              assignment.due_at, assignment.required, assignment.status,
              definition.approval_required, definition.name,
              contact.display_name, contact.first_name,
              contact.email_normalized
       FROM p_task_assignments AS assignment
       JOIN p_task_definitions AS definition
         ON definition.organization_id = assignment.organization_id
        AND definition.event_id = assignment.event_id
        AND definition.id = assignment.definition_id
        AND definition.source_deleted_at IS NULL
       JOIN p_contacts AS contact
         ON contact.organization_id = assignment.organization_id
        AND contact.id = assignment.contact_id
        AND contact.source_deleted_at IS NULL
       WHERE assignment.organization_id = ?1 AND assignment.event_id = ?2
         AND assignment.definition_id = ?3
         AND assignment.source_deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM task_reminder_results AS result
           WHERE result.organization_id = assignment.organization_id
             AND result.workflow_id = ?4
             AND result.assignment_id = assignment.id
         )
       ORDER BY assignment.due_at, assignment.id LIMIT ?5`,
    )
      .bind(
        workflow.organization_id,
        workflow.event_id,
        workflow.definition_id,
        workflowId,
        maximumAssignments + 1,
      )
      .all<ReminderAssignmentRow>();
    if (assignmentRows.results.length > maximumAssignments) {
      throw new Error("Task reminder assignment scope exceeds 5,000 rows.");
    }
    const nowDate = this.#now();
    const now = nowDate.toISOString();
    let nextWake = Number.POSITIVE_INFINITY;
    const repository = new D1EmailTemplateProjectionRepository(
      this.#environment.DB,
    );
    const selected = await repository.readTemplateWithHead(
      {
        id: event.id,
        name: event.name,
        organizationId: event.organization_id,
        slug: event.slug,
        sourceRecordId: "workflow",
        timezone: event.timezone,
        venue: "",
      },
      "template_task_reminder",
    );
    const emailConfig = parseEmailDeliveryConfig(
      this.#environment.EMAIL_DELIVERY_CONFIG,
      this.#environment.APP_ENV,
    );
    const template =
      selected?.head.template.status === "active"
        ? selected.head.template
        : createSeedEmailTemplates({
            createdAt: now,
            eventId: event.id,
            replyTo: emailConfig.authReplyTo,
            sender: {
              address:
                /<([^<>]+)>$/u.exec(emailConfig.authFrom)?.[1] ??
                emailConfig.authFrom,
              name: "OpenSession",
            },
          }).find(({ id }) => id === "template_task_reminder");
    if (!template)
      throw new Error("The task reminder email template is unavailable.");
    const coordinator = new CampaignEmailCoordinator({
      config: emailConfig,
      database: this.#environment.DB,
      now: this.#now,
      queue: this.#environment.EMAIL_QUEUE,
    });
    for (const assignment of assignmentRows.results) {
      if (assignment.required !== 1) {
        await recordResult(
          this.#environment.DB,
          workflow,
          assignment,
          "skipped",
          "optional",
          null,
          now,
        );
        continue;
      }
      if (
        assignment.status === "waived" ||
        assignment.status === "submitted" ||
        assignment.status === "complete"
      ) {
        await recordResult(
          this.#environment.DB,
          workflow,
          assignment,
          "skipped",
          "completed",
          null,
          now,
        );
        continue;
      }
      if (!assignment.due_at) {
        await recordResult(
          this.#environment.DB,
          workflow,
          assignment,
          "skipped",
          "missing_due",
          null,
          now,
        );
        continue;
      }
      const wakeAt = reminderAt(assignment.due_at, workflow.lead_minutes);
      if (wakeAt > nowDate.getTime()) {
        nextWake = Math.min(nextWake, wakeAt);
        continue;
      }
      if (!assignment.email_normalized.trim()) {
        await recordResult(
          this.#environment.DB,
          workflow,
          assignment,
          "skipped",
          "missing_email",
          null,
          now,
        );
        continue;
      }
      const values: EmailMergeValues = {
        "event.name": { type: "text", value: event.name },
        "recipient.first_name": { type: "text", value: firstName(assignment) },
        "task.due_at": {
          display: dueDisplay(assignment.due_at, event.timezone),
          type: "date_time",
          value: assignment.due_at,
        },
        "task.name": { type: "text", value: assignment.name },
        "task.portal_url": {
          type: "url",
          value: `${origin(this.#environment.APP_ENV)}/portal/${encodeURIComponent(event.slug)}/tasks/${encodeURIComponent(assignment.assignment_id)}`,
        },
      };
      const rendered = renderEmailTemplate(template, values);
      const campaignId = `task_reminder_${workflowId}_${currentCheckpoint.retry_count}`;
      const messageId = await createCampaignMessageKey({
        campaignId,
        contactId: assignment.contact_id,
        templateId: template.id,
        templateVersion: template.version,
      });
      const message: CampaignEmailQueueMessage = {
        campaign_id: campaignId,
        contact_id: assignment.contact_id,
        email: { ...rendered, to: [assignment.email_normalized] },
        event_id: event.id,
        kind: "campaign.email.requested",
        message_id: messageId,
        organization_id: event.organization_id,
        queued_at: now,
        request_id: workflow.request_id,
        template_id: template.id,
        template_version: template.version,
        version: 1,
      };
      const delivery = await coordinator.enqueue(message);
      const suppressed =
        delivery.outcome === "suppressed" ||
        (delivery.outcome === "already_terminal" &&
          delivery.status === "suppressed");
      await recordResult(
        this.#environment.DB,
        workflow,
        assignment,
        suppressed ? "skipped" : "queued",
        suppressed
          ? "suppressed"
          : delivery.outcome === "queued"
            ? "queued"
            : "already_queued",
        suppressed ? null : messageId,
        now,
      );
    }
    const nextWakeAt = Number.isFinite(nextWake)
      ? new Date(nextWake).toISOString()
      : null;
    await saveCheckpoint(
      this.#environment.DB,
      workflowId,
      nextWakeAt ? "sleeping" : "complete",
      { ...currentCheckpoint, next_wake_at: nextWakeAt },
      now,
    );
    if (!nextWakeAt) {
      await this.#environment.DB.prepare(
        `UPDATE workflow_runs SET finished_at = ?2
         WHERE id = ?1 AND status = 'complete'`,
      )
        .bind(workflowId, now)
        .run();
    }
    return { nextWakeAt };
  }
}

export class TaskReminderCoordinator {
  readonly #environment: Env;

  constructor(environment: Env) {
    this.#environment = environment;
  }

  async schedule(
    event: Pick<EventRow, "id" | "organization_id" | "timezone">,
    command: TaskReminderScheduleCommand,
    requestId: string,
  ) {
    const workflowId = `trw_${(
      await sha256Hex(
        `task-reminder\u0000${event.organization_id}\u0000${event.id}\u0000${command.command_id}`,
      )
    ).slice(0, 40)}`;
    const now = new Date().toISOString();
    const workflowInput: WorkflowInput = {
      command_id: command.command_id,
      definition_id: command.definition_id,
      event_id: event.id,
      lead_minutes: command.lead_minutes,
      organization_id: event.organization_id,
      request_id: requestId,
      timezone: event.timezone,
      version: 1,
      workflow_id: workflowId,
    };
    const payload = JSON.stringify(workflowInput);
    const outboxId = `out_${(
      await sha256Hex(`task-reminder-outbox\u0000${workflowId}`)
    ).slice(0, 26)}`;
    const inserted = await this.#environment.DB.batch([
      this.#environment.DB.prepare(
        `INSERT INTO workflow_runs (
           id, organization_id, event_id, workflow_type, provider_instance_id,
           idempotency_key, status, input_json, checkpoint_json, created_at,
           updated_at
         ) VALUES (?1, ?2, ?3, 'task_due_reminder', NULL, ?4, 'queued', ?5,
                   ?6, ?7, ?7)
         ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
      ).bind(
        workflowId,
        event.organization_id,
        event.id,
        `task-reminder:v1:${event.id}:${command.command_id}`,
        payload,
        JSON.stringify({
          last_control_command_id: null,
          next_wake_at: null,
          retry_count: 0,
        }),
        now,
      ),
      this.#environment.DB.prepare(
        `INSERT INTO outbox_events (
           id, organization_id, event_id, aggregate_type, aggregate_id,
           event_type, idempotency_key, payload_json, status, available_at,
           created_at, updated_at
         ) VALUES (?1, ?2, ?3, 'task_definition', ?4,
                   'task.reminder.requested', ?5, ?6, 'pending', ?7, ?7, ?7)
         ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
      ).bind(
        outboxId,
        event.organization_id,
        event.id,
        command.definition_id,
        `task-reminder:v1:${event.id}:${command.command_id}`,
        payload,
        now,
      ),
    ]);
    const stored = await this.#row(workflowId);
    const storedInput = stored ? input(stored.input_json) : null;
    if (
      !stored ||
      !storedInput ||
      storedInput.command_id !== command.command_id ||
      storedInput.definition_id !== command.definition_id ||
      storedInput.event_id !== event.id ||
      storedInput.lead_minutes !== command.lead_minutes ||
      storedInput.organization_id !== event.organization_id ||
      storedInput.timezone !== event.timezone
    ) {
      throw new Error("Task reminder command conflicts with an existing job.");
    }
    const replayed = inserted[0]?.meta.changes !== 1;
    if (!stored.provider_instance_id) {
      const instance = await this.#environment.TASK_REMINDER_WORKFLOW.create({
        id: workflowId,
        params: {
          definition_id: command.definition_id,
          event_id: event.id,
          organization_id: event.organization_id,
          request_id: requestId,
          version: 1,
          workflow_id: workflowId,
        },
        retention: { errorRetention: "30 days", successRetention: "30 days" },
      });
      await this.#environment.DB.batch([
        this.#environment.DB.prepare(
          `UPDATE workflow_runs SET provider_instance_id = ?2, updated_at = ?3
           WHERE id = ?1 AND provider_instance_id IS NULL`,
        ).bind(workflowId, instance.id, now),
        this.#environment.DB.prepare(
          `UPDATE outbox_events
           SET status = 'published', published_at = ?2, updated_at = ?2,
               attempt_count = attempt_count + 1
           WHERE id = ?1 AND status = 'pending'`,
        ).bind(outboxId, now),
      ]);
    }
    return taskReminderCommandResponseSchema.parse({
      job: await this.read(event.organization_id, event.id, workflowId),
      ok: true,
      replayed,
    });
  }

  async read(
    organizationId: string,
    eventId: string,
    workflowId: string,
  ): Promise<TaskReminderJob> {
    const row = await this.#environment.DB.prepare(
      `SELECT input_json, checkpoint_json, status, provider_instance_id,
              created_at, updated_at
       FROM workflow_runs
       WHERE organization_id = ?1 AND event_id = ?2 AND id = ?3
         AND workflow_type = 'task_due_reminder' LIMIT 1`,
    )
      .bind(organizationId, eventId, workflowId)
      .first<WorkflowRow>();
    if (!row) throw new Error("Task reminder workflow does not exist.");
    const storedInput = input(row.input_json);
    const storedCheckpoint = checkpoint(row.checkpoint_json);
    const results = await this.#environment.DB.prepare(
      `SELECT assignment_id, contact_id, disposition, reason, message_id,
              evaluated_at
       FROM task_reminder_results
       WHERE organization_id = ?1 AND event_id = ?2 AND workflow_id = ?3
       ORDER BY assignment_id LIMIT 5001`,
    )
      .bind(organizationId, eventId, workflowId)
      .all();
    if (results.results.length > maximumAssignments) {
      throw new Error("Task reminder result scope exceeds 5,000 rows.");
    }
    return taskReminderJobSchema.parse({
      created_at: row.created_at,
      definition_id: storedInput.definition_id,
      event_id: storedInput.event_id,
      id: storedInput.workflow_id,
      lead_minutes: storedInput.lead_minutes,
      next_wake_at: storedCheckpoint.next_wake_at,
      provider_instance_id: row.provider_instance_id,
      results: results.results,
      status: row.status,
      timezone: storedInput.timezone,
      updated_at: row.updated_at,
    });
  }

  async control(
    organizationId: string,
    eventId: string,
    workflowId: string,
    command: TaskReminderControlCommand,
  ) {
    const row = await this.#row(workflowId);
    if (!row) throw new Error("Task reminder workflow does not exist.");
    const storedInput = input(row.input_json);
    if (
      storedInput.organization_id !== organizationId ||
      storedInput.event_id !== eventId ||
      !row.provider_instance_id
    ) {
      throw new Error("Task reminder workflow scope is invalid.");
    }
    const now = new Date().toISOString();
    const controlPayload = JSON.stringify(command);
    const controlKey = `task-reminder-control:v1:${workflowId}:${command.command_id}`;
    const controlOutboxId = `out_${(
      await sha256Hex(`task-reminder-control\u0000${controlKey}`)
    ).slice(0, 26)}`;
    const inserted = await this.#environment.DB.prepare(
      `INSERT INTO outbox_events (
         id, organization_id, event_id, aggregate_type, aggregate_id,
         event_type, idempotency_key, payload_json, status, available_at,
         created_at, updated_at
       ) VALUES (?1, ?2, ?3, 'workflow_run', ?4, ?5, ?6, ?7,
                 'pending', ?8, ?8, ?8)
       ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
    )
      .bind(
        controlOutboxId,
        organizationId,
        eventId,
        workflowId,
        `task.reminder.${command.type}.requested`,
        controlKey,
        controlPayload,
        now,
      )
      .run();
    const controlOutbox = await this.#environment.DB.prepare(
      `SELECT status, payload_json FROM outbox_events
       WHERE organization_id = ?1 AND id = ?2 LIMIT 1`,
    )
      .bind(organizationId, controlOutboxId)
      .first<{ payload_json: string; status: string }>();
    if (!controlOutbox || controlOutbox.payload_json !== controlPayload) {
      throw new Error(
        "Task reminder control command conflicts with a prior use.",
      );
    }
    if (controlOutbox.status === "published") {
      return taskReminderCommandResponseSchema.parse({
        job: await this.read(organizationId, eventId, workflowId),
        ok: true,
        replayed: true,
      });
    }
    const instance = await this.#environment.TASK_REMINDER_WORKFLOW.get(
      row.provider_instance_id,
    );
    if (command.type === "cancel") {
      if (row.status !== "canceled") {
        await instance.terminate();
      }
      await this.#environment.DB.prepare(
        `UPDATE workflow_runs SET status = 'canceled', finished_at = ?2,
                checkpoint_json = ?3, updated_at = ?2, error_code = NULL
         WHERE id = ?1`,
      )
        .bind(
          workflowId,
          now,
          JSON.stringify({
            ...checkpoint(row.checkpoint_json),
            last_control_command_id: command.command_id,
          }),
        )
        .run();
    } else {
      const current = checkpoint(row.checkpoint_json);
      if (current.last_control_command_id !== command.command_id) {
        await this.#environment.DB.batch([
          this.#environment.DB.prepare(
            `DELETE FROM task_reminder_results
             WHERE organization_id = ?1 AND workflow_id = ?2`,
          ).bind(organizationId, workflowId),
          this.#environment.DB.prepare(
            `UPDATE workflow_runs
             SET status = 'queued', checkpoint_json = ?2, finished_at = NULL,
                 error_code = NULL, updated_at = ?3
             WHERE id = ?1`,
          ).bind(
            workflowId,
            JSON.stringify({
              last_control_command_id: command.command_id,
              next_wake_at: null,
              retry_count: current.retry_count + 1,
            }),
            now,
          ),
        ]);
      }
      await instance.restart();
    }
    await this.#environment.DB.prepare(
      `UPDATE outbox_events
       SET status = 'published', published_at = ?2, updated_at = ?2,
           attempt_count = attempt_count + 1
       WHERE id = ?1 AND status = 'pending'`,
    )
      .bind(controlOutboxId, now)
      .run();
    return taskReminderCommandResponseSchema.parse({
      job: await this.read(organizationId, eventId, workflowId),
      ok: true,
      replayed: inserted.meta.changes !== 1,
    });
  }

  async #row(workflowId: string): Promise<WorkflowRow | null> {
    return this.#environment.DB.prepare(
      `SELECT input_json, checkpoint_json, status, provider_instance_id,
              created_at, updated_at
       FROM workflow_runs WHERE id = ?1 AND workflow_type = 'task_due_reminder'
       LIMIT 1`,
    )
      .bind(workflowId)
      .first<WorkflowRow>();
  }
}

export type { EventRow as TaskReminderEvent };
