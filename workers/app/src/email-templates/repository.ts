import {
  EMAIL_MERGE_SCHEMA_VERSION,
  emailDocumentSchema,
  emailMergeFieldDefinitions,
  emailMergeFieldNameSchema,
  emailTemplateFamilyId,
  emailTemplateHead,
  emailTemplateSchema,
  emailTemplateVersionId,
  type EmailMergeValues,
  type EmailPreviewRecipient,
  type EmailTemplate,
  type EmailTemplateAudience,
  type EmailTemplateDraft,
  type EmailTemplateRecord,
  type EmailTemplateWorkspace,
} from "@sessionbox-killer/email";

export interface EmailTemplateEventProjection {
  readonly id: string;
  readonly name: string;
  readonly organizationId: string;
  readonly slug: string;
  readonly sourceRecordId: string;
  readonly timezone: string;
  readonly venue: string;
}

export interface EmailTemplateWithHead {
  readonly current: EmailTemplateRecord;
  readonly head: EmailTemplateRecord;
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

interface TemplateRow {
  audience_type: string;
  body_document_json: string;
  event_id: string;
  id: string;
  merge_schema_version: number;
  name: string;
  projected_at: string;
  reply_to: string | null;
  sender_email: string;
  sender_name: string;
  source_version: number;
  status: string;
  subject: string;
  used_merge_fields_json: string;
  version: number;
}

interface RecipientRow {
  display_name: string;
  email_normalized: string;
  first_name: string | null;
  id: string;
  portal_state: string;
  roles_json: string;
}

interface SubmissionRow {
  friendly_id: string;
  title: string;
}

interface SessionRow {
  ends_at: string | null;
  room_name: string | null;
  session_id: string;
  starts_at: string | null;
  title: string;
}

interface TaskRow {
  assignment_id: string;
  due_at: string | null;
  name: string;
}

function eventProjection(row: EventRow): EmailTemplateEventProjection {
  return {
    id: row.id,
    name: row.name,
    organizationId: row.organization_id,
    slug: row.slug,
    sourceRecordId: row.source_record_id,
    timezone: row.timezone,
    venue: row.venue ?? "",
  };
}

function json(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new EmailTemplateProjectionError(`${label} is not valid JSON.`);
  }
}

function templateRecord(row: TemplateRow): EmailTemplateRecord {
  const rawDocument = json(row.body_document_json, "Template body");
  const legacyDocument =
    rawDocument &&
    typeof rawDocument === "object" &&
    !Array.isArray(rawDocument)
      ? { previewText: "", ...rawDocument }
      : rawDocument;
  const body = emailDocumentSchema.safeParse(legacyDocument);
  if (!body.success) {
    throw new EmailTemplateProjectionError(
      `Template ${row.id} has an invalid structured body.`,
    );
  }
  const rawMergeFields = json(
    row.used_merge_fields_json,
    "Template merge fields",
  );
  const mergeFields = Array.isArray(rawMergeFields)
    ? rawMergeFields.flatMap((field) => {
        const parsed = emailMergeFieldNameSchema.safeParse(field);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
  if (
    !Array.isArray(rawMergeFields) ||
    mergeFields.length !== rawMergeFields.length
  ) {
    throw new EmailTemplateProjectionError(
      `Template ${row.id} has invalid merge-field metadata.`,
    );
  }

  const template = emailTemplateSchema.safeParse({
    allowedMergeFields: mergeFields,
    audience: row.audience_type,
    body: body.data,
    createdAt: row.projected_at,
    eventId: row.event_id,
    id: row.id,
    internalName: row.name,
    mergeSchemaVersion: row.merge_schema_version,
    replyTo: row.reply_to ?? row.sender_email,
    sender: { address: row.sender_email, name: row.sender_name },
    status: row.status,
    subject: row.subject,
    updatedAt: row.projected_at,
    version: row.version,
  });
  if (!template.success) {
    throw new EmailTemplateProjectionError(
      `Template ${row.id} has invalid projected metadata.`,
    );
  }
  return { sourceVersion: row.source_version, template: template.data };
}

function safeBaseUrl(requestUrl: string): string {
  const url = new URL(requestUrl);
  return url.protocol === "https:"
    ? url.origin
    : "https://preview.opensession.invalid";
}

function displayDate(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "long",
    timeZone: timezone,
    timeZoneName: "short",
  }).format(new Date(value));
}

function parseRoles(value: string): readonly string[] {
  const parsed = json(value, "Recipient roles");
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((role) => typeof role !== "string" || role.length === 0)
  ) {
    throw new EmailTemplateProjectionError("Recipient roles are invalid.");
  }
  return parsed;
}

