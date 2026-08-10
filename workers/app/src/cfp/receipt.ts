import {
  createCampaignMessageKey,
  createSeedEmailTemplates,
  renderEmailTemplate,
  type EmailMergeValues,
} from "@sessionbox-killer/email";
import type {
  ProtectedPublicCfpSubmissionRequest,
  ProtectedPublicCfpSubmissionUpdateRequest,
} from "@sessionbox-killer/contracts";

import { sha256Hex } from "../auth/crypto.js";
import { isAllowlisted, parseEmailDeliveryConfig } from "../email/config.js";
import {
  CampaignEmailCoordinator,
  type CampaignEnqueueResult,
} from "../email/delivery.js";
import {
  parseEmailQueueMessage,
  type CampaignEmailQueueMessage,
} from "../email/messages.js";
import {
  cfpContactIdForEmail,
  cfpSubmissionTitle,
  type CfpSubmissionCoordinates,
} from "./submission-compiler.js";

type FinalSubmissionRequest =
  | ProtectedPublicCfpSubmissionRequest
  | ProtectedPublicCfpSubmissionUpdateRequest;

interface DurableCfpReceiptRow {
  contact_id: string | null;
  event_id: string | null;
  id: string;
  queue_handed_off_at: string | null;
  queue_payload_json: string | null;
  recipient_hash: string;
  status: string;
  template_id: string | null;
  template_version: number | null;
}

const terminalReceiptStatuses = new Set([
  "bounced",
  "complained",
  "delivered",
  "sent",
  "suppressed",
]);

export class CfpReceiptUnavailableError extends Error {
  readonly status = 503;

  constructor(message: string) {
    super(message);
    this.name = "CfpReceiptUnavailableError";
  }
}

export function requireCfpReceiptDelivery(
  deliveryConfig: unknown,
  environment: Env["APP_ENV"],
  recipient: string,
): void {
  const config = parseEmailDeliveryConfig(deliveryConfig, environment);
  if (!isAllowlisted(config, recipient)) {
    throw new CfpReceiptUnavailableError(
      "Receipt delivery is not enabled for this address.",
    );
  }
}

export interface CfpSubmissionReceiptOptions {
  readonly coordinates: CfpSubmissionCoordinates;
  readonly database: D1Database;
  readonly deliveryConfig: unknown;
  readonly environment: Env["APP_ENV"];
  readonly event: {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
  };
  readonly now?: () => Date;
  readonly organizationId: string;
  readonly portalOrigin: string;
  readonly queue: Queue<CampaignEmailQueueMessage>;
  readonly request: FinalSubmissionRequest;
  readonly requestId: string;
}

function sender(value: string): { address: string; name: string } {
  const friendly = /^(.*?)\s*<([^<>]+)>$/u.exec(value);
  return friendly
    ? {
        address: friendly[2] as string,
        name: friendly[1]?.trim() || "OpenSession",
      }
    : { address: value, name: "OpenSession" };
}

function firstName(value: string): string {
  return value.trim().split(/\s+/u)[0] || value.trim();
}

function receiptCampaignId(submissionId: string): string {
  return `cfp_receipt_${submissionId}`;
}

async function durableReceipt(
  database: D1Database,
  organizationId: string,
  submissionId: string,
): Promise<DurableCfpReceiptRow | null> {
  const rows = await database
    .prepare(
      `SELECT contact_id, event_id, id, queue_handed_off_at,
              queue_payload_json, recipient_hash, status, template_id,
              template_version
       FROM provider_messages
       WHERE organization_id = ?1 AND campaign_id = ?2 AND kind = 'campaign'
       ORDER BY created_at, id
       LIMIT 2`,
    )
    .bind(organizationId, receiptCampaignId(submissionId))
    .all<DurableCfpReceiptRow>();
  if (rows.results.length > 1) {
    throw new Error("CFP receipt idempotency state is inconsistent.");
  }
  return rows.results[0] ?? null;
}

async function validateDurableReceipt(
  row: DurableCfpReceiptRow,
  eventId: string,
  recipient: string,
): Promise<void> {
  if (
    row.event_id !== eventId ||
    row.template_id !== "template_submission_receipt" ||
    row.template_version !== 1 ||
    row.recipient_hash !==
      (await sha256Hex(recipient.trim().toLocaleLowerCase("en-US")))
  ) {
    throw new Error("CFP receipt idempotency state is inconsistent.");
  }
}

export async function hasConfirmedCfpSubmissionReceipt(
  options: Pick<
    CfpSubmissionReceiptOptions,
    "coordinates" | "database" | "event" | "organizationId" | "request"
  >,
): Promise<boolean> {
  const primaryParticipant = options.request.participants[0];
  if (!primaryParticipant) return false;
  const existing = await durableReceipt(
    options.database,
    options.organizationId,
    options.coordinates.submissionId,
  );
  if (!existing) return false;
  await validateDurableReceipt(
    existing,
    options.event.id,
    primaryParticipant.email,
  );
  return (
    Boolean(existing.queue_handed_off_at) ||
    existing.status === "sending" ||
    terminalReceiptStatuses.has(existing.status)
  );
}

