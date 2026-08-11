import {
  createCampaignMessageKey,
  createSeedEmailTemplates,
  renderEmailTemplate,
  type EmailMergeValues,
} from "@sessionbox-killer/email";

import type { EmailDeliveryConfig } from "../email/config.js";
import { CampaignEmailCoordinator } from "../email/delivery.js";
import type { EmailQueueMessage } from "../email/messages.js";
import { D1EmailTemplateProjectionRepository } from "../email-templates/repository.js";
import type { TaskEventScope } from "../tasks/service.js";
import { LifecycleEmailOutbox } from "./email-outbox.js";

interface AssignmentRow {
  assignment_id: string;
  contact_id: string;
  display_name: string;
  email_normalized: string;
  first_name: string | null;
  name: string;
}

interface EventRow {
  id: string;
  name: string;
  organization_id: string;
  slug: string;
  source_record_id: string;
  timezone: string;
  venue: string | null;
}

function firstName(row: AssignmentRow): string {
  return (
    row.first_name?.trim() ||
    row.display_name.trim().split(/\s+/u)[0] ||
    "there"
  );
}

function safeOrigin(requestUrl: string): string {
  const value = new URL(requestUrl);
  return value.protocol === "https:" ||
    (value.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(value.hostname))
    ? value.origin
    : "https://preview.opensession.invalid";
}

export class TaskAssignmentLifecycleService {
  readonly #database: D1Database;
  readonly #emailConfig: EmailDeliveryConfig;
  readonly #now: () => Date;
  readonly #outbox: LifecycleEmailOutbox;

  constructor(options: {
    database: D1Database;
    emailConfig: EmailDeliveryConfig;
    emailQueue: Queue<EmailQueueMessage>;
    now?: () => Date;
  }) {
    this.#database = options.database;
    this.#emailConfig = options.emailConfig;
    this.#now = options.now ?? (() => new Date());
    this.#outbox = new LifecycleEmailOutbox({
      coordinator: new CampaignEmailCoordinator({
        config: options.emailConfig,
        database: options.database,
        now: this.#now,
        queue: options.emailQueue,
      }),
      database: options.database,
      now: this.#now,
    });
  }

  async notify(
    event: TaskEventScope,
    assignmentIds: readonly string[],
    requestId: string,
    requestUrl: string,
  ): Promise<void> {
    const ids = [...new Set(assignmentIds)].sort();
    if (ids.length === 0) return;
    if (ids.length > 5_000) {
      throw new Error("Task assignment notification scope exceeds 5,000 rows.");
    }
    const placeholders = ids.map((_, index) => `?${index + 3}`).join(", ");
    const [eventRow, assignments] = await Promise.all([
      this.#database
        .prepare(
          `SELECT id, name, organization_id, slug, source_record_id, timezone,
                  venue
           FROM p_events WHERE organization_id = ?1 AND id = ?2
             AND source_deleted_at IS NULL LIMIT 1`,
        )
        .bind(event.organizationId, event.eventId)
        .first<EventRow>(),
      this.#database
        .prepare(
          `SELECT assignment.id AS assignment_id, assignment.contact_id,
                  definition.name, contact.display_name, contact.first_name,
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
             AND assignment.id IN (${placeholders})
             AND assignment.source_deleted_at IS NULL
           ORDER BY assignment.id LIMIT 5001`,
        )
        .bind(event.organizationId, event.eventId, ...ids)
        .all<AssignmentRow>(),
    ]);
    if (!eventRow || assignments.results.length !== ids.length) {
      throw new Error("Task assignment notification projection is incomplete.");
    }
    const repository = new D1EmailTemplateProjectionRepository(this.#database);
    const selected = await repository.readTemplateWithHead(
      {
        id: eventRow.id,
        name: eventRow.name,
        organizationId: eventRow.organization_id,
        slug: eventRow.slug,
        sourceRecordId: eventRow.source_record_id,
        timezone: eventRow.timezone,
        venue: eventRow.venue ?? "",
      },
      "template_task_assigned",
    );
    const queuedAt = this.#now().toISOString();
    const template =
      selected?.head.template.status === "active"
        ? selected.head.template
        : createSeedEmailTemplates({
            createdAt: queuedAt,
            eventId: eventRow.id,
            replyTo: this.#emailConfig.authReplyTo,
            sender: {
              address:
                /<([^<>]+)>$/u.exec(this.#emailConfig.authFrom)?.[1] ??
                this.#emailConfig.authFrom,
              name: "OpenSession",
            },
          }).find(({ id }) => id === "template_task_assigned");
    if (!template)
      throw new Error("The task-assigned email template is unavailable.");
    const origin = safeOrigin(requestUrl);
    for (const assignment of assignments.results) {
      const values: EmailMergeValues = {
        "event.name": { type: "text", value: eventRow.name },
        "recipient.first_name": {
          type: "text",
          value: firstName(assignment),
        },
        "task.name": { type: "text", value: assignment.name },
        "task.portal_url": {
          type: "url",
          value: `${origin}/portal/${encodeURIComponent(eventRow.slug)}/tasks/${encodeURIComponent(assignment.assignment_id)}`,
        },
      };
      const rendered = renderEmailTemplate(template, values);
      const campaignId = `task_assignment_${assignment.assignment_id}`;
      const messageId = await createCampaignMessageKey({
        campaignId,
        contactId: assignment.contact_id,
        templateId: template.id,
        templateVersion: template.version,
      });
      await this.#outbox.enqueueAndDispatch({
        aggregateId: assignment.assignment_id,
        aggregateType: "task_assignment",
        eventId: eventRow.id,
        eventType: "lifecycle.task_assignment.requested",
        idempotencyKey: `lifecycle:task-assignment:${assignment.assignment_id}`,
        message: {
          campaign_id: campaignId,
          contact_id: assignment.contact_id,
          email: { ...rendered, to: [assignment.email_normalized] },
          event_id: eventRow.id,
          kind: "campaign.email.requested",
          message_id: messageId,
          organization_id: eventRow.organization_id,
          queued_at: queuedAt,
          request_id: requestId,
          template_id: template.id,
          template_version: template.version,
          version: 1,
        },
        organizationId: eventRow.organization_id,
      });
    }
  }
}
