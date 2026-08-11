import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  UploadFinalizeResponse,
  UploadIntentResponse,
} from "@sessionbox-killer/contracts";
import { readinessDashboardQuerySchema } from "@sessionbox-killer/contracts/readiness";
import type { TaskDefinitionDraft } from "@sessionbox-killer/contracts/tasks";
import { sha256Hex } from "../src/auth/crypto";
import type { AuthenticatedSession } from "../src/auth/service";
import {
  AuthorityOutcomeUnknownError,
  parseBaseAuthorityCommand,
  type AuthorityResponse,
  type BaseAuthorityCommand,
} from "../src/authority/types";
import {
  TaskAuthorityPendingError,
  TaskAuthorityService,
  TaskIdempotencyConflictError,
  TaskVersionConflictError,
  verifyTaskDownloadReceipt,
  type TaskCommandActor,
  type TaskEventScope,
} from "../src/tasks/service";
import { UploadService } from "../src/uploads/service";
import type { UploadError } from "../src/uploads/service";
import { D1ScheduleProjectionRepository } from "../src/schedule/d1-repository";
import { ReadinessDashboardService } from "../src/readiness/service";

const now = "2026-08-10T18:00:00.000Z";
const contentHash = "a".repeat(64);
const authPepper = "task-readiness-test-pepper-with-at-least-32-characters";
const sessionToken = `task-readiness-session-${"s".repeat(36)}`;
const speakerSessionToken = `task-speaker-session-${"p".repeat(36)}`;
const server = createTestHarness({
  workers: [
    {
      configPath: "workers/app/wrangler.jsonc",
      secrets: { AUTH_HASH_PEPPER: authPepper },
    },
  ],
});

const event: TaskEventScope = {
  eventId: "evt_tasks",
  eventRecordId: "rec_event_tasks",
  organizationId: "org_tasks",
  slug: "task-summit",
  timezone: "America/Los_Angeles",
};
const organizer: TaskCommandActor = {
  actorId: "usr_organizer",
  auditActorType: "user",
  domainActorType: "organizer",
};
const speaker: TaskCommandActor = {
  actorId: "contact_speaker",
  auditActorType: "portal",
  domainActorType: "speaker",
};

function sql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function targetPolicy(scope: "contact" | "session"): string {
  return JSON.stringify({
    due: null,
    schema_version: 1,
    target: {
      assignment_scope: scope,
      contact: {
        exclude_contact_ids: [],
        include_contact_ids: [],
        roles: ["speaker"],
      },
      session:
        scope === "session"
          ? {
              format_ids: [],
              include_session_ids: [],
              participant_roles: ["speaker"],
              track_ids: [],
            }
          : null,
    },
  });
}

async function seedReadyTaskFile(options: {
  byteSize?: number;
  id: string;
  lineageId: string;
  replacesFileId?: string;
  version: number;
}): Promise<void> {
  await database.batch([
    database
      .prepare(
        `INSERT INTO file_objects (
           id, organization_id, event_id, owner_contact_id, object_key,
           display_filename, declared_mime_type, detected_mime_type,
           byte_size, checksum_sha256, status, created_at, finalized_at,
           purpose, lineage_id, version_number, replaces_file_id,
           r2_version, r2_etag, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'application/pdf',
                   'application/pdf', ?7, ?8, 'ready', ?9, ?9, 'slides',
                   ?10, ?11, ?12, ?13, ?14, ?9)`,
      )
      .bind(
        options.id,
        event.organizationId,
        event.eventId,
        speaker.actorId,
        `private/${options.id}`,
        `slides-v${options.version}.pdf`,
        options.byteSize ?? 1_024,
        String(options.version).repeat(64).slice(0, 64),
        now,
        options.lineageId,
        options.version,
        options.replacesFileId ?? null,
        `r2-version-${options.version}`,
        `etag-${options.version}`,
      ),
    database
      .prepare(
        `INSERT INTO file_upload_intents (
           id, file_object_id, token_hash, status, expires_at, cleanup_after,
           attempts, created_at, updated_at, uploaded_at, finalized_at
         ) VALUES (?1, ?2, ?3, 'finalized', '2099-01-01T00:00:00.000Z',
                   '2099-01-02T00:00:00.000Z', 1, ?4, ?4, ?4, ?4)`,
      )
      .bind(
        `intent_${options.id}`,
        options.id,
        String(options.version + 4)
          .repeat(64)
          .slice(0, 64),
        now,
      ),
  ]);
}