export async function enqueueCfpSubmissionReceipt(
  options: CfpSubmissionReceiptOptions,
): Promise<CampaignEnqueueResult> {
  const primaryParticipant = options.request.participants[0];
  if (!primaryParticipant) {
    throw new TypeError("A final CFP receipt requires a primary participant.");
  }
  const campaignId = receiptCampaignId(options.coordinates.submissionId);
  const existing = await durableReceipt(
    options.database,
    options.organizationId,
    options.coordinates.submissionId,
  );
  if (existing) {
    await validateDurableReceipt(
      existing,
      options.event.id,
      primaryParticipant.email,
    );
    if (existing.status === "failed" && !existing.queue_handed_off_at) {
      throw new CfpReceiptUnavailableError(
        "Receipt queue handoff recovery expired.",
      );
    }
    if (terminalReceiptStatuses.has(existing.status)) {
      return { outcome: "already_terminal", status: existing.status };
    }
    if (
      existing.status === "failed" ||
      existing.status === "sending" ||
      existing.queue_handed_off_at
    ) {
      return { outcome: "already_queued", status: existing.status };
    }
  }
  const config = parseEmailDeliveryConfig(
    options.deliveryConfig,
    options.environment,
  );
  if (existing?.queue_payload_json) {
    const stored = parseEmailQueueMessage(
      JSON.parse(existing.queue_payload_json) as unknown,
    );
    if (stored.kind !== "campaign.email.requested") {
      throw new Error("CFP receipt queue payload is inconsistent.");
    }
    const result = await new CampaignEmailCoordinator({
      config,
      database: options.database,
      ...(options.now ? { now: options.now } : {}),
      queue: options.queue,
    }).enqueue(stored);
    if (result.outcome === "handoff_pending") {
      throw new CfpReceiptUnavailableError(
        "Receipt queue handoff is still in progress.",
      );
    }
    return result;
  }
  const title = cfpSubmissionTitle(options.request.answers);
  const queuedAt = (options.now ?? (() => new Date()))().toISOString();
  const template = createSeedEmailTemplates({
    createdAt: queuedAt,
    eventId: options.event.id,
    replyTo: config.authReplyTo,
    sender: sender(config.authFrom),
  }).find((candidate) => candidate.id === "template_submission_receipt");
  if (!template) throw new Error("The CFP receipt template is unavailable.");

  const portalOrigin = new URL(options.portalOrigin);
  if (options.environment === "local" && portalOrigin.protocol === "http:") {
    portalOrigin.protocol = "https:";
  }
  const portalUrl = new URL(
    `/e/${encodeURIComponent(options.event.slug)}/cfp`,
    portalOrigin,
  ).toString();
  const mergeValues: EmailMergeValues = {
    "event.name": {
      type: "text",
      value: options.event.name,
    },
    "organizer.email": { type: "email", value: config.authReplyTo },
    "recipient.first_name": {
      type: "text",
      value: firstName(primaryParticipant.name),
    },
    "submission.friendly_id": {
      type: "text",
      value: options.coordinates.friendlyId,
    },
    "submission.portal_url": { type: "url", value: portalUrl },
    "submission.title": { type: "text", value: title },
  };
  const rendered = renderEmailTemplate(template, mergeValues);
  const contactId =
    existing?.contact_id ??
    (await cfpContactIdForEmail(
      options.database,
      options.organizationId,
      primaryParticipant.email,
    ));
  if (!contactId) {
    throw new Error("The CFP receipt contact lineage is unavailable.");
  }
  const messageId =
    existing?.id ??
    (await createCampaignMessageKey({
      campaignId,
      contactId,
      templateId: rendered.templateId,
      templateVersion: rendered.templateVersion,
    }));
  const message: CampaignEmailQueueMessage = {
    campaign_id: campaignId,
    contact_id: contactId,
    email: {
      from: rendered.from,
      html: rendered.html,
      replyTo: rendered.replyTo,
      subject: rendered.subject,
      text: rendered.text,
      to: [primaryParticipant.email],
    },
    event_id: options.event.id,
    kind: "campaign.email.requested",
    message_id: messageId,
    organization_id: options.organizationId,
    queued_at: queuedAt,
    request_id: options.requestId,
    template_id: rendered.templateId,
    template_version: rendered.templateVersion,
    version: 1,
  };
  const coordinator = new CampaignEmailCoordinator({
    config,
    database: options.database,
    ...(options.now ? { now: options.now } : {}),
    queue: options.queue,
  });
  let result: CampaignEnqueueResult;
  try {
    result = await coordinator.enqueue(message);
  } catch (error) {
    const winner = await durableReceipt(
      options.database,
      options.organizationId,
      options.coordinates.submissionId,
    );
    if (!winner || winner.id === message.message_id) throw error;
    await validateDurableReceipt(
      winner,
      options.event.id,
      primaryParticipant.email,
    );
    if (winner.status === "failed" && !winner.queue_handed_off_at) {
      throw new CfpReceiptUnavailableError(
        "Receipt queue handoff recovery expired.",
      );
    }
    if (terminalReceiptStatuses.has(winner.status)) {
      return { outcome: "already_terminal", status: winner.status };
    }
    if (
      winner.status === "failed" ||
      winner.status === "sending" ||
      winner.queue_handed_off_at
    ) {
      return { outcome: "already_queued", status: winner.status };
    }
    if (!winner.queue_payload_json) throw error;
    const durable = parseEmailQueueMessage(
      JSON.parse(winner.queue_payload_json) as unknown,
    );
    if (durable.kind !== "campaign.email.requested") throw error;
    result = await coordinator.enqueue(durable);
  }
  if (result.outcome === "handoff_pending") {
    throw new CfpReceiptUnavailableError(
      "Receipt queue handoff is still in progress.",
    );
  }
  return result;
}
