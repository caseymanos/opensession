export type TaskKind = "ack" | "file" | "form" | "link";
export type TaskParticipantRole = "chair" | "moderator" | "speaker";
export type TaskAssignmentState =
  "approved" | "complete" | "incomplete" | "rejected" | "submitted";

export interface EventLocalDuePolicy {
  readonly disambiguation: "earlier" | "later" | "reject";
  readonly localDate: string;
  readonly localTime: string;
}

export interface TaskContactTarget {
  readonly excludeContactIds: readonly string[];
  readonly includeContactIds: readonly string[];
  readonly roles: readonly TaskParticipantRole[];
}

export interface TaskSessionTarget {
  readonly formatIds: readonly string[];
  readonly includeSessionIds: readonly string[];
  readonly participantRoles: readonly TaskParticipantRole[];
  readonly trackIds: readonly string[];
}

export interface TaskTargetRule {
  readonly assignmentScope: "contact" | "session";
  readonly contact: TaskContactTarget;
  readonly session: TaskSessionTarget | null;
}

export interface TaskDefinition {
  readonly approvalRequired: boolean;
  readonly description: string;
  readonly due: EventLocalDuePolicy | null;
  readonly eventId: string;
  readonly id: string;
  readonly kind: TaskKind;
  readonly name: string;
  readonly required: boolean;
  readonly target: TaskTargetRule;
  readonly version: number;
}

export interface TaskTargetContact {
  readonly contactId: string;
  readonly roles: readonly TaskParticipantRole[];
}

export interface TaskTargetParticipant {
  readonly contactId: string;
  readonly role: TaskParticipantRole;
}

export interface TaskTargetSession {
  readonly formatId: string | null;
  readonly participants: readonly TaskTargetParticipant[];
  readonly sessionId: string;
  readonly state: "accepted" | "published" | "scheduled";
  readonly trackId: string | null;
}

export interface TaskTargetingSnapshot {
  readonly contacts: readonly TaskTargetContact[];
  readonly eventId: string;
  readonly sessions: readonly TaskTargetSession[];
}

export interface TaskAssignmentIdentity {
  readonly assignmentId: string;
  readonly contactId: string;
  readonly definitionId: string;
  readonly eventId: string;
  readonly sessionId: string | null;
}

export interface TaskAssignmentDraft extends TaskAssignmentIdentity {
  readonly approvalRequired: boolean;
  readonly dueAt: string | null;
  readonly required: boolean;
  readonly state: "incomplete";
}

export interface TaskHistoryEntry {
  readonly actorId: string | null;
  readonly actorType: "organizer" | "speaker" | "system";
  readonly at: string;
  readonly commandId: string;
  readonly from: TaskAssignmentState;
  readonly reason: string | null;
  readonly to: TaskAssignmentState;
  readonly version: number;
}

export interface TaskAssignment extends TaskAssignmentIdentity {
  readonly approvalRequired: boolean;
  readonly dueAt: string | null;
  readonly history: readonly TaskHistoryEntry[];
  readonly required: boolean;
  readonly state: TaskAssignmentState;
  readonly version: number;
}

export interface TaskTransition {
  readonly actorId: string | null;
  readonly actorType: TaskHistoryEntry["actorType"];
  readonly at: string;
  readonly commandId: string;
  readonly expectedVersion: number;
  readonly reason: string | null;
  readonly to: TaskAssignmentState;
}

export type TaskReadinessStatus =
  "not_configured" | "outstanding" | "overdue" | "ready";

const maximumApplicableAssignments = 5_000;

export interface TaskReadiness {
  readonly configuration: "configured" | "no_assignments" | "optional_only";
  readonly explanation: string;
  readonly nextDue: {
    readonly at: string;
    readonly localDate: string;
    readonly localTime: string;
    readonly timezone: string;
  } | null;
  readonly outstandingCount: number;
  readonly overdueCount: number;
  readonly ratio: {
    readonly complete: number;
    readonly percent: number | null;
    readonly total: number;
  };
  readonly status: TaskReadinessStatus;
}

