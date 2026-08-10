import { EmailTemplateValidationError, analyzeEmailTemplate } from "./merge.js";
import { freezeDeep } from "./freeze.js";
import type {
  EmailAddress,
  EmailDocument,
  EmailMergeFieldName,
  EmailTemplate,
  EmailTemplateAudience,
} from "./types.js";

export interface EmailTemplateRevisionChanges {
  readonly allowedMergeFields?: readonly EmailMergeFieldName[];
  readonly audience?: EmailTemplateAudience;
  readonly body?: EmailDocument;
  readonly internalName?: string;
  readonly replyTo?: string;
  readonly sender?: EmailAddress;
  readonly subject?: string;
}

function assertLaterTimestamp(current: string, updatedAt: string): void {
  if (
    !updatedAt.endsWith("Z") ||
    !Number.isFinite(Date.parse(updatedAt)) ||
    Date.parse(updatedAt) <= Date.parse(current)
  ) {
    throw new TypeError("Template revision timestamp must advance in UTC.");
  }
}

function assertTemplate(template: EmailTemplate): void {
  const analysis = analyzeEmailTemplate(template);
  if (!analysis.valid) throw new EmailTemplateValidationError(analysis.issues);
}

function assertCampaignSnapshotSource(template: EmailTemplate): void {
  assertTemplate(template);
  if (template.status !== "active") {
    throw new EmailTemplateValidationError([
      {
        code: "invalid_template",
        location: "status",
        message: "Only an active template can become a campaign snapshot.",
      },
    ]);
  }
}

export function createEmailTemplateRevision(
  current: EmailTemplate,
  changes: EmailTemplateRevisionChanges,
  updatedAt: string,
): EmailTemplate {
  assertLaterTimestamp(current.updatedAt, updatedAt);
  const revision: EmailTemplate = {
    ...current,
    ...changes,
    allowedMergeFields:
      changes.allowedMergeFields ?? current.allowedMergeFields,
    body: changes.body ?? current.body,
    sender: changes.sender ?? current.sender,
    status: "draft",
    updatedAt,
    version: current.version + 1,
  };
  assertTemplate(revision);
  return revision;
}

export function activateEmailTemplate(
  current: EmailTemplate,
  updatedAt: string,
): EmailTemplate {
  assertLaterTimestamp(current.updatedAt, updatedAt);
  const active: EmailTemplate = {
    ...current,
    status: "active",
    updatedAt,
    version: current.version + 1,
  };
  assertTemplate(active);
  return active;
}

export function snapshotEmailTemplate(
  template: EmailTemplate,
): Readonly<EmailTemplate> {
  assertCampaignSnapshotSource(template);
  return freezeDeep(structuredClone(template));
}

export function serializeEmailTemplateSnapshot(
  template: EmailTemplate,
): string {
  return JSON.stringify(snapshotEmailTemplate(template));
}
