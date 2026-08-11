import {
  taskAssignmentResponseEnvelopeSchema,
  taskAssignmentSchema,
  taskDefinitionSchema,
  taskReadinessSchema,
  taskTargetRuleSchema,
  type TaskAssignment,
  type TaskAssignmentResponseEnvelope,
  type TaskDefinition,
  type TaskDefinitionDraft,
  type TaskReadiness,
} from "@sessionbox-killer/contracts/tasks";
import {
  evaluateTaskReadiness,
  type TaskAssignment as DomainAssignment,
  type TaskDefinition as DomainDefinition,
  type TaskReadiness as DomainReadiness,
  type TaskTargetRule as DomainTargetRule,
} from "@sessionbox-killer/domain/tasks";

export interface TaskDefinitionRow {
  approval_required: number;
  description: string | null;
  event_id: string;
  file_policy_json: string;
  form_schema_json: string;
  id: string;
  name: string;
  required_default: number;
  source_record_id: string;
  source_version: number;
  target_rule_json: string;
  type: "ack" | "file" | "form" | "link";
}

export interface TaskAssignmentRow {
  approval_required: number;
  approved_at: string | null;
  completed_at: string | null;
  contact_id: string;
  definition_id: string;
  due_at: string | null;
  event_id: string;
  id: string;
  required: number;
  response_json: string;
  session_id: string | null;
  source_record_id: string;
  source_version: number;
  status:
    | "complete"
    | "in_progress"
    | "not_started"
    | "rejected"
    | "submitted"
    | "waived";
}

