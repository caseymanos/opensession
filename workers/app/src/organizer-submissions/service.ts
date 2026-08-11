import {
  organizerSubmissionCommandResultSchema,
  type OrganizerSubmissionCommand,
  type OrganizerSubmissionCommandResult,
  type OrganizerSubmissionNote,
  type OrganizerSubmissionStatus,
} from "@sessionbox-killer/contracts";

import type { BaseAuthority } from "../authority/base-authority.js";
import {
  AuthorityCommandFailedError,
  AuthorityIdempotencyConflictError,
  parseBaseAuthorityCommand,
  type AuthorityResponse,
  type BaseAuthorityCommand,
} from "../authority/types.js";
import {
  nextSubmissionStatus,
  OrganizerSubmissionIdempotencyConflictError,
  OrganizerSubmissionNotFoundError,
  OrganizerSubmissionVersionConflictError,
} from "./policy.js";

interface OrganizerSubmissionServiceOptions {
  actorDisplayName: string;
  actorId: string;
  actorType?: "api_key" | "user";
  authority: Pick<BaseAuthority, "execute">;
  database: D1Database;
  eventId: string;
  organizationId: string;
  requestId: string;
}

interface SubmissionPersistenceRow {
  source_record_id: string;
  source_version: number;
  status: OrganizerSubmissionStatus;
}

interface CommandReceiptRow {
  command_id: string;
  command_hash: string;
  operations_json: string | null;
  result_json: string | null;
  state: "applying" | "complete";
  submission_id: string;
}

const authorityConflictNames = new Set([
  "AirtableIdempotencyConflictError",
  "AirtableManualEditError",
  "AirtableVersionConflictError",
  "AuthorityIdempotencyConflictError",
]);

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right, "en-US"))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new TypeError("Value is not JSON serializable.");
  return encoded;
}

function errorName(error: unknown): string | null {
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9]+$/u.test(error.name)
    ? error.name
    : null;
}

function authorityFailureStatus(error: unknown): number | null {
  if (error instanceof AuthorityCommandFailedError) return error.status;
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    return error.status;
  }
  return authorityConflictNames.has(errorName(error) ?? "") ? 409 : null;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function stableId(prefix: string, value: string, length = 48) {
  return `${prefix}_${(await sha256Hex(value)).slice(0, length)}`;
}

function readAppliedAt(operations: readonly BaseAuthorityCommand[]): string {
  const value = operations[0]?.fields["Organizer activity at"];
  if (typeof value !== "string") {
    throw new Error(
      "Organizer submission command is missing its activity time.",
    );
  }
  return value;
}

function noteFromOperations(
  operations: readonly BaseAuthorityCommand[],
  projection: { createdAt: string; version: number } | null,
): OrganizerSubmissionNote | null {
  const operation = operations.find(
    ({ table }) => table === "submission_notes",
  );
  if (!operation) return null;
  if (!projection) throw new Error("Organizer note result is missing.");
  const body = operation.fields.Body;
  const actorId = operation.fields["Actor ID"];
  const actorDisplayName = operation.fields["Actor display name"];
  if (
    typeof body !== "string" ||
    typeof actorId !== "string" ||
    typeof actorDisplayName !== "string"
  ) {
    throw new Error("Organizer note command is malformed.");
  }
  return {
    actor: { displayName: actorDisplayName, id: actorId },
    body,
    createdAt: projection.createdAt,
    id: operation.entityId,
    version: projection.version,
  };
}

export class AirtableOrganizerSubmissionCommandService {
  readonly #actorDisplayName: string;
  readonly #actorId: string;
  readonly #actorType: "api_key" | "user";
  readonly #authority: Pick<BaseAuthority, "execute">;
  readonly #database: D1Database;
  readonly #eventId: string;
  readonly #organizationId: string;
  readonly #requestId: string;

  constructor(options: OrganizerSubmissionServiceOptions) {
    this.#actorDisplayName = options.actorDisplayName;
    this.#actorId = options.actorId;
    this.#actorType = options.actorType ?? "user";
    this.#authority = options.authority;
    this.#database = options.database;
    this.#eventId = options.eventId;
    this.#organizationId = options.organizationId;
    this.#requestId = options.requestId;
  }

