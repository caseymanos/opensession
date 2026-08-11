import type { AirtableTableKey } from "@sessionbox-killer/data/airtable/internal";

export type ProjectionValueKind =
  | "boolean"
  | "json_array"
  | "json_object"
  | "json_value"
  | "link"
  | "multiselect"
  | "number"
  | "text";

export interface ProjectionFieldSpec {
  readonly column: string;
  readonly defaultValue?: boolean | number | string;
  readonly field: string;
  readonly kind: ProjectionValueKind;
  readonly linkedTable?: AirtableTableKey;
  readonly required?: boolean;
}

export interface ProjectionTableSpec {
  readonly fields: readonly ProjectionFieldSpec[];
  readonly scope: "event" | "organization";
  readonly scopeLinks?: readonly ProjectionFieldSpec[];
  readonly table: `p_${string}`;
}

const text = (
  field: string,
  column: string,
  required = false,
  defaultValue?: string,
): ProjectionFieldSpec => ({
  column,
  field,
  kind: "text",
  required,
  ...(defaultValue === undefined ? {} : { defaultValue }),
});
const number = (
  field: string,
  column: string,
  required = false,
  defaultValue?: number,
): ProjectionFieldSpec => ({
  column,
  field,
  kind: "number",
  required,
  ...(defaultValue === undefined ? {} : { defaultValue }),
});
const boolean = (
  field: string,
  column: string,
  defaultValue = false,
): ProjectionFieldSpec => ({
  column,
  defaultValue,
  field,
  kind: "boolean",
  required: true,
});
const json = (
  field: string,
  column: string,
  shape: "array" | "object" | "value",
  defaultValue?: string,
): ProjectionFieldSpec => ({
  column,
  ...(defaultValue === undefined ? {} : { defaultValue }),
  field,
  kind: `json_${shape}`,
  required: defaultValue === undefined,
});
const multi = (field: string, column: string): ProjectionFieldSpec => ({
  column,
  defaultValue: "[]",
  field,
  kind: "multiselect",
  required: true,
});
const link = (
  field: string,
  column: string,
  linkedTable: AirtableTableKey,
  required = true,
): ProjectionFieldSpec => ({
  column,
  field,
  kind: "link",
  linkedTable,
  required,
});

export const projectionSpecs: Readonly<
  Record<AirtableTableKey, ProjectionTableSpec>
