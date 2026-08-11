import {
  campaignConfirmResponseSchema,
  campaignPlanSchema,
  campaignPreviewResponseSchema,
  campaignReplayResponseSchema,
  createCampaignMessageKey,
  createCampaignPlan,
  renderEmailTemplate,
  serializeCampaignPlan,
  type CampaignConfirmRequest,
  type CampaignConfirmResponse,
  type CampaignPlan,
  type CampaignPreviewRequest,
  type CampaignPreviewResponse,
  type CampaignReplayResponse,
} from "@sessionbox-killer/email";

import type { BaseAuthority } from "../authority/base-authority.js";
import { hashAuthorityValue } from "../authority/types.js";
import type { AuthorityResponse } from "../authority/types.js";
import type { EmailDeliveryConfig } from "../email/config.js";
import { CampaignEmailCoordinator } from "../email/delivery.js";
import {
  parseEmailQueueMessage,
  type CampaignEmailQueueMessage,
  type EmailQueueMessage,
} from "../email/messages.js";
import type { EmailTemplateEventProjection } from "../email-templates/repository.js";
import { CampaignProjectionError } from "./repository.js";
import type { D1CampaignRepository } from "./repository.js";

interface CampaignReceiptRow {
  campaign_id: string;
  command_id: string;
  created_at: string;
  plan_json: string;
  preview_id: string;
  request_hash: string;
  result_json: string | null;
  state: "applying" | "complete" | "preparing";
}

interface CampaignMessageReceiptRow {
  contact_id: string;
  contact_source_record_id: string;
  message_id: string;
  queue_payload_json: string;
  state: "prepared" | "queued";
}

interface CampaignServiceOptions {
  readonly actor: {
    readonly email: string;
    readonly id: string;
    readonly name: string;
  };
  readonly authority: Pick<BaseAuthority, "execute">;
  readonly config: EmailDeliveryConfig;
  readonly database: D1Database;
  readonly now?: () => Date;
  readonly queue: Queue<EmailQueueMessage>;
  readonly repository: D1CampaignRepository;
  readonly requestUrl: string;
}

const previewLifetimeMilliseconds = 15 * 60 * 1_000;

function parsePlan(value: string): CampaignPlan {
  try {
    return campaignPlanSchema.parse(JSON.parse(value) as unknown);
  } catch {
    throw new CampaignProjectionError("The durable campaign plan is invalid.");
  }
}

function parseResult(value: string): CampaignConfirmResponse {
  try {
    return campaignConfirmResponseSchema.parse(JSON.parse(value) as unknown);
  } catch {
    throw new CampaignProjectionError(
      "The durable campaign result is invalid.",
    );
  }
}

function exclusionCounts(plan: CampaignPlan) {
  const counts = new Map<string, number>();
  for (const exclusion of plan.audience.excluded) {
    counts.set(exclusion.reason, (counts.get(exclusion.reason) ?? 0) + 1);
  }
  return [...counts]
    .sort(([left], [right]) => left.localeCompare(right, "en-US"))
    .map(([reason, count]) => ({ count, reason }));
}

function scheduledAt(plan: CampaignPlan, createdAt: string): string {
  return plan.schedule.mode === "scheduled"
    ? plan.schedule.scheduledAt
    : createdAt;
}

async function campaignId(
  event: EmailTemplateEventProjection,
  commandId: string,
): Promise<string> {
  return `campaign_${await hashAuthorityValue([
    "campaign",
    event.organizationId,
    event.id,
    commandId,
  ])}`;
}

async function stableCommandId(
  operation: "campaign" | "message",
  organizationId: string,
  commandId: string,
  entityId: string,
): Promise<string> {
  return `campaign_${operation}_${await hashAuthorityValue([
    organizationId,
    commandId,
    entityId,
  ])}`;
}

async function stableRequestId(
  organizationId: string,
  commandId: string,
): Promise<string> {
  return `campaign_request_${await hashAuthorityValue([
    organizationId,
    commandId,
  ])}`;
}

export class CampaignConfirmationConflictError extends Error {
  constructor() {
    super("This campaign command was already used with different inputs.");
    this.name = "CampaignConfirmationConflictError";
  }
}

export class CampaignPreviewExpiredError extends Error {
  constructor() {
    super("The campaign preview expired. Create a fresh preview to continue.");
    this.name = "CampaignPreviewExpiredError";
  }
}

export class CampaignPreviewChangedError extends Error {
  constructor() {
    super("The campaign audience or template changed after preview.");
    this.name = "CampaignPreviewChangedError";
  }
}