export interface TaskBackfillPreview {
  readonly create: readonly TaskAssignmentDraft[];
  readonly noLongerTargeted: readonly TaskAssignmentIdentity[];
  readonly policy: "additive_preserve_existing";
  readonly preserve: readonly TaskAssignmentIdentity[];
  readonly previewId: string;
}

export type TaskDomainErrorCode =
  | "assignment_limit_exceeded"
  | "ambiguous_local_due"
  | "illegal_transition"
  | "invalid_local_due"
  | "invalid_timezone"
  | "reason_required"
  | "version_conflict";

export class TaskDomainError extends Error {
  readonly code: TaskDomainErrorCode;

  constructor(code: TaskDomainErrorCode, message: string) {
    super(message);
    this.name = "TaskDomainError";
    this.code = code;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Value is not serializable.");
  return encoded;
}

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(value)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function parseLocalDue(due: EventLocalDuePolicy): {
  day: number;
  hour: number;
  minute: number;
  month: number;
  year: number;
} {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due.localDate);
  const time = /^(\d{2}):(\d{2})$/.exec(due.localTime);
  if (!date || !time) {
    throw new TaskDomainError(
      "invalid_local_due",
      "Task due dates require a valid local date and time.",
    );
  }
  const [year, month, day, hour, minute] = [
    Number(date[1]),
    Number(date[2]),
    Number(date[3]),
    Number(time[1]),
    Number(time[2]),
  ];
  const roundTrip = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day ||
    roundTrip.getUTCHours() !== hour ||
    roundTrip.getUTCMinutes() !== minute
  ) {
    throw new TaskDomainError(
      "invalid_local_due",
      "Task due dates require a valid local date and time.",
    );
  }
  return { day, hour, minute, month, year };
}

function formatter(timezone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      second: "2-digit",
      timeZone: timezone,
      year: "numeric",
    });
  } catch {
    throw new TaskDomainError(
      "invalid_timezone",
      "The event timezone is not a valid IANA timezone.",
    );
  }
}

function dateTimeParts(
  format: Intl.DateTimeFormat,
  instant: number,
): Record<string, number> {
  return Object.fromEntries(
    format
      .formatToParts(new Date(instant))
      .filter(({ type }) =>
        ["day", "hour", "minute", "month", "second", "year"].includes(type),
      )
      .map(({ type, value }) => [type, Number(value)]),
  );
}

function offsetAt(format: Intl.DateTimeFormat, instant: number): number {
  const parts = dateTimeParts(format, instant);
  return (
    Date.UTC(
      parts.year ?? 0,
      (parts.month ?? 1) - 1,
      parts.day ?? 1,
      parts.hour ?? 0,
      parts.minute ?? 0,
      parts.second ?? 0,
    ) -
    Math.trunc(instant / 1_000) * 1_000
  );
}

function sameLocalDateTime(
  format: Intl.DateTimeFormat,
  instant: number,
  expected: ReturnType<typeof parseLocalDue>,
): boolean {
  const parts = dateTimeParts(format, instant);
  return (
    parts.year === expected.year &&
    parts.month === expected.month &&
    parts.day === expected.day &&
    parts.hour === expected.hour &&
    parts.minute === expected.minute
  );
}

