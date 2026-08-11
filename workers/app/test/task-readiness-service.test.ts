import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TaskDefinitionDraft } from "@sessionbox-killer/contracts/tasks";
import { sha256Hex } from "../src/auth/crypto";
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
  type TaskCommandActor,
  type TaskEventScope,
} from "../src/tasks/service";

const now = "2026-08-10T18:00:00.000Z";
const contentHash = "a".repeat(64);
const authPepper = "task-readiness-test-pepper-with-at-least-32-characters";
const sessionToken = `task-readiness-session-${"s".repeat(36)}`;
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
    if (command.operation === "tasks.assignment.transition") {
      await this.#database
        .prepare(
          `UPDATE p_task_assignments
           SET status = ?3, completed_at = ?4, approved_at = ?5,
               response_json = ?6, source_version = ?7, projected_at = ?8,
               updated_at = ?8
           WHERE organization_id = ?1 AND id = ?2`,
        )
        .bind(
          command.organizationId,
          command.entityId,
          stringField(fields, "Status"),
          optionalStringField(fields, "Completed at"),
          optionalStringField(fields, "Approved at"),
          stringField(fields, "Response JSON"),
          command.expectedVersion + 1,
          now,
        )
        .run();
    }
  }
}

let database: D1Database;
let authority: ProjectingAuthority;
let tasks: TaskAuthorityService;
let origin = "";

beforeAll(async () => {
  origin = (await server.listen()).url.origin;
  const worker = server.getWorker<Env>();
  await worker.applyD1Migrations("DB");
  database = (await worker.getEnv()).DB;
  const tokenHash = await sha256Hex(sessionToken);
  const csrfHash = await sha256Hex("task-readiness-csrf");
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
       '2099-01-01T00:00:00.000Z', ${sql(now)});

    INSERT INTO auth_session_secrets
      (session_id, csrf_token_hash, created_at)
    VALUES
      ('auth_task_readiness', ${sql(csrfHash)}, ${sql(now)});

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
        reason: null,
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
        reason: null,
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
    const headers = {
      Accept: "application/json",
      Cookie: `__Host-opensession-session=${sessionToken}`,
      "User-Agent": "OpenSession task route test",
    };
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

    expect(readiness.status).toBe(200);
    await expect(readiness.json()).resolves.toMatchObject({
      event_id: "evt_tasks",
      speakers: [{ contact_id: "contact_speaker" }],
      timezone: "America/Los_Angeles",
    });
    expect(definitions.status).toBe(200);
    await expect(definitions.json()).resolves.toEqual([
      expect.objectContaining({ id: "def_profile" }),
      expect.objectContaining({ id: "def_slides" }),
    ]);
    expect(foreign.status).toBe(403);
    expect(JSON.stringify(await foreign.json())).not.toContain("Fern Foreign");

    const unauthenticated = await server.fetch(
      "/api/events/evt_tasks/task-definitions",
      { headers: { Accept: "application/json" } },
    );
    expect(unauthenticated.status).toBe(401);
  });

  it("maps preview, idempotency, version, and transition failures at the route boundary", async () => {
    const headers = {
      Accept: "application/json",
      Cookie: `__Host-opensession-session=${sessionToken}`,
      "Content-Type": "application/json",
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      "User-Agent": "OpenSession task command route test",
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
        reason: null,
        to: "submitted",
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
