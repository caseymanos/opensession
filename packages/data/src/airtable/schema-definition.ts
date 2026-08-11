export const AIRTABLE_SCHEMA_VERSION = 9;

export type AirtableTableKey =
  | "organizations"
  | "events"
  | "forms"
  | "form_fields"
  | "form_rules"
  | "contacts"
  | "event_contacts"
  | "submissions"
  | "submission_answers"
  | "submission_participants"
  | "submission_notes"
  | "reviewer_groups"
  | "rubrics"
  | "criteria"
  | "reviews"
  | "review_scores"
  | "sessions"
  | "session_participants"
  | "rooms"
  | "tracks"
  | "formats"
  | "schedule_slots"
  | "task_definitions"
  | "task_assignments"
  | "resources"
  | "email_templates"
  | "campaigns"
  | "messages"
  | "integrations"
  | "external_mappings"
  | "sync_runs";

interface BaseFieldSpec {
  description?: string;
  key: string;
  name: string;
}

interface SimpleFieldSpec extends BaseFieldSpec {
  type: "email" | "multilineText" | "singleLineText";
}

interface NumberFieldSpec extends BaseFieldSpec {
  options: { precision: number };
  type: "number";
}

interface CheckboxFieldSpec extends BaseFieldSpec {
  options: { color: "greenBright"; icon: "check" };
  type: "checkbox";
}

interface DateTimeFieldSpec extends BaseFieldSpec {
  options: {
    dateFormat: { name: "iso" };
    timeFormat: { name: "24hour" };
    timeZone: "utc";
  };
  type: "dateTime";
}

interface SelectFieldSpec extends BaseFieldSpec {
  options: { choices: readonly { name: string }[] };
  type: "multipleSelects" | "singleSelect";
}

export interface LinkFieldSpec extends BaseFieldSpec {
  linkedTable: AirtableTableKey;
  type: "multipleRecordLinks";
}

export type AirtableFieldSpec =
  | CheckboxFieldSpec
  | DateTimeFieldSpec
  | LinkFieldSpec
  | NumberFieldSpec
  | SelectFieldSpec
  | SimpleFieldSpec;

export interface AirtableTableSpec {
  description: string;
  fields: readonly AirtableFieldSpec[];
  key: AirtableTableKey;
  name: string;
}

export interface AirtableSchemaSpec {
  tables: readonly AirtableTableSpec[];
  version: number;
}

function stableFieldKey(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase("en-US")
    .replaceAll(/[^a-z0-9]+/g, "_")
    .replaceAll(/^_|_$/g, "");
}

const text = (key: string, displayName = key): SimpleFieldSpec => ({
  key: stableFieldKey(key),
  name: displayName,
  type: "singleLineText",
});
const longText = (key: string, displayName = key): SimpleFieldSpec => ({
  key: stableFieldKey(key),
  name: displayName,
  type: "multilineText",
});
const email = (key: string, displayName = key): SimpleFieldSpec => ({
  key: stableFieldKey(key),
  name: displayName,
  type: "email",
});
const number = (
  key: string,
  precision = 0,
  displayName = key,
): NumberFieldSpec => ({
  key: stableFieldKey(key),
  name: displayName,
  options: { precision },
  type: "number",
});
const checkbox = (key: string, displayName = key): CheckboxFieldSpec => ({
  key: stableFieldKey(key),
  name: displayName,
  options: { color: "greenBright", icon: "check" },
  type: "checkbox",
});
const dateTime = (key: string, displayName = key): DateTimeFieldSpec => ({
  key: stableFieldKey(key),
  name: displayName,
  options: {
    dateFormat: { name: "iso" },
    timeFormat: { name: "24hour" },
    timeZone: "utc",
  },
  type: "dateTime",
});
const select = (
  key: string,
  choices: readonly string[],
  displayName = key,
): SelectFieldSpec => ({
  key: stableFieldKey(key),
  name: displayName,
  options: { choices: choices.map((choice) => ({ name: choice })) },
  type: "singleSelect",
});
const multiSelect = (
  key: string,
  choices: readonly string[],
  displayName = key,
): SelectFieldSpec => ({
  key: stableFieldKey(key),
  name: displayName,
  options: { choices: choices.map((choice) => ({ name: choice })) },
  type: "multipleSelects",
});
const link = (
  key: string,
  linkedTable: AirtableTableKey,
  displayName = key,
): LinkFieldSpec => ({
  key: stableFieldKey(key),
  linkedTable,
  name: displayName,
  type: "multipleRecordLinks",
});

