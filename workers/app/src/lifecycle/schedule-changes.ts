import {
  createCampaignMessageKey,
  renderEmailTemplate,
  type EmailMergeValues,
} from "@sessionbox-killer/email";

import type { EmailDeliveryConfig } from "../email/config.js";
import { CampaignEmailCoordinator } from "../email/delivery.js";
import type { EmailQueueMessage } from "../email/messages.js";
import { D1EmailTemplateProjectionRepository } from "../email-templates/repository.js";
import { LifecycleEmailOutbox } from "./email-outbox.js";

interface ChangeRow {
  organization_id: string;
  payload_json: string;
}

interface ChangePayload {
  commandId: string;
  sessionId: string;
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

interface RecipientRow {
  contact_id: string;
  display_name: string;
  email_normalized: string;
  ends_at: string;
  first_name: string | null;
  room_name: string;
  session_id: string;
  starts_at: string;
  title: string;
}

function changePayload(value: string): ChangePayload {
  const parsed = JSON.parse(value) as Partial<ChangePayload>;
  if (
    typeof parsed.commandId !== "string" ||
    typeof parsed.sessionId !== "string"
  ) {
    throw new Error("Schedule lifecycle payload is invalid.");
  }
  return parsed as ChangePayload;
}

function firstName(row: RecipientRow): string {
  return (
    row.first_name?.trim() ||
    row.display_name.trim().split(/\s+/u)[0] ||
    "there"
  );
}

function display(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "long",
    timeZone: timezone,
    timeZoneName: "short",
  }).format(new Date(value));
}

function safeOrigin(requestUrl: string): string {
  const value = new URL(requestUrl);
  return value.protocol === "https:" ||
    (value.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(value.hostname))
    ? value.origin
    : "https://preview.opensession.invalid";
}

export class ScheduleChangeLifecycleService {
  readonly #database: D1Database;
  readonly #now: () => Date;
  readonly #outbox: LifecycleEmailOutbox;

  constructor(options: {
    database: D1Database;
    emailConfig: EmailDeliveryConfig;
    emailQueue: Queue<EmailQueueMessage>;
    now?: () => Date;
  }) {
    this.#database = options.database;
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
    eventId: string,
    commandId: string,
    requestId: string,
    requestUrl: string,
  ): Promise<void> {
    const change = await this.#database
      .prepare(
        `SELECT organization_id, payload_json FROM outbox_events
         WHERE event_id = ?1 AND event_type = 'schedule.public_change.recorded'
           AND json_extract(payload_json, '$.commandId') = ?2
         ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(eventId, commandId)
      .first<ChangeRow>();
    if (!change) return;
    const payload = changePayload(change.payload_json);
    const [event, recipients] = await Promise.all([
      this.#database
        .prepare(
          `SELECT id, name, organization_id, slug, source_record_id, timezone,
                  venue
           FROM p_events WHERE organization_id = ?1 AND id = ?2
             AND source_deleted_at IS NULL LIMIT 1`,
        )
        .bind(change.organization_id, eventId)
        .first<EventRow>(),
      this.#database
        .prepare(
          `SELECT participant.contact_id, contact.display_name,
                  contact.first_name, contact.email_normalized,
                  session.id AS session_id, session.title, slot.starts_at,
                  slot.ends_at, room.name AS room_name
           FROM p_session_participants AS participant
           JOIN p_contacts AS contact
             ON contact.organization_id = participant.organization_id
            AND contact.id = participant.contact_id
            AND contact.source_deleted_at IS NULL
           JOIN p_sessions AS session
             ON session.organization_id = participant.organization_id
            AND session.event_id = participant.event_id
            AND session.id = participant.session_id
            AND session.source_deleted_at IS NULL
           JOIN p_schedule_slots AS slot
             ON slot.organization_id = session.organization_id
            AND slot.event_id = session.event_id
            AND slot.session_id = session.id
            AND slot.source_deleted_at IS NULL
           JOIN p_rooms AS room
             ON room.organization_id = slot.organization_id
            AND room.event_id = slot.event_id AND room.id = slot.room_id
            AND room.source_deleted_at IS NULL
           WHERE participant.organization_id = ?1
             AND participant.event_id = ?2 AND participant.session_id = ?3
             AND participant.role IN ('speaker', 'moderator', 'chair')
             AND participant.source_deleted_at IS NULL
           ORDER BY participant.sort_order, participant.id LIMIT 201`,
        )
        .bind(change.organization_id, eventId, payload.sessionId)
        .all<RecipientRow>(),
    ]);
    if (!event) throw new Error("Schedule lifecycle event is unavailable.");
    if (recipients.results.length > 200) {
      throw new Error("Schedule lifecycle recipient scope exceeds 200 rows.");
    }
    const repository = new D1EmailTemplateProjectionRepository(this.#database);
    const selected = await repository.readTemplateWithHead(
      {
        id: event.id,
        name: event.name,
        organizationId: event.organization_id,
        slug: event.slug,
        sourceRecordId: event.source_record_id,
        timezone: event.timezone,
        venue: event.venue ?? "",
      },
      "template_schedule_updated",
    );
    if (!selected || selected.head.template.status !== "active") {
      throw new Error("The schedule-update email template is unavailable.");
    }
    const origin = safeOrigin(requestUrl);
    const queuedAt = this.#now().toISOString();
    for (const recipient of recipients.results) {
      const template = selected.head.template;
      const values: EmailMergeValues = {
        "event.name": { type: "text", value: event.name },
        "recipient.first_name": {
          type: "text",
          value: firstName(recipient),
        },
        "session.end_at": {
          display: display(recipient.ends_at, event.timezone),
          type: "date_time",
          value: recipient.ends_at,
        },
        "session.public_url": {
          type: "url",
          value: `${origin}/e/${encodeURIComponent(event.slug)}#session-${encodeURIComponent(recipient.session_id)}`,
        },
        "session.room": { type: "text", value: recipient.room_name },
        "session.start_at": {
          display: display(recipient.starts_at, event.timezone),
          type: "date_time",
          value: recipient.starts_at,
        },
        "session.title": { type: "text", value: recipient.title },
      };
      const rendered = renderEmailTemplate(template, values);
      const campaignId = `schedule_change_${commandId}`;
      const messageId = await createCampaignMessageKey({
        campaignId,
        contactId: recipient.contact_id,
        templateId: template.id,
        templateVersion: template.version,
      });
      await this.#outbox.enqueueAndDispatch({
        aggregateId: recipient.session_id,
        aggregateType: "schedule_session",
        eventId: event.id,
        eventType: "lifecycle.schedule_change.requested",
        idempotencyKey: `lifecycle:schedule-change:${commandId}:${recipient.contact_id}`,
        message: {
          campaign_id: campaignId,
          contact_id: recipient.contact_id,
          email: { ...rendered, to: [recipient.email_normalized] },
          event_id: event.id,
          kind: "campaign.email.requested",
          message_id: messageId,
          organization_id: event.organization_id,
          queued_at: queuedAt,
          request_id: requestId,
          template_id: template.id,
          template_version: template.version,
          version: 1,
        },
        organizationId: event.organization_id,
      });
    }
  }
}
