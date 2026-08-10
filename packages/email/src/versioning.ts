import { EmailTemplateValidationError, analyzeEmailTemplate } from "./merge.js";
import { freezeDeep } from "./freeze.js";
import {
  emailTemplateFamilyId,
  emailTemplateHead,
  emailTemplateVersionId,
} from "./identity.js";
import type {
  EmailAddress,
  EmailDocument,
  EmailMergeFieldName,
  EmailTemplate,
  EmailTemplateAudience,
  EmailTemplateDraft,
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

function assertCampaignSnapshotSource(
  template: EmailTemplate,
  familyVersions: readonly EmailTemplate[],
): void {
  assertTemplate(template);
  const head = emailTemplateHead(
    familyVersions,
    emailTemplateFamilyId(template.id),
  );
  if (!head || head.id !== template.id) {
    throw new EmailTemplateValidationError([
      {
        code: "invalid_template",
        location: "id",
        message:
          "Only the current template-family head can become a campaign snapshot.",
      },
    ]);
  }
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

export function emailTemplateDraft(
  template: EmailTemplate,
): EmailTemplateDraft {
  return {
    allowedMergeFields: [...template.allowedMergeFields],
    audience: template.audience,
    body: structuredClone(template.body),
    internalName: template.internalName,
    replyTo: template.replyTo,
    sender: { ...template.sender },
    subject: template.subject,
  };
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
    id: emailTemplateVersionId(current.id, current.version + 1),
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
  changes: EmailTemplateRevisionChanges = {},
): EmailTemplate {
  if (current.status !== "draft") {
    throw new EmailTemplateValidationError([
      {
        code: "invalid_template",
        location: "status",
        message: "Only a draft template version can be activated.",
      },
    ]);
  }
  assertLaterTimestamp(current.updatedAt, updatedAt);
  const active: EmailTemplate = {
    ...current,
    ...changes,
    allowedMergeFields:
      changes.allowedMergeFields ?? current.allowedMergeFields,
    body: changes.body ?? current.body,
    id: emailTemplateVersionId(current.id, current.version + 1),
    sender: changes.sender ?? current.sender,
    status: "active",
    updatedAt,
    version: current.version + 1,
  };
  assertTemplate(active);
  return active;
}

export function archiveEmailTemplate(
  current: EmailTemplate,
  updatedAt: string,
): EmailTemplate {
  if (current.status === "archived") {
    throw new EmailTemplateValidationError([
      {
        code: "invalid_template",
        location: "status",
        message: "This template version is already archived.",
      },
    ]);
  }
  assertLaterTimestamp(current.updatedAt, updatedAt);
  const archived: EmailTemplate = {
    ...current,
    id: emailTemplateVersionId(current.id, current.version + 1),
    status: "archived",
    updatedAt,
    version: current.version + 1,
  };
  assertTemplate(archived);
  return archived;
}

export function snapshotEmailTemplate(
  template: EmailTemplate,
  familyVersions: readonly EmailTemplate[],
): Readonly<EmailTemplate> {
  assertCampaignSnapshotSource(template, familyVersions);
  return freezeDeep(structuredClone(template));
}

export function serializeEmailTemplateSnapshot(
  template: EmailTemplate,
  familyVersions: readonly EmailTemplate[],
): string {
  return JSON.stringify(snapshotEmailTemplate(template, familyVersions));
}
