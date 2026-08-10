export const EMAIL_MERGE_SCHEMA_VERSION = 1;

export const emailMergeFieldDefinitions = {
  "event.location": { type: "text" },
  "event.name": { type: "text" },
  "event.public_url": { type: "url" },
  "organizer.email": { type: "email" },
  "organizer.name": { type: "text" },
  "recipient.first_name": { type: "text" },
  "recipient.full_name": { type: "text" },
  "session.end_at": { type: "date_time" },
  "session.public_url": { type: "url" },
  "session.room": { type: "text" },
  "session.start_at": { type: "date_time" },
  "session.title": { type: "text" },
  "submission.friendly_id": { type: "text" },
  "submission.portal_url": { type: "url" },
  "submission.title": { type: "text" },
  "task.due_at": { type: "date_time" },
  "task.name": { type: "text" },
  "task.portal_url": { type: "url" },
} as const;

export type EmailMergeFieldName = keyof typeof emailMergeFieldDefinitions;
export type EmailMergeFieldType =
  (typeof emailMergeFieldDefinitions)[EmailMergeFieldName]["type"];

export type EmailMergeValue =
  | {
      readonly type: "date_time";
      readonly display: string;
      readonly value: string;
    }
  | { readonly type: "email"; readonly value: string }
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "url"; readonly value: string };

export type EmailMergeValues = Partial<
  Readonly<Record<EmailMergeFieldName, EmailMergeValue>>
>;

export type EmailTemplateAudience =
  "organizer" | "reviewer" | "speaker" | "submitter";

export type EmailTemplateStatus = "active" | "archived" | "draft";

export interface EmailAddress {
  readonly address: string;
  readonly name: string;
}

export type EmailDocumentBlock =
  | { readonly text: string; readonly type: "heading" }
  | { readonly text: string; readonly type: "paragraph" }
  | { readonly label: string; readonly type: "button"; readonly url: string }
  | { readonly type: "divider" };

export interface EmailDocument {
  readonly blocks: readonly EmailDocumentBlock[];
  readonly previewText: string;
}

export interface EmailTemplate {
  readonly allowedMergeFields: readonly EmailMergeFieldName[];
  readonly audience: EmailTemplateAudience;
  readonly body: EmailDocument;
  readonly createdAt: string;
  readonly eventId: string;
  readonly id: string;
  readonly internalName: string;
  readonly mergeSchemaVersion: typeof EMAIL_MERGE_SCHEMA_VERSION;
  readonly replyTo: string;
  readonly sender: EmailAddress;
  readonly status: EmailTemplateStatus;
  readonly subject: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface EmailTemplateIssue {
  readonly code:
    | "duplicate_field"
    | "field_not_allowed"
    | "invalid_address"
    | "invalid_field_value"
    | "invalid_template"
    | "invalid_token"
    | "missing_field_value"
    | "output_too_large"
    | "unknown_field"
    | "unsafe_url";
  readonly location: string;
  readonly message: string;
  readonly offset?: number;
}

export interface EmailTemplateAnalysis {
  readonly issues: readonly EmailTemplateIssue[];
  readonly usedFields: readonly EmailMergeFieldName[];
  readonly valid: boolean;
}

export interface RenderedEmailTemplate {
  readonly from: string;
  readonly html: string;
  readonly replyTo: string;
  readonly subject: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly text: string;
  readonly usedFields: readonly EmailMergeFieldName[];
}

export interface EmailMessage {
  readonly from: string;
  readonly html: string;
  readonly replyTo: string;
  readonly subject: string;
  readonly text: string;
  readonly to: readonly string[];
}

export interface EmailSender {
  send(
    message: EmailMessage,
    idempotencyKey: string,
  ): Promise<{ providerId: string }>;
}
