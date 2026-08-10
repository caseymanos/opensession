export interface AirtableErrorDetails {
  code: string;
  requestId?: string | undefined;
  retryable: boolean;
  status: number;
}

export class AirtableError extends Error {
  readonly code: string;
  readonly requestId: string | undefined;
  readonly retryable: boolean;
  readonly status: number;

  constructor(details: AirtableErrorDetails) {
    super(`Airtable request failed with ${details.code} (${details.status}).`);
    this.name = "AirtableError";
    this.code = details.code;
    this.requestId = details.requestId;
    this.retryable = details.retryable;
    this.status = details.status;
  }
}

export class AirtableAmbiguousWriteError extends AirtableError {
  readonly outcome = "unknown" as const;

  constructor(details: Omit<AirtableErrorDetails, "retryable">) {
    super({ ...details, retryable: false });
    this.name = "AirtableAmbiguousWriteError";
  }
}

export class AirtableResponseError extends Error {
  constructor(operation: string) {
    super(`Airtable returned an invalid response for ${operation}.`);
    this.name = "AirtableResponseError";
  }
}

export class AirtablePartialWriteError extends Error {
  readonly completedCount: number;
  readonly failedBatchIndex: number;
  readonly failedBatchOutcome: "rejected" | "unknown";
  readonly providerCode: string;
  readonly totalCount: number;

  constructor(options: {
    cause: unknown;
    completedCount: number;
    failedBatchIndex: number;
    totalCount: number;
  }) {
    super(
      `Airtable batch write stopped after ${options.completedCount} of ${options.totalCount} records.`,
      { cause: options.cause },
    );
    this.name = "AirtablePartialWriteError";
    this.completedCount = options.completedCount;
    this.failedBatchIndex = options.failedBatchIndex;
    this.failedBatchOutcome =
      options.cause instanceof AirtableAmbiguousWriteError
        ? "unknown"
        : "rejected";
    this.providerCode =
      options.cause instanceof AirtableError
        ? options.cause.code
        : "unexpected_failure";
    this.totalCount = options.totalCount;
  }
}

export class AirtableIdempotencyConflictError extends Error {
  readonly commandId: string;
  readonly entityId: string;

  constructor(commandId: string, entityId: string) {
    super(`Command ${commandId} was already used with a different payload.`);
    this.name = "AirtableIdempotencyConflictError";
    this.commandId = commandId;
    this.entityId = entityId;
  }
}

export class AirtableManualEditError extends Error {
  readonly entityId: string;

  constructor(entityId: string) {
    super(
      `Airtable record ${entityId} changed outside the command store and requires reconciliation.`,
    );
    this.name = "AirtableManualEditError";
    this.entityId = entityId;
  }
}

export class AirtableSchemaDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AirtableSchemaDriftError";
  }
}

export class AirtableVersionConflictError extends Error {
  readonly actualVersion: number;
  readonly entityId: string;
  readonly expectedVersion: number;

  constructor(
    entityId: string,
    expectedVersion: number,
    actualVersion: number,
  ) {
    super(
      `Version conflict for ${entityId}: expected ${expectedVersion}, found ${actualVersion}.`,
    );
    this.name = "AirtableVersionConflictError";
    this.actualVersion = actualVersion;
    this.entityId = entityId;
    this.expectedVersion = expectedVersion;
  }
}
