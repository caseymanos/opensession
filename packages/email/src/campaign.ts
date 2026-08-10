import { validateEmailMergeValues } from "./merge.js";
import { freezeDeep } from "./freeze.js";
import { snapshotEmailTemplate } from "./versioning.js";
import type {
  EmailAddress,
  EmailMergeValues,
  EmailTemplate,
  EmailTemplateAudience,
} from "./types.js";

export type CampaignAudienceRole = EmailTemplateAudience;
export type CampaignPortalState =
  "active" | "invited" | "not_invited" | "revoked";
export type CampaignReadiness = "all" | "outstanding" | "ready";
export type CampaignSuppressionReason =
  "bounced" | "complained" | "manual" | "provider_suppressed";
export type CampaignExclusionReason =
  | "cross_event"
  | "duplicate_contact"
  | "duplicate_email"
  | "invalid_email"
  | "invalid_merge_values"
  | CampaignSuppressionReason;

export interface CampaignAudienceFilter {
  readonly portalStates: readonly CampaignPortalState[];
  readonly readiness: CampaignReadiness;
  readonly roles: readonly CampaignAudienceRole[];
}

export interface CampaignAudienceCandidate {
  readonly contactId: string;
  readonly displayName: string;
  readonly email: string;
  readonly eventId: string;
  readonly mergeValues: EmailMergeValues;
  readonly suppressionReason?: CampaignSuppressionReason;
}

export interface CampaignAudienceExclusion {
  readonly contactId: string;
  readonly reason: CampaignExclusionReason;
}

export interface CampaignAudienceSample {
  readonly contactId: string;
  readonly displayName: string;
  readonly email: string;
}

export interface CampaignAudienceSnapshot {
  readonly createdAt: string;
  readonly eventId: string;
  readonly excluded: readonly CampaignAudienceExclusion[];
  readonly excludedCount: number;
  readonly filter: CampaignAudienceFilter;
  readonly includedContactIds: readonly string[];
  readonly includedCount: number;
  readonly samples: readonly CampaignAudienceSample[];
  readonly totalCandidates: number;
}

export type CampaignSchedule =
  | { readonly mode: "now" }
  | { readonly mode: "scheduled"; readonly scheduledAt: string };

export interface CampaignPlan {
  readonly audience: CampaignAudienceSnapshot;
  readonly schedule: CampaignSchedule;
  readonly sender: Readonly<EmailAddress>;
  readonly template: Readonly<EmailTemplate>;
}

export class CampaignPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampaignPlanError";
  }
}

const stableIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const emailAddressPattern =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const roles = new Set<CampaignAudienceRole>([
  "organizer",
  "reviewer",
  "speaker",
  "submitter",
]);
const portalStates = new Set<CampaignPortalState>([
  "active",
  "invited",
  "not_invited",
  "revoked",
]);
const readinessStates = new Set<CampaignReadiness>([
  "all",
  "outstanding",
  "ready",
]);
const suppressionPriority: Readonly<Record<CampaignSuppressionReason, number>> =
  {
    bounced: 1,
    complained: 3,
    manual: 4,
    provider_suppressed: 2,
  };
const suppressionReasons = new Set<CampaignSuppressionReason>([
  "bounced",
  "complained",
  "manual",
  "provider_suppressed",
]);

function assertStableId(value: string, label: string): void {
  if (!stableIdPattern.test(value)) {
    throw new CampaignPlanError(`${label} is not a stable identifier.`);
  }
}

function assertTimestamp(value: string): void {
  if (!value.endsWith("Z") || !Number.isFinite(Date.parse(value))) {
    throw new CampaignPlanError("Campaign snapshot timestamp must be UTC.");
  }
}

function normalizeSchedule(
  schedule: CampaignSchedule,
  createdAt: string,
): CampaignSchedule {
  if (schedule.mode === "now") return { mode: "now" };
  assertTimestamp(schedule.scheduledAt);
  if (Date.parse(schedule.scheduledAt) <= Date.parse(createdAt)) {
    throw new CampaignPlanError(
      "Scheduled delivery must be after confirmation.",
    );
  }
  return { mode: "scheduled", scheduledAt: schedule.scheduledAt };
}

function normalizeFilter(
  filter: CampaignAudienceFilter,
): CampaignAudienceFilter {
  const normalizedRoles = [...new Set(filter.roles)].sort();
  const normalizedPortalStates = [...new Set(filter.portalStates)].sort();
  if (
    normalizedRoles.length === 0 ||
    normalizedRoles.some((role) => !roles.has(role))
  ) {
    throw new CampaignPlanError("Audience filter must contain valid roles.");
  }
  if (normalizedPortalStates.some((state) => !portalStates.has(state))) {
    throw new CampaignPlanError(
      "Audience filter contains an invalid portal state.",
    );
  }
  if (!readinessStates.has(filter.readiness)) {
    throw new CampaignPlanError("Audience readiness filter is invalid.");
  }
  return {
    portalStates: normalizedPortalStates,
    readiness: filter.readiness,
    roles: normalizedRoles,
  };
}

