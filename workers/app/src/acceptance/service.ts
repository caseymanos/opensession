import {
  createCampaignMessageKey,
  renderEmailTemplate,
  type EmailMergeValues,
} from "@sessionbox-killer/email";
import type { RecordDecisionCommand } from "@sessionbox-killer/contracts";

import type { BaseAuthority } from "../authority/base-authority.js";
import {
  hashAuthorityValue,
  type BaseAuthorityCommand,
} from "../authority/types.js";
import { D1CalendarIntentOutbox } from "../calendar/outbox.js";
import type { EmailDeliveryConfig } from "../email/config.js";
import { CampaignEmailCoordinator } from "../email/delivery.js";
import type {
  CampaignEmailQueueMessage,
  EmailQueueMessage,
} from "../email/messages.js";
import {
  D1EmailTemplateProjectionRepository,
  type EmailTemplateEventProjection,
} from "../email-templates/repository.js";
import { TaskAuthorityService, type TaskEventScope } from "../tasks/service.js";

interface AcceptanceServiceOptions {
  actor: { email: string; id: string; name: string };
  authority: Pick<BaseAuthority, "execute">;
  database: D1Database;
  emailConfig: EmailDeliveryConfig;
  emailQueue: Queue<EmailQueueMessage>;
  failAfterStep?: string;
  now?: () => Date;
  requestId: string;
  requestUrl: string;
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

interface SubmissionRow {
  abstract_value: string | null;
  format_record_id: string | null;
  friendly_id: string;
  id: string;
  source_record_id: string;
  title: string;
  track_record_id: string | null;
}

interface ParticipantRow {
  contact_id: string;
  contact_record_id: string;
  display_name: string;
  email_normalized: string;
  first_name: string | null;
  sort_order: number;
}

interface EventContactRow {
  contact_id: string;
  id: string;
  invitation_at: string | null;
  portal_state: "active" | "invited" | "not_invited" | "revoked";
  readiness_projection_json: string;
  roles_json: string;
  source_record_id: string;
  source_version: number;
}

interface SessionRow {
  id: string;
  source_record_id: string;
}

interface SessionParticipantRow {
  contact_id: string;
  id: string;
  source_record_id: string;
}

interface WorkflowRow {
  checkpoint_json: string | null;
  error_code: string | null;
  input_json: string;
  status:
    "canceled" | "complete" | "failed" | "queued" | "running" | "sleeping";
  updated_at: string;
}

interface PlannedParticipant {
  contactId: string;
  contactRecordId: string;
  displayName: string;
  email: string;
  eventContact: EventContactRow | null;
  eventContactId: string;
  existingSessionParticipant: SessionParticipantRow | null;
  firstName: string;
  sessionParticipantId: string;
  sortOrder: number;
}

interface AcceptancePlan {
  command: RecordDecisionCommand;
  createdAt: string;
  emails: CampaignEmailQueueMessage[];
  event: EventRow;
  existingSession: SessionRow | null;
  participants: PlannedParticipant[];
  requestId: string;
  sessionId: string | null;
  submission: SubmissionRow;
  version: 1;
  workflowId: string;
}

interface AcceptancePlanningSeed {
  command: RecordDecisionCommand;
  createdAt: string;
  requestId: string;
  version: 0;
  workflowId: string;
}

interface AcceptanceCheckpoint {
  authorityIndex: number;
  calendarComplete: boolean;
  emailIndex: number;
  sessionRecordId: string | null;
  tasksComplete: boolean;
  version: 1;
}

export interface AcceptanceOrchestrationResult {
  status: "complete";
  workflowId: string;
}

const runningLeaseMilliseconds = 2 * 60 * 1_000;

export class AcceptanceOrchestrationPendingError extends Error {
  constructor() {
    super(
      "Acceptance side effects are still being reconciled. Retry the exact decision command.",
    );
    this.name = "AcceptanceOrchestrationPendingError";
  }
}

function parseJsonObject(
  value: string,
  label: string,
): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} is invalid.`);
  }
  return parsed as Record<string, unknown>;
}

function roles(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.some((role) => typeof role !== "string")
  ) {
    throw new Error("Event-contact roles are invalid.");
  }
  return [...new Set([...parsed, "speaker"])].sort();
}

function checkpoint(value: string | null): AcceptanceCheckpoint {
  if (!value) {
    return {
      authorityIndex: 0,
      calendarComplete: false,
      emailIndex: 0,
      sessionRecordId: null,
      tasksComplete: false,
      version: 1,
    };
  }
  const parsed = parseJsonObject(value, "Acceptance checkpoint");
  if (
    parsed.version !== 1 ||
    !Number.isInteger(parsed.authorityIndex) ||
    !Number.isInteger(parsed.emailIndex) ||
    typeof parsed.calendarComplete !== "boolean" ||
    typeof parsed.tasksComplete !== "boolean" ||
    (parsed.sessionRecordId !== null &&
      typeof parsed.sessionRecordId !== "string")
  ) {
    throw new Error("Acceptance checkpoint is invalid.");
  }
  return parsed as unknown as AcceptanceCheckpoint;
}

function workflowInput(value: string): AcceptancePlan | AcceptancePlanningSeed {
  const parsed = parseJsonObject(value, "Acceptance plan");
  if (
    parsed.version === 0 &&
    typeof parsed.workflowId === "string" &&
    typeof parsed.requestId === "string" &&
    typeof parsed.createdAt === "string" &&
    parsed.command &&
    typeof parsed.command === "object"
  ) {
    return parsed as unknown as AcceptancePlanningSeed;
  }
  if (
    parsed.version !== 1 ||
    typeof parsed.workflowId !== "string" ||
    typeof parsed.requestId !== "string" ||
    !Array.isArray(parsed.participants) ||
    !Array.isArray(parsed.emails)
  ) {
    throw new Error("Acceptance plan is invalid.");
  }
  return parsed as unknown as AcceptancePlan;
}

function templateIds(decision: RecordDecisionCommand["decision"]): string[] {
  if (decision === "accepted") {
    return ["template_submission_accepted", "template_acceptance"];
  }
  if (decision === "declined") {
    return ["template_submission_declined", "template_decline"];
  }
  return ["template_submission_waitlisted", "template_waitlist"];
}

function safeOrigin(requestUrl: string): string {
  const url = new URL(requestUrl);
  return url.protocol === "https:" ||
    (url.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(url.hostname))
    ? url.origin
    : "https://preview.opensession.invalid";
}

function workflowErrorCode(error: unknown): string {
  const name = error instanceof Error ? error.name : "AcceptanceWorkflowError";
  return /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(name)
    ? name
    : "AcceptanceWorkflowError";
}

export class AcceptanceOrchestrationService {
  readonly #actor: AcceptanceServiceOptions["actor"];
  readonly #authority: AcceptanceServiceOptions["authority"];
  readonly #database: D1Database;
  readonly #emailCoordinator: CampaignEmailCoordinator;
  readonly #failAfterStep: string | undefined;
  readonly #now: () => Date;
  readonly #requestId: string;
  readonly #requestUrl: string;

  constructor(options: AcceptanceServiceOptions) {
    this.#actor = options.actor;
    this.#authority = options.authority;
    this.#database = options.database;
    this.#failAfterStep = options.failAfterStep;
    this.#now = options.now ?? (() => new Date());
    this.#requestId = options.requestId;
    this.#requestUrl = options.requestUrl;
    this.#emailCoordinator = new CampaignEmailCoordinator({
      config: options.emailConfig,
      database: options.database,
      now: this.#now,
      queue: options.emailQueue,
    });
  }

  async execute(
    eventId: string,
    organizationId: string,
    command: RecordDecisionCommand,
  ): Promise<AcceptanceOrchestrationResult> {
    const workflowId = `awf_${(
      await hashAuthorityValue([
        "acceptance",
        organizationId,
        eventId,
        command.commandId,
      ])
    ).slice(0, 40)}`;
    let row = await this.#workflow(workflowId);
    if (!row) {
      const now = this.#now().toISOString();
      const seed: AcceptancePlanningSeed = {
        command,
        createdAt: now,
        requestId: this.#requestId,
        version: 0,
        workflowId,
      };
      const inputJson = JSON.stringify(seed);
      await this.#database
        .prepare(
          `INSERT INTO workflow_runs (
             id, organization_id, event_id, workflow_type, idempotency_key,
             status, input_json, checkpoint_json, created_at, updated_at
           ) VALUES (?1, ?2, ?3, 'decision_acceptance', ?4, 'queued', ?5, NULL, ?6, ?6)
           ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
        )
        .bind(
          workflowId,
          organizationId,
          eventId,
          `decision-acceptance:v1:${eventId}:${command.commandId}`,
          inputJson,
          now,
        )
        .run();
      row = await this.#workflow(workflowId);
      if (!row || row.input_json !== inputJson) {
        throw new Error(
          "The acceptance workflow conflicts with an existing command.",
        );
      }
    }
    const input = workflowInput(row.input_json);
    if (
      input.command.commandId !== command.commandId ||
      JSON.stringify(input.command) !== JSON.stringify(command)
    ) {
      throw new Error("The acceptance workflow command changed during replay.");
    }
    if (row.status === "complete") {
      if (input.version !== 1) {
        throw new Error("A completed acceptance workflow has no frozen plan.");
      }
      return { status: "complete", workflowId };
    }
    if (!(await this.#claim(workflowId))) {
      throw new AcceptanceOrchestrationPendingError();
    }
    try {
      const frozen =
        input.version === 1
          ? input
          : await this.#buildPlan(
              workflowId,
              eventId,
              organizationId,
              command,
              input.createdAt,
              input.requestId,
            );
      if (input.version === 0) {
        const frozenPlan = await this.#database
          .prepare(
            `UPDATE workflow_runs SET input_json = ?2, updated_at = ?3
             WHERE id = ?1 AND status = 'running' AND input_json = ?4`,
          )
          .bind(
            workflowId,
            JSON.stringify(frozen),
            this.#now().toISOString(),
            row.input_json,
          )
          .run();
        if (frozenPlan.meta.changes !== 1) {
          throw new Error("Acceptance plan ownership was lost.");
        }
      }
      await this.#resume(frozen, checkpoint(row.checkpoint_json));
      const completedAt = this.#now().toISOString();
      const completed = await this.#database
        .prepare(
          `UPDATE workflow_runs
           SET status = 'complete', finished_at = ?2, updated_at = ?2,
               error_code = NULL
           WHERE id = ?1 AND status = 'running'`,
        )
        .bind(workflowId, completedAt)
        .run();
      if (completed.meta.changes !== 1) {
        const winner = await this.#workflow(workflowId);
        if (winner?.status !== "complete") {
          throw new Error("Acceptance workflow completion was not durable.");
        }
      }
      return { status: "complete", workflowId };
    } catch (error) {
      const pending = error instanceof AcceptanceOrchestrationPendingError;
      await this.#database
        .prepare(
          `UPDATE workflow_runs SET status = ?2, error_code = ?3,
                   updated_at = ?4
           WHERE id = ?1 AND status = 'running'`,
        )
        .bind(
          workflowId,
          pending ? "sleeping" : "failed",
          pending ? null : workflowErrorCode(error),
          this.#now().toISOString(),
        )
        .run();
      throw error;
    }
  }

  async #workflow(workflowId: string): Promise<WorkflowRow | null> {
    return this.#database
      .prepare(
        `SELECT status, input_json, checkpoint_json, error_code, updated_at
         FROM workflow_runs WHERE id = ?1 LIMIT 1`,
      )
      .bind(workflowId)
      .first<WorkflowRow>();
  }

  async #claim(workflowId: string): Promise<boolean> {
    const now = this.#now();
    const staleAt = new Date(
      now.getTime() - runningLeaseMilliseconds,
    ).toISOString();
    const claimed = await this.#database
      .prepare(
        `UPDATE workflow_runs SET status = 'running', updated_at = ?2,
                 error_code = NULL
         WHERE id = ?1 AND (
           status IN ('queued', 'failed', 'sleeping') OR
           (status = 'running' AND updated_at <= ?3)
         )`,
      )
      .bind(workflowId, now.toISOString(), staleAt)
      .run();
    return claimed.meta.changes === 1;
  }

  async #buildPlan(
    workflowId: string,
    eventId: string,
    organizationId: string,
    command: RecordDecisionCommand,
    createdAt: string,
    requestId: string,
  ): Promise<AcceptancePlan> {
    const [event, submission, participantResult, sessionResult] =
      await Promise.all([
        this.#database
          .prepare(
            `SELECT id, name, organization_id, slug, source_record_id, timezone, venue
           FROM p_events WHERE organization_id = ?1 AND id = ?2
             AND source_deleted_at IS NULL LIMIT 1`,
          )
          .bind(organizationId, eventId)
          .first<EventRow>(),
        this.#database
          .prepare(
            `SELECT submission.id, submission.friendly_id, submission.title,
                  submission.source_record_id,
                  track.source_record_id AS track_record_id,
                  format.source_record_id AS format_record_id,
                  (SELECT CASE WHEN json_type(answer.value_json) = 'text'
                               THEN json_extract(answer.value_json, '$') END
                   FROM p_submission_answers answer
                   WHERE answer.organization_id = submission.organization_id
                     AND answer.event_id = submission.event_id
                     AND answer.submission_id = submission.id
                     AND answer.field_stable_key IN ('abstract', 'description')
                     AND answer.source_deleted_at IS NULL
                   ORDER BY CASE answer.field_stable_key WHEN 'abstract' THEN 0 ELSE 1 END
                   LIMIT 1) AS abstract_value
           FROM p_submissions submission
           LEFT JOIN p_tracks track
             ON track.organization_id = submission.organization_id
            AND track.event_id = submission.event_id
            AND track.id = submission.track_id
            AND track.source_deleted_at IS NULL
           LEFT JOIN p_submission_answers format_answer
             ON format_answer.organization_id = submission.organization_id
            AND format_answer.event_id = submission.event_id
            AND format_answer.submission_id = submission.id
            AND format_answer.field_stable_key = 'format'
            AND format_answer.source_deleted_at IS NULL
           LEFT JOIN p_formats format
             ON format.organization_id = submission.organization_id
            AND format.event_id = submission.event_id
            AND lower(format.name) = lower(CASE
              WHEN json_type(format_answer.value_json) = 'text'
              THEN json_extract(format_answer.value_json, '$') ELSE '' END)
            AND format.source_deleted_at IS NULL
           WHERE submission.organization_id = ?1 AND submission.event_id = ?2
             AND submission.id = ?3 AND submission.source_deleted_at IS NULL
           LIMIT 1`,
          )
          .bind(organizationId, eventId, command.submissionId)
          .first<SubmissionRow>(),
        this.#database
          .prepare(
            `SELECT participant.contact_id, participant.sort_order,
                  contact.source_record_id AS contact_record_id,
                  contact.display_name, contact.first_name,
                  contact.email_normalized
           FROM p_submission_participants participant
           JOIN p_contacts contact
             ON contact.organization_id = participant.organization_id
            AND contact.id = participant.contact_id
            AND contact.source_deleted_at IS NULL
           WHERE participant.organization_id = ?1
             AND participant.event_id = ?2 AND participant.submission_id = ?3
             AND participant.source_deleted_at IS NULL
           ORDER BY participant.sort_order, participant.id LIMIT 65`,
          )
          .bind(organizationId, eventId, command.submissionId)
          .all<ParticipantRow>(),
        this.#database
          .prepare(
            `SELECT id, source_record_id FROM p_sessions
           WHERE organization_id = ?1 AND event_id = ?2
             AND source_submission_id = ?3 AND source_deleted_at IS NULL
           ORDER BY id LIMIT 2`,
          )
          .bind(organizationId, eventId, command.submissionId)
          .all<SessionRow>(),
      ]);
    if (!event || !submission || participantResult.results.length === 0) {
      throw new Error("The accepted submission snapshot is incomplete.");
    }
    if (
      participantResult.results.length > 64 ||
      sessionResult.results.length > 1
    ) {
      throw new Error("The accepted submission snapshot is ambiguous.");
    }
    const sessionId =
      command.decision === "accepted"
        ? (sessionResult.results[0]?.id ??
          `session_${(
            await hashAuthorityValue([
              organizationId,
              eventId,
              command.submissionId,
            ])
          ).slice(0, 40)}`)
        : null;
    const contactIds = participantResult.results.map(
      ({ contact_id }) => contact_id,
    );
    const [contactResult, existingParticipantResult] = await Promise.all([
      this.#database
        .prepare(
          `SELECT id, contact_id, roles_json, portal_state, invitation_at,
                  readiness_projection_json, source_record_id, source_version
           FROM p_event_contacts
           WHERE organization_id = ?1 AND event_id = ?2
             AND contact_id IN (SELECT value FROM json_each(?3))
             AND source_deleted_at IS NULL ORDER BY contact_id`,
        )
        .bind(organizationId, eventId, JSON.stringify(contactIds))
        .all<EventContactRow>(),
      sessionResult.results[0]
        ? this.#database
            .prepare(
              `SELECT id, contact_id, source_record_id
               FROM p_session_participants
               WHERE organization_id = ?1 AND event_id = ?2 AND session_id = ?3
                 AND source_deleted_at IS NULL ORDER BY contact_id LIMIT 65`,
            )
            .bind(organizationId, eventId, sessionResult.results[0].id)
            .all<SessionParticipantRow>()
        : Promise.resolve({ results: [] as SessionParticipantRow[] }),
    ]);
    const eventContacts = new Map(
      contactResult.results.map((item) => [item.contact_id, item]),
    );
    const sessionParticipants = new Map(
      existingParticipantResult.results.map((item) => [item.contact_id, item]),
    );
    const participants = await Promise.all(
      participantResult.results.map(async (item) => ({
        contactId: item.contact_id,
        contactRecordId: item.contact_record_id,
        displayName: item.display_name,
        email: item.email_normalized,
        eventContact: eventContacts.get(item.contact_id) ?? null,
        eventContactId:
          eventContacts.get(item.contact_id)?.id ??
          `event_contact_${(
            await hashAuthorityValue([organizationId, eventId, item.contact_id])
          ).slice(0, 36)}`,
        existingSessionParticipant:
          sessionParticipants.get(item.contact_id) ?? null,
        firstName:
          item.first_name ??
          item.display_name.split(/\s+/u)[0] ??
          item.display_name,
        sessionParticipantId: `session_participant_${(
          await hashAuthorityValue([
            organizationId,
            eventId,
            sessionId,
            item.contact_id,
          ])
        ).slice(0, 32)}`,
        sortOrder: item.sort_order,
      })),
    );
    const eventProjection: EmailTemplateEventProjection = {
      id: event.id,
      name: event.name,
      organizationId: event.organization_id,
      slug: event.slug,
      sourceRecordId: event.source_record_id,
      timezone: event.timezone,
      venue: event.venue ?? "",
    };
    const emails =
      command.messageMode === "send_queued"
        ? await this.#emailPlan(
            workflowId,
            eventProjection,
            submission,
            participants,
            command,
            createdAt,
            sessionId,
          )
        : [];
    return {
      command,
      createdAt,
      emails,
      event,
      existingSession: sessionResult.results[0] ?? null,
      participants,
      requestId,
      sessionId,
      submission,
      version: 1,
      workflowId,
    };
  }

  async #emailPlan(
    workflowId: string,
    event: EmailTemplateEventProjection,
    submission: SubmissionRow,
    participants: PlannedParticipant[],
    command: RecordDecisionCommand,
    createdAt: string,
    sessionId: string | null,
  ): Promise<CampaignEmailQueueMessage[]> {
    const repository = new D1EmailTemplateProjectionRepository(this.#database);
    let selected = null;
    for (const id of templateIds(command.decision)) {
      selected = await repository.readTemplateWithHead(event, id);
      if (selected) break;
    }
    if (!selected || selected.head.template.status !== "active") {
      throw new Error("The selected decision email template is unavailable.");
    }
    const template = selected.head.template;
    const origin = safeOrigin(this.#requestUrl);
    const campaignId = `decision_${(
      await hashAuthorityValue([
        event.organizationId,
        event.id,
        command.commandId,
      ])
    ).slice(0, 40)}`;
    return Promise.all(
      participants.map(async (participant) => {
        const submissionUrl =
          command.decision === "accepted"
            ? `${origin}/portal/${encodeURIComponent(event.slug)}`
            : `${origin}/app/${encodeURIComponent(event.slug)}/submissions/${encodeURIComponent(submission.friendly_id)}`;
        const values: EmailMergeValues = {
          "event.name": { type: "text", value: event.name },
          "event.public_url": {
            type: "url",
            value: `${origin}/e/${encodeURIComponent(event.slug)}`,
          },
          "organizer.email": { type: "email", value: this.#actor.email },
          "organizer.name": { type: "text", value: this.#actor.name },
          "recipient.first_name": {
            type: "text",
            value: participant.firstName,
          },
          "recipient.full_name": {
            type: "text",
            value: participant.displayName,
          },
          "session.public_url": {
            type: "url",
            value: `${origin}/e/${encodeURIComponent(event.slug)}#session-${encodeURIComponent(sessionId ?? command.submissionId)}`,
          },
          "session.title": { type: "text", value: submission.title },
          "submission.friendly_id": {
            type: "text",
            value: submission.friendly_id,
          },
          "submission.portal_url": { type: "url", value: submissionUrl },
          "submission.title": { type: "text", value: submission.title },
          ...(event.venue
            ? {
                "event.location": { type: "text" as const, value: event.venue },
              }
            : {}),
        };
        const rendered = renderEmailTemplate(template, values);
        const messageId = await createCampaignMessageKey({
          campaignId,
          contactId: participant.contactId,
          templateId: template.id,
          templateVersion: template.version,
        });
        return {
          campaign_id: campaignId,
          contact_id: participant.contactId,
          email: { ...rendered, to: [participant.email] },
          event_id: event.id,
          kind: "campaign.email.requested" as const,
          message_id: messageId,
          organization_id: event.organizationId,
          queued_at: createdAt,
          request_id: workflowId,
          template_id: template.id,
          template_version: template.version,
          version: 1 as const,
        };
      }),
    );
  }

  async #resume(
    frozen: AcceptancePlan,
    current: AcceptanceCheckpoint,
  ): Promise<void> {
    while (true) {
      const operations = await this.#authorityOperations(frozen, current);
      if (current.authorityIndex >= operations.length) break;
      const operation = operations[current.authorityIndex];
      if (!operation)
        throw new Error("Acceptance authority plan is incomplete.");
      const response = await this.#authority.execute(operation);
      this.#inject(`authority-commit:${current.authorityIndex + 1}`);
      if (operation.table === "sessions") {
        current.sessionRecordId = response.authority.recordId;
      }
      current.authorityIndex += 1;
      await this.#saveCheckpoint(frozen.workflowId, current);
      this.#inject(`authority:${current.authorityIndex}`);
    }
    if (frozen.command.decision === "accepted" && !current.tasksComplete) {
      await this.#assertOnboardingProjected(frozen);
      const event: TaskEventScope = {
        eventId: frozen.event.id,
        eventRecordId: frozen.event.source_record_id,
        organizationId: frozen.event.organization_id,
        slug: frozen.event.slug,
        timezone: frozen.event.timezone,
      };
      await new TaskAuthorityService({
        authority: this.#authority,
        database: this.#database,
      }).materializeAcceptance(
        event,
        {
          acceptance_id: frozen.workflowId,
          command_id: `acceptance_tasks_${(
            await hashAuthorityValue([frozen.workflowId, "tasks"])
          ).slice(0, 36)}`,
          session_ids: frozen.sessionId ? [frozen.sessionId] : [],
          type: "materialize_acceptance",
        },
        {
          actorId: this.#actor.id,
          auditActorType: "user",
          domainActorType: "organizer",
        },
        frozen.requestId,
      );
      current.tasksComplete = true;
      await this.#saveCheckpoint(frozen.workflowId, current);
      this.#inject("tasks");
    }
    while (current.emailIndex < frozen.emails.length) {
      const message = frozen.emails[current.emailIndex];
      if (!message) throw new Error("Acceptance email plan is incomplete.");
      await this.#emailCoordinator.enqueue(message);
      await this.#auditEmail(frozen, message);
      current.emailIndex += 1;
      await this.#saveCheckpoint(frozen.workflowId, current);
      this.#inject(`email:${current.emailIndex}`);
    }
    if (
      frozen.command.decision === "accepted" &&
      !current.calendarComplete &&
      frozen.sessionId
    ) {
      await new D1CalendarIntentOutbox(this.#database).enqueueAcceptance({
        actor: { id: this.#actor.id, type: "user" },
        commandId: frozen.command.commandId,
        contactIds: frozen.participants.map(({ contactId }) => contactId),
        eventId: frozen.event.id,
        occurredAt: frozen.createdAt,
        organizationId: frozen.event.organization_id,
        requestId: frozen.requestId,
        sessionId: frozen.sessionId,
        workflowId: frozen.workflowId,
      });
      current.calendarComplete = true;
      await this.#saveCheckpoint(frozen.workflowId, current);
      this.#inject("calendar");
    }
  }

  async #authorityOperations(
    frozen: AcceptancePlan,
    current: AcceptanceCheckpoint,
  ): Promise<BaseAuthorityCommand[]> {
    if (frozen.command.decision !== "accepted" || !frozen.sessionId) return [];
    const operations: BaseAuthorityCommand[] = [];
    if (!frozen.existingSession) {
      operations.push({
        audit: this.#audit(frozen, "acceptance.session.materialize", {
          sessionId: frozen.sessionId,
          submissionId: frozen.submission.id,
        }),
        commandId: await this.#childCommandId(
          frozen,
          "session",
          frozen.sessionId,
        ),
        entityId: frozen.sessionId,
        expectedVersion: 0,
        fields: {
          Abstract: frozen.submission.abstract_value,
          Event: [frozen.event.source_record_id],
          "External mapping JSON": "{}",
          "Friendly ID": frozen.submission.friendly_id,
          Format: frozen.submission.format_record_id
            ? [frozen.submission.format_record_id]
            : [],
          Public: false,
          "Source submission": [frozen.submission.source_record_id],
          Status: "accepted",
          Title: frozen.submission.title,
          Track: frozen.submission.track_record_id
            ? [frozen.submission.track_record_id]
            : [],
        },
        operation: "acceptance.session.materialize",
        organizationId: frozen.event.organization_id,
        table: "sessions",
      });
    } else if (!current.sessionRecordId) {
      current.sessionRecordId = frozen.existingSession.source_record_id;
    }
    for (const participant of frozen.participants) {
      const existing = participant.eventContact;
      operations.push({
        audit: this.#audit(frozen, "acceptance.portal.grant", {
          contactId: participant.contactId,
          portalState:
            existing?.portal_state === "active" ? "active" : "invited",
        }),
        commandId: await this.#childCommandId(
          frozen,
          "portal",
          participant.contactId,
        ),
        entityId: participant.eventContactId,
        expectedVersion: existing?.source_version ?? 0,
        fields: {
          Contact: [participant.contactRecordId],
          Event: [frozen.event.source_record_id],
          "Invitation time": existing?.invitation_at ?? frozen.createdAt,
          "Portal state":
            existing?.portal_state === "active" ? "active" : "invited",
          "Readiness projection JSON": existing
            ? JSON.stringify(
                parseJsonObject(
                  existing.readiness_projection_json,
                  "Readiness projection",
                ),
              )
            : "{}",
          Roles: existing ? roles(existing.roles_json) : ["speaker"],
        },
        operation: "acceptance.portal.grant",
        organizationId: frozen.event.organization_id,
        table: "event_contacts",
      });
    }
    const sessionRecordId = current.sessionRecordId;
    if (!sessionRecordId && current.authorityIndex > 0) {
      throw new AcceptanceOrchestrationPendingError();
    }
    if (sessionRecordId) {
      for (const participant of frozen.participants) {
        if (participant.existingSessionParticipant) continue;
        operations.push({
          audit: this.#audit(frozen, "acceptance.participant.materialize", {
            contactId: participant.contactId,
            sessionId: frozen.sessionId,
          }),
          commandId: await this.#childCommandId(
            frozen,
            "participant",
            participant.contactId,
          ),
          entityId: participant.sessionParticipantId,
          expectedVersion: 0,
          fields: {
            "Confirmed state": "pending",
            Contact: [participant.contactRecordId],
            Order: participant.sortOrder,
            Role: "speaker",
            Session: [sessionRecordId],
          },
          operation: "acceptance.participant.materialize",
          organizationId: frozen.event.organization_id,
          table: "session_participants",
        });
      }
    }
    return operations;
  }

  #audit(
    frozen: AcceptancePlan,
    action: string,
    safeDiff: Record<string, unknown>,
  ): BaseAuthorityCommand["audit"] {
    return {
      action,
      actorId: this.#actor.id,
      actorType: "user",
      eventId: frozen.event.id,
      requestId: frozen.requestId,
      safeDiff: {
        ...safeDiff,
        decisionCommandId: frozen.command.commandId,
        workflowId: frozen.workflowId,
      },
    };
  }

  async #childCommandId(
    frozen: AcceptancePlan,
    step: string,
    entityId: string,
  ): Promise<string> {
    return `acceptance_${step}_${(
      await hashAuthorityValue([frozen.workflowId, step, entityId])
    ).slice(0, 32)}`;
  }

  async #assertOnboardingProjected(frozen: AcceptancePlan): Promise<void> {
    if (!frozen.sessionId) throw new Error("Accepted workflow has no session.");
    const [session, participants, contacts] = await Promise.all([
      this.#database
        .prepare(
          `SELECT COUNT(*) AS count FROM p_sessions
           WHERE organization_id = ?1 AND event_id = ?2 AND id = ?3
             AND source_deleted_at IS NULL`,
        )
        .bind(frozen.event.organization_id, frozen.event.id, frozen.sessionId)
        .first<{ count: number }>(),
      this.#database
        .prepare(
          `SELECT COUNT(DISTINCT contact_id) AS count FROM p_session_participants
           WHERE organization_id = ?1 AND event_id = ?2 AND session_id = ?3
             AND contact_id IN (SELECT value FROM json_each(?4))
             AND source_deleted_at IS NULL`,
        )
        .bind(
          frozen.event.organization_id,
          frozen.event.id,
          frozen.sessionId,
          JSON.stringify(frozen.participants.map(({ contactId }) => contactId)),
        )
        .first<{ count: number }>(),
      this.#database
        .prepare(
          `SELECT COUNT(DISTINCT contact_id) AS count FROM p_event_contacts
           WHERE organization_id = ?1 AND event_id = ?2
             AND contact_id IN (SELECT value FROM json_each(?3))
             AND portal_state IN ('active', 'invited')
             AND EXISTS (SELECT 1 FROM json_each(roles_json) WHERE value = 'speaker')
             AND source_deleted_at IS NULL`,
        )
        .bind(
          frozen.event.organization_id,
          frozen.event.id,
          JSON.stringify(frozen.participants.map(({ contactId }) => contactId)),
        )
        .first<{ count: number }>(),
    ]);
    if (
      session?.count !== 1 ||
      participants?.count !== frozen.participants.length ||
      contacts?.count !== frozen.participants.length
    ) {
      throw new AcceptanceOrchestrationPendingError();
    }
  }

  async #saveCheckpoint(
    workflowId: string,
    value: AcceptanceCheckpoint,
  ): Promise<void> {
    const updated = await this.#database
      .prepare(
        `UPDATE workflow_runs SET checkpoint_json = ?2, updated_at = ?3
         WHERE id = ?1 AND status = 'running'`,
      )
      .bind(workflowId, JSON.stringify(value), this.#now().toISOString())
      .run();
    if (updated.meta.changes !== 1) {
      throw new Error("Acceptance checkpoint ownership was lost.");
    }
  }

  async #auditEmail(
    frozen: AcceptancePlan,
    message: CampaignEmailQueueMessage,
  ): Promise<void> {
    const auditId = `aud_${(
      await hashAuthorityValue([
        frozen.event.organization_id,
        frozen.workflowId,
        message.message_id,
      ])
    ).slice(0, 26)}`;
    await this.#database
      .prepare(
        `INSERT INTO audit_events (
           id, organization_id, event_id, actor_type, actor_id, action,
           entity_type, entity_id, request_id, command_id, redaction_version,
           safe_diff_json, metadata_json, created_at
         ) VALUES (?1, ?2, ?3, 'user', ?4, 'acceptance.email.queued',
                   'provider_message', ?5, ?6, ?7, 1, ?8, ?9, ?10)
         ON CONFLICT (id) DO NOTHING`,
      )
      .bind(
        auditId,
        frozen.event.organization_id,
        frozen.event.id,
        this.#actor.id,
        message.message_id,
        frozen.requestId,
        frozen.command.commandId,
        JSON.stringify({
          templateId: message.template_id,
          templateVersion: message.template_version,
        }),
        JSON.stringify({ workflowId: frozen.workflowId }),
        frozen.createdAt,
      )
      .run();
  }

  #inject(step: string): void {
    if (this.#failAfterStep === step) {
      throw new Error(`Injected acceptance failure after ${step}.`);
    }
  }
}