export class D1EmailTemplateProjectionRepository {
  readonly #database: D1Database;

  constructor(database: D1Database) {
    this.#database = database;
  }

  async findEventCandidates(
    eventKey: string,
  ): Promise<readonly EmailTemplateEventProjection[]> {
    const rows = await this.#database
      .prepare(
        `SELECT event.id, event.name, event.organization_id, event.slug,
                event.source_record_id, event.timezone, event.venue
         FROM p_events AS event
         JOIN tenant_registry AS tenant
           ON tenant.organization_id = event.organization_id
          AND tenant.status = 'active'
          AND tenant.authority_ready_at IS NOT NULL
         WHERE (event.id = ?1 OR event.slug = ?1)
           AND event.source_deleted_at IS NULL
         ORDER BY CASE WHEN event.id = ?1 THEN 0 ELSE 1 END,
                  event.organization_id
         LIMIT 33`,
      )
      .bind(eventKey)
      .all<EventRow>();
    return rows.results.map(eventProjection);
  }

  async readWorkspace(
    event: EmailTemplateEventProjection,
  ): Promise<EmailTemplateWorkspace> {
    const [templateRows, recipientRows] = await Promise.all([
      this.#database
        .prepare(
          `SELECT id, event_id, name, audience_type, sender_name, sender_email,
                  subject, body_document_json, reply_to,
                  used_merge_fields_json, merge_schema_version, status,
                  version, source_version, projected_at
           FROM p_email_templates
           WHERE organization_id = ?1 AND event_id = ?2
             AND source_deleted_at IS NULL
           ORDER BY name COLLATE NOCASE, version DESC, id
           LIMIT 101`,
        )
        .bind(event.organizationId, event.id)
        .all<TemplateRow>(),
      this.#database
        .prepare(
          `SELECT contact.id, contact.display_name, contact.first_name,
                  contact.email_normalized, event_contact.roles_json
           FROM p_event_contacts AS event_contact
           JOIN p_contacts AS contact
             ON contact.organization_id = event_contact.organization_id
            AND contact.id = event_contact.contact_id
            AND contact.source_deleted_at IS NULL
           WHERE event_contact.organization_id = ?1
             AND event_contact.event_id = ?2
             AND event_contact.portal_state IN ('active', 'invited')
             AND event_contact.source_deleted_at IS NULL
             AND EXISTS (
               SELECT 1 FROM json_each(event_contact.roles_json)
               WHERE json_each.value = 'speaker'
             )
           ORDER BY contact.display_name COLLATE NOCASE, contact.id
           LIMIT 201`,
        )
        .bind(event.organizationId, event.id)
        .all<RecipientRow>(),
    ]);
    if (templateRows.results.length > 100) {
      throw new EmailTemplateProjectionError(
        "The event has more than 100 template versions.",
      );
    }
    if (recipientRows.results.length > 200) {
      throw new EmailTemplateProjectionError(
        "The event has more than 200 preview recipients.",
      );
    }
    const recipients: EmailPreviewRecipient[] = recipientRows.results.map(
      (recipient) => ({
        email: recipient.email_normalized,
        id: recipient.id,
        name: recipient.display_name,
        roles: [...parseRoles(recipient.roles_json)],
      }),
    );
    return {
      event: { id: event.id, name: event.name, slug: event.slug },
      mergeFields: Object.entries(emailMergeFieldDefinitions).map(
        ([name, definition]) => ({
          name: name as keyof typeof emailMergeFieldDefinitions,
          type: definition.type,
        }),
      ),
      recipients,
      templates: templateRows.results.map(templateRecord),
    };
  }

  async readTemplate(
    event: EmailTemplateEventProjection,
    templateId: string,
  ): Promise<EmailTemplateRecord | null> {
    const row = await this.#database
      .prepare(
        `SELECT id, event_id, name, audience_type, sender_name, sender_email,
                subject, body_document_json, reply_to,
                used_merge_fields_json, merge_schema_version, status,
                version, source_version, projected_at
         FROM p_email_templates
         WHERE organization_id = ?1 AND event_id = ?2 AND id = ?3
           AND source_deleted_at IS NULL
         LIMIT 1`,
      )
      .bind(event.organizationId, event.id, templateId)
      .first<TemplateRow>();
    return row ? templateRecord(row) : null;
  }

