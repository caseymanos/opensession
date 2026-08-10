import {
  expectedAirtableSchema,
  hashAirtableValue,
  type AirtableCellValue,
  type AirtableCommand,
  type AirtableCommandResult,
  type AirtableTableKey,
} from "@sessionbox-killer/data/airtable/internal";

const stableIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const operationPattern = /^[a-z][a-z0-9._-]{2,127}$/;
const tableKeys = new Set<string>(
  expectedAirtableSchema.tables.map((table) => table.key),
);
const actorTypes = new Set<AuthorityActorType>([
  "api_key",
  "portal",
  "system",
  "user",
]);

export type AuthorityActorType = "api_key" | "portal" | "system" | "user";

export interface AuthorityAuditContext {
  action: string;
  actorId?: string;
  actorType: AuthorityActorType;
  eventId?: string;
  requestId: string;
  safeDiff: Readonly<Record<string, unknown>>;
}

export interface BaseAuthorityCommand extends AirtableCommand {
  audit: AuthorityAuditContext;
  operation: string;
  organizationId: string;
}

export interface AuthorityResponse {
  authority: AirtableCommandResult;
  commandId: string;
  projection: "durable" | "repair_pending";
  status: "committed" | "committed_with_repair";
}

export interface AuthorityCommandInspection {
  attemptCount: number;
  commandId: string;
  operation: string;
  organizationId: string;
  originalResponse: AuthorityResponse | null;
  requestHash: string;
  state:
    | "airtable_committed"
    | "complete"
    | "failed"
    | "leased"
    | "outcome_unknown"
    | "projection_pending"
    | "received";
}

export interface AuthorityFailure {
  code: string;
  message: string;
  status: number;
}

export class AuthorityCommandFailedError extends Error {
  readonly status: number;

  constructor(failure: AuthorityFailure) {
    super(failure.message);
    this.name = failure.code;
    this.status = failure.status;
  }
}

export class AuthorityIdempotencyConflictError extends Error {
  constructor(commandId: string) {
    super(`Command ${commandId} was already used with a different request.`);
    this.name = "AuthorityIdempotencyConflictError";
  }
}

export class AuthorityOutcomeUnknownError extends Error {
  constructor(commandId: string) {
    super(`Command ${commandId} has an unresolved provider outcome.`);
    this.name = "AuthorityOutcomeUnknownError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertStableId(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !stableIdPattern.test(value)) {
    throw new TypeError(`${label} is not a stable identifier.`);
  }
}

function assertOperation(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !operationPattern.test(value)) {
    throw new TypeError(`${label} is not a valid operation name.`);
  }
}

function assertJsonObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be a JSON object.`);
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new TypeError(`${label} must be JSON serializable.`);
  }
  if (encoded.length > 16_384) {
    throw new TypeError(`${label} exceeds the 16 KiB audit limit.`);
  }
}

function parseAudit(value: unknown): AuthorityAuditContext {
  if (!isRecord(value)) {
    throw new TypeError("Audit context is required.");
  }
  assertOperation(value.action, "Audit action");
  assertStableId(value.requestId, "Request ID");
  if (
    typeof value.actorType !== "string" ||
    !actorTypes.has(value.actorType as AuthorityActorType)
  ) {
    throw new TypeError("Audit actor type is invalid.");
  }
  if (value.actorId !== undefined) {
    assertStableId(value.actorId, "Actor ID");
  }
  if (value.actorType !== "system" && value.actorId === undefined) {
    throw new TypeError("Audit actor ID is required for non-system actors.");
  }
  if (value.actorType === "system" && value.actorId !== undefined) {
    throw new TypeError("System audit actors must not include an actor ID.");
  }
  if (value.eventId !== undefined) {
    assertStableId(value.eventId, "Event ID");
  }
  assertJsonObject(value.safeDiff, "Audit safe diff");

  return {
    action: value.action,
    actorType: value.actorType as AuthorityActorType,
    requestId: value.requestId,
    safeDiff: value.safeDiff,
    ...(value.actorId === undefined ? {} : { actorId: value.actorId }),
    ...(value.eventId === undefined ? {} : { eventId: value.eventId }),
  };
}

export function parseBaseAuthorityCommand(
  value: unknown,
): BaseAuthorityCommand {
  if (!isRecord(value)) {
    throw new TypeError("Authority command must be an object.");
  }
  assertStableId(value.organizationId, "Organization ID");
  assertOperation(value.operation, "Operation");
  assertStableId(value.commandId, "Command ID");
  assertStableId(value.entityId, "Entity ID");
  if (
    !Number.isInteger(value.expectedVersion) ||
    (value.expectedVersion as number) < 0
  ) {
    throw new TypeError("Expected version must be a non-negative integer.");
  }
  if (typeof value.table !== "string" || !tableKeys.has(value.table)) {
    throw new TypeError("Airtable table key is invalid.");
  }
  if (!isRecord(value.fields)) {
    throw new TypeError("Airtable fields must be an object.");
  }

  return {
    audit: parseAudit(value.audit),
    commandId: value.commandId,
    entityId: value.entityId,
    expectedVersion: value.expectedVersion as number,
    fields: value.fields as Record<string, AirtableCellValue>,
    operation: value.operation,
    organizationId: value.organizationId,
    table: value.table as AirtableTableKey,
  };
}

export function hashAuthorityRequest(
  command: BaseAuthorityCommand,
): Promise<string> {
  return hashAirtableValue({
    audit: command.audit,
    commandId: command.commandId,
    entityId: command.entityId,
    expectedVersion: command.expectedVersion,
    fields: command.fields,
    operation: command.operation,
    organizationId: command.organizationId,
    schemaVersion: 1,
    table: command.table,
  });
}

export function hashAuthorityValue(value: unknown): Promise<string> {
  return hashAirtableValue(value);
}

export type {
  AirtableCellValue,
  AirtableFields,
} from "@sessionbox-killer/data/airtable/internal";
