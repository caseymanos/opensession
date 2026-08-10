import { emailMergeFieldDefinitions } from "./types.js";
import type {
  EmailMergeFieldName,
  EmailMergeValues,
  EmailTemplate,
  ResolvedEmailMergeField,
} from "./types.js";

export interface DeterministicEmailPreviewOptions {
  readonly eventLocation?: string;
  readonly eventName?: string;
  readonly eventPublicUrl?: string;
  readonly organizerEmail?: string;
  readonly organizerName?: string;
  readonly recipientFirstName?: string;
  readonly recipientFullName?: string;
}

export function createDeterministicEmailPreviewValues(
  options: DeterministicEmailPreviewOptions = {},
): EmailMergeValues {
  const eventName = options.eventName ?? "AI Engineer Summit 2026";
  return {
    "event.location": {
      type: "text",
      value: options.eventLocation ?? "Fort Mason Center, San Francisco",
    },
    "event.name": { type: "text", value: eventName },
    "event.public_url": {
      type: "url",
      value:
        options.eventPublicUrl ??
        "https://events.opensession.invalid/ai-engineer-summit",
    },
    "organizer.email": {
      type: "email",
      value: options.organizerEmail ?? "program@opensession.invalid",
    },
    "organizer.name": {
      type: "text",
      value: options.organizerName ?? "OpenSession program team",
    },
    "recipient.first_name": {
      type: "text",
      value: options.recipientFirstName ?? "Mina",
    },
    "recipient.full_name": {
      type: "text",
      value: options.recipientFullName ?? "Mina Okafor",
    },
    "session.end_at": {
      display: "October 13 at 10:45 AM PT",
      type: "date_time",
      value: "2026-10-13T17:45:00.000Z",
    },
    "session.public_url": {
      type: "url",
      value:
        "https://events.opensession.invalid/ai-engineer-summit#session-agents",
    },
    "session.room": { type: "text", value: "Harbor Stage" },
    "session.start_at": {
      display: "October 13 at 10:00 AM PT",
      type: "date_time",
      value: "2026-10-13T17:00:00.000Z",
    },
    "session.title": {
      type: "text",
      value: "Agents that recover in production",
    },
    "submission.friendly_id": { type: "text", value: "SUB-0104" },
    "submission.portal_url": {
      type: "url",
      value:
        "https://events.opensession.invalid/ai-engineer-summit/submissions/SUB-0104",
    },
    "submission.title": {
      type: "text",
      value: "Agents that recover in production",
    },
    "task.due_at": {
      display: "September 2 at 5:00 PM PT",
      type: "date_time",
      value: "2026-09-03T00:00:00.000Z",
    },
    "task.name": { type: "text", value: "Upload your final slides" },
    "task.portal_url": {
      type: "url",
      value:
        "https://events.opensession.invalid/ai-engineer-summit/portal/tasks/final-slides",
    },
  };
}

function displayValue(
  values: EmailMergeValues,
  name: EmailMergeFieldName,
): string | null {
  const value = values[name];
  if (!value) return null;
  return value.type === "date_time" ? value.display : value.value;
}

export function resolvedEmailMergeFields(
  template: EmailTemplate,
  values: EmailMergeValues,
): readonly ResolvedEmailMergeField[] {
  return [...new Set(template.allowedMergeFields)].sort().flatMap((name) => {
    const value = displayValue(values, name);
    return value === null
      ? []
      : [
          {
            displayValue: value,
            name,
            type: emailMergeFieldDefinitions[name].type,
          },
        ];
  });
}