async function sha256Bytes(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function uploadPdf(
  filename: string,
  body: ArrayBuffer,
  replacesFileId?: string,
): Promise<UploadFinalizeResponse> {
  const checksum = await sha256Bytes(body);
  const authenticationHeaders = {
    Cookie: `__Host-opensession-session=${speakerSessionToken}`,
    Origin: origin,
    "Sec-Fetch-Site": "same-origin",
    "X-CSRF-Token": "task-speaker-csrf",
  };
  const intentResponse = await server.fetch("/api/uploads/intents", {
    body: JSON.stringify({
      byte_size: body.byteLength,
      checksum_sha256: checksum,
      content_type: "application/pdf",
      event_id: event.eventId,
      filename,
      organization_id: event.organizationId,
      owner_contact_id: "contact_speaker",
      purpose: "slides",
      ...(replacesFileId ? { replaces_file_id: replacesFileId } : {}),
    }),
    headers: { ...authenticationHeaders, "Content-Type": "application/json" },
    method: "POST",
  });
  if (intentResponse.status !== 201) {
    throw new Error(`Upload intent failed: ${await intentResponse.text()}`);
  }
  const intent = (await intentResponse.json()) as UploadIntentResponse;
  const stored = await server.fetch(intent.upload.url, {
    body,
    headers: {
      ...intent.upload.headers,
      "Content-Length": String(body.byteLength),
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
    },
    method: "PUT",
  });
  if (stored.status !== 201) {
    throw new Error(`Upload storage failed: ${await stored.text()}`);
  }
  const finalized = await server.fetch(
    `/api/uploads/${intent.file.id}/finalize`,
    {
      headers: { ...authenticationHeaders, "Content-Type": "application/json" },
      method: "POST",
    },
  );
  if (!finalized.ok) {
    throw new Error(`Upload finalize failed: ${await finalized.text()}`);
  }
  return (await finalized.json()) as UploadFinalizeResponse;
}

function definitionDraft(
  id: string,
  scope: "contact" | "session",
): TaskDefinitionDraft {
  return {
    approval_required: id === "def_slides",
    configuration:
      id === "def_slides"
        ? {
            extensions: ["pdf"],
            kind: "file",
            max_bytes: 20_000_000,
            max_files: 1,
            private: true,
          }
        : { acknowledgement_label: "I acknowledge", kind: "ack" },
    description:
      id === "def_slides" ? "Upload final slides." : "Confirm profile.",
    due: null,
    id,
    name: id === "def_slides" ? "Final slides" : "Confirm profile",
    required: true,
    target: {
      assignment_scope: scope,
      contact: {
        exclude_contact_ids: [],
        include_contact_ids: [],
        roles: ["speaker"],
      },
      session:
        scope === "session"
          ? {
              format_ids: [],
              include_session_ids: [],
              participant_roles: ["speaker"],
              track_ids: [],
            }
          : null,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Expected an authority field object.");
  }
  return value as Record<string, unknown>;
}

function stringField(fields: Record<string, unknown>, name: string): string {
  const value = fields[name];
  if (typeof value !== "string") throw new TypeError(`${name} is not text.`);
  return value;
}

function optionalStringField(
  fields: Record<string, unknown>,
  name: string,
): string | null {
  const value = fields[name];
  if (value === null) return null;
  if (typeof value !== "string") throw new TypeError(`${name} is not text.`);
  return value;
}

function booleanField(fields: Record<string, unknown>, name: string): number {
  const value = fields[name];
  if (typeof value !== "boolean") {
    throw new TypeError(`${name} is not boolean.`);
  }
  return value ? 1 : 0;
}

function linkedRecord(
  fields: Record<string, unknown>,
  name: string,
): string | null {
  const value = fields[name];
  if (!Array.isArray(value)) throw new TypeError(`${name} is not a link.`);
  const first = value[0];
  if (first === undefined) return null;
  if (typeof first !== "string") throw new TypeError(`${name} is not a link.`);
  return first;
}

class ProjectingAuthority {
  readonly captured: BaseAuthorityCommand[] = [];
  readonly #database: D1Database;
  readonly #responses = new Map<string, AuthorityResponse>();
  #repairNext = false;
  #unknownAfterCommitNext = false;
  #repairCommand: BaseAuthorityCommand | null = null;

  constructor(database: D1Database) {
    this.#database = database;
  }

  returnRepairPendingOnce(): void {
    this.#repairNext = true;
  }

  returnOutcomeUnknownAfterCommitOnce(): void {
    this.#unknownAfterCommitNext = true;
  }

  async repairProjection(): Promise<void> {
    if (!this.#repairCommand)
      throw new Error("No task projection needs repair.");
    await this.#project(this.#repairCommand);
    this.#repairCommand = null;
  }

  async execute(value: unknown): Promise<AuthorityResponse> {
    const command = parseBaseAuthorityCommand(value);
    this.captured.push(command);
    const replay = this.#responses.get(command.commandId);
    if (replay) {
      return {
        ...replay,
        authority: { ...replay.authority, replayed: true },
      };
    }

    const response: AuthorityResponse = {
      authority: {
        entityId: command.entityId,
        fields: { ...command.fields },
        recordId: `rec_${command.table}_${command.entityId}`,
        replayed: false,
        sourceVersion: command.expectedVersion + 1,
      },
      commandId: command.commandId,
      projection: this.#repairNext ? "repair_pending" : "durable",
      status: this.#repairNext ? "committed_with_repair" : "committed",
    };
    this.#responses.set(command.commandId, response);
    await this.#database
      .prepare(
        `INSERT OR IGNORE INTO idempotency_keys (
           tenant_key, operation, command_id, request_hash, status,
           entity_type, entity_id, original_response_status,
           original_response_json, created_at, updated_at, expires_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 200, ?8, ?9, ?9, ?10)`,
      )
      .bind(
        command.organizationId,
        command.operation,
        command.commandId,
        "b".repeat(64),
        response.status,
        command.table,
        command.entityId,
        JSON.stringify(response),
        now,
        "2099-01-01T00:00:00.000Z",
      )
      .run();

    if (this.#repairNext) {
      this.#repairNext = false;
      this.#repairCommand = command;
      return response;
    }

    await this.#project(command);
    if (this.#unknownAfterCommitNext) {
      this.#unknownAfterCommitNext = false;
      throw new AuthorityOutcomeUnknownError(command.commandId);
    }
    return response;
  }

  async #idForRecord(table: string, recordId: string): Promise<string> {
    const row = await this.#database
      .prepare(`SELECT id FROM ${table} WHERE source_record_id = ?1 LIMIT 1`)
      .bind(recordId)
      .first<{ id: string }>();
    if (!row) throw new Error(`Projection link ${recordId} is missing.`);
    return row.id;
  }

  async #project(command: BaseAuthorityCommand): Promise<void> {
    const fields = asRecord(command.fields);
    if (command.table === "task_definitions") {
      const eventRecord = linkedRecord(fields, "Event");
      if (!eventRecord) throw new Error("Task definition event is missing.");
      const eventId = await this.#idForRecord("p_events", eventRecord);
      await this.#database
        .prepare(
          `INSERT OR REPLACE INTO p_task_definitions (
             id, organization_id, event_id, name, type, description,
             required_default, approval_required, target_rule_json,
             form_schema_json, file_policy_json, source_record_id,
             source_version, source_content_hash, projected_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                     ?13, ?14, ?15)`,
        )
        .bind(
          command.entityId,
          command.organizationId,
          eventId,
          stringField(fields, "Name"),
          stringField(fields, "Type"),
          stringField(fields, "Description"),
          booleanField(fields, "Required default"),
          booleanField(fields, "Approval required"),
          stringField(fields, "Target rule JSON"),
          stringField(fields, "Form schema JSON"),
          stringField(fields, "File policy JSON"),
          `rec_task_definitions_${command.entityId}`,
          command.expectedVersion + 1,
          contentHash,
          now,
        )
        .run();
      return;
    }
    if (command.table !== "task_assignments") return;
    if (command.operation === "tasks.assignment.materialize") {
      const contactRecord = linkedRecord(fields, "Contact");
      const definitionRecord = linkedRecord(fields, "Definition");
      const eventRecord = linkedRecord(fields, "Event");
      if (!contactRecord || !definitionRecord || !eventRecord) {
        throw new Error("Task materialization links are incomplete.");
      }
      const [contactId, definitionId, eventId] = await Promise.all([
        this.#idForRecord("p_contacts", contactRecord),
        this.#idForRecord("p_task_definitions", definitionRecord),
        this.#idForRecord("p_events", eventRecord),
      ]);
      const sessionRecord = linkedRecord(fields, "Session");
      const sessionId = sessionRecord
        ? await this.#idForRecord("p_sessions", sessionRecord)
        : null;
      await this.#database
        .prepare(
          `INSERT OR REPLACE INTO p_task_assignments (
             id, organization_id, event_id, definition_id, contact_id,
             session_id, due_at, required, status, completed_at, approved_at,
             response_json, file_object_ids_json, updated_at, source_record_id,
             source_version, source_content_hash, projected_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                     ?13, ?14, ?15, ?16, ?17, ?14)`,
        )
        .bind(
          command.entityId,
          command.organizationId,
          eventId,
          definitionId,
          contactId,
          sessionId,
          optionalStringField(fields, "Due UTC"),
          booleanField(fields, "Required"),
          stringField(fields, "Status"),
          optionalStringField(fields, "Completed at"),
          optionalStringField(fields, "Approved at"),
          stringField(fields, "Response JSON"),
          stringField(fields, "File object IDs JSON"),
          now,
          `rec_task_assignments_${command.entityId}`,
          command.expectedVersion + 1,
          contentHash,
        )
        .run();
      return;
    }
    if (
      command.operation === "tasks.assignment.transition" ||
      command.operation === "tasks.assignment.submit" ||
      command.operation === "tasks.assignment.review"
    ) {
      const fileIds = fields["File object IDs JSON"];
      await this.#database
        .prepare(
          `UPDATE p_task_assignments
           SET status = ?3, completed_at = ?4, approved_at = ?5,
               response_json = ?6,
               file_object_ids_json = COALESCE(?7, file_object_ids_json),
               source_version = ?8, projected_at = ?9, updated_at = ?9
           WHERE organization_id = ?1 AND id = ?2`,
        )
        .bind(
          command.organizationId,
          command.entityId,
          stringField(fields, "Status"),
          optionalStringField(fields, "Completed at"),
          optionalStringField(fields, "Approved at"),
          stringField(fields, "Response JSON"),
          typeof fileIds === "string" ? fileIds : null,
          command.expectedVersion + 1,
          now,
        )
        .run();
      await this.#database
        .prepare(
          `INSERT OR REPLACE INTO audit_events (
             id, organization_id, event_id, actor_type, actor_id, action,
             entity_type, entity_id, request_id, command_id,
             redaction_version, safe_diff_json, metadata_json, created_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'task_assignments', ?7, ?8,
                     ?9, 1, ?10, '{}', ?11)`,
        )
        .bind(
          `aud_mock_${command.commandId}`,
          command.organizationId,
          command.audit.eventId ?? null,
          command.audit.actorType,
          command.audit.actorId ?? null,
          command.audit.action,
          command.entityId,
          command.audit.requestId,
          command.commandId,
          JSON.stringify(command.audit.safeDiff),
          now,
        )
        .run();
    }
  }
}

let database: D1Database;
let uploadBucket: R2Bucket;
let authority: ProjectingAuthority;
let tasks: TaskAuthorityService;
let origin = "";

beforeAll(async () => {
  origin = (await server.listen()).url.origin;
  const worker = server.getWorker<Env>();
  await worker.applyD1Migrations("DB");
  const environment = await worker.getEnv();
  database = environment.DB;
  uploadBucket = environment.UPLOADS;
  const tokenHash = await sha256Hex(sessionToken);
  const speakerTokenHash = await sha256Hex(speakerSessionToken);
  const csrfHash = await sha256Hex("task-readiness-csrf");
  const speakerCsrfHash = await sha256Hex("task-speaker-csrf");
  const seedSql = `
    INSERT INTO tenant_registry
      (organization_id, base_key, source_record_id, created_at, updated_at,
       authority_ready_at)
    VALUES
      ('org_tasks', 'base_tasks', 'rec_org_tasks', ${sql(now)}, ${sql(now)}, ${sql(now)}),
      ('org_foreign', 'base_foreign', 'rec_org_foreign', ${sql(now)}, ${sql(now)}, ${sql(now)});

    INSERT INTO users
      (id, email_normalized, display_name, created_at, updated_at)
    VALUES
      ('usr_organizer', 'organizer@example.test', 'Olivia Organizer',
       ${sql(now)}, ${sql(now)}),
      ('usr_speaker', 'speaker@example.test', 'Sam Speaker',
       ${sql(now)}, ${sql(now)});

    INSERT INTO organization_memberships
      (id, organization_id, user_id, role, created_at, updated_at)
    VALUES
      ('membership_organizer', 'org_tasks', 'usr_organizer', 'owner',
       ${sql(now)}, ${sql(now)});

    INSERT INTO auth_sessions
      (id, user_id, token_hash, created_at, expires_at, last_seen_at)
    VALUES
      ('auth_task_readiness', 'usr_organizer', ${sql(tokenHash)}, ${sql(now)},
       '2099-01-01T00:00:00.000Z', ${sql(now)}),
      ('auth_task_speaker', 'usr_speaker', ${sql(speakerTokenHash)}, ${sql(now)},
       '2099-01-01T00:00:00.000Z', ${sql(now)});

    INSERT INTO auth_session_secrets
      (session_id, csrf_token_hash, created_at)
    VALUES
      ('auth_task_readiness', ${sql(csrfHash)}, ${sql(now)}),
      ('auth_task_speaker', ${sql(speakerCsrfHash)}, ${sql(now)});

    INSERT INTO p_events
      (id, organization_id, name, slug, timezone, status, brand_json,
       source_record_id, source_version, source_content_hash, projected_at)
    VALUES
      ('evt_tasks', 'org_tasks', 'Task Summit', 'task-summit',
       'America/Los_Angeles', 'open', '{}', 'rec_event_tasks', 1,
       ${sql(contentHash)}, ${sql(now)}),
      ('evt_foreign', 'org_foreign', 'Foreign Summit', 'foreign-summit',
       'UTC', 'open', '{}', 'rec_event_foreign', 1, ${sql(contentHash)}, ${sql(now)});

    INSERT INTO p_contacts
      (id, organization_id, email_normalized, display_name, source_record_id,
       source_version, source_content_hash, projected_at)
    VALUES
      ('contact_speaker', 'org_tasks', 'speaker@example.test', 'Sam Speaker',
       'rec_contact_speaker', 1, ${sql(contentHash)}, ${sql(now)}),
      ('contact_foreign', 'org_foreign', 'foreign@example.test', 'Fern Foreign',
       'rec_contact_foreign', 1, ${sql(contentHash)}, ${sql(now)});

    INSERT INTO p_event_contacts
      (id, organization_id, event_id, contact_id, roles_json, portal_state,
       source_record_id, source_version, source_content_hash, projected_at)
    VALUES
      ('event_contact_speaker', 'org_tasks', 'evt_tasks', 'contact_speaker',
       '["speaker"]', 'active', 'rec_event_contact_speaker', 1,
       ${sql(contentHash)}, ${sql(now)}),
      ('event_contact_foreign', 'org_foreign', 'evt_foreign', 'contact_foreign',
       '["speaker"]', 'active', 'rec_event_contact_foreign', 1,
       ${sql(contentHash)}, ${sql(now)});

    INSERT INTO p_sessions
      (id, organization_id, event_id, friendly_id, title, status, updated_at,
       source_record_id, source_version, source_content_hash, projected_at)
    VALUES
      ('session_alpha', 'org_tasks', 'evt_tasks', 'TASK-1', 'Alpha', 'accepted',
       ${sql(now)}, 'rec_session_alpha', 1, ${sql(contentHash)}, ${sql(now)}),
      ('session_beta', 'org_tasks', 'evt_tasks', 'TASK-2', 'Beta', 'scheduled',
       ${sql(now)}, 'rec_session_beta', 1, ${sql(contentHash)}, ${sql(now)}),
      ('session_gamma', 'org_tasks', 'evt_tasks', 'TASK-3', 'Gamma', 'published',
       ${sql(now)}, 'rec_session_gamma', 1, ${sql(contentHash)}, ${sql(now)});

    INSERT INTO p_session_participants
      (id, organization_id, event_id, session_id, contact_id, role, sort_order,
       confirmed_state, source_record_id, source_version, source_content_hash,
       projected_at)
    VALUES
      ('part_alpha', 'org_tasks', 'evt_tasks', 'session_alpha', 'contact_speaker',
       'speaker', 1, 'confirmed', 'rec_part_alpha', 1, ${sql(contentHash)}, ${sql(now)}),
      ('part_beta', 'org_tasks', 'evt_tasks', 'session_beta', 'contact_speaker',
       'speaker', 1, 'confirmed', 'rec_part_beta', 1, ${sql(contentHash)}, ${sql(now)}),
      ('part_gamma', 'org_tasks', 'evt_tasks', 'session_gamma', 'contact_speaker',
       'speaker', 1, 'confirmed', 'rec_part_gamma', 1, ${sql(contentHash)}, ${sql(now)});

    INSERT INTO p_task_definitions
      (id, organization_id, event_id, name, type, description,
       required_default, approval_required, target_rule_json, form_schema_json,
       file_policy_json, source_record_id, source_version, source_content_hash,
       projected_at)
    VALUES
      ('def_profile', 'org_tasks', 'evt_tasks', 'Confirm profile', 'ack',
       'Confirm public profile.', 1, 0, ${sql(targetPolicy("contact"))},
       '{"acknowledgement_label":"I acknowledge","kind":"ack"}', '{}',
       'rec_def_profile', 1, ${sql(contentHash)}, ${sql(now)}),
      ('def_slides', 'org_tasks', 'evt_tasks', 'Final slides', 'file',
       'Upload final slides.', 1, 1, ${sql(targetPolicy("session"))}, '{}',
       '{"extensions":["pdf"],"kind":"file","max_bytes":20000000,"max_files":1,"private":true}',
       'rec_def_slides', 1, ${sql(contentHash)}, ${sql(now)});
  `;
  await database.exec(
    seedSql
      .split(";")
      .map((statement) => statement.replaceAll(/\s+/g, " ").trim())
      .filter(Boolean)
      .map((statement) => `${statement};`)
      .join("\n"),
  );
  authority = new ProjectingAuthority(database);
  tasks = new TaskAuthorityService({
    authority,
    database,
    downloadReceiptSecret: authPepper,
    now: () => new Date(now),
  });
});

afterAll(async () => {
  await server.close();
});

describe("task/readiness Workerd behavior", () => {
  it("matches contact and session targets within the selected event", async () => {
    const contact = await tasks.previewBackfill(event, {
      definition: definitionDraft("def_profile", "contact"),
      expected_version: 1,
    });
    const session = await tasks.previewBackfill(event, {
      definition: definitionDraft("def_slides", "session"),
      expected_version: 1,
    });

    expect(contact.create).toHaveLength(1);
    expect(contact.create[0]).toMatchObject({
      contact_id: "contact_speaker",
      event_id: "evt_tasks",
      session_id: null,
    });
    expect(session.create.map(({ session_id }) => session_id)).toEqual([
      "session_alpha",
      "session_beta",
      "session_gamma",
    ]);
    expect(JSON.stringify([contact, session])).not.toContain("evt_foreign");
  });

  it("materializes once at the acceptance boundary and rejects payload drift", async () => {
    const command = {
      acceptance_id: "accept_alpha",
      command_id: "cmd_materialize_alpha",
      session_ids: ["session_alpha"],
      type: "materialize_acceptance" as const,
    };
    const first = await tasks.materializeAcceptance(
      event,
      command,
      organizer,
      "req_materialize_alpha",
    );
    const replay = await tasks.materializeAcceptance(
      event,
      command,
      organizer,
      "req_materialize_alpha_replay",
    );

    expect(first).toMatchObject({
      ok: true,
      repair_pending: false,
      replayed: false,
      result: { boundary_id: "accept_alpha", created_count: 2 },
    });
    expect(replay).toMatchObject({ ok: true, replayed: true });
    expect(await tasks.reads().assignments(event)).toHaveLength(2);
    await expect(
      tasks.materializeAcceptance(
        event,
        { ...command, session_ids: ["session_beta"] },
        organizer,
        "req_materialize_alpha_conflict",
      ),
    ).rejects.toBeInstanceOf(TaskIdempotencyConflictError);
  });

  it("keeps submission outstanding and becomes ready only after approval", async () => {
    const assignments = await tasks.reads().assignments(event);
    const profile = assignments.find(
      ({ definition_id }) => definition_id === "def_profile",
    );
    const slides = assignments.find(
      ({ definition_id }) => definition_id === "def_slides",
    );
    if (!profile || !slides)
      throw new Error("Expected task assignments are missing.");

    const initial = await tasks.reads().readiness(event);
    expect(initial.speakers[0]?.readiness).toMatchObject({
      ratio: { complete: 0, total: 2 },
      status: "outstanding",
    });

    await tasks.transitionAssignment(
      event,
      profile.assignment_id,
      {
        command_id: "cmd_profile_complete",
        expected_version: 1,
        reason: "Profile received outside the portal.",
        to: "complete",
        type: "transition_assignment",
      },
      organizer,
      "req_profile_complete",
    );
    const submitted = await tasks.transitionAssignment(
      event,
      slides.assignment_id,
      {
        command_id: "cmd_slides_submit",
        expected_version: 1,
        reason: null,
        to: "submitted",
        type: "transition_assignment",
      },
      speaker,
      "req_slides_submit",
    );
    expect(submitted).toMatchObject({
      ok: true,
      result: { state: "submitted", version: 2 },
    });
    const afterSubmission = await tasks.reads().readiness(event);
    expect(afterSubmission.speakers[0]?.readiness).toMatchObject({
      ratio: { complete: 1, total: 2 },
      status: "outstanding",
    });

    const approved = await tasks.transitionAssignment(
      event,
      slides.assignment_id,
      {
        command_id: "cmd_slides_approve",
        expected_version: 2,
        reason: "Reviewed the submitted slide deck.",
        to: "approved",
        type: "transition_assignment",
      },
      organizer,
      "req_slides_approve",
    );
    expect(approved).toMatchObject({
      ok: true,
      result: { state: "approved", version: 3 },
    });
    expect(
      (await tasks.reads().readiness(event)).speakers[0]?.readiness,
    ).toMatchObject({
      ratio: { complete: 2, percent: 100, total: 2 },
      status: "ready",
    });

    const approvalReplay = await tasks.transitionAssignment(
      event,
      slides.assignment_id,
      {
        command_id: "cmd_slides_approve",
        expected_version: 2,
        reason: "Reviewed the submitted slide deck.",
        to: "approved",
        type: "transition_assignment",
      },
      organizer,
      "req_slides_approve_replay",
    );
    expect(approvalReplay).toMatchObject({ ok: true, replayed: true });
    await expect(
      tasks.transitionAssignment(
        event,
        slides.assignment_id,
        {
          command_id: "cmd_slides_illegal",
          expected_version: 3,
          reason: null,
          to: "approved",
          type: "transition_assignment",
        },
        organizer,
        "req_slides_illegal",
      ),
    ).rejects.toMatchObject({ code: "illegal_transition" });
    await expect(
      tasks.transitionAssignment(
        event,
        profile.assignment_id,
        {
          command_id: "cmd_profile_stale",
          expected_version: 1,
          reason: null,
          to: "incomplete",
          type: "transition_assignment",
        },
        organizer,
        "req_profile_stale",
      ),
    ).rejects.toBeInstanceOf(TaskVersionConflictError);

    const transitionAudit = authority.captured.find(
      ({ commandId }) => commandId === "cmd_profile_complete",
    )?.audit.safeDiff;
    expect(transitionAudit).toEqual({
      from: "incomplete",
      reasonPresent: true,
      to: "complete",
      version: 2,
    });
    expect(JSON.stringify(transitionAudit)).not.toContain("outside the portal");
    expect(JSON.stringify(transitionAudit)).not.toContain("object");
  });

  it("atomically submits, replaces, reviews, and revokes task file receipts", async () => {
    await database
      .prepare(
        `INSERT INTO p_task_assignments (
           id, organization_id, event_id, definition_id, contact_id,
           session_id, due_at, required, status, completed_at, approved_at,
           response_json, file_object_ids_json, updated_at, source_record_id,
           source_version, source_content_hash, projected_at
         ) VALUES (?1, ?2, ?3, 'def_slides', 'contact_speaker', NULL,
                   '2026-08-09T18:00:00.000Z', 0, 'not_started', NULL, NULL,
                   ?4, '[]', ?5, ?6, 1, ?7, ?5)`,
      )
      .bind(
        "assignment_file_response",
        event.organizationId,
        event.eventId,
        JSON.stringify({
          current_response: null,
          history: [],
          response_history: [],
          schema_version: 2,
          state: "incomplete",
          version: 1,
        }),
        now,
        "rec_assignment_file_response",
        contentHash,
      )
      .run();
    await seedReadyTaskFile({
      id: "file_task_v1",
      lineageId: "file_task_v1",
      version: 1,
    });

    const firstCommand = {
      command_id: "cmd_file_response_v1",
      expected_version: 1,
      response: {
        acknowledged: true as const,
        file_ids: ["file_task_v1"],
        kind: "file" as const,
        notes: "Captions are embedded.",
      },
      type: "submit_assignment" as const,
    };
    const submitted = await tasks.submitAssignment(
      event,
      "assignment_file_response",
      firstCommand,
      speaker,
      "req_file_response_v1",
    );
    expect(submitted).toMatchObject({
      ok: true,
      replayed: false,
      result: {
        audit: { action: "tasks.assignment.submit" },
        detail: {
          assignment: { state: "submitted", version: 2 },
          overdue: false,
          response_history: [{ command_id: "cmd_file_response_v1" }],
        },
      },
    });
    const firstDetail = submitted.ok ? submitted.result.detail : null;
    const firstFile = firstDetail?.files[0];
    expect(firstFile).toMatchObject({
      id: "file_task_v1",
      status: "current",
      version: 1,
    });
    expect(firstFile?.download?.url).toContain("receipt=");
    expect(JSON.stringify(firstDetail)).not.toContain("private/file_task_v1");
    expect(JSON.stringify(firstDetail)).not.toContain("object_key");

    const replay = await tasks.submitAssignment(
      event,
      "assignment_file_response",
      firstCommand,
      speaker,
      "req_file_response_v1_replay",
    );
    expect(replay).toMatchObject({ ok: true, replayed: true });
    await expect(
      tasks.submitAssignment(
        event,
        "assignment_file_response",
        {
          ...firstCommand,
          response: { ...firstCommand.response, notes: "Payload drift" },
        },
        speaker,
        "req_file_response_v1_drift",
      ),
    ).rejects.toBeInstanceOf(TaskIdempotencyConflictError);

    await expect(
      tasks.reviewAssignment(
        event,
        "assignment_file_response",
        {
          command_id: "cmd_file_review_blank",
          decision: "approve",
          expected_version: 2,
          reason: " ",
          type: "review_assignment",
        },
        organizer,
        "req_file_review_blank",
      ),
    ).rejects.toMatchObject({ code: "reason_required" });
    const rejected = await tasks.reviewAssignment(
      event,
      "assignment_file_response",
      {
        command_id: "cmd_file_review_reject",
        decision: "reject",
        expected_version: 2,
        reason: "Please replace the draft with the captioned export.",
        type: "review_assignment",
      },
      organizer,
      "req_file_review_reject",
    );
    expect(rejected).toMatchObject({
      ok: true,
      result: { detail: { assignment: { state: "rejected", version: 3 } } },
    });

    await seedReadyTaskFile({
      id: "file_task_v2",
      lineageId: "file_task_v1",
      replacesFileId: "file_task_v1",
      version: 2,
    });
    await seedReadyTaskFile({
      id: "file_task_unrelated",
      lineageId: "file_task_unrelated",
      version: 7,
    });
    await database
      .prepare(
        `UPDATE p_task_definitions
         SET file_policy_json = ?1
         WHERE organization_id = ?2 AND event_id = ?3 AND id = 'def_slides'`,
      )
      .bind(
        JSON.stringify({
          extensions: ["pdf"],
          kind: "file",
          max_bytes: 20_000_000,
          max_files: 2,
          private: true,
        }),
        event.organizationId,
        event.eventId,
      )
      .run();
    try {
      await expect(
        tasks.submitAssignment(
          event,
          "assignment_file_response",
          {
            command_id: "cmd_file_mixed_lineage",
            expected_version: 3,
            response: {
              acknowledged: true,
              file_ids: ["file_task_v2", "file_task_unrelated"],
              kind: "file",
              notes: "One replacement plus an unrelated upload.",
            },
            type: "submit_assignment",
          },
          speaker,
          "req_file_mixed_lineage",
        ),
      ).rejects.toMatchObject({ code: "invalid_response" });
    } finally {
      await database
        .prepare(
          `UPDATE p_task_definitions
           SET file_policy_json = ?1
           WHERE organization_id = ?2 AND event_id = ?3 AND id = 'def_slides'`,
        )
        .bind(
          JSON.stringify({
            extensions: ["pdf"],
            kind: "file",
            max_bytes: 20_000_000,
            max_files: 1,
            private: true,
          }),
          event.organizationId,
          event.eventId,
        )
        .run();
    }
    await expect(
      tasks.submitAssignment(
        event,
        "assignment_file_response",
        {
          command_id: "cmd_file_duplicate_old",
          expected_version: 3,
          response: firstCommand.response,
          type: "submit_assignment",
        },
        speaker,
        "req_file_duplicate_old",
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
    const replacement = await tasks.submitAssignment(
      event,
      "assignment_file_response",
      {
        command_id: "cmd_file_response_v2",
        expected_version: 3,
        response: {
          acknowledged: true,
          file_ids: ["file_task_v2"],
          kind: "file",
          notes: "Captioned final export.",
        },
        type: "submit_assignment",
      },
      speaker,
      "req_file_response_v2",
    );
    expect(replacement).toMatchObject({
      ok: true,
      result: {
        detail: {
          assignment: { state: "submitted", version: 4 },
          files: [
            { id: "file_task_v2", status: "current", version: 2 },
            { id: "file_task_v1", status: "replaced", version: 1 },
          ],
        },
      },
    });
    expect(
      await tasks
        .reads()
        .fileIsCurrent(event, "assignment_file_response", "file_task_v1"),
    ).toBe(false);
    expect(
      await tasks
        .reads()
        .fileIsCurrent(event, "assignment_file_response", "file_task_v2"),
    ).toBe(true);

    await seedReadyTaskFile({
      id: "file_task_v3",
      lineageId: "file_task_v1",
      replacesFileId: "file_task_v2",
      version: 3,
    });
    await expect(
      tasks.reviewAssignment(
        event,
        "assignment_file_response",
        {
          command_id: "cmd_file_review_obsolete",
          decision: "approve",
          expected_version: 4,
          reason: "This decision raced with a newer finalized file.",
          type: "review_assignment",
        },
        organizer,
        "req_file_review_obsolete",
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
    const latest = await tasks.submitAssignment(
      event,
      "assignment_file_response",
      {
        command_id: "cmd_file_response_v3",
        expected_version: 4,
        response: {
          acknowledged: true,
          file_ids: ["file_task_v3"],
          kind: "file",
          notes: "Final show-day export.",
        },
        type: "submit_assignment",
      },
      speaker,
      "req_file_response_v3",
    );
    expect(latest).toMatchObject({
      ok: true,
      result: {
        detail: {
          assignment: { state: "submitted", version: 5 },
          files: expect.arrayContaining([
            expect.objectContaining({
              id: "file_task_v3",
              status: "current",
              version: 3,
            }),
          ]),
        },
      },
    });

    const approved = await tasks.reviewAssignment(
      event,
      "assignment_file_response",
      {
        command_id: "cmd_file_review_approve",
        decision: "approve",
        expected_version: 5,
        reason: "Verified captions, fonts, and show-day compatibility.",
        type: "review_assignment",
      },
      organizer,
      "req_file_review_approve",
    );
    expect(approved).toMatchObject({
      ok: true,
      result: {
        audit: { action: "tasks.assignment.review" },
        detail: { assignment: { state: "approved", version: 6 } },
      },
    });
    await expect(
      tasks.reviewAssignment(
        event,
        "assignment_file_response",
        {
          command_id: "cmd_file_review_stale",
          decision: "reject",
          expected_version: 5,
          reason: "Stale concurrent decision.",
          type: "review_assignment",
        },
        organizer,
        "req_file_review_stale",
      ),
    ).rejects.toBeInstanceOf(TaskVersionConflictError);

    const receiptUrl = firstFile?.download?.url;
    if (!receiptUrl) throw new Error("The first download receipt is missing.");
    const receipt = new URL(
      receiptUrl,
      "https://opensession.test",
    ).searchParams.get("receipt");
    if (!receipt) throw new Error("The receipt token is missing.");
    await expect(
      verifyTaskDownloadReceipt(
        authPepper,
        event,
        "assignment_file_response",
        "file_task_v1",
        receipt,
        new Date("2026-08-10T18:06:00.000Z"),
      ),
    ).resolves.toBe("expired");
    await expect(
      verifyTaskDownloadReceipt(
        authPepper,
        { ...event, eventId: "evt_foreign" },
        "assignment_file_response",
        "file_task_v1",
        receipt,
        new Date("2026-08-10T18:01:00.000Z"),
      ),
    ).resolves.toBe("invalid");
  });

  it("completes the real R2 upload, replacement, approval, and old-file denial path", async () => {
    const session: AuthenticatedSession = {
      csrfTokenHash: "c".repeat(64),
      expiresAt: "2099-01-01T00:00:00.000Z",
      id: "auth_task_speaker",
      tokenHash: "d".repeat(64),
      user: {
        displayName: "Sam Speaker",
        email: "speaker@example.test",
        id: "usr_speaker",
      },
    };
    const uploads = new UploadService({
      bucket: uploadBucket,
      database,
      now: () => new Date(now),
      tokenFactory: () => `task-upload-token-${crypto.randomUUID()}`,
    });
    await database
      .prepare(
        `INSERT INTO p_sessions (
           id, organization_id, event_id, friendly_id, title, status,
           updated_at, source_record_id, source_version, source_content_hash,
           projected_at
         ) VALUES ('session_r2_demo', ?1, ?2, 'TASK-R2', 'R2 demo',
                   'scheduled', ?3, 'rec_session_r2_demo', 1, ?4, ?3)`,
      )
      .bind(event.organizationId, event.eventId, now, contentHash)
      .run();
    await database
      .prepare(
        `INSERT INTO p_task_assignments (
           id, organization_id, event_id, definition_id, contact_id,
           session_id, due_at, required, status, completed_at, approved_at,
           response_json, file_object_ids_json, updated_at, source_record_id,
           source_version, source_content_hash, projected_at
         ) VALUES (?1, ?2, ?3, 'def_slides', 'contact_speaker', 'session_r2_demo',
                   NULL, 1, 'not_started', NULL, NULL, ?4, '[]', ?5, ?6, 1,
                   ?7, ?5)`,
      )
      .bind(
        "assignment_r2_demo",
        event.organizationId,
        event.eventId,
        JSON.stringify({
          current_response: null,
          history: [],
          response_history: [],
          schema_version: 2,
          state: "incomplete",
          submission_receipts: [],
          version: 1,
        }),
        now,
        "rec_assignment_r2_demo",
        contentHash,
      )
      .run();

    const first = await uploadPdf(
      "architecture-v1.pdf",
      new TextEncoder().encode("%PDF-1.7\nOpenSession version one\n%%EOF")
        .buffer as ArrayBuffer,
    );
    const submitted = await tasks.submitAssignment(
      event,
      "assignment_r2_demo",
      {
        command_id: "cmd_r2_demo_submit_v1",
        expected_version: 1,
        response: {
          acknowledged: true,
          file_ids: [first.id],
          kind: "file",
          notes: "Initial slides.",
        },
        type: "submit_assignment",
      },
      speaker,
      "req_r2_demo_submit_v1",
    );
    expect(submitted).toMatchObject({
      ok: true,
      result: {
        detail: {
          assignment: { state: "submitted", version: 2 },
          files: [{ id: first.id, status: "current", version: 1 }],
        },
      },
    });

    const replacement = await uploadPdf(
      "architecture-v2.pdf",
      new TextEncoder().encode("%PDF-1.7\nOpenSession version two\n%%EOF")
        .buffer as ArrayBuffer,
      first.id,
    );
    expect(replacement.version).toBe(2);
    await expect(uploads.download(session, first.id)).rejects.toMatchObject({
      code: "file_not_found",
    } satisfies Partial<UploadError>);

    const replaced = await tasks.submitAssignment(
      event,
      "assignment_r2_demo",
      {
        command_id: "cmd_r2_demo_submit_v2",
        expected_version: 2,
        response: {
          acknowledged: true,
          file_ids: [replacement.id],
          kind: "file",
          notes: "Final slides.",
        },
        type: "submit_assignment",
      },
      speaker,
      "req_r2_demo_submit_v2",
    );
    expect(replaced).toMatchObject({
      ok: true,
      result: {
        detail: {
          files: [
            { id: replacement.id, status: "current", version: 2 },
            { id: first.id, status: "replaced", version: 1 },
          ],
        },
      },
    });
    const approved = await tasks.reviewAssignment(
      event,
      "assignment_r2_demo",
      {
        command_id: "cmd_r2_demo_approve",
        decision: "approve",
        expected_version: 3,
        reason: "Verified the final deck and show-day compatibility.",
        type: "review_assignment",
      },
      organizer,
      "req_r2_demo_approve",
    );
    expect(approved).toMatchObject({
      ok: true,
      result: {
        audit: { action: "tasks.assignment.review" },
        detail: { assignment: { state: "approved", version: 4 } },
      },
    });
    expect(
      await tasks.reads().fileIsCurrent(event, "assignment_r2_demo", first.id),
    ).toBe(false);
    const currentDownload = await uploads.download(session, replacement.id);
    await expect(new Response(currentDownload.body).text()).resolves.toContain(
      "OpenSession version two",
    );
  });

  it("resumes an outcome-unknown materialization without duplicate assignments", async () => {
    authority.returnOutcomeUnknownAfterCommitOnce();
    const command = {
      acceptance_id: "accept_beta",
      command_id: "cmd_materialize_beta",
      session_ids: ["session_beta"],
      type: "materialize_acceptance" as const,
    };
    await expect(
      tasks.materializeAcceptance(
        event,
        command,
        organizer,
        "req_materialize_beta",
      ),
    ).rejects.toBeInstanceOf(TaskAuthorityPendingError);
    const receipt = await database
      .prepare(
        `SELECT status FROM idempotency_keys
         WHERE tenant_key = ?1 AND operation = 'tasks.materialize.plan'
           AND command_id = ?2`,
      )
      .bind(event.organizationId, command.command_id)
      .first<{ status: string }>();
    expect(receipt?.status).toBe("unknown");

    const resumed = await tasks.materializeAcceptance(
      event,
      command,
      organizer,
      "req_materialize_beta_resume",
    );
    expect(resumed).toMatchObject({ ok: true, replayed: true });
    const betaAssignments = (await tasks.reads().assignments(event)).filter(
      ({ session_id }) => session_id === "session_beta",
    );
    expect(betaAssignments).toHaveLength(1);
  });

  it("keeps task mutation receipts explicit until a pending projection is repaired", async () => {
    await database
      .prepare(
        `INSERT INTO p_task_assignments (
           id, organization_id, event_id, definition_id, contact_id,
           session_id, due_at, required, status, completed_at, approved_at,
           response_json, file_object_ids_json, updated_at, source_record_id,
           source_version, source_content_hash, projected_at
         ) VALUES (?1, ?2, ?3, 'def_profile', 'contact_speaker', 'session_alpha',
                   NULL, 0, 'not_started', NULL, NULL, ?4, '[]', ?5, ?6, 1,
                   ?7, ?5)`,
      )
      .bind(
        "assignment_submit_repair",
        event.organizationId,
        event.eventId,
        JSON.stringify({
          current_response: null,
          history: [],
          response_history: [],
          schema_version: 2,
          state: "incomplete",
          submission_receipts: [],
          version: 1,
        }),
        now,
        "rec_assignment_submit_repair",
        contentHash,
      )
      .run();
    const command = {
      command_id: "cmd_submit_repair",
      expected_version: 1,
      response: { acknowledged: true as const, kind: "ack" as const },
      type: "submit_assignment" as const,
    };

    authority.returnRepairPendingOnce();
    const pending = await tasks.submitAssignment(
      event,
      "assignment_submit_repair",
      command,
      speaker,
      "req_submit_repair",
    );
    expect(pending).toMatchObject({
      ok: true,
      repair_pending: true,
      replayed: false,
      result: {
        audit: { action: "tasks.assignment.submit" },
        detail: {
          assignment: { state: "incomplete", version: 1 },
          current_response: null,
        },
      },
    });

    const pendingReplay = await tasks.submitAssignment(
      event,
      "assignment_submit_repair",
      command,
      speaker,
      "req_submit_repair_before_projection",
    );
    expect(pendingReplay).toMatchObject({
      ok: true,
      repair_pending: true,
      replayed: true,
      result: {
        detail: {
          assignment: { state: "incomplete", version: 1 },
          current_response: null,
        },
      },
    });
    const captured = authority.captured.filter(
      ({ commandId }) => commandId === command.command_id,
    );
    expect(captured).toHaveLength(2);
    expect(captured[1]).toEqual(captured[0]);

    await authority.repairProjection();
    const repaired = await tasks.submitAssignment(
      event,
      "assignment_submit_repair",
      command,
      speaker,
      "req_submit_repair_replay",
    );
    expect(repaired).toMatchObject({
      ok: true,
      repair_pending: false,
      replayed: true,
      result: {
        detail: {
          assignment: { state: "complete", version: 2 },
          current_response: { acknowledged: true, kind: "ack" },
        },
      },
    });
  });

  it("reports projection failure, then exposes the repaired projection", async () => {
    authority.returnRepairPendingOnce();
    const response = await tasks.materializeAcceptance(
      event,
      {
        acceptance_id: "accept_gamma",
        command_id: "cmd_materialize_gamma",
        session_ids: ["session_gamma"],
        type: "materialize_acceptance",
      },
      organizer,
      "req_materialize_gamma",
    );
    expect(response).toMatchObject({ ok: true, repair_pending: true });
    expect(
      (await tasks.reads().assignments(event)).filter(
        ({ session_id }) => session_id === "session_gamma",
      ),
    ).toHaveLength(0);

    await authority.repairProjection();
    expect(
      (await tasks.reads().assignments(event)).filter(
        ({ session_id }) => session_id === "session_gamma",
      ),
    ).toHaveLength(1);

    const gamma = (await tasks.reads().assignments(event)).find(
      ({ session_id }) => session_id === "session_gamma",
    );
    if (!gamma) throw new Error("The repaired assignment is missing.");
    const transition = {
      command_id: "cmd_gamma_submit_unknown",
      expected_version: 1,
      reason: null,
      to: "submitted" as const,
      type: "transition_assignment" as const,
    };
    authority.returnOutcomeUnknownAfterCommitOnce();
    await expect(
      tasks.transitionAssignment(
        event,
        gamma.assignment_id,
        transition,
        speaker,
        "req_gamma_submit_unknown",
      ),
    ).rejects.toBeInstanceOf(TaskAuthorityPendingError);
    await expect(
      tasks.transitionAssignment(
        event,
        gamma.assignment_id,
        transition,
        speaker,
        "req_gamma_submit_reconcile",
      ),
    ).resolves.toMatchObject({
      ok: true,
      replayed: true,
      result: { state: "submitted", version: 2 },
    });
  });

  it("registers organizer read routes and fails event isolation closed", async () => {
    await database.batch([
      database
        .prepare(
          `INSERT INTO p_events (
             id, organization_id, name, slug, timezone, status, brand_json,
             schedule_days_json, source_record_id, source_version,
             source_content_hash, projected_at
           ) VALUES ('evt_readiness_valid', ?1, 'Readiness Valid',
                     'readiness-valid', 'UTC', 'open', '{}',
                     '[{"date":"2026-08-11","businessStart":"09:00","businessEnd":"17:00"}]',
                     'rec_event_readiness_valid', 1, ?2, ?3)`,
        )
        .bind(event.organizationId, contentHash, now),
      database
        .prepare(
          `INSERT INTO p_contacts (
             id, organization_id, email_normalized, display_name,
             source_record_id, source_version, source_content_hash, projected_at
           ) VALUES ('contact_unconfigured', ?1, 'new@example.test',
                     'Nia New', 'rec_contact_unconfigured', 1, ?2, ?3)`,
        )
        .bind(event.organizationId, contentHash, now),
      database
        .prepare(
          `INSERT INTO p_rooms (
             id, organization_id, event_id, name, capacity, sort_order,
             source_record_id, source_version, source_content_hash, projected_at
           ) VALUES ('room_readiness_valid', ?1, 'evt_readiness_valid',
                     'Main room', 100, 1, 'rec_room_readiness_valid', 1, ?2, ?3)`,
        )
        .bind(event.organizationId, contentHash, now),
      database
        .prepare(
          `INSERT INTO p_tracks (
             id, organization_id, event_id, name, sort_order,
             source_record_id, source_version, source_content_hash, projected_at
           ) VALUES ('track_readiness_valid', ?1, 'evt_readiness_valid',
                     'General', 1, 'rec_track_readiness_valid', 1, ?2, ?3)`,
        )
        .bind(event.organizationId, contentHash, now),
      database
        .prepare(
          `INSERT INTO p_formats (
             id, organization_id, event_id, name, default_duration_minutes,
             sort_order, source_record_id, source_version,
             source_content_hash, projected_at
           ) VALUES ('format_readiness_valid', ?1, 'evt_readiness_valid',
                     'Talk', 30, 1, 'rec_format_readiness_valid', 1, ?2, ?3)`,
        )
        .bind(event.organizationId, contentHash, now),
      database
        .prepare(
          `INSERT INTO p_event_contacts (
             id, organization_id, event_id, contact_id, roles_json,
             portal_state, source_record_id, source_version,
             source_content_hash, projected_at
           ) VALUES ('event_contact_unconfigured', ?1, ?2,
                     'contact_unconfigured', '["speaker"]', 'invited',
                     'rec_event_contact_unconfigured', 1, ?3, ?4)`,
        )
        .bind(event.organizationId, event.eventId, contentHash, now),
    ]);
    const headers = {
      Accept: "application/json",
      Cookie: `__Host-opensession-session=${sessionToken}`,
      "User-Agent": "OpenSession task route test",
    };
    const dashboard = new ReadinessDashboardService(
      database,
      () => new Date(now),
    );
    const directReadiness = await dashboard.read(
      event,
      readinessDashboardQuerySchema.parse({ page_size: 10 }),
    );
    expect(directReadiness).toMatchObject({
      metrics: { hard_conflicts: null, speakers_total: 2 },
      projection: {
        reasons: expect.arrayContaining(["schedule_unavailable"]),
      },
    });
    await expect(
      dashboard.read(
        event,
        readinessDashboardQuerySchema.parse({
          page_size: 10,
          portal: "invited",
          q: "Sam",
          task: "def_profile",
        }),
      ),
    ).resolves.toMatchObject({ page: { total: 0 }, speakers: [] });
    await expect(
      dashboard.read(
        event,
        readinessDashboardQuerySchema.parse({
          due: "next_7_days",
          page_size: 10,
        }),
      ),
    ).resolves.toMatchObject({ page: { total: 0 }, speakers: [] });
    await expect(
      dashboard.read(
        {
          ...event,
          eventId: "evt_readiness_valid",
          eventRecordId: "rec_event_readiness_valid",
          slug: "readiness-valid",
          timezone: "UTC",
        },
        readinessDashboardQuerySchema.parse({ page_size: 10 }),
      ),
    ).resolves.toMatchObject({
      metrics: { hard_conflicts: 0 },
      page: { total: 0 },
    });
    const readiness = await server.fetch("/api/events/evt_tasks/readiness", {
      headers,
    });
    const definitions = await server.fetch(
      "/api/events/task-summit/task-definitions",
      { headers },
    );
    const foreign = await server.fetch("/api/events/evt_foreign/readiness", {
      headers,
    });
    const foreignBody = await foreign.text();

    expect(readiness.status).toBe(200);
    await expect(readiness.json()).resolves.toMatchObject({
      event: {
        id: "evt_tasks",
        timezone: "America/Los_Angeles",
      },
      metrics: {
        accepted_unscheduled: 1,
        hard_conflicts: null,
        speakers_total: 2,
      },
      projection: {
        reasons: expect.arrayContaining(["schedule_unavailable"]),
        state: "partial",
      },
      speakers: expect.arrayContaining([
        expect.objectContaining({ contact_id: "contact_speaker" }),
      ]),
    });
    expect(definitions.status).toBe(200);
    await expect(definitions.json()).resolves.toEqual([
      expect.objectContaining({ id: "def_profile" }),
      expect.objectContaining({ id: "def_slides" }),
    ]);

    await expect(
      new D1ScheduleProjectionRepository(database).read("evt_readiness_valid"),
    ).resolves.toMatchObject({ event: { eventId: "evt_readiness_valid" } });
    const completeSchedule = await server.fetch(
      "/api/events/evt_readiness_valid/readiness?page_size=10",
      { headers },
    );
    expect(completeSchedule.status).toBe(200);
    await expect(completeSchedule.json()).resolves.toMatchObject({
      metrics: { hard_conflicts: 0 },
      page: { total: 0 },
      speakers: [],
    });

    const filtered = await server.fetch(
      "/api/events/evt_tasks/readiness?page_size=10&portal=invited&task=def_profile&q=Sam",
      { headers },
    );
    expect(filtered.status).toBe(200);
    await expect(filtered.json()).resolves.toMatchObject({
      page: { number: 1, size: 10, total: 0, total_pages: 0 },
      speakers: [],
    });
    const invalidQuery = await server.fetch(
      "/api/events/evt_tasks/readiness?page_size=9",
      { headers },
    );
    expect(invalidQuery.status).toBe(400);
    await expect(invalidQuery.json()).resolves.toMatchObject({
      error: { code: "invalid_readiness_query" },
    });
    await database
      .prepare(
        `UPDATE tenant_registry SET authority_ready_at = NULL
         WHERE organization_id = ?`,
      )
      .bind(event.organizationId)
      .run();
    const rebuilding = await server.fetch(
      "/api/events/evt_tasks/readiness?page_size=10",
      { headers },
    );
    expect(rebuilding.status).toBe(200);
    await expect(rebuilding.json()).resolves.toMatchObject({
      projection: {
        reasons: expect.arrayContaining(["upstream_rebuilding"]),
        state: "partial",
      },
    });
    await database
      .prepare(
        `UPDATE tenant_registry SET authority_ready_at = ?1
         WHERE organization_id = ?2`,
      )
      .bind(now, event.organizationId)
      .run();
    expect(foreign.status).toBe(403);
    expect(foreignBody).not.toContain("Fern Foreign");

    const unauthenticated = await server.fetch(
      "/api/events/evt_tasks/task-definitions",
      { headers: { Accept: "application/json" } },
    );
    expect(unauthenticated.status).toBe(401);

    await database.batch([
      database
        .prepare("DELETE FROM p_event_contacts WHERE id = ?")
        .bind("event_contact_unconfigured"),
      database
        .prepare("DELETE FROM p_contacts WHERE id = ?")
        .bind("contact_unconfigured"),
      database
        .prepare("DELETE FROM p_formats WHERE id = ?")
        .bind("format_readiness_valid"),
      database
        .prepare("DELETE FROM p_tracks WHERE id = ?")
        .bind("track_readiness_valid"),
      database
        .prepare("DELETE FROM p_rooms WHERE id = ?")
        .bind("room_readiness_valid"),
      database
        .prepare("DELETE FROM p_events WHERE id = ?")
        .bind("evt_readiness_valid"),
    ]);
  });

  it("scopes assignment detail and forces speakers through typed submissions", async () => {
    const profile = (await tasks.reads().assignments(event)).find(
      ({ definition_id }) => definition_id === "def_profile",
    );
    if (!profile) throw new Error("The profile assignment is missing.");
    const speakerHeaders = {
      Accept: "application/json",
      Cookie: `__Host-opensession-session=${speakerSessionToken}`,
      "Content-Type": "application/json",
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      "User-Agent": "OpenSession speaker task route test",
      "X-CSRF-Token": "task-speaker-csrf",
    };
    const detail = await server.fetch(
      `/api/events/evt_tasks/task-assignments/${profile.assignment_id}`,
      { headers: speakerHeaders },
    );
    expect(detail.status, await detail.clone().text()).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      assignment: { assignment_id: profile.assignment_id },
      permissions: { can_review: false, can_submit: true },
      speaker: { contact_id: "contact_speaker" },
    });
    expect(detail.headers.get("Cache-Control")).toBe("private, no-store");

    const legacyTransition = await server.fetch(
      `/api/events/evt_tasks/task-assignments/${profile.assignment_id}/transitions`,
      {
        body: JSON.stringify({
          command_id: "cmd_speaker_legacy_transition",
          expected_version: profile.version,
          reason: null,
          to: "submitted",
          type: "transition_assignment",
        }),
        headers: speakerHeaders,
        method: "POST",
      },
    );
    expect(legacyTransition.status).toBe(403);
    await expect(legacyTransition.json()).resolves.toMatchObject({
      error: { code: "forbidden" },
    });

    const mismatchedTypedResponse = await server.fetch(
      `/api/events/evt_tasks/task-assignments/${profile.assignment_id}/submissions`,
      {
        body: JSON.stringify({
          command_id: "cmd_speaker_mismatched_response",
          expected_version: profile.version,
          response: { answers: [], kind: "form" },
          type: "submit_assignment",
        }),
        headers: speakerHeaders,
        method: "POST",
      },
    );
    expect(mismatchedTypedResponse.status).toBe(422);
    await expect(mismatchedTypedResponse.json()).resolves.toMatchObject({
      error: { code: "task_invalid_request" },
    });

    const foreign = await server.fetch(
      `/api/events/evt_foreign/task-assignments/${profile.assignment_id}`,
      { headers: speakerHeaders },
    );
    expect(foreign.status).toBe(403);
  });

  it("maps preview, idempotency, version, and transition failures at the route boundary", async () => {
    const headers = {
      Accept: "application/json",
      Cookie: `__Host-opensession-session=${sessionToken}`,
      "Content-Type": "application/json",
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      "User-Agent": "OpenSession task command route test",
      "X-CSRF-Token": "task-readiness-csrf",
    };
    const post = (path: string, body: unknown, requestHeaders = headers) =>
      server.fetch(path, {
        body: JSON.stringify(body),
        headers: requestHeaders,
        method: "POST",
      });

    const preview = await post(
      "/api/events/evt_tasks/task-definitions/backfill-preview",
      {
        definition: definitionDraft("def_profile", "contact"),
        expected_version: 1,
      },
    );
    expect(preview.status, await preview.clone().text()).toBe(200);
    await expect(preview.json()).resolves.toMatchObject({
      policy: "additive_preserve_existing",
    });

    const stalePreview = await post(
      "/api/events/evt_tasks/task-definitions/backfill-preview",
      {
        definition: definitionDraft("def_profile", "contact"),
        expected_version: 0,
      },
    );
    expect(stalePreview.status).toBe(412);
    await expect(stalePreview.json()).resolves.toMatchObject({
      error: { code: "task_version_conflict" },
    });

    const invalidDue = await post(
      "/api/events/evt_tasks/task-definitions/backfill-preview",
      {
        definition: {
          ...definitionDraft("def_profile", "contact"),
          due: {
            disambiguation: "earlier",
            local_date: "2026-03-08",
            local_time: "02:30",
          },
        },
        expected_version: 1,
      },
    );
    expect(invalidDue.status).toBe(422);
    await expect(invalidDue.json()).resolves.toMatchObject({
      error: { code: "task_invalid_request" },
    });

    const definitionConflict = await post(
      "/api/events/evt_tasks/task-definitions/commands",
      {
        backfill_preview_id: null,
        command_id: "cmd_definition_stale_route",
        definition: definitionDraft("def_profile", "contact"),
        expected_version: 0,
        type: "upsert_definition",
      },
    );
    expect(definitionConflict.status).toBe(412);

    const materializationConflict = await post(
      "/api/events/evt_tasks/task-materializations/commands",
      {
        acceptance_id: "accept_alpha",
        command_id: "cmd_materialize_alpha",
        session_ids: ["session_beta"],
        type: "materialize_acceptance",
      },
    );
    expect(materializationConflict.status).toBe(409);
    await expect(materializationConflict.json()).resolves.toMatchObject({
      error: { code: "task_idempotency_conflict" },
    });

    const approvedSlides = (await tasks.reads().assignments(event)).find(
      ({ definition_id, session_id }) =>
        definition_id === "def_slides" && session_id === "session_alpha",
    );
    if (!approvedSlides) throw new Error("The approved assignment is missing.");
    const illegal = await post(
      `/api/events/evt_tasks/task-assignments/${approvedSlides.assignment_id}/transitions`,
      {
        command_id: "cmd_illegal_route",
        expected_version: approvedSlides.version,
        reason: null,
        to: "approved",
        type: "transition_assignment",
      },
    );
    expect(illegal.status).toBe(422);
    await expect(illegal.json()).resolves.toMatchObject({
      error: { code: "task_illegal_transition" },
    });

    const missing = await post(
      "/api/events/evt_tasks/task-assignments/assignment_missing/transitions",
      {
        command_id: "cmd_missing_route",
        expected_version: 1,
        reason: "Administrative reset.",
        to: "incomplete",
        type: "transition_assignment",
      },
    );
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: "task_not_found" },
    });

    const crossSite = await post(
      "/api/events/evt_tasks/task-materializations/commands",
      {},
      { ...headers, Origin: "https://attacker.example" },
    );
    expect(crossSite.status).toBe(400);
    const invalid = await post(
      "/api/events/evt_tasks/task-materializations/commands",
      {},
    );
    expect(invalid.status).toBe(400);

    const oversized = await post(
      "/api/events/evt_tasks/task-definitions/commands",
      { padding: "x".repeat(70 * 1024) },
    );
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      error: { code: "request_too_large" },
    });
  });

  it("continues definition backfill after an outcome-unknown authority write", async () => {
    const command = {
      backfill_preview_id: null,
      command_id: "cmd_definition_unknown",
      definition: definitionDraft("def_ack_new", "contact"),
      expected_version: 0,
      type: "upsert_definition" as const,
    };
    authority.returnOutcomeUnknownAfterCommitOnce();
    await expect(
      tasks.upsertDefinition(
        event,
        command,
        organizer,
        "req_definition_unknown",
      ),
    ).rejects.toBeInstanceOf(TaskAuthorityPendingError);

    const reconciled = await tasks.upsertDefinition(
      event,
      command,
      organizer,
      "req_definition_reconcile",
    );
    expect(reconciled).toMatchObject({
      ok: true,
      replayed: true,
      result: { id: "def_ack_new", version: 1 },
    });
    expect(
      (await tasks.reads().assignments(event)).filter(
        ({ definition_id }) => definition_id === "def_ack_new",
      ),
    ).toHaveLength(1);
    expect(
      authority.captured.find(
        ({ commandId }) => commandId === command.command_id,
      )?.audit.safeDiff,
    ).toMatchObject({
      backfillPolicy: "additive_preserve_existing",
      backfillPreviewId: null,
      targetChangePreviewed: false,
    });
  });
});