const lifecycleFields = [
  number("Source version"),
  text("Last command ID"),
  text("Last command hash"),
  text("Applied content hash"),
  dateTime("Created at"),
  dateTime("Updated at"),
] as const;

const table = (
  key: AirtableTableKey,
  name: string,
  fields: readonly AirtableFieldSpec[],
): AirtableTableSpec => {
  const describedFields = [text("ID"), ...fields, ...lifecycleFields].map(
    (field) => ({
      ...field,
      description:
        field.description ??
        `OpenSession field · key=${key}.${field.key} · schema v${AIRTABLE_SCHEMA_VERSION}`,
    }),
  );

  return {
    description: `OpenSession table · key=${key} · schema v${AIRTABLE_SCHEMA_VERSION}`,
    fields: describedFields,
    key,
    name,
  };
};

const statuses = {
  campaign: ["draft", "scheduled", "sending", "complete", "failed"],
  event: ["draft", "open", "closed", "published", "archived"],
  form: ["draft", "published", "closed", "archived"],
  integration: ["disabled", "enabled", "degraded"],
  message: ["queued", "sent", "delivered", "bounced", "failed"],
  portal: ["not_invited", "invited", "active", "revoked"],
  resource: ["draft", "published", "archived"],
  review: ["assigned", "draft", "submitted", "withdrawn"],
  session: ["draft", "accepted", "scheduled", "published", "canceled"],
  submission: [
    "draft",
    "submitted",
    "in_review",
    "accepted",
    "waitlisted",
    "declined",
    "withdrawn",
  ],
  task: [
    "not_started",
    "in_progress",
    "submitted",
    "complete",
    "rejected",
    "waived",
  ],
} as const;