interface PersistedDefinitionPolicy {
  due: TaskDefinitionDraft["due"];
  schema_version: 1;
  target: TaskDefinitionDraft["target"];
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("Task projection contains invalid JSON.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function legacyTarget(value: unknown): TaskDefinitionDraft["target"] {
  const record = isRecord(value) ? value : {};
  const roles = Array.isArray(record.roles)
    ? record.roles.filter(
        (role): role is "chair" | "moderator" | "speaker" =>
          role === "chair" || role === "moderator" || role === "speaker",
      )
    : ["speaker" as const];
  const sessionRequired = record.sessionRequired === true;
  return taskTargetRuleSchema.parse({
    assignment_scope: sessionRequired ? "session" : "contact",
    contact: {
      exclude_contact_ids: [],
      include_contact_ids: [],
      roles,
    },
    session: sessionRequired
      ? {
          format_ids: [],
          include_session_ids: [],
          participant_roles: ["speaker"],
          track_ids: [],
        }
      : null,
  });
}

function persistedPolicy(row: TaskDefinitionRow): PersistedDefinitionPolicy {
  const value = parseJson(row.target_rule_json);
  if (
    isRecord(value) &&
    value.schema_version === 1 &&
    "target" in value &&
    "due" in value
  ) {
    const target = taskTargetRuleSchema.parse(value.target);
    const due = value.due;
    return {
      due:
        due === null
          ? null
          : taskDefinitionSchema.shape.due.unwrap().parse(due),
      schema_version: 1,
      target,
    };
  }
  return {
    due: null,
    schema_version: 1,
    target: legacyTarget(value),
  };
}

function legacyConfiguration(
  row: TaskDefinitionRow,
): TaskDefinitionDraft["configuration"] {
  const form = parseJson(row.form_schema_json);
  const file = parseJson(row.file_policy_json);
  if (row.type === "ack") {
    return { acknowledgement_label: "I acknowledge", kind: "ack" };
  }
  if (row.type === "link") {
    const record = isRecord(form) ? form : {};
    return {
      acknowledgement_label:
        typeof record.acknowledgement_label === "string"
          ? record.acknowledgement_label
          : "I reviewed this link",
      kind: "link",
      url:
        typeof record.url === "string"
          ? record.url
          : "https://opensession.invalid/task-link",
    };
  }
  if (row.type === "file") {
    const record = isRecord(file) ? file : {};
    const extensions = Array.isArray(record.extensions)
      ? record.extensions.filter(
          (extension): extension is string => typeof extension === "string",
        )
      : ["pdf"];
    return {
      extensions: extensions.length > 0 ? extensions : ["pdf"],
      kind: "file",
      max_bytes:
        typeof record.max_bytes === "number"
          ? record.max_bytes
          : typeof record.maxBytes === "number"
            ? record.maxBytes
            : 52_428_800,
      max_files: typeof record.max_files === "number" ? record.max_files : 1,
      private: true,
    };
  }
  const record = isRecord(form) ? form : {};
  if (Array.isArray(record.fields)) {
    const fields = record.fields.map((field) => {
      if (typeof field === "string") {
        return {
          help_text: "",
          id: `field_${field.replaceAll(/[^A-Za-z0-9_-]/g, "_")}`,
          label: field.replaceAll("_", " "),
          options: [],
          required: true,
          type: "text" as const,
        };
      }
      return field;
    });
    const parsed = taskDefinitionSchema.shape.configuration.safeParse({
      fields,
      kind: "form",
    });
    if (parsed.success) return parsed.data;
  }
  return {
    fields: [
      {
        help_text: "",
        id: "field_response",
        label: "Response",
        options: [],
        required: true,
        type: "textarea",
      },
    ],
    kind: "form",
  };
}

export function taskDefinitionFromRow(row: TaskDefinitionRow): TaskDefinition {
  const policy = persistedPolicy(row);
  const form = parseJson(row.form_schema_json);
  const file = parseJson(row.file_policy_json);
  const storedConfiguration = row.type === "file" ? file : form;
  const configured =
    taskDefinitionSchema.shape.configuration.safeParse(storedConfiguration);
  return taskDefinitionSchema.parse({
    approval_required: row.approval_required === 1,
    configuration: configured.success
      ? configured.data
      : legacyConfiguration(row),
    description: row.description ?? "",
    due: policy.due,
    event_id: row.event_id,
    id: row.id,
    name: row.name,
    required: row.required_default === 1,
    target: policy.target,
    version: row.source_version,
  });
}

export function taskDefinitionPolicyJson(
  definition: TaskDefinitionDraft,
): string {
  return JSON.stringify({
    due: definition.due,
    schema_version: 1,
    target: definition.target,
  } satisfies PersistedDefinitionPolicy);
}

export function taskDefinitionConfigurationFields(
  definition: TaskDefinitionDraft,
): { filePolicyJson: string; formSchemaJson: string } {
  return definition.configuration.kind === "file"
    ? {
        filePolicyJson: JSON.stringify(definition.configuration),
        formSchemaJson: "{}",
      }
    : {
        filePolicyJson: "{}",
        formSchemaJson: JSON.stringify(definition.configuration),
      };
}

export function domainTaskDefinition(
  definition: TaskDefinition,
): DomainDefinition {
  const target: DomainTargetRule = {
    assignmentScope: definition.target.assignment_scope,
    contact: {
      excludeContactIds: definition.target.contact.exclude_contact_ids,
      includeContactIds: definition.target.contact.include_contact_ids,
      roles: definition.target.contact.roles,
    },
    session: definition.target.session
      ? {
          formatIds: definition.target.session.format_ids,
          includeSessionIds: definition.target.session.include_session_ids,
          participantRoles: definition.target.session.participant_roles,
          trackIds: definition.target.session.track_ids,
        }
      : null,
  };
  return {
    approvalRequired: definition.approval_required,
    description: definition.description,
    due: definition.due
      ? {
          disambiguation: definition.due.disambiguation,
          localDate: definition.due.local_date,
          localTime: definition.due.local_time,
        }
      : null,
    eventId: definition.event_id,
    id: definition.id,
    kind: definition.configuration.kind,
    name: definition.name,
    required: definition.required,
    target,
    version: definition.version,
  };
}

function legacyAssignmentState(
  row: TaskAssignmentRow,
): TaskAssignment["state"] {
  if (row.status === "waived") return "complete";
  if (row.approved_at !== null) return "approved";
  if (row.status === "complete") return "complete";
  if (row.status === "submitted") return "submitted";
  if (row.status === "rejected") return "rejected";
  return "incomplete";
}

export function assignmentEnvelopeFromRow(
  row: TaskAssignmentRow,
): TaskAssignmentResponseEnvelope {
  const parsed = taskAssignmentResponseEnvelopeSchema.safeParse(
    parseJson(row.response_json),
  );
  if (parsed.success && parsed.data.version === row.source_version) {
    return parsed.data;
  }
  return {
    history: [],
    schema_version: 1,
    state: legacyAssignmentState(row),
    version: row.source_version,
  };
}

export function taskAssignmentFromRow(row: TaskAssignmentRow): TaskAssignment {
  const envelope = assignmentEnvelopeFromRow(row);
  return taskAssignmentSchema.parse({
    approval_required: row.approval_required === 1,
    assignment_id: row.id,
    contact_id: row.contact_id,
    definition_id: row.definition_id,
    due_at: row.due_at,
    event_id: row.event_id,
    history: envelope.history,
    required: row.required === 1,
    session_id: row.session_id,
    state: envelope.state,
    version: row.source_version,
  });
}

export function domainTaskAssignment(
  assignment: TaskAssignment,
): DomainAssignment {
  return {
    approvalRequired: assignment.approval_required,
    assignmentId: assignment.assignment_id,
    contactId: assignment.contact_id,
    definitionId: assignment.definition_id,
    dueAt: assignment.due_at,
    eventId: assignment.event_id,
    history: assignment.history.map((entry) => ({
      actorId: entry.actor_id,
      actorType: entry.actor_type,
      at: entry.at,
      commandId: entry.command_id,
      from: entry.from,
      reason: entry.reason,
      to: entry.to,
      version: entry.version,
    })),
    required: assignment.required,
    sessionId: assignment.session_id,
    state: assignment.state,
    version: assignment.version,
  };
}

export function contractTaskAssignment(
  assignment: DomainAssignment,
): TaskAssignment {
  return taskAssignmentSchema.parse({
    approval_required: assignment.approvalRequired,
    assignment_id: assignment.assignmentId,
    contact_id: assignment.contactId,
    definition_id: assignment.definitionId,
    due_at: assignment.dueAt,
    event_id: assignment.eventId,
    history: assignment.history.map((entry) => ({
      actor_id: entry.actorId,
      actor_type: entry.actorType,
      at: entry.at,
      command_id: entry.commandId,
      from: entry.from,
      reason: entry.reason,
      to: entry.to,
      version: entry.version,
    })),
    required: assignment.required,
    session_id: assignment.sessionId,
    state: assignment.state,
    version: assignment.version,
  });
}

export function assignmentResponseJson(assignment: DomainAssignment): string {
  return JSON.stringify(
    taskAssignmentResponseEnvelopeSchema.parse({
      history: assignment.history.map((entry) => ({
        actor_id: entry.actorId,
        actor_type: entry.actorType,
        at: entry.at,
        command_id: entry.commandId,
        from: entry.from,
        reason: entry.reason,
        to: entry.to,
        version: entry.version,
      })),
      schema_version: 1,
      state: assignment.state,
      version: assignment.version,
    }),
  );
}

export function assignmentProviderStatus(
  state: TaskAssignment["state"],
): TaskAssignmentRow["status"] {
  if (state === "incomplete") return "not_started";
  if (state === "approved") return "complete";
  return state;
}

export function contractTaskReadiness(
  readiness: DomainReadiness,
): TaskReadiness {
  return taskReadinessSchema.parse({
    configuration: readiness.configuration,
    explanation: readiness.explanation,
    next_due: readiness.nextDue
      ? {
          at: readiness.nextDue.at,
          local_date: readiness.nextDue.localDate,
          local_time: readiness.nextDue.localTime,
          timezone: readiness.nextDue.timezone,
        }
      : null,
    outstanding_count: readiness.outstandingCount,
    overdue_count: readiness.overdueCount,
    ratio: readiness.ratio,
    status: readiness.status,
  });
}

export function readinessForAssignments(
  assignments: readonly TaskAssignment[],
  timezone: string,
  now: Date,
): TaskReadiness {
  return contractTaskReadiness(
    evaluateTaskReadiness(assignments.map(domainTaskAssignment), timezone, now),
  );
}
