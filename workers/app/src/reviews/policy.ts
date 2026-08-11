export class ReviewOperationsValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "ReviewOperationsValidationError";
    this.field = field;
  }
}

export class ReviewOperationsVersionConflictError extends Error {
  readonly actualVersion: number;
  readonly expectedVersion: number;

  constructor(expectedVersion: number, actualVersion: number) {
    super(
      `Review operation version ${expectedVersion} is stale; the current version is ${actualVersion}.`,
    );
    this.name = "ReviewOperationsVersionConflictError";
    this.actualVersion = actualVersion;
    this.expectedVersion = expectedVersion;
  }
}

export class ReviewOperationsIdempotencyConflictError extends Error {
  readonly commandId: string;

  constructor(commandId: string) {
    super(`Command ${commandId} was already used with a different request.`);
    this.name = "ReviewOperationsIdempotencyConflictError";
    this.commandId = commandId;
  }
}

export class ReviewOperationsNotFoundError extends Error {
  constructor(message = "The requested review resource does not exist.") {
    super(message);
    this.name = "ReviewOperationsNotFoundError";
  }
}