export const expectedAirtableSchema: AirtableSchemaSpec = {
  version: AIRTABLE_SCHEMA_VERSION,
  tables: [
    table("organizations", "Organizations", [
      text("Name"),
      text("Slug"),
      text("Default timezone"),
    ]),
    table("events", "Events", [
      link("Organization", "organizations"),
      text("Name"),
      text("Slug"),
      text("Timezone"),
      dateTime("Start"),
      dateTime("End"),
      text("Venue"),
      dateTime("CFP opens"),
      dateTime("CFP closes"),
      dateTime("Review closes"),
      select("Status", statuses.event),
      longText("Brand JSON"),
      longText("Schedule days JSON"),
      number("Schedule snap minutes"),
      number("Schedule version"),
      number("Published version"),
      checkbox("Is demo"),
    ]),
    table("forms", "Forms", [
      link("Event", "events"),
      text("Name"),
      select("Status", statuses.form),
      number("Version"),
      longText("Welcome content"),
      number("Submission limit"),
      checkbox("Edit after close"),
      dateTime("Published at"),
    ]),
    table("form_fields", "Form Fields", [
      link("Form", "forms"),
      text("Stable key"),
      number("Order"),
      select("Block type", [
        "text",
        "textarea",
        "select",
        "multiselect",
        "checkbox",
        "file",
        "participant",
        "section",
        "url",
      ]),
      text("Label"),
      longText("Help"),
      checkbox("Required"),
      longText("Options JSON"),
      longText("Validation JSON"),
    ]),
    table("form_rules", "Form Rules", [
      link("Form", "forms"),
      link("Target field", "form_fields"),
      select("Effect", ["show", "require"]),
      link("Source field", "form_fields"),
      select("Operator", [
        "equals",
        "not_equals",
        "contains",
        "not_contains",
        "is_empty",
        "is_not_empty",
      ]),
      longText("Value JSON"),
      number("Order"),
    ]),
    table("contacts", "Contacts", [
      link("Organization", "organizations"),
      email("Email normalized"),
      text("Display name"),
      text("First name"),
      text("Last name"),
      text("Pronouns"),
      text("Title"),
      text("Company"),
      longText("Bio"),
      text("Headshot object key"),
      text("Headshot alt text"),
      longText("Social JSON"),
      select("Profile publication state", ["draft", "approved", "published"]),
      dateTime("Profile approved at"),
      text("Profile approved by"),
    ]),
    table("event_contacts", "Event Contacts", [
      link("Event", "events"),
      link("Contact", "contacts"),
      multiSelect("Roles", [
        "organizer",
        "reviewer",
        "speaker",
        "moderator",
        "viewer",
      ]),
      select("Portal state", statuses.portal),
      dateTime("Invitation time"),
      dateTime("Last active"),
      longText("Readiness projection JSON"),
    ]),
    table("submissions", "Submissions", [
      link("Event", "events"),
      link("Form", "forms"),
      number("Form version"),
      text("Friendly ID"),
      link("Submitter contact", "contacts"),
      text("Title"),
      link("Track", "tracks"),
      select("Status", statuses.submission),
      text("Route key"),
      longText("Draft JSON"),
      text("Default reviewer group ID"),
      dateTime("Submitted at"),
      longText("Decision note"),
      dateTime("Organizer activity at"),
    ]),
    table("submission_answers", "Submission Answers", [
      link("Submission", "submissions"),
      number("Form version snapshot"),
      text("Field stable key"),
      text("Field label snapshot"),
      text("Type"),
      longText("Value JSON"),
      number("Order"),
    ]),
    table("submission_participants", "Submission Participants", [
      link("Submission", "submissions"),
      link("Contact", "contacts"),
      text("Role"),
      number("Order"),
      checkbox("Is primary"),
    ]),
    table("submission_notes", "Submission Notes", [
      link("Submission", "submissions"),
      longText("Body"),
      text("Actor ID"),
      text("Actor display name"),
    ]),
    table("rubrics", "Rubrics", [
      link("Event", "events"),
      text("Name"),
      number("Version"),
      longText("Criteria snapshot JSON"),
      select("Status", ["draft", "active", "archived"]),
    ]),
    table("reviewer_groups", "Reviewer Groups", [
      link("Event", "events"),
      text("Name"),
      text("Route key"),
      longText("Member IDs JSON"),
      select("Status", ["active", "archived"]),
    ]),
    table("criteria", "Criteria", [
      link("Rubric", "rubrics"),
      text("Label"),
      longText("Guidance"),
      number("Minimum"),
      number("Maximum"),
      number("Weight", 2),
      number("Order"),
    ]),
    table("reviews", "Reviews", [
      link("Submission", "submissions"),
      link("Reviewer membership", "event_contacts"),
      text("Reviewer group ID"),
      number("Rubric version"),
      longText("Rubric snapshot JSON"),
      checkbox("Scoring required"),
      dateTime("Assigned at"),
      select("Status", statuses.review),
      checkbox("Conflict"),
      longText("Conflict note"),
      longText("Score snapshot JSON"),
      longText("Reviewer note"),
      dateTime("Submitted at"),
    ]),
    table("review_scores", "Review Scores", [
      link("Review", "reviews"),
      link("Criterion", "criteria"),
      number("Numeric score", 2),
      longText("Comment"),
    ]),
    table("sessions", "Sessions", [
      link("Event", "events"),
      link("Source submission", "submissions"),
      text("Friendly ID"),
      text("Title"),
      longText("Abstract"),
      select("Status", statuses.session),
      link("Track", "tracks"),
      link("Format", "formats"),
      number("Expected attendance"),
      number("Duration minutes"),
      checkbox("Public"),
      longText("External mapping JSON"),
    ]),
    table("session_participants", "Session Participants", [
      link("Session", "sessions"),
      link("Contact", "contacts"),
      select("Role", ["speaker", "moderator", "chair"]),
      number("Order"),
      select("Confirmed state", ["pending", "confirmed", "declined"]),
    ]),
    table("rooms", "Rooms", [
      link("Event", "events"),
      text("Name"),
      number("Capacity"),
      number("Sort order"),
    ]),
    table("tracks", "Tracks", [
      link("Event", "events"),
      text("Name"),
      text("Color"),
      longText("Description"),
      number("Sort order"),
      text("CFP selection"),
      longText("CFP aliases JSON"),
      text("Route key"),
      text("Submission track"),
      text("Default reviewer group ID"),
    ]),
    table("formats", "Formats", [
      link("Event", "events"),
      text("Name"),
      number("Default duration minutes"),
      number("Sort order"),
    ]),
    table("schedule_slots", "Schedule Slots", [
      link("Event", "events"),
      link("Session", "sessions"),
      dateTime("Start UTC"),
      dateTime("End UTC"),
      link("Room", "rooms"),
      number("Version"),
      number("Published version"),
      longText("Override reason"),
    ]),
    table("task_definitions", "Task Definitions", [
      link("Event", "events"),
      text("Name"),
      select("Type", ["link", "form", "file", "ack"]),
      longText("Description"),
      checkbox("Required default"),
      checkbox("Approval required"),
      longText("Target rule JSON"),
      longText("Form schema JSON"),
      longText("File policy JSON"),
    ]),
    table("task_assignments", "Task Assignments", [
      link("Event", "events"),
      link("Definition", "task_definitions"),
      link("Contact", "contacts"),
      link("Session", "sessions"),
      dateTime("Due UTC"),
      checkbox("Required"),
      select("Status", statuses.task),
      dateTime("Completed at"),
      dateTime("Approved at"),
      link("Approved by", "event_contacts"),
      longText("Response JSON"),
      longText("File object IDs JSON"),
    ]),
    table("resources", "Resources", [
      link("Event", "events"),
      text("Title"),
      text("Subtitle"),
      longText("Sanitized HTML"),
      longText("Target rule JSON"),
      select("Status", statuses.resource),
      dateTime("Published at"),
    ]),
    table("email_templates", "Email Templates", [
      link("Event", "events"),
      text("Name"),
      text("Audience type"),
      text("Sender name"),
      email("Sender email"),
      text("Subject"),
      longText("Body document JSON"),
      longText("Body HTML"),
      longText("Body text"),
      email("Reply to"),
      longText("Used merge fields JSON"),
      number("Merge schema version"),
      select("Status", ["draft", "active", "archived"]),
      number("Version"),
    ]),
    table("campaigns", "Campaigns", [
      link("Event", "events"),
      link("Template", "email_templates"),
      number("Template version"),
      longText("Template snapshot JSON"),
      longText("Audience filter snapshot JSON"),
      text("Trigger"),
      dateTime("Scheduled at"),
      select("Status", statuses.campaign),
    ]),
    table("messages", "Messages", [
      link("Campaign", "campaigns"),
      link("Contact", "contacts"),
      email("Recipient email"),
      text("Idempotency key"),
      text("Provider ID"),
      select("Status", statuses.message),
      dateTime("Queued at"),
      dateTime("Sent at"),
      dateTime("Delivered at"),
      text("Error code"),
    ]),
    table("integrations", "Integrations", [
      link("Event", "events"),
      text("Provider"),
      select("Status", statuses.integration),
      checkbox("Enabled"),
      longText("Non-secret config JSON"),
    ]),
    table("external_mappings", "External Mappings", [
      link("Integration", "integrations"),
      text("Entity type"),
      text("Source ID"),
      text("External ID"),
      text("Content hash"),
      dateTime("Last synced"),
    ]),
    table("sync_runs", "Sync Runs", [
      link("Integration", "integrations"),
      text("Trigger"),
      select("Mode", ["dry_run", "apply"]),
      text("Cursor"),
      longText("Counts JSON"),
      select("Status", ["queued", "running", "complete", "failed"]),
      dateTime("Started at"),
      dateTime("Finished at"),
      longText("Error summary"),
    ]),
  ],
};

export function getExpectedTable(key: AirtableTableKey): AirtableTableSpec {
  const result = expectedAirtableSchema.tables.find(
    (table) => table.key === key,
  );

  if (!result) {
    throw new Error(`Unknown Airtable table key: ${key}`);
  }

  return result;
}