  async execute(
    command: OrganizerSubmissionCommand,
  ): Promise<OrganizerSubmissionCommandResult> {
    const commandHash = await sha256Hex(
      canonicalJson({
        actorId: this.#actorId,
        command,
        eventId: this.#eventId,
        organizationId: this.#organizationId,
      }),
    );
    const existing = await this.#readReceipt(command.commandId);
    if (existing) return this.#resume(existing, commandHash, true);

    const submission = await this.#submission(command.submissionId);
    if (!submission) throw new OrganizerSubmissionNotFoundError();
    if (submission.source_version !== command.expectedVersion) {
      throw new OrganizerSubmissionVersionConflictError(
        command.expectedVersion,
        submission.source_version,
      );
    }
    const nextStatus = nextSubmissionStatus(submission.status, command);
    const operations = await this.#operations(command, submission, nextStatus);
    const now = new Date().toISOString();
    try {
      await this.#database
        .prepare(
          `INSERT INTO organizer_submission_command_receipts (
             organization_id, event_id, submission_id, command_id,
             command_hash, state, operations_json, result_json,
             created_at, updated_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, 'applying', ?6, NULL, ?7, ?7)`,
        )
        .bind(
          this.#organizationId,
          this.#eventId,
          command.submissionId,
          command.commandId,
          commandHash,
          JSON.stringify(operations),
          now,
        )
        .run();
    } catch (error) {
      const winner = await this.#readReceipt(command.commandId);
      if (winner) return this.#resume(winner, commandHash, true);
      throw error;
    }
    return this.#apply(command.commandId, operations, nextStatus, false);
  }

  async #readReceipt(commandId: string): Promise<CommandReceiptRow | null> {
    return this.#database
      .prepare(
        `SELECT command_id, submission_id, command_hash, state,
                operations_json, result_json
         FROM organizer_submission_command_receipts
         WHERE organization_id = ?1 AND event_id = ?2 AND command_id = ?3`,
      )
      .bind(this.#organizationId, this.#eventId, commandId)
      .first<CommandReceiptRow>();
  }