export function resolveEventLocalDue(
  due: EventLocalDuePolicy,
  timezone: string,
): string {
  const expected = parseLocalDue(due);
  const format = formatter(timezone);
  const localAsUtc = Date.UTC(
    expected.year,
    expected.month - 1,
    expected.day,
    expected.hour,
    expected.minute,
  );
  const offsets = new Set<number>();
  for (let sample = -48; sample <= 48; sample += 6) {
    offsets.add(offsetAt(format, localAsUtc + sample * 60 * 60 * 1_000));
  }
  const candidates = [...offsets]
    .map((offset) => localAsUtc - offset)
    .filter((instant) => sameLocalDateTime(format, instant, expected))
    .sort((left, right) => left - right);

  if (candidates.length === 0) {
    throw new TaskDomainError(
      "invalid_local_due",
      "The task due time does not exist in the event timezone.",
    );
  }
  if (candidates.length > 1 && due.disambiguation === "reject") {
    throw new TaskDomainError(
      "ambiguous_local_due",
      "The task due time occurs twice in the event timezone; choose earlier or later.",
    );
  }
  const resolved =
    due.disambiguation === "later" ? candidates.at(-1) : candidates[0];
  if (resolved === undefined) {
    throw new TaskDomainError(
      "invalid_local_due",
      "The task due time could not be resolved.",
    );
  }
  return new Date(resolved).toISOString();
}

function containsOrAll(values: readonly string[], candidate: string | null) {
  return (
    values.length === 0 || (candidate !== null && values.includes(candidate))
  );
}

function contactMatches(
  target: TaskContactTarget,
  contact: TaskTargetContact,
): boolean {
  return (
    !target.excludeContactIds.includes(contact.contactId) &&
    containsOrAll(target.includeContactIds, contact.contactId) &&
    (target.roles.length === 0 ||
      contact.roles.some((role) => target.roles.includes(role)))
  );
}

function sessionMatches(
  target: TaskSessionTarget,
  session: TaskTargetSession,
): boolean {
  return (
    containsOrAll(target.includeSessionIds, session.sessionId) &&
    containsOrAll(target.trackIds, session.trackId) &&
    containsOrAll(target.formatIds, session.formatId)
  );
}

export async function applicableTaskAssignments(
  definitions: readonly TaskDefinition[],
  snapshot: TaskTargetingSnapshot,
  timezone: string,
): Promise<TaskAssignmentDraft[]> {
  const contacts = new Map(
    snapshot.contacts.map((contact) => [contact.contactId, contact]),
  );
  const drafts: TaskAssignmentDraft[] = [];
  const identities = new Set<string>();

  for (const definition of [...definitions].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    if (definition.eventId !== snapshot.eventId) continue;
    const dueAt = definition.due
      ? resolveEventLocalDue(definition.due, timezone)
      : null;
    const candidates: { contactId: string; sessionId: string | null }[] = [];
    if (definition.target.assignmentScope === "contact") {
      for (const contact of contacts.values()) {
        if (contactMatches(definition.target.contact, contact)) {
          candidates.push({ contactId: contact.contactId, sessionId: null });
        }
      }
    } else if (definition.target.session) {
      for (const session of snapshot.sessions) {
        if (!sessionMatches(definition.target.session, session)) continue;
        for (const participant of session.participants) {
          const contact = contacts.get(participant.contactId);
          if (
            contact &&
            definition.target.session.participantRoles.includes(
              participant.role,
            ) &&
            contactMatches(definition.target.contact, contact)
          ) {
            candidates.push({
              contactId: participant.contactId,
              sessionId: session.sessionId,
            });
          }
        }
      }
    }

    for (const candidate of candidates.sort((left, right) =>
      `${left.contactId}:${left.sessionId ?? ""}`.localeCompare(
        `${right.contactId}:${right.sessionId ?? ""}`,
      ),
    )) {
      const identity = `${definition.id}:${candidate.contactId}:${candidate.sessionId ?? ""}`;
      if (identities.has(identity)) continue;
      if (drafts.length >= maximumApplicableAssignments) {
        throw new TaskDomainError(
          "assignment_limit_exceeded",
          `Task targeting exceeds the ${maximumApplicableAssignments}-assignment materialization limit.`,
        );
      }
      identities.add(identity);
      const digest = await sha256({
        contactId: candidate.contactId,
        definitionId: definition.id,
        eventId: snapshot.eventId,
        sessionId: candidate.sessionId,
      });
      drafts.push({
        approvalRequired: definition.approvalRequired,
        assignmentId: `asg_${digest.slice(0, 36)}`,
        contactId: candidate.contactId,
        definitionId: definition.id,
        dueAt,
        eventId: snapshot.eventId,
        required: definition.required,
        sessionId: candidate.sessionId,
        state: "incomplete",
      });
    }
  }
  return drafts;
}