  async readTemplateWithHead(
    event: EmailTemplateEventProjection,
    templateId: string,
  ): Promise<EmailTemplateWithHead | null> {
    const rows = await this.#database
      .prepare(
        `SELECT id, event_id, name, audience_type, sender_name, sender_email,
                subject, body_document_json, reply_to,
                used_merge_fields_json, merge_schema_version, status,
                version, source_version, projected_at
         FROM p_email_templates
         WHERE organization_id = ?1 AND event_id = ?2
           AND source_deleted_at IS NULL
         ORDER BY version DESC, id
         LIMIT 101`,
      )
      .bind(event.organizationId, event.id)
      .all<TemplateRow>();
    if (rows.results.length > 100) {
      throw new EmailTemplateProjectionError(
        "The event has more than 100 template versions.",
      );
    }
    const records = rows.results.map(templateRecord);
    const current = records.find(({ template }) => template.id === templateId);
    if (!current) return null;
    const headTemplate = emailTemplateHead(
      records.map(({ template }) => template),
      emailTemplateFamilyId(current.template.id),
    );
    const head = records.find(
      ({ template }) => template.id === headTemplate?.id,
    );
    if (!head) {
      throw new EmailTemplateProjectionError(
        "The template family has no valid immutable head.",
      );
    }
    return { current, head };
  }

  async readRecipientMergeValues(options: {
    readonly event: EmailTemplateEventProjection;
    readonly organizer: { readonly email: string; readonly name: string };
    readonly recipientId: string;
    readonly requestUrl: string;
  }): Promise<EmailMergeValues | null> {
    return this.readContactMergeValues({
      ...options,
      portalStates: ["active", "invited"],
      requiredRole: "speaker",
    });
  }