function normalizeEmail(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return normalized.length <= 320 && emailAddressPattern.test(normalized)
    ? normalized
    : null;
}

function exclusion(
  excluded: CampaignAudienceExclusion[],
  contactId: string,
  reason: CampaignExclusionReason,
): void {
  excluded.push({ contactId, reason });
}

export function createCampaignPlan(options: {
  readonly candidates: readonly CampaignAudienceCandidate[];
  readonly createdAt: string;
  readonly eventId: string;
  readonly filter: CampaignAudienceFilter;
  readonly schedule: CampaignSchedule;
  readonly template: EmailTemplate;
  readonly templateVersions: readonly EmailTemplate[];
}): CampaignPlan {
  assertStableId(options.eventId, "Event ID");
  assertTimestamp(options.createdAt);
  if (options.template.eventId !== options.eventId) {
    throw new CampaignPlanError("Template belongs to another event.");
  }
  const template = snapshotEmailTemplate(
    options.template,
    options.templateVersions,
  );
  const filter = normalizeFilter(options.filter);
  const schedule = normalizeSchedule(options.schedule, options.createdAt);
  const excluded: CampaignAudienceExclusion[] = [];
  const included: CampaignAudienceSample[] = [];
  const contactIds = new Set<string>();
  const emails = new Set<string>();

  const candidates = [...options.candidates].sort((left, right) =>
    left.contactId.localeCompare(right.contactId, "en-US"),
  );
  const suppressedEmails = new Map<string, CampaignSuppressionReason>();
  for (const candidate of candidates) {
    assertStableId(candidate.contactId, "Contact ID");
    if (
      candidate.suppressionReason &&
      !suppressionReasons.has(candidate.suppressionReason)
    ) {
      throw new CampaignPlanError("Candidate suppression reason is invalid.");
    }
    if (candidate.eventId !== options.eventId || !candidate.suppressionReason) {
      continue;
    }
    const email = normalizeEmail(candidate.email);
    if (!email) continue;
    const current = suppressedEmails.get(email);
    if (
      !current ||
      suppressionPriority[candidate.suppressionReason] >
        suppressionPriority[current]
    ) {
      suppressedEmails.set(email, candidate.suppressionReason);
    }
  }
  for (const candidate of candidates) {
    if (contactIds.has(candidate.contactId)) {
      exclusion(excluded, candidate.contactId, "duplicate_contact");
      continue;
    }
    contactIds.add(candidate.contactId);
    if (candidate.eventId !== options.eventId) {
      exclusion(excluded, candidate.contactId, "cross_event");
      continue;
    }
    const email = normalizeEmail(candidate.email);
    if (!email) {
      exclusion(excluded, candidate.contactId, "invalid_email");
      continue;
    }
    const suppressionReason = suppressedEmails.get(email);
    if (suppressionReason) {
      exclusion(excluded, candidate.contactId, suppressionReason);
      continue;
    }
    if (emails.has(email)) {
      exclusion(excluded, candidate.contactId, "duplicate_email");
      continue;
    }
    if (!validateEmailMergeValues(template, candidate.mergeValues).valid) {
      exclusion(excluded, candidate.contactId, "invalid_merge_values");
      continue;
    }
    emails.add(email);
    included.push({
      contactId: candidate.contactId,
      displayName: candidate.displayName,
      email,
    });
  }

  const audience: CampaignAudienceSnapshot = {
    createdAt: options.createdAt,
    eventId: options.eventId,
    excluded,
    excludedCount: excluded.length,
    filter,
    includedContactIds: included.map(({ contactId }) => contactId),
    includedCount: included.length,
    samples: included.slice(0, 5),
    totalCandidates: candidates.length,
  };
  return freezeDeep({
    audience: structuredClone(audience),
    schedule: structuredClone(schedule),
    sender: structuredClone(template.sender),
    template: structuredClone(template),
  });
}

export function serializeCampaignPlan(plan: CampaignPlan): string {
  return JSON.stringify(freezeDeep(structuredClone(plan)));
}

export async function createCampaignMessageKey(options: {
  readonly campaignId: string;
  readonly contactId: string;
  readonly templateId: string;
  readonly templateVersion: number;
}): Promise<string> {
  assertStableId(options.campaignId, "Campaign ID");
  assertStableId(options.contactId, "Contact ID");
  assertStableId(options.templateId, "Template ID");
  if (
    !Number.isInteger(options.templateVersion) ||
    options.templateVersion < 1
  ) {
    throw new CampaignPlanError("Template version must be positive.");
  }
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      options.campaignId,
      options.contactId,
      options.templateId,
      options.templateVersion,
    ]),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `email_${hex}`;
}