function identityKey(identity: TaskAssignmentIdentity): string {
  return `${identity.definitionId}:${identity.contactId}:${identity.sessionId ?? ""}`;
}

export async function previewTaskBackfill(
  definitions: readonly TaskDefinition[],
  snapshot: TaskTargetingSnapshot,
  timezone: string,
  existing: readonly TaskAssignmentIdentity[],
): Promise<TaskBackfillPreview> {
  const applicable = await applicableTaskAssignments(
    definitions,
    snapshot,
    timezone,
  );
  const applicableByKey = new Map(
    applicable.map((assignment) => [identityKey(assignment), assignment]),
  );
  const eventExisting = existing.filter(
    ({ eventId }) => eventId === snapshot.eventId,
  );
  const existingByKey = new Map(
    eventExisting.map((assignment) => [identityKey(assignment), assignment]),
  );
  const create = applicable.filter(
    (assignment) => !existingByKey.has(identityKey(assignment)),
  );
  const preserve = eventExisting.filter((assignment) =>
    applicableByKey.has(identityKey(assignment)),
  );
  const noLongerTargeted = eventExisting.filter(
    (assignment) => !applicableByKey.has(identityKey(assignment)),
  );
  const previewId = `tbp_${(
    await sha256({
      applicable: applicable.map(identityKey),
      definitions: definitions.map(
        ({ approvalRequired, due, id, required, target, version }) => ({
          approvalRequired,
          due,
          id,
          required,
          target,
          version,
        }),
      ),
      eventId: snapshot.eventId,
      existing: eventExisting.map(identityKey).sort(),
      policy: "additive_preserve_existing",
      timezone,
    })
  ).slice(0, 36)}`;
  return {
    create,
    noLongerTargeted,
    policy: "additive_preserve_existing",
    preserve,
    previewId,
  };
}

function requiresReason(
  current: TaskAssignmentState,
  transition: TaskTransition,
): boolean {
  return (
    transition.to === "rejected" ||
    (transition.to === "incomplete" && current !== "incomplete") ||
    (transition.to === "complete" && current === "incomplete")
  );
}

function legalTransition(
  assignment: TaskAssignment,
  transition: TaskTransition,
): boolean {
  if (transition.actorType === "speaker") {
    return (
      transition.to === "submitted" &&
      (assignment.state === "incomplete" || assignment.state === "rejected")
    );
  }
  if (transition.to === "incomplete") {
    return assignment.state !== "incomplete";
  }
  if (transition.to === "rejected") {
    return assignment.state === "submitted";
  }
  if (transition.to === "approved") {
    return assignment.approvalRequired && assignment.state === "submitted";
  }
  if (transition.to === "complete") {
    return (
      !assignment.approvalRequired &&
      (assignment.state === "submitted" || assignment.state === "incomplete")
    );
  }
  return (
    transition.to === "submitted" &&
    (assignment.state === "incomplete" || assignment.state === "rejected")
  );
}