  async readContactMergeValues(options: {
    readonly event: EmailTemplateEventProjection;
    readonly organizer: { readonly email: string; readonly name: string };
    readonly portalStates?: readonly string[];
    readonly recipientId: string;
    readonly requestUrl: string;
    readonly requiredRole?: EmailTemplateAudience;
  }): Promise<EmailMergeValues | null> {
    const { event } = options;
    const recipient = await this.#database
      .prepare(
        `SELECT contact.id, contact.display_name, contact.first_name,
                contact.email_normalized, event_contact.portal_state,
                event_contact.roles_json
         FROM p_event_contacts AS event_contact
         JOIN p_contacts AS contact
           ON contact.organization_id = event_contact.organization_id
          AND contact.id = event_contact.contact_id
          AND contact.source_deleted_at IS NULL
         WHERE event_contact.organization_id = ?1
           AND event_contact.event_id = ?2
           AND event_contact.contact_id = ?3
           AND event_contact.source_deleted_at IS NULL
         LIMIT 1`,
      )
      .bind(event.organizationId, event.id, options.recipientId)
      .first<RecipientRow>();
    if (!recipient) return null;
    const recipientRoles = parseRoles(recipient.roles_json);
    if (
      (options.requiredRole &&
        !recipientRoles.includes(options.requiredRole)) ||
      (options.portalStates &&
        !options.portalStates.includes(recipient.portal_state))
    ) {
      return null;
    }

    const [submission, session, task] = await Promise.all([
      this.#database
        .prepare(
          `SELECT submission.friendly_id, submission.title
           FROM p_submissions AS submission
           WHERE submission.organization_id = ?1
             AND submission.event_id = ?2
             AND submission.source_deleted_at IS NULL
             AND (
               submission.submitter_contact_id = ?3 OR EXISTS (
                 SELECT 1 FROM p_submission_participants AS participant
                 WHERE participant.organization_id = submission.organization_id
                   AND participant.event_id = submission.event_id
                   AND participant.submission_id = submission.id
                   AND participant.contact_id = ?3
                   AND participant.source_deleted_at IS NULL
               )
             )
           ORDER BY CASE submission.status
             WHEN 'accepted' THEN 0 WHEN 'in_review' THEN 1
             WHEN 'submitted' THEN 2 ELSE 3 END,
             submission.submitted_at DESC, submission.id
           LIMIT 1`,
        )
        .bind(event.organizationId, event.id, recipient.id)
        .first<SubmissionRow>(),
      this.#database
        .prepare(
          `SELECT session.id AS session_id, session.title,
                  slot.starts_at, slot.ends_at, room.name AS room_name
           FROM p_session_participants AS participant
           JOIN p_sessions AS session
             ON session.organization_id = participant.organization_id
            AND session.event_id = participant.event_id
            AND session.id = participant.session_id
            AND session.source_deleted_at IS NULL
           LEFT JOIN p_schedule_slots AS slot
             ON slot.organization_id = session.organization_id
            AND slot.event_id = session.event_id
            AND slot.session_id = session.id
            AND slot.source_deleted_at IS NULL
           LEFT JOIN p_rooms AS room
             ON room.organization_id = session.organization_id
            AND room.event_id = session.event_id
            AND room.id = slot.room_id
            AND room.source_deleted_at IS NULL
           WHERE participant.organization_id = ?1
             AND participant.event_id = ?2
             AND participant.contact_id = ?3
             AND participant.confirmed_state != 'declined'
             AND participant.source_deleted_at IS NULL
           ORDER BY CASE session.status WHEN 'published' THEN 0
             WHEN 'scheduled' THEN 1 ELSE 2 END,
             slot.starts_at, session.id
           LIMIT 1`,
        )
        .bind(event.organizationId, event.id, recipient.id)
        .first<SessionRow>(),
      this.#database
        .prepare(
          `SELECT assignment.id AS assignment_id, assignment.due_at,
                  definition.name
           FROM p_task_assignments AS assignment
           JOIN p_task_definitions AS definition
             ON definition.organization_id = assignment.organization_id
            AND definition.event_id = assignment.event_id
            AND definition.id = assignment.definition_id
            AND definition.source_deleted_at IS NULL
           WHERE assignment.organization_id = ?1
             AND assignment.event_id = ?2
             AND assignment.contact_id = ?3
             AND assignment.status IN ('not_started', 'in_progress', 'rejected')
             AND assignment.source_deleted_at IS NULL
           ORDER BY assignment.due_at, assignment.id
           LIMIT 1`,
        )
        .bind(event.organizationId, event.id, recipient.id)
        .first<TaskRow>(),
    ]);

    const baseUrl = safeBaseUrl(options.requestUrl);
    const values: EmailMergeValues = {
      "event.name": { type: "text", value: event.name },
      "event.public_url": {
        type: "url",
        value: `${baseUrl}/e/${encodeURIComponent(event.slug)}`,
      },
      "organizer.email": { type: "email", value: options.organizer.email },
      "organizer.name": { type: "text", value: options.organizer.name },
      "recipient.first_name": {
        type: "text",
        value:
          recipient.first_name ||
          recipient.display_name.split(" ")[0] ||
          recipient.display_name,
      },
      "recipient.full_name": {
        type: "text",
        value: recipient.display_name,
      },
      ...(event.venue
        ? { "event.location": { type: "text" as const, value: event.venue } }
        : {}),
      ...(submission
        ? {
            "submission.friendly_id": {
              type: "text" as const,
              value: submission.friendly_id,
            },
            "submission.portal_url": {
              type: "url" as const,
              value: `${baseUrl}/app/${encodeURIComponent(event.slug)}/submissions/${encodeURIComponent(submission.friendly_id)}`,
            },
            "submission.title": {
              type: "text" as const,
              value: submission.title,
            },
          }
        : {}),
      ...(session
        ? {
            "session.public_url": {
              type: "url" as const,
              value: `${baseUrl}/e/${encodeURIComponent(event.slug)}#session-${encodeURIComponent(session.session_id)}`,
            },
            "session.title": { type: "text" as const, value: session.title },
            ...(session.room_name
              ? {
                  "session.room": {
                    type: "text" as const,
                    value: session.room_name,
                  },
                }
              : {}),
            ...(session.starts_at
              ? {
                  "session.start_at": {
                    display: displayDate(session.starts_at, event.timezone),
                    type: "date_time" as const,
                    value: session.starts_at,
                  },
                }
              : {}),
            ...(session.ends_at
              ? {
                  "session.end_at": {
                    display: displayDate(session.ends_at, event.timezone),
                    type: "date_time" as const,
                    value: session.ends_at,
                  },
                }
              : {}),
          }
        : {}),
      ...(task
        ? {
            "task.name": { type: "text" as const, value: task.name },
            "task.portal_url": {
              type: "url" as const,
              value: `${baseUrl}/portal/${encodeURIComponent(event.slug)}/tasks/${encodeURIComponent(task.assignment_id)}`,
            },
            ...(task.due_at
              ? {
                  "task.due_at": {
                    display: displayDate(task.due_at, event.timezone),
                    type: "date_time" as const,
                    value: task.due_at,
                  },
                }
              : {}),
          }
        : {}),
    };
    return values;
  }
}

export class EmailTemplateProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailTemplateProjectionError";
  }
}

export function ephemeralEmailTemplate(
  current: EmailTemplate,
  draft: EmailTemplateDraft,
): EmailTemplate {
  return {
    ...current,
    ...draft,
    id: emailTemplateVersionId(current.id, current.version + 1),
    mergeSchemaVersion: EMAIL_MERGE_SCHEMA_VERSION,
    status: "draft",
    version: current.version + 1,
  };
}