  async #resume(
    receipt: CommandReceiptRow,
    commandHash: string,
    replayed: boolean,
  ): Promise<OrganizerSubmissionCommandResult> {
    if (receipt.command_hash !== commandHash) {
      throw new OrganizerSubmissionIdempotencyConflictError(receipt.command_id);
    }
    if (receipt.state === "complete") {
      if (!receipt.result_json)
        throw new Error("Complete receipt is malformed.");
      const result = organizerSubmissionCommandResultSchema.parse(
        JSON.parse(receipt.result_json) as unknown,
      );
      return { ...result, outcome: "replayed" };
    }
    if (!receipt.operations_json)
      throw new Error("Applying receipt is malformed.");
    const operations = (JSON.parse(receipt.operations_json) as unknown[]).map(
      parseBaseAuthorityCommand,
    );
    const submissionOperation = operations[0];
    const status = submissionOperation?.fields.Status;
    if (!submissionOperation || typeof status !== "string") {
      throw new Error("Applying organizer receipt has no target status.");
    }
    if (receipt.submission_id !== submissionOperation.entityId) {
      throw new Error("Applying organizer receipt has an invalid submission.");
    }
    return this.#apply(
      receipt.command_id,
      operations,
      status as OrganizerSubmissionStatus,
      replayed,
    );
  }

  async #apply(
    commandId: string,
    operations: readonly BaseAuthorityCommand[],
    status: OrganizerSubmissionStatus,
    replayed: boolean,
  ): Promise<OrganizerSubmissionCommandResult> {
    let submissionVersion = 0;
    let projection: "durable" | "repair_pending" = "durable";
    let appliedAt = readAppliedAt(operations);
    let noteProjection: { createdAt: string; version: number } | null = null;
    for (const operation of operations) {
      let response: AuthorityResponse;
      try {
        response = await this.#authority.execute(operation);
      } catch (error) {
        if (
          error instanceof AuthorityIdempotencyConflictError ||
          errorName(error) === "AuthorityIdempotencyConflictError"
        ) {
          throw new OrganizerSubmissionIdempotencyConflictError(commandId);
        }
        if (authorityFailureStatus(error) === 409) {
          if (operation.table === "submissions") {
            const current = await this.#submission(operation.entityId);
            throw new OrganizerSubmissionVersionConflictError(
              operation.expectedVersion,
              current?.source_version ?? operation.expectedVersion,
            );
          }
        }
        throw error;
      }
      if (operation.table === "submissions") {
        submissionVersion = response.authority.sourceVersion;
        const updatedAt = response.authority.fields["Updated at"];
        if (typeof updatedAt === "string") appliedAt = updatedAt;
      }
      if (operation.table === "submission_notes") {
        const createdAt = response.authority.fields["Created at"];
        if (typeof createdAt !== "string") {
          throw new Error(
            "Organizer note authority result has no creation time.",
          );
        }
        noteProjection = {
          createdAt,
          version: response.authority.sourceVersion,
        };
      }
      if (response.projection === "repair_pending")
        projection = "repair_pending";
    }
    if (submissionVersion < 1) {
      throw new Error("Organizer command did not update its submission.");
    }
    const result = organizerSubmissionCommandResultSchema.parse({
      appliedAt,
      commandId,
      note: noteFromOperations(operations, noteProjection),
      outcome: replayed ? "replayed" : "applied",
      projection,
      status,
      submissionId: operations[0]?.entityId,
      version: submissionVersion,
    });
    const completed = await this.#database
      .prepare(
        `UPDATE organizer_submission_command_receipts
         SET state = 'complete', operations_json = NULL, result_json = ?4,
             updated_at = ?5
         WHERE organization_id = ?1 AND event_id = ?2 AND command_id = ?3
           AND state = 'applying'`,
      )
      .bind(
        this.#organizationId,
        this.#eventId,
        commandId,
        JSON.stringify({ ...result, outcome: "applied" }),
        new Date().toISOString(),
      )
      .run();
    if (completed.meta.changes !== 1) {
      const receipt = await this.#readReceipt(commandId);
      if (receipt?.state === "complete" && receipt.result_json) {
        const winner = organizerSubmissionCommandResultSchema.parse(
          JSON.parse(receipt.result_json) as unknown,
        );
        return { ...winner, outcome: "replayed" };
      }
      throw new Error("Organizer command completion was not durable.");
    }
    return result;
  }

  async #submission(submissionId: string) {
    return this.#database
      .prepare(
        `SELECT source_record_id, source_version, status
         FROM p_submissions
         WHERE organization_id = ?1 AND event_id = ?2 AND id = ?3
           AND source_deleted_at IS NULL
         LIMIT 1`,
      )
      .bind(this.#organizationId, this.#eventId, submissionId)
      .first<SubmissionPersistenceRow>();
  }

  async #operations(
    command: OrganizerSubmissionCommand,
    submission: SubmissionPersistenceRow,
    nextStatus: OrganizerSubmissionStatus,
  ): Promise<readonly BaseAuthorityCommand[]> {
    const appliedAt = new Date().toISOString();
    const noteId = await stableId(
      "submission_note",
      `${this.#organizationId}:${this.#eventId}:${command.commandId}`,
      40,
    );
    const safeDiff = {
      commandId: command.commandId,
      fromStatus: submission.status,
      ...(command.type === "add_note"
        ? { noteId, noteLength: command.body.length }
        : { reason: command.reason }),
      submissionId: command.submissionId,
      toStatus: nextStatus,
    };
    const submissionOperation: BaseAuthorityCommand = {
      audit: {
        action: `organizer.submission.${command.type}`,
        actorId: this.#actorId,
        actorType: this.#actorType,
        eventId: this.#eventId,
        requestId: this.#requestId,
        safeDiff,
      },
      commandId: await stableId(
        "submission_command",
        `${command.commandId}:submission`,
      ),
      entityId: command.submissionId,
      expectedVersion: command.expectedVersion,
      fields: {
        "Organizer activity at": appliedAt,
        Status: nextStatus,
      },
      operation: `organizer.submission.${command.type}.submissions`,
      organizationId: this.#organizationId,
      table: "submissions",
    };
    if (command.type !== "add_note") return [submissionOperation];
    return [
      submissionOperation,
      {
        audit: {
          ...submissionOperation.audit,
          action: "organizer.submission.note.persist",
          safeDiff: {
            noteId,
            noteLength: command.body.length,
            submissionId: command.submissionId,
          },
        },
        commandId: await stableId(
          "submission_command",
          `${command.commandId}:note`,
        ),
        entityId: noteId,
        expectedVersion: 0,
        fields: {
          "Actor ID": this.#actorId,
          "Actor display name": this.#actorDisplayName,
          Body: command.body,
          Submission: [submission.source_record_id],
        },
        operation: "organizer.submission.add_note.submission_notes",
        organizationId: this.#organizationId,
        table: "submission_notes",
      },
    ];
  }
}
