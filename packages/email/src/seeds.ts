import {
  EMAIL_MERGE_SCHEMA_VERSION,
  type EmailAddress,
  type EmailMergeFieldName,
  type EmailTemplate,
  type EmailTemplateAudience,
} from "./types.js";

export interface SeedEmailTemplateOptions {
  readonly createdAt: string;
  readonly eventId: string;
  readonly replyTo: string;
  readonly sender: EmailAddress;
}

interface SeedDefinition {
  readonly allowedMergeFields: readonly EmailMergeFieldName[];
  readonly audience: EmailTemplateAudience;
  readonly blocks: EmailTemplate["body"]["blocks"];
  readonly id: string;
  readonly internalName: string;
  readonly previewText: string;
  readonly subject: string;
}

const seedDefinitions: readonly SeedDefinition[] = [
  {
    allowedMergeFields: [
      "event.name",
      "organizer.email",
      "recipient.first_name",
      "submission.friendly_id",
      "submission.portal_url",
      "submission.title",
    ],
    audience: "submitter",
    blocks: [
      { text: "Thanks, {{recipient.first_name}}", type: "heading" },
      {
        text: "We received “{{submission.title}}” for {{event.name}}. Your confirmation number is {{submission.friendly_id}}.",
        type: "paragraph",
      },
      {
        label: "Review your submission",
        type: "button",
        url: "{{submission.portal_url}}",
      },
      {
        text: "Questions? Reply to this email or contact {{organizer.email}}.",
        type: "paragraph",
      },
    ],
    id: "template_submission_receipt",
    internalName: "Submission receipt",
    previewText: "Your {{event.name}} submission is safely recorded.",
    subject: "We received {{submission.friendly_id}} for {{event.name}}",
  },
  {
    allowedMergeFields: [
      "event.name",
      "recipient.first_name",
      "submission.portal_url",
      "submission.title",
    ],
    audience: "speaker",
    blocks: [
      {
        text: "You’re on the program, {{recipient.first_name}}",
        type: "heading",
      },
      {
        text: "We’re delighted to accept “{{submission.title}}” for {{event.name}}.",
        type: "paragraph",
      },
      {
        label: "Open your speaker portal",
        type: "button",
        url: "{{submission.portal_url}}",
      },
      {
        text: "The portal shows your next steps and the information the program team still needs.",
        type: "paragraph",
      },
    ],
    id: "template_submission_accepted",
    internalName: "Submission accepted",
    previewText: "Your proposal for {{event.name}} has been accepted.",
    subject: "Accepted: {{submission.title}} at {{event.name}}",
  },
  {
    allowedMergeFields: [
      "event.name",
      "organizer.email",
      "recipient.first_name",
      "submission.portal_url",
      "submission.title",
    ],
    audience: "submitter",
    blocks: [
      { text: "An update on your proposal", type: "heading" },
      {
        text: "Hi {{recipient.first_name}}, thank you for proposing “{{submission.title}}” for {{event.name}}. We aren’t able to include it in this program.",
        type: "paragraph",
      },
      {
        label: "View your submission",
        type: "button",
        url: "{{submission.portal_url}}",
      },
      {
        text: "Questions about the process can go to {{organizer.email}}.",
        type: "paragraph",
      },
    ],
    id: "template_submission_declined",
    internalName: "Submission declined",
    previewText: "The {{event.name}} program team has reviewed your proposal.",
    subject: "Your {{event.name}} proposal",
  },
  {
    allowedMergeFields: [
      "event.name",
      "recipient.first_name",
      "task.due_at",
      "task.name",
      "task.portal_url",
    ],
    audience: "speaker",
    blocks: [
      { text: "A quick readiness reminder", type: "heading" },
      {
        text: "Hi {{recipient.first_name}}, “{{task.name}}” for {{event.name}} is due {{task.due_at}}.",
        type: "paragraph",
      },
      {
        label: "Complete this task",
        type: "button",
        url: "{{task.portal_url}}",
      },
    ],
    id: "template_task_reminder",
    internalName: "Task reminder",
    previewText: "One {{event.name}} speaker task needs your attention.",
    subject: "Reminder: {{task.name}} is due {{task.due_at}}",
  },
  {
    allowedMergeFields: [
      "event.name",
      "recipient.first_name",
      "session.end_at",
      "session.public_url",
      "session.room",
      "session.start_at",
      "session.title",
    ],
    audience: "speaker",
    blocks: [
      { text: "Your session schedule changed", type: "heading" },
      {
        text: "Hi {{recipient.first_name}}, “{{session.title}}” at {{event.name}} is now scheduled for {{session.start_at}}–{{session.end_at}} in {{session.room}}.",
        type: "paragraph",
      },
      {
        label: "View the current schedule",
        type: "button",
        url: "{{session.public_url}}",
      },
      {
        text: "A calendar update will keep the same event identity so your calendar can replace the prior time.",
        type: "paragraph",
      },
    ],
    id: "template_schedule_updated",
    internalName: "Schedule updated",
    previewText: "Your {{event.name}} session time or room changed.",
    subject: "Schedule update: {{session.title}}",
  },
];

export function createSeedEmailTemplates(
  options: SeedEmailTemplateOptions,
): readonly EmailTemplate[] {
  return seedDefinitions.map((definition) => ({
    allowedMergeFields: [...definition.allowedMergeFields],
    audience: definition.audience,
    body: {
      blocks: definition.blocks.map((block) => ({ ...block })),
      previewText: definition.previewText,
    },
    createdAt: options.createdAt,
    eventId: options.eventId,
    id: definition.id,
    internalName: definition.internalName,
    mergeSchemaVersion: EMAIL_MERGE_SCHEMA_VERSION,
    replyTo: options.replyTo,
    sender: { ...options.sender },
    status: "active",
    subject: definition.subject,
    updatedAt: options.createdAt,
    version: 1,
  }));
}