> = {
  organizations: {
    fields: [
      text("Name", "name", true),
      text("Slug", "slug", true),
      text("Default timezone", "default_timezone", true),
    ],
    scope: "organization",
    table: "p_organizations",
  },
  events: {
    fields: [
      text("Name", "name", true),
      text("Slug", "slug", true),
      text("Timezone", "timezone", true),
      text("Start", "starts_at"),
      text("End", "ends_at"),
      text("Venue", "venue"),
      text("CFP opens", "cfp_opens_at"),
      text("CFP closes", "cfp_closes_at"),
      text("Status", "status", true),
      json("Brand JSON", "brand_json", "object", "{}"),
      json("Schedule days JSON", "schedule_days_json", "array", "[]"),
      number("Schedule snap minutes", "schedule_snap_minutes", true, 15),
      number("Schedule version", "schedule_version", true, 0),
      number("Published version", "published_version", true, 0),
      boolean("Is demo", "is_demo"),
    ],
    scope: "event",
    scopeLinks: [link("Organization", "organization_id", "organizations")],
    table: "p_events",
  },
  forms: {
    fields: [
      link("Event", "event_id", "events"),
      text("Name", "name", true),
      text("Status", "status", true),
      number("Version", "version", true),
      text("Welcome content", "welcome_content"),
      number("Submission limit", "submission_limit"),
      boolean("Edit after close", "edit_after_close"),
      text("Published at", "published_at"),
    ],
    scope: "event",
    table: "p_forms",
  },
  form_fields: {
    fields: [
      link("Form", "form_id", "forms"),
      text("Stable key", "stable_key", true),
      number("Order", "sort_order", true),
      text("Block type", "block_type", true),
      text("Label", "label", true),
      text("Help", "help_text"),
      boolean("Required", "required"),
      json("Options JSON", "options_json", "array", "[]"),
      json("Validation JSON", "validation_json", "object", "{}"),
    ],
    scope: "event",
    table: "p_form_fields",
  },
  form_rules: {
    fields: [
      link("Form", "form_id", "forms"),
      link("Target field", "target_field_id", "form_fields"),
      text("Effect", "effect", true),
      link("Source field", "source_field_id", "form_fields"),
      text("Operator", "operator", true),
      json("Value JSON", "value_json", "value"),
      number("Order", "sort_order", true),
    ],
    scope: "event",
    table: "p_form_rules",
  },
  contacts: {
    fields: [
      text("Email normalized", "email_normalized", true),
      text("Display name", "display_name", true),
      text("First name", "first_name"),
      text("Last name", "last_name"),
      text("Pronouns", "pronouns"),
      text("Title", "title"),
      text("Company", "company"),
      text("Bio", "bio"),
      text("Headshot object key", "headshot_object_key"),
      text("Headshot alt text", "headshot_alt_text"),
      json("Social JSON", "social_json", "object", "{}"),
      text(
        "Profile publication state",
        "profile_publication_state",
        false,
        "draft",
      ),
      text("Profile approved at", "profile_approved_at"),
      text("Profile approved by", "profile_approved_by"),
    ],
    scope: "organization",
    scopeLinks: [link("Organization", "organization_id", "organizations")],
    table: "p_contacts",
  },
  event_contacts: {
    fields: [
      link("Event", "event_id", "events"),
      link("Contact", "contact_id", "contacts"),
      multi("Roles", "roles_json"),
      text("Portal state", "portal_state", true),
      text("Invitation time", "invitation_at"),
      text("Last active", "last_active_at"),
      json(
        "Readiness projection JSON",
        "readiness_projection_json",
        "object",
        "{}",
      ),
    ],
    scope: "event",
    table: "p_event_contacts",
  },
  submissions: {
    fields: [
      link("Event", "event_id", "events"),
      link("Form", "form_id", "forms"),
      number("Form version", "form_version", true),
      text("Friendly ID", "friendly_id", true),
      link("Submitter contact", "submitter_contact_id", "contacts"),
      text("Title", "title", true),
      link("Track", "track_id", "tracks", false),
      text("Status", "status", true),
      text("Route key", "route_key"),
      json("Draft JSON", "draft_json", "object", "{}"),
      text("Default reviewer group ID", "default_reviewer_group_id"),
      text("Submitted at", "submitted_at"),
      text("Decision note", "decision_note"),
      text("Organizer activity at", "organizer_activity_at"),
    ],
    scope: "event",
    table: "p_submissions",
  },
  submission_answers: {
    fields: [
      link("Submission", "submission_id", "submissions"),
      number("Form version snapshot", "form_version_snapshot"),
      text("Field stable key", "field_stable_key", true),
      text("Field label snapshot", "field_label_snapshot", true),
      text("Type", "answer_type", true),
      json("Value JSON", "value_json", "value"),
      number("Order", "sort_order", true),
    ],
    scope: "event",
    table: "p_submission_answers",
  },
  submission_participants: {
    fields: [
      link("Submission", "submission_id", "submissions"),
      link("Contact", "contact_id", "contacts"),
      text("Role", "role", true),
      number("Order", "sort_order", true),
      boolean("Is primary", "is_primary"),
    ],
    scope: "event",
    table: "p_submission_participants",
  },
  submission_notes: {
    fields: [
      link("Submission", "submission_id", "submissions"),
      text("Body", "body", true),
      text("Actor ID", "actor_id", true),
      text("Actor display name", "actor_display_name", true),
      text("Created at", "created_at", true),
    ],
    scope: "event",
    table: "p_submission_notes",
  },
  rubrics: {
    fields: [
      link("Event", "event_id", "events"),
      text("Name", "name", true),
      text("Status", "status", true),
    ],
    scope: "event",
    table: "p_rubrics",
  },
  criteria: {
    fields: [
      link("Rubric", "rubric_id", "rubrics"),
      text("Label", "label", true),
      text("Guidance", "guidance"),
      number("Minimum", "minimum_score", true),
      number("Maximum", "maximum_score", true),
      number("Weight", "weight", true),
      number("Order", "sort_order", true),
    ],
    scope: "event",
    table: "p_criteria",
  },
  reviews: {
    fields: [
      link("Submission", "submission_id", "submissions"),
      link("Reviewer membership", "reviewer_id", "event_contacts"),
      text("Status", "status", true),
      boolean("Conflict", "conflict"),
      text("Conflict note", "conflict_note"),
      text("Submitted at", "submitted_at"),
    ],
    scope: "event",
    table: "p_reviews",
  },
  review_scores: {
    fields: [
      link("Review", "review_id", "reviews"),
      link("Criterion", "criterion_id", "criteria"),
      number("Numeric score", "numeric_score"),
      text("Comment", "comment"),
    ],
    scope: "event",
    table: "p_review_scores",
  },
  sessions: {
    fields: [
      link("Event", "event_id", "events"),
      link("Source submission", "source_submission_id", "submissions", false),
      text("Friendly ID", "friendly_id", true),
      text("Title", "title", true),
      text("Abstract", "abstract"),
      text("Status", "status", true),
      link("Track", "track_id", "tracks", false),
      link("Format", "format_id", "formats", false),
      number("Expected attendance", "expected_attendance"),
      number("Duration minutes", "duration_minutes"),
      boolean("Public", "is_public"),
      json("External mapping JSON", "external_mapping_json", "object", "{}"),
    ],
    scope: "event",
    table: "p_sessions",
  },
  session_participants: {
    fields: [
      link("Session", "session_id", "sessions"),
      link("Contact", "contact_id", "contacts"),
      text("Role", "role", true),
      number("Order", "sort_order", true),
      text("Confirmed state", "confirmed_state", true),
    ],
    scope: "event",
    table: "p_session_participants",
  },
  rooms: {
    fields: [
      link("Event", "event_id", "events"),
      text("Name", "name", true),
      number("Capacity", "capacity"),
      number("Sort order", "sort_order", true),
    ],
    scope: "event",
    table: "p_rooms",
  },
  tracks: {
    fields: [
      link("Event", "event_id", "events"),
      text("Name", "name", true),
      text("Color", "color"),
      text("Description", "description"),
      number("Sort order", "sort_order", true),
      text("CFP selection", "cfp_selection"),
      json("CFP aliases JSON", "cfp_aliases_json", "array", "[]"),
      text("Route key", "route_key"),
      text("Submission track", "submission_track"),
      text("Default reviewer group ID", "default_reviewer_group_id"),
    ],
    scope: "event",
    table: "p_tracks",
  },
  formats: {
    fields: [
      link("Event", "event_id", "events"),
      text("Name", "name", true),
      number("Default duration minutes", "default_duration_minutes"),
      number("Sort order", "sort_order", true),
    ],
    scope: "event",
    table: "p_formats",
  },
  schedule_slots: {
    fields: [
      link("Event", "event_id", "events"),
      link("Session", "session_id", "sessions"),
      text("Start UTC", "starts_at", true),
      text("End UTC", "ends_at", true),
      link("Room", "room_id", "rooms"),
      number("Version", "version", true),
      number("Published version", "published_version", true, 0),
      text("Override reason", "override_reason"),
    ],
    scope: "event",
    table: "p_schedule_slots",
  },
  task_definitions: {
    fields: [
      link("Event", "event_id", "events"),
      text("Name", "name", true),
      text("Type", "type", true),
      text("Description", "description"),
      boolean("Required default", "required_default"),
      boolean("Approval required", "approval_required"),
      json("Target rule JSON", "target_rule_json", "object", "{}"),
      json("Form schema JSON", "form_schema_json", "object", "{}"),
      json("File policy JSON", "file_policy_json", "object", "{}"),
    ],
    scope: "event",
    table: "p_task_definitions",
  },
  task_assignments: {
    fields: [
      link("Event", "event_id", "events"),
      link("Definition", "definition_id", "task_definitions"),
      link("Contact", "contact_id", "contacts"),
      link("Session", "session_id", "sessions", false),
      text("Due UTC", "due_at"),
      boolean("Required", "required"),
      text("Status", "status", true),
      text("Completed at", "completed_at"),
      text("Approved at", "approved_at"),
      link("Approved by", "approved_by_id", "event_contacts", false),
      json("Response JSON", "response_json", "value", "{}"),
      json("File object IDs JSON", "file_object_ids_json", "array", "[]"),
    ],
    scope: "event",
    table: "p_task_assignments",
  },
  resources: {
    fields: [
      link("Event", "event_id", "events"),
      text("Title", "title", true),
      text("Subtitle", "subtitle"),
      text("Sanitized HTML", "sanitized_html", true),
      json("Target rule JSON", "target_rule_json", "object", "{}"),
      text("Status", "status", true),
      text("Published at", "published_at"),
    ],
    scope: "event",
    table: "p_resources",
  },
  email_templates: {
    fields: [
      link("Event", "event_id", "events"),
      text("Name", "name", true),
      text("Audience type", "audience_type", true),
      text("Sender name", "sender_name", true),
      text("Sender email", "sender_email", true),
      text("Subject", "subject", true),
      json("Body document JSON", "body_document_json", "value"),
      text("Body HTML", "body_html", true),
      text("Body text", "body_text", true),
      text("Reply to", "reply_to"),
      json("Used merge fields JSON", "used_merge_fields_json", "array", "[]"),
      number("Merge schema version", "merge_schema_version", true),
      text("Status", "status", true),
      number("Version", "version", true),
    ],
    scope: "event",
    table: "p_email_templates",
  },
  campaigns: {
    fields: [
      link("Event", "event_id", "events"),
      link("Template", "template_id", "email_templates"),
      number("Template version", "template_version", true),
      json("Template snapshot JSON", "template_snapshot_json", "value"),
      json(
        "Audience filter snapshot JSON",
        "audience_filter_snapshot_json",
        "value",
      ),
      text("Trigger", "trigger_name", true),
      text("Scheduled at", "scheduled_at"),
      text("Status", "status", true),
    ],
    scope: "event",
    table: "p_campaigns",
  },
  messages: {
    fields: [
      link("Campaign", "campaign_id", "campaigns"),
      link("Contact", "contact_id", "contacts"),
      text("Recipient email", "recipient_email", true),
      text("Idempotency key", "idempotency_key", true),
      text("Provider ID", "provider_id"),
      text("Status", "status", true),
      text("Queued at", "queued_at"),
      text("Sent at", "sent_at"),
      text("Delivered at", "delivered_at"),
      text("Error code", "error_code"),
    ],
    scope: "event",
    table: "p_messages",
  },
  integrations: {
    fields: [
      link("Event", "event_id", "events"),
      text("Provider", "provider", true),
      text("Status", "status", true),
      boolean("Enabled", "enabled"),
      json("Non-secret config JSON", "non_secret_config_json", "object", "{}"),
    ],
    scope: "event",
    table: "p_integrations",
  },
  external_mappings: {
    fields: [
      link("Integration", "integration_id", "integrations"),
      text("Entity type", "entity_type", true),
      text("Source ID", "source_id", true),
      text("External ID", "external_id", true),
      text("Content hash", "content_hash", true),
      text("Last synced", "last_synced_at"),
    ],
    scope: "event",
    table: "p_external_mappings",
  },
  sync_runs: {
    fields: [
      link("Integration", "integration_id", "integrations"),
      text("Trigger", "trigger_name", true),
      text("Mode", "mode", true),
      text("Cursor", "cursor"),
      json("Counts JSON", "counts_json", "value", "{}"),
      text("Status", "status", true),
      text("Started at", "started_at"),
      text("Finished at", "finished_at"),
      text("Error summary", "error_summary"),
    ],
    scope: "event",
    table: "p_sync_runs",
  },
};

export const projectionTableOrder: readonly AirtableTableKey[] = [
  "organizations",
  "events",
  "contacts",
  "forms",
  "form_fields",
  "form_rules",
  "tracks",
  "formats",
  "rooms",
  "event_contacts",
  "submissions",
  "submission_answers",
  "submission_participants",
  "submission_notes",
  "rubrics",
  "criteria",
  "reviews",
  "review_scores",
  "sessions",
  "session_participants",
  "schedule_slots",
  "task_definitions",
  "task_assignments",
  "resources",
  "email_templates",
  "campaigns",
  "messages",
  "integrations",
  "external_mappings",
  "sync_runs",
];

export const reverseProjectionTableOrder = [...projectionTableOrder].reverse();
