import type {
  OrganizerSubmissionCommand,
  OrganizerSubmissionCommandType,
  OrganizerSubmissionStatus,
} from "@sessionbox-killer/contracts";

const legalTransitions: Readonly<
  Record<
    Exclude<OrganizerSubmissionCommandType, "add_note">,
    Readonly<
      Partial<Record<OrganizerSubmissionStatus, OrganizerSubmissionStatus>>
    >
  >
> = {
  reopen: {
    accepted: "submitted",
    declined: "submitted",
    waitlisted: "submitted",
    withdrawn: "submitted",
  },
  start_review: { submitted: "in_review" },
  withdraw: {
    accepted: "withdrawn",
    declined: "withdrawn",
    in_review: "withdrawn",
    submitted: "withdrawn",
    waitlisted: "withdrawn",
  },
};

export class OrganizerSubmissionValidationError extends Error {
  readonly field: string;
  readonly reason: "illegal_transition" | "invalid_command";

  constructor(
    field: string,
    message: string,
    reason: "illegal_transition" | "invalid_command" = "invalid_command",
  ) {
    super(message);
    this.name = "OrganizerSubmissionValidationError";
    this.field = field;
    this.reason = reason;
  }
}

export class OrganizerSubmissionVersionConflictError extends Error {
  readonly actualVersion: number;
  readonly expectedVersion: number;

  constructor(expectedVersion: number, actualVersion: number) {
    super(
      `Submission version ${expectedVersion} is stale; the current version is ${actualVersion}.`,
    );
    this.name = "OrganizerSubmissionVersionConflictError";
    this.actualVersion = actualVersion;
    this.expectedVersion = expectedVersion;
  }
}

export class OrganizerSubmissionIdempotencyConflictError extends Error {
  readonly commandId: string;

  constructor(commandId: string) {
    super(`Command ${commandId} was already used with a different request.`);
    this.name = "OrganizerSubmissionIdempotencyConflictError";
    this.commandId = commandId;
  }
}

export class OrganizerSubmissionNotFoundError extends Error {
  constructor() {
    super("The requested submission does not exist.");
    this.name = "OrganizerSubmissionNotFoundError";
  }
}

export function nextSubmissionStatus(
  status: OrganizerSubmissionStatus,
  command: OrganizerSubmissionCommand,
): OrganizerSubmissionStatus {
  if (command.type === "add_note") return status;
  const next = legalTransitions[command.type][status];
  if (!next) {
    throw new OrganizerSubmissionValidationError(
      "type",
      `The ${command.type} command is not allowed while the submission is ${status}.`,
      "illegal_transition",
    );
  }
  return next;
}

export function allowedSubmissionCommands(
  status: OrganizerSubmissionStatus,
): OrganizerSubmissionCommandType[] {
  const commands: OrganizerSubmissionCommandType[] = ["add_note"];
  for (const command of ["start_review", "reopen", "withdraw"] as const) {
    if (legalTransitions[command][status]) commands.push(command);
  }
  return commands;
}