export class CampaignNotFoundError extends Error {
  constructor() {
    super("The campaign or template was not found in this event.");
    this.name = "CampaignNotFoundError";
  }
}

export class CampaignService {
  readonly #actor: CampaignServiceOptions["actor"];
  readonly #authority: CampaignServiceOptions["authority"];
  readonly #coordinator: CampaignEmailCoordinator;
  readonly #database: D1Database;
  readonly #now: () => Date;
  readonly #repository: D1CampaignRepository;
  readonly #requestUrl: string;

  constructor(options: CampaignServiceOptions) {
    this.#actor = options.actor;
    this.#authority = options.authority;
    this.#database = options.database;
    this.#now = options.now ?? (() => new Date());
    this.#repository = options.repository;
    this.#requestUrl = options.requestUrl;
    this.#coordinator = new CampaignEmailCoordinator({
      config: options.config,
      database: options.database,
      now: this.#now,
      queue: options.queue,
    });
  }

  async preview(
    event: EmailTemplateEventProjection,
    request: CampaignPreviewRequest,
  ): Promise<CampaignPreviewResponse> {
    const createdAt = this.#now().toISOString();
    const plan = await this.#createPlan(event, request, createdAt);
    const previewId = `campaign_preview_${await hashAuthorityValue(plan)}`;
    return campaignPreviewResponseSchema.parse({
      audience: {
        excludedByReason: exclusionCounts(plan),
        excludedCount: plan.audience.excludedCount,
        includedCount: plan.audience.includedCount,
        samples: plan.audience.samples,
        totalCandidates: plan.audience.totalCandidates,
      },
      createdAt,
      expiresAt: new Date(
        Date.parse(createdAt) + previewLifetimeMilliseconds,
      ).toISOString(),
      filter: plan.audience.filter,
      previewId,
      schedule: plan.schedule,
      sender: plan.sender,
      template: {
        audience: plan.template.audience,
        id: plan.template.id,
        internalName: plan.template.internalName,
        subject: plan.template.subject,
        version: plan.template.version,
      },
    });
  }

  async confirm(
    event: EmailTemplateEventProjection,
    request: CampaignConfirmRequest,
  ): Promise<CampaignConfirmResponse> {
    const requestHash = await hashAuthorityValue(request);
    const existing = await this.#receipt(event, request.commandId);
    if (existing && existing.request_hash !== requestHash) {
      throw new CampaignConfirmationConflictError();
    }
    if (existing?.state === "complete" && existing.result_json) {
      return { ...parseResult(existing.result_json), replayed: true };
    }
    let receipt =
      existing ?? (await this.#createReceipt(event, request, requestHash));
    let plan = parsePlan(receipt.plan_json);
    if (receipt.state === "preparing") {
      await this.#prepareMessages(event, receipt, plan);
      const current = await this.#receipt(event, request.commandId);
      if (!current) {
        throw new CampaignProjectionError(
          "The durable campaign receipt disappeared during preparation.",
        );
      }
      if (current.state === "complete" && current.result_json) {
        return { ...parseResult(current.result_json), replayed: true };
      }
      receipt = current;
      plan = parsePlan(current.plan_json);
    }
    return this.#apply(event, receipt, plan, existing !== null);
  }

  async replay(options: {
    readonly campaignId: string;
    readonly event: EmailTemplateEventProjection;
    readonly messageId?: string;
  }): Promise<CampaignReplayResponse> {
    const log = await this.#repository.readDeliveryLog(
      options.event,
      options.campaignId,
    );
    if (!log) throw new CampaignNotFoundError();
    const selected = options.messageId
      ? log.messages.filter(({ messageId }) => messageId === options.messageId)
      : log.messages;
    if (options.messageId && selected.length === 0) {
      throw new CampaignNotFoundError();
    }
    let queued = 0;
    let suppressed = 0;
    let notReplayable = 0;
    for (const message of selected) {
      if (!message.replayable) {
        notReplayable += 1;
        continue;
      }
      const result = await this.#coordinator.replayById({
        campaignId: options.campaignId,
        eventId: options.event.id,
        messageId: message.messageId,
        organizationId: options.event.organizationId,
      });
      if (result.outcome === "queued") queued += 1;
      else if (result.outcome === "suppressed") suppressed += 1;
      else notReplayable += 1;
    }
    return campaignReplayResponseSchema.parse({
      campaignId: options.campaignId,
      notReplayable,
      queued,
      suppressed,
    });
  }

  async #createPlan(
    event: EmailTemplateEventProjection,
    request: CampaignPreviewRequest,
    createdAt: string,
  ): Promise<CampaignPlan> {
    const [template, candidates] = await Promise.all([
      this.#repository.readTemplatePlanInputs(event, request.templateId),
      this.#repository.readAudienceCandidates({
        event,
        organizer: this.#actor,
        requestUrl: this.#requestUrl,
      }),
    ]);
    if (!template) throw new CampaignNotFoundError();
    return createCampaignPlan({
      candidates,
      createdAt,
      eventId: event.id,
      filter: request.filter,
      schedule: request.schedule,
      template: template.selected,
      templateVersions: template.versions,
    });
  }

  async #createReceipt(
    event: EmailTemplateEventProjection,
    request: CampaignConfirmRequest,
    requestHash: string,
  ): Promise<CampaignReceiptRow> {
    const now = this.#now();
    const previewTime = Date.parse(request.previewCreatedAt);
    if (
      now.getTime() < previewTime ||
      now.getTime() - previewTime > previewLifetimeMilliseconds ||
      (request.schedule.mode === "scheduled" &&
        Date.parse(request.schedule.scheduledAt) <= now.getTime())
    ) {
      throw new CampaignPreviewExpiredError();
    }
    const plan = await this.#createPlan(
      event,
      request,
      request.previewCreatedAt,
    );
    const previewId = `campaign_preview_${await hashAuthorityValue(plan)}`;
    if (previewId !== request.previewId) {
      throw new CampaignPreviewChangedError();
    }
    const id = await campaignId(event, request.commandId);
    const nowIso = now.toISOString();
    const inserted = await this.#database
      .prepare(
        `INSERT INTO campaign_command_receipts (
           organization_id, event_id, command_id, request_hash, campaign_id,
           preview_id, plan_json, state, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'preparing', ?8, ?8)
         ON CONFLICT (organization_id, event_id, command_id) DO NOTHING`,
      )
      .bind(
        event.organizationId,
        event.id,
        request.commandId,
        requestHash,
        id,
        previewId,
        serializeCampaignPlan(plan),
        nowIso,
      )
      .run();
    const receipt = await this.#receipt(event, request.commandId);
    if (!receipt || receipt.request_hash !== requestHash) {
      throw new CampaignConfirmationConflictError();
    }
    if (inserted.meta.changes !== 1 && receipt.preview_id !== previewId) {
      throw new CampaignConfirmationConflictError();
    }
    return receipt;
  }

  async #prepareMessages(
    event: EmailTemplateEventProjection,
    receipt: CampaignReceiptRow,
    plan: CampaignPlan,
  ): Promise<void> {
    const current = await this.#repository.readAudienceCandidates({
      event,
      organizer: this.#actor,
      requestUrl: this.#requestUrl,
    });
    const byId = new Map(
      current.map((candidate) => [candidate.contactId, candidate]),
    );
    const template = await this.#repository.readTemplatePlanInputs(
      event,
      plan.template.id,
    );
    if (!template) throw new CampaignNotFoundError();
    const queuedAt = receipt.created_at;
    const deliverAt = scheduledAt(plan, queuedAt);
    const requestId = await stableRequestId(
      event.organizationId,
      receipt.command_id,
    );
    const expected = new Map<
      string,
      {
        readonly contactId: string;
        readonly contactSourceRecordId: string;
        readonly queuePayloadJson: string;
      }
    >();
    for (const contactId of plan.audience.includedContactIds) {
      const candidate = byId.get(contactId);
      const contactSourceRecordId =
        await this.#repository.readContactSourceRecordId(event, contactId);
      if (!candidate || !contactSourceRecordId) {
        throw new CampaignProjectionError(
          "A confirmed campaign recipient is no longer event-scoped.",
        );
      }
      const messageId = await createCampaignMessageKey({
        campaignId: receipt.campaign_id,
        contactId,
        templateId: plan.template.id,
        templateVersion: plan.template.version,
      });
      const rendered = renderEmailTemplate(
        plan.template,
        candidate.mergeValues,
      );
      const message: CampaignEmailQueueMessage = {
        campaign_id: receipt.campaign_id,
        contact_id: contactId,
        email: { ...rendered, to: [candidate.email] },
        event_id: event.id,
        kind: "campaign.email.requested",
        message_id: messageId,
        organization_id: event.organizationId,
        queued_at: queuedAt,
        request_id: requestId,
        scheduled_at: deliverAt,
        template_id: plan.template.id,
        template_version: plan.template.version,
        version: 1,
      };
      const queuePayloadJson = JSON.stringify(message);
      expected.set(messageId, {
        contactId,
        contactSourceRecordId,
        queuePayloadJson,
      });
      await this.#database
        .prepare(
          `INSERT INTO campaign_message_receipts (
             organization_id, event_id, command_id, campaign_id, message_id,
             contact_id, contact_source_record_id, queue_payload_json, state,
             created_at, updated_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'prepared', ?9, ?9)
           ON CONFLICT (organization_id, event_id, command_id, message_id)
           DO NOTHING`,
        )
        .bind(
          event.organizationId,
          event.id,
          receipt.command_id,
          receipt.campaign_id,
          messageId,
          contactId,
          contactSourceRecordId,
          queuePayloadJson,
          queuedAt,
        )
        .run();
    }
    const staged = await this.#messageReceipts(event, receipt.command_id);
    if (staged.length !== expected.size) {
      throw new CampaignProjectionError(
        "Campaign message preparation did not reconcile.",
      );
    }
    for (const row of staged) {
      const prepared = expected.get(row.message_id);
      if (
        !prepared ||
        row.contact_id !== prepared.contactId ||
        row.contact_source_record_id !== prepared.contactSourceRecordId ||
        row.queue_payload_json !== prepared.queuePayloadJson
      ) {
        throw new CampaignProjectionError(
          "Campaign message preparation scope is inconsistent.",
        );
      }
    }
    const promoted = await this.#database
      .prepare(
        `UPDATE campaign_command_receipts
         SET state = 'applying', updated_at = ?1
         WHERE organization_id = ?2 AND event_id = ?3 AND command_id = ?4
           AND state = 'preparing'`,
      )
      .bind(
        this.#now().toISOString(),
        event.organizationId,
        event.id,
        receipt.command_id,
      )
      .run();
    if (promoted.meta.changes !== 1) {
      const current = await this.#receipt(event, receipt.command_id);
      if (current?.state === "applying" || current?.state === "complete") {
        return;
      }
      throw new CampaignProjectionError(
        "Campaign preparation state changed unexpectedly.",
      );
    }
  }

  async #apply(
    event: EmailTemplateEventProjection,
    receipt: CampaignReceiptRow,
    plan: CampaignPlan,
    replayed: boolean,
  ): Promise<CampaignConfirmResponse> {
    const template = await this.#repository.readTemplatePlanInputs(
      event,
      plan.template.id,
    );
    if (!template) throw new CampaignNotFoundError();
    const requestId = await stableRequestId(
      event.organizationId,
      receipt.command_id,
    );
    const deliverAt = scheduledAt(plan, receipt.created_at);
    const campaignResponse = await this.#authority.execute({
      audit: {
        action: "campaign.confirm",
        actorId: this.#actor.id,
        actorType: "user",
        eventId: event.id,
        requestId,
        safeDiff: {
          campaign_id: receipt.campaign_id,
          excluded_count: plan.audience.excludedCount,
          included_count: plan.audience.includedCount,
          scheduled_at: deliverAt,
          template_id: plan.template.id,
          template_version: plan.template.version,
        },
      },
      commandId: await stableCommandId(
        "campaign",
        event.organizationId,
        receipt.command_id,
        receipt.campaign_id,
      ),
      entityId: receipt.campaign_id,
      expectedVersion: 0,
      fields: {
        "Audience filter snapshot JSON": JSON.stringify(plan.audience),
        Event: [event.sourceRecordId],
        "Scheduled at": deliverAt,
        Status:
          plan.audience.includedCount === 0
            ? "complete"
            : plan.schedule.mode === "scheduled"
              ? "scheduled"
              : "sending",
        Template: [template.sourceRecordId],
        "Template snapshot JSON": JSON.stringify(plan.template),
        "Template version": plan.template.version,
        Trigger: "organizer_campaign",
      },
      operation: "campaign.confirm",
      organizationId: event.organizationId,
      table: "campaigns",
    });
    let projection: "durable" | "repair_pending" = campaignResponse.projection;
    const messageRows = await this.#messageReceipts(event, receipt.command_id);
    if (messageRows.length !== plan.audience.includedCount) {
      const current = await this.#receipt(event, receipt.command_id);
      if (current?.state === "complete" && current.result_json) {
        return { ...parseResult(current.result_json), replayed: true };
      }
      throw new CampaignProjectionError(
        "Prepared campaign messages do not reconcile with the audience.",
      );
    }
    let queued = 0;
    let alreadyQueued = 0;
    let suppressed = 0;
    for (const row of messageRows) {
      const parsed = parseEmailQueueMessage(JSON.parse(row.queue_payload_json));
      if (parsed.kind !== "campaign.email.requested") {
        throw new CampaignProjectionError(
          "A prepared campaign message is invalid.",
        );
      }
      const messageResponse: AuthorityResponse = await this.#authority.execute({
        audit: {
          action: "campaign.message.queue",
          actorId: this.#actor.id,
          actorType: "user",
          eventId: event.id,
          requestId,
          safeDiff: {
            campaign_id: receipt.campaign_id,
            message_id: row.message_id,
            scheduled_at: deliverAt,
            template_id: plan.template.id,
            template_version: plan.template.version,
          },
        },
        commandId: await stableCommandId(
          "message",
          event.organizationId,
          receipt.command_id,
          row.message_id,
        ),
        entityId: row.message_id,
        expectedVersion: 0,
        fields: {
          Campaign: [campaignResponse.authority.recordId],
          Contact: [row.contact_source_record_id],
          "Error code": null,
          "Idempotency key": row.message_id,
          "Provider ID": null,
          "Queued at": parsed.queued_at,
          "Recipient email": parsed.email.to[0] as string,
          Status: "queued",
        },
        operation: "campaign.message.queue",
        organizationId: event.organizationId,
        table: "messages",
      });
      if (messageResponse.projection === "repair_pending") {
        projection = "repair_pending";
      }
      const handoff = await this.#coordinator.enqueue(parsed);
      if (
        handoff.outcome === "suppressed" ||
        (handoff.outcome === "already_terminal" &&
          handoff.status === "suppressed")
      ) {
        suppressed += 1;
      } else if (
        handoff.outcome === "queued" ||
        handoff.outcome === "scheduled"
      ) {
        queued += 1;
      } else if (
        handoff.outcome === "already_queued" ||
        handoff.outcome === "already_terminal" ||
        handoff.outcome === "handoff_pending"
      ) {
        alreadyQueued += 1;
      }
      await this.#database
        .prepare(
          `UPDATE campaign_message_receipts
           SET state = 'queued', updated_at = ?1
           WHERE organization_id = ?2 AND event_id = ?3 AND command_id = ?4
             AND message_id = ?5`,
        )
        .bind(
          this.#now().toISOString(),
          event.organizationId,
          event.id,
          receipt.command_id,
          row.message_id,
        )
        .run();
    }
    const result = campaignConfirmResponseSchema.parse({
      campaignId: receipt.campaign_id,
      messages: {
        alreadyQueued,
        queued,
        suppressed,
        total: messageRows.length,
      },
      projection,
      replayed,
      scheduledAt: deliverAt,
    });
    const completedAt = this.#now().toISOString();
    const [completion] = await this.#database.batch([
      this.#database
        .prepare(
          `UPDATE campaign_command_receipts
           SET state = 'complete', result_json = ?1, completed_at = ?2,
               updated_at = ?2
           WHERE organization_id = ?3 AND event_id = ?4 AND command_id = ?5
             AND state = 'applying'`,
        )
        .bind(
          JSON.stringify(result),
          completedAt,
          event.organizationId,
          event.id,
          receipt.command_id,
        ),
      this.#database
        .prepare(
          `DELETE FROM campaign_message_receipts
           WHERE organization_id = ?1 AND event_id = ?2 AND command_id = ?3`,
        )
        .bind(event.organizationId, event.id, receipt.command_id),
    ]);
    if (completion?.meta.changes !== 1) {
      const current = await this.#receipt(event, receipt.command_id);
      if (current?.state === "complete" && current.result_json) {
        return { ...parseResult(current.result_json), replayed: true };
      }
      throw new CampaignProjectionError(
        "Campaign completion state changed unexpectedly.",
      );
    }
    return result;
  }

  async #receipt(
    event: EmailTemplateEventProjection,
    commandId: string,
  ): Promise<CampaignReceiptRow | null> {
    return this.#database
      .prepare(
        `SELECT command_id, request_hash, campaign_id, preview_id, plan_json,
                state, result_json, created_at
         FROM campaign_command_receipts
         WHERE organization_id = ?1 AND event_id = ?2 AND command_id = ?3
         LIMIT 1`,
      )
      .bind(event.organizationId, event.id, commandId)
      .first<CampaignReceiptRow>();
  }

  async #messageReceipts(
    event: EmailTemplateEventProjection,
    commandId: string,
  ): Promise<readonly CampaignMessageReceiptRow[]> {
    const rows = await this.#database
      .prepare(
        `SELECT message_id, contact_id, contact_source_record_id,
                queue_payload_json, state
         FROM campaign_message_receipts
         WHERE organization_id = ?1 AND event_id = ?2 AND command_id = ?3
         ORDER BY message_id`,
      )
      .bind(event.organizationId, event.id, commandId)
      .all<CampaignMessageReceiptRow>();
    return rows.results;
  }
}
