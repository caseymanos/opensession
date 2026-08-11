import { createCampaignMessageKey } from "@sessionbox-killer/email";

import type { EmailDeliveryConfig } from "../email/config.js";
import { CampaignEmailCoordinator } from "../email/delivery.js";
import type { EmailQueueMessage } from "../email/messages.js";
import { inspectFeatureFlags } from "../features.js";
import type { EmailTemplateEventProjection } from "../email-templates/repository.js";

export type ProviderAcceptancePhase = "initial" | "subsequent";

const campaignId = "campaign_acceptance_demo";
const templateId = "template_acceptance";
const templateVersion = 1;
const verifiedSender = "OpenSession <auth@updates.opensessionboard.com>";
const verifiedReplyTo = "hello@opensessionboard.com";
const safeRecipients = [
  "bounced@resend.dev",
  "complained@resend.dev",
  "delivered@resend.dev",
  "suppressed@resend.dev",
] as const;
const phaseRecipients: Readonly<
  Record<
    ProviderAcceptancePhase,
    readonly { contactId: string; recipient: (typeof safeRecipients)[number] }[]
  >
> = {
  initial: [
    { contactId: "contact_speaker_01", recipient: "delivered@resend.dev" },
    { contactId: "contact_speaker_02", recipient: "bounced@resend.dev" },
    { contactId: "contact_speaker_03", recipient: "complained@resend.dev" },
    { contactId: "contact_speaker_04", recipient: "suppressed@resend.dev" },
  ],
  subsequent: [
    { contactId: "contact_speaker_05", recipient: "bounced@resend.dev" },
    { contactId: "contact_speaker_06", recipient: "complained@resend.dev" },
    { contactId: "contact_speaker_07", recipient: "suppressed@resend.dev" },
  ],
};

async function providerAcceptanceQueuedAt(options: {
  readonly database: D1Database;
  readonly fallback: string;
  readonly messageId: string;
  readonly organizationId: string;
}): Promise<string> {
  const existing = await options.database
    .prepare(
      `SELECT scheduled_at
       FROM provider_messages
       WHERE organization_id = ?1 AND id = ?2 AND kind = 'campaign'
       LIMIT 1`,
    )
    .bind(options.organizationId, options.messageId)
    .first<{ scheduled_at: string | null }>();
  return existing?.scheduled_at ?? options.fallback;
}

export class ProviderAcceptanceUnavailableError extends Error {
  constructor(message = "The provider acceptance window is unavailable.") {
    super(message);
    this.name = "ProviderAcceptanceUnavailableError";
  }
}

export function assertProviderAcceptanceWindow(options: {
  readonly config: EmailDeliveryConfig;
  readonly environment: Env["APP_ENV"];
  readonly featureFlags: unknown;
}): void {
  const inspection = inspectFeatureFlags(options.featureFlags);
  const allowlist = [...options.config.allowlist].sort();
  if (
    options.environment !== "production" ||
    !inspection.valid ||
    !inspection.flags.email ||
    inspection.flags.ai ||
    inspection.flags.embeds ||
    inspection.flags.integrations ||
    inspection.flags.webhooks ||
    inspection.flags.writes ||
    options.config.mode !== "allowlist" ||
    options.config.authFrom !== verifiedSender ||
    options.config.authReplyTo !== verifiedReplyTo ||
    allowlist.length !== safeRecipients.length ||
    allowlist.some((recipient, index) => recipient !== safeRecipients[index])
  ) {
    throw new ProviderAcceptanceUnavailableError();
  }
}

export async function runProviderAcceptance(options: {
  readonly commandId: string;
  readonly config: EmailDeliveryConfig;
  readonly database: D1Database;
  readonly event: EmailTemplateEventProjection;
  readonly now?: () => Date;
  readonly phase: ProviderAcceptancePhase;
  readonly queue: Queue<EmailQueueMessage>;
}): Promise<{
  readonly campaignId: string;
  readonly messages: readonly {
    readonly messageId: string;
    readonly outcome: string;
    readonly status?: string;
  }[];
  readonly phase: ProviderAcceptancePhase;
}> {
  if (!/^ral59_[A-Za-z0-9_]{6,48}$/.test(options.commandId)) {
    throw new TypeError("Provider acceptance command is invalid.");
  }
  const recipients = phaseRecipients[options.phase];
  const contactIds = recipients.map(({ contactId }) => contactId);
  const placeholders = contactIds.map((_, index) => `?${index + 3}`).join(", ");
  const [campaign, contacts] = await options.database.batch([
    options.database
      .prepare(
        `SELECT COUNT(*) AS count FROM p_campaigns
         WHERE organization_id = ?1 AND event_id = ?2 AND id = ?3
           AND template_id = ?4 AND template_version = ?5
           AND source_deleted_at IS NULL`,
      )
      .bind(
        options.event.organizationId,
        options.event.id,
        campaignId,
        templateId,
        templateVersion,
      ),
    options.database
      .prepare(
        `SELECT COUNT(DISTINCT contact.id) AS count
         FROM p_contacts AS contact
         INNER JOIN p_event_contacts AS membership
           ON membership.organization_id = contact.organization_id
          AND membership.contact_id = contact.id
         WHERE contact.organization_id = ?1 AND membership.event_id = ?2
           AND contact.id IN (${placeholders})
           AND contact.source_deleted_at IS NULL
           AND membership.source_deleted_at IS NULL`,
      )
      .bind(options.event.organizationId, options.event.id, ...contactIds),
  ]);
  const campaignCount = campaign?.results[0] as { count?: unknown } | undefined;
  const contactCount = contacts?.results[0] as { count?: unknown } | undefined;
  if (campaignCount?.count !== 1 || contactCount?.count !== contactIds.length) {
    throw new ProviderAcceptanceUnavailableError(
      "The provider acceptance campaign projection is unavailable.",
    );
  }

  const now = options.now?.() ?? new Date();
  const queuedAt = now.toISOString();
  const coordinator = new CampaignEmailCoordinator({
    config: options.config,
    database: options.database,
    now: () => now,
    queue: options.queue,
  });
  const messages = [];
  for (const { contactId, recipient } of recipients) {
    const messageId = await createCampaignMessageKey({
      campaignId,
      contactId,
      templateId,
      templateVersion,
    });
    const durableQueuedAt = await providerAcceptanceQueuedAt({
      database: options.database,
      fallback: queuedAt,
      messageId,
      organizationId: options.event.organizationId,
    });
    const result = await coordinator.enqueue({
      campaign_id: campaignId,
      contact_id: contactId,
      email: {
        from: options.config.authFrom,
        html: "<p>OpenSession production email acceptance.</p>",
        replyTo: options.config.authReplyTo,
        subject: "OpenSession production email acceptance",
        text: "OpenSession production email acceptance.",
        to: [recipient],
      },
      event_id: options.event.id,
      kind: "campaign.email.requested",
      message_id: messageId,
      organization_id: options.event.organizationId,
      queued_at: durableQueuedAt,
      request_id: `${options.commandId}_${options.phase}`,
      template_id: templateId,
      template_version: templateVersion,
      version: 1,
    });
    messages.push({ messageId, ...result });
  }
  return { campaignId, messages, phase: options.phase };
}
