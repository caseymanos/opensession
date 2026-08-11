import type { EmailMessage } from "@sessionbox-killer/email";

export interface MagicLinkEmailQueueMessage {
  readonly delivery_id: string;
  readonly expires_at: string;
  readonly kind: "auth.magic_link.requested";
  readonly link: string;
  readonly purpose: "portal" | "sign_in";
  readonly request_id: string;
  readonly to: string;
  readonly version: 1;
}

export interface CampaignEmailQueueMessage {
  readonly campaign_id: string;
  readonly contact_id: string;
  readonly email: EmailMessage;
  readonly event_id: string;
  readonly kind: "campaign.email.requested";
  readonly message_id: string;
  readonly organization_id: string;
  readonly queued_at: string;
  readonly request_id: string;
  readonly scheduled_at?: string;
  readonly template_id: string;
  readonly template_version: number;
  readonly version: 1;
}

export type EmailQueueMessage =
  CampaignEmailQueueMessage | MagicLinkEmailQueueMessage;

export function serializeMagicLinkDeliveryBinding(
  message: MagicLinkEmailQueueMessage,
): string {
  return JSON.stringify([
    message.delivery_id,
    message.expires_at,
    message.link,
    message.purpose,
    message.request_id,
    message.to.trim().toLowerCase(),
    message.version,
  ]);
}

const stableIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const messageIdPattern = /^email_[a-f\d]{64}$/;
const emailPattern = /^[^\s@<>]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableId(value: unknown): value is string {
  return typeof value === "string" && stableIdPattern.test(value);
}

function utcTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.endsWith("Z") &&
    Number.isFinite(Date.parse(value))
  );
}

function address(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 320 &&
    !/[\r\n\0]/u.test(value) &&
    emailPattern.test(value)
  );
}

function renderedMessage(value: unknown): value is EmailMessage {
  if (!isRecord(value) || !Array.isArray(value.to) || value.to.length !== 1) {
    return false;
  }
  return (
    typeof value.from === "string" &&
    value.from.length <= 400 &&
    !/[\r\n\0]/u.test(value.from) &&
    typeof value.replyTo === "string" &&
    address(value.replyTo) &&
    typeof value.subject === "string" &&
    value.subject.length <= 200 &&
    !/[\r\n\0]/u.test(value.subject) &&
    typeof value.html === "string" &&
    new TextEncoder().encode(value.html).byteLength <= 96 * 1_024 &&
    typeof value.text === "string" &&
    new TextEncoder().encode(value.text).byteLength <= 96 * 1_024 &&
    address(value.to[0])
  );
}

function parseMagicLink(
  value: Record<string, unknown>,
): MagicLinkEmailQueueMessage {
  if (
    value.version !== 1 ||
    !stableId(value.delivery_id) ||
    !stableId(value.request_id) ||
    !utcTimestamp(value.expires_at) ||
    !address(value.to) ||
    (value.purpose !== "portal" && value.purpose !== "sign_in") ||
    typeof value.link !== "string" ||
    value.link.length > 4_096
  ) {
    throw new TypeError("Magic-link email message is invalid.");
  }
  let link: URL;
  try {
    link = new URL(value.link);
  } catch {
    throw new TypeError("Magic-link email URL is invalid.");
  }
  if (
    link.username ||
    link.password ||
    (link.protocol !== "https:" &&
      !(link.protocol === "http:" && link.hostname === "localhost"))
  ) {
    throw new TypeError("Magic-link email URL is unsafe.");
  }
  return value as unknown as MagicLinkEmailQueueMessage;
}

function parseCampaign(
  value: Record<string, unknown>,
): CampaignEmailQueueMessage {
  if (
    value.version !== 1 ||
    typeof value.message_id !== "string" ||
    !messageIdPattern.test(value.message_id) ||
    !stableId(value.organization_id) ||
    !stableId(value.event_id) ||
    !stableId(value.campaign_id) ||
    !stableId(value.contact_id) ||
    !stableId(value.template_id) ||
    !stableId(value.request_id) ||
    !Number.isInteger(value.template_version) ||
    (value.template_version as number) < 1 ||
    !utcTimestamp(value.queued_at) ||
    (value.scheduled_at !== undefined && !utcTimestamp(value.scheduled_at)) ||
    !renderedMessage(value.email)
  ) {
    throw new TypeError("Campaign email message is invalid.");
  }
  const scheduledAt =
    typeof value.scheduled_at === "string"
      ? value.scheduled_at
      : (value.queued_at as string);
  if (Date.parse(scheduledAt) < Date.parse(value.queued_at as string)) {
    throw new TypeError("Campaign schedule precedes its queue timestamp.");
  }
  return value as unknown as CampaignEmailQueueMessage;
}

export function parseEmailQueueMessage(value: unknown): EmailQueueMessage {
  if (!isRecord(value)) throw new TypeError("Email queue message is invalid.");
  if (value.kind === "auth.magic_link.requested") return parseMagicLink(value);
  if (value.kind === "campaign.email.requested") return parseCampaign(value);
  throw new TypeError("Email queue message kind is unsupported.");
}