export function transitionTaskAssignment(
  assignment: TaskAssignment,
  transition: TaskTransition,
): TaskAssignment {
  if (transition.expectedVersion !== assignment.version) {
    throw new TaskDomainError(
      "version_conflict",
      `Expected assignment version ${transition.expectedVersion}, received ${assignment.version}.`,
    );
  }
  if (transition.actorType === "system" && transition.actorId !== null) {
    throw new TypeError("System transitions cannot name an actor.");
  }
  if (transition.actorType !== "system" && transition.actorId === null) {
    throw new TypeError("Human transitions require an actor.");
  }
  if (!Number.isFinite(Date.parse(transition.at))) {
    throw new TypeError("Transition time must be an ISO timestamp.");
  }
  if (!legalTransition(assignment, transition)) {
    throw new TaskDomainError(
      "illegal_transition",
      `Task assignment cannot move from ${assignment.state} to ${transition.to}.`,
    );
  }
  const reason = transition.reason?.trim() || null;
  if (requiresReason(assignment.state, transition) && reason === null) {
    throw new TaskDomainError(
      "reason_required",
      "This task transition requires a reason.",
    );
  }
  const version = assignment.version + 1;
  return {
    ...assignment,
    history: [
      ...assignment.history,
      {
        actorId: transition.actorId,
        actorType: transition.actorType,
        at: new Date(transition.at).toISOString(),
        commandId: transition.commandId,
        from: assignment.state,
        reason,
        to: transition.to,
        version,
      },
    ],
    state: transition.to,
    version,
  };
}

export function taskSatisfiesReadiness(
  assignment: Pick<TaskAssignment, "approvalRequired" | "state">,
): boolean {
  return assignment.approvalRequired
    ? assignment.state === "approved"
    : assignment.state === "complete" || assignment.state === "approved";
}

function localDueView(at: string, timezone: string) {
  const parts = dateTimeParts(formatter(timezone), Date.parse(at));
  const pad = (value: number | undefined) =>
    String(value ?? 0).padStart(2, "0");
  return {
    at,
    localDate: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`,
    localTime: `${pad(parts.hour)}:${pad(parts.minute)}`,
    timezone,
  };
}

export function evaluateTaskReadiness(
  assignments: readonly TaskAssignment[],
  timezone: string,
  now: Date,
): TaskReadiness {
  formatter(timezone);
  const required = assignments.filter(({ required }) => required);
  if (assignments.length === 0) {
    return {
      configuration: "no_assignments",
      explanation: "The program team has not assigned any tasks yet.",
      nextDue: null,
      outstandingCount: 0,
      overdueCount: 0,
      ratio: { complete: 0, percent: null, total: 0 },
      status: "not_configured",
    };
  }
  if (required.length === 0) {
    return {
      configuration: "optional_only",
      explanation:
        "Only optional tasks are assigned; readiness is not configured until at least one task is required.",
      nextDue: null,
      outstandingCount: 0,
      overdueCount: 0,
      ratio: { complete: 0, percent: null, total: 0 },
      status: "not_configured",
    };
  }

  const complete = required.filter(taskSatisfiesReadiness);
  const outstanding = required.filter(
    (assignment) => !taskSatisfiesReadiness(assignment),
  );
  const nowMilliseconds = now.getTime();
  const overdue = outstanding.filter(
    ({ dueAt }) =>
      dueAt !== null &&
      Number.isFinite(Date.parse(dueAt)) &&
      Date.parse(dueAt) < nowMilliseconds,
  );
  const nextDueAt = outstanding
    .map(({ dueAt }) => dueAt)
    .filter((dueAt): dueAt is string =>
      dueAt === null ? false : Number.isFinite(Date.parse(dueAt)),
    )
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
  const status: TaskReadinessStatus =
    outstanding.length === 0
      ? "ready"
      : overdue.length > 0
        ? "overdue"
        : "outstanding";
  return {
    configuration: "configured",
    explanation:
      status === "ready"
        ? "Every required task is complete, including required approvals."
        : status === "overdue"
          ? "At least one required task is incomplete after its event-local due time."
          : "One or more required tasks still need completion or approval.",
    nextDue: nextDueAt ? localDueView(nextDueAt, timezone) : null,
    outstandingCount: outstanding.length,
    overdueCount: overdue.length,
    ratio: {
      complete: complete.length,
      percent: Math.round((complete.length / required.length) * 100),
      total: required.length,
    },
    status,
  };
}
