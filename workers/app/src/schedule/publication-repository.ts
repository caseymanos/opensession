import {
  calendarChangeIntentSchema,
  publicScheduleProjectionSchema,
  scheduleCommandResultSchema,
  scheduleSessionSchema,
  scheduleSnapshotSchema,
  type CalendarChangeIntent,
  type PublicScheduleProjection,
  type PublishScheduleCommand,
  type ScheduleCommand,
  type ScheduleCommandResult,
  type ScheduleSnapshot,
} from "@sessionbox-killer/contracts";

import {
  D1CalendarIntentOutbox,
  type CalendarOutboxResult,
} from "../calendar/outbox.js";
import { D1PublicScheduleProjectionReader } from "../public-schedule/projection.js";

interface PublicationRepositoryOptions {
  actorId: string;
  database: D1Database;
  requestId: string;
}

interface CommitInput {
  command: ScheduleCommand;
  organizationId: string;
  previousSnapshot: ScheduleSnapshot;
  result: ScheduleCommandResult;
}

interface PublicationCommitInput extends CommitInput {
  command: PublishScheduleCommand;
}

interface PublicationIdentity {
  publicationVersion: number;
  snapshotId: string;
  snapshotSha256: string;
}

interface ExistingPublicationRow {
  publication_version: number;
}

interface PublicChangeRow {
  actor_id: string | null;
  actor_type: "api_key" | "portal" | "system" | "user";
  calendar_intent_enqueued_at: string | null;
  calendar_outbox_id: string | null;
  change_type: "canceled" | "rescheduled" | "unassigned";
  command_id: string;
  event_id: string;
  id: string;
  occurred_at: string;
  organization_id: string;
  previous_public_session_json: string;
  request_id: string;
  session_id: string;
  source_publication_version: number;
}

interface CalendarChangeRepair extends CalendarOutboxResult {
  factId: string;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError("Publication value is not JSON serializable.");
  }
  return encoded;
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

async function stableId(prefix: string, identity: string): Promise<string> {
  return `${prefix}_${(await sha256Hex(identity)).slice(0, 48)}`;
}

function changedPublicSession(
  command: ScheduleCommand,
  previous: ScheduleSnapshot,
  next: ScheduleSnapshot,
) {
  if (
    command.type !== "cancel_session" &&
    command.type !== "reschedule_session" &&
    command.type !== "unassign_session"
  ) {
    return null;
  }
  const prior = previous.sessions.find(
    (session) => session.id === command.sessionId,
  );
  const draft = next.sessions.find(
    (session) => session.id === command.sessionId,
  );
  if (
    !prior ||
    !draft ||
    prior.state !== "published" ||
    !prior.slot ||
    prior.slot.publicationVersion <= 0
  ) {
    return null;
  }
  return {
    changeType:
      command.type === "cancel_session"
        ? ("canceled" as const)
        : command.type === "unassign_session"
          ? ("unassigned" as const)
          : ("rescheduled" as const),
    draft,
    prior,
    sourcePublicationVersion: prior.slot.publicationVersion,
  };
}

export class D1SchedulePublicationRepository {
  readonly #actorId: string;
  readonly #calendarOutbox: D1CalendarIntentOutbox;
  readonly #database: D1Database;
  readonly #publicProjection: D1PublicScheduleProjectionReader;
  readonly #requestId: string;

  constructor(options: PublicationRepositoryOptions) {
    this.#actorId = options.actorId;
    this.#calendarOutbox = new D1CalendarIntentOutbox(options.database);
    this.#database = options.database;
    this.#publicProjection = new D1PublicScheduleProjectionReader(
      options.database,
    );
    this.#requestId = options.requestId;
  }

  async ensureLegacyBaseline(
    organizationId: string,
    snapshot: ScheduleSnapshot,
  ): Promise<void> {
    const publicationVersion = snapshot.event.publicationVersion;
    if (publicationVersion === 0) return;
    const existing = await this.#latest(snapshot.event.eventId);
    if (existing) return;
    const live = await this.#publicProjection.readLiveByEventId(
      snapshot.event.eventId,
    );
    if (!live || live.projection.version !== publicationVersion) {
      throw new Error(
        "The existing public schedule cannot be captured before publication.",
      );
    }
    const createdAt = live.projection.generatedAt;
    const identity = await this.#publicationIdentity(
      snapshot,
      live.projection,
      `legacy_${snapshot.event.eventId}_${publicationVersion}`,
    );
    await this.#database
      .prepare(
        `INSERT INTO schedule_publications (
           organization_id, event_id, publication_version, schedule_version,
           snapshot_id, command_id, schedule_snapshot_json,
           public_projection_json, snapshot_sha256,
           soft_warning_override_json, published_at, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, ?10)`,
      )
      .bind(
        organizationId,
        snapshot.event.eventId,
        publicationVersion,
        snapshot.event.version,
        identity.snapshotId,
        `legacy_${snapshot.event.eventId}_${publicationVersion}`,
        JSON.stringify(scheduleSnapshotSchema.parse(snapshot)),
        JSON.stringify(live.projection),
        identity.snapshotSha256,
        createdAt,
      )
      .run();
  }

  async commit(input: CommitInput): Promise<PublicationIdentity | null> {
    if (input.command.type === "publish_schedule") {
      return this.#commitPublication({ ...input, command: input.command });
    }
    await this.#commitDraftChange(input);
    return null;
  }

  async repairCalendarChange(
    eventId: string,
    commandId: string,
  ): Promise<CalendarChangeRepair | null> {
    const rows = await this.#database
      .prepare(
        `SELECT id, organization_id, event_id, session_id, command_id,
                request_id, actor_type, actor_id, source_publication_version,
                change_type, previous_public_session_json, occurred_at,
                calendar_intent_enqueued_at, calendar_outbox_id
         FROM schedule_public_changes
         WHERE event_id = ?1 AND command_id = ?2
         ORDER BY organization_id, session_id LIMIT 2`,
      )
      .bind(eventId, commandId)
      .all<PublicChangeRow>();
    if (rows.results.length > 1) {
      throw new Error("Calendar change repair resolved multiple public facts.");
    }
    const fact = rows.results[0];
    if (!fact || fact.calendar_intent_enqueued_at) return null;
    const intent = this.#calendarChangeIntent(fact);
    const result = await this.#calendarOutbox.enqueueChange(intent);
    const now = new Date().toISOString();
    const marked = await this.#database
      .prepare(
        `UPDATE schedule_public_changes
         SET calendar_intent_enqueued_at = ?2, calendar_outbox_id = ?3
         WHERE id = ?1 AND calendar_intent_enqueued_at IS NULL
           AND calendar_outbox_id IS NULL`,
      )
      .bind(fact.id, now, result.outboxId)
      .run();
    if (marked.meta.changes !== 1) {
      const current = await this.#database
        .prepare(
          `SELECT calendar_intent_enqueued_at, calendar_outbox_id
           FROM schedule_public_changes WHERE id = ?`,
        )
        .bind(fact.id)
        .first<
          Pick<
            PublicChangeRow,
            "calendar_intent_enqueued_at" | "calendar_outbox_id"
          >
        >();
      if (
        !current?.calendar_intent_enqueued_at ||
        current.calendar_outbox_id !== result.outboxId
      ) {
        throw new Error("Calendar change repair could not record its handoff.");
      }
    }
    return { ...result, factId: fact.id };
  }

  async #commitPublication(
    input: PublicationCommitInput,
  ): Promise<PublicationIdentity> {
    const live = await this.#publicProjection.readLiveByEventId(
      input.command.eventId,
    );
    if (
      !live ||
      live.projection.version !== input.result.snapshot.event.publicationVersion
    ) {
      throw new Error(
        "The public projection does not match the committed publication version.",
      );
    }
    const projection = publicScheduleProjectionSchema.parse(live.projection);
    const result = scheduleCommandResultSchema.parse(input.result);
    const identity = await this.#publicationIdentity(
      result.snapshot,
      projection,
      input.command.commandId,
    );
    const now = new Date().toISOString();
    const auditId = await stableId(
      "aud",
      `${input.organizationId}:${input.command.commandId}:publication`,
    );
    const outboxId = await stableId(
      "out",
      `${input.organizationId}:${input.command.commandId}:publication`,
    );
    const payload = {
      commandId: input.command.commandId,
      eventId: input.command.eventId,
      kind: "schedule.publication.committed",
      publicationVersion: identity.publicationVersion,
      scheduleVersion: result.snapshot.event.version,
      snapshotId: identity.snapshotId,
      softWarningOverride: input.command.softWarningOverride ?? null,
      version: 1,
    };
    const statements = [
      this.#database
        .prepare(
          `INSERT INTO schedule_publications (
             organization_id, event_id, publication_version, schedule_version,
             snapshot_id, command_id, schedule_snapshot_json,
             public_projection_json, snapshot_sha256,
             soft_warning_override_json, published_at, created_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`,
        )
        .bind(
          input.organizationId,
          input.command.eventId,
          identity.publicationVersion,
          result.snapshot.event.version,
          identity.snapshotId,
          input.command.commandId,
          JSON.stringify(result.snapshot),
          JSON.stringify(projection),
          identity.snapshotSha256,
          input.command.softWarningOverride
            ? JSON.stringify(input.command.softWarningOverride)
            : null,
          now,
        ),
      this.#database
        .prepare(
          `INSERT INTO audit_events (
             id, organization_id, event_id, actor_type, actor_id, action,
             entity_type, entity_id, request_id, command_id,
             redaction_version, safe_diff_json, metadata_json, created_at
           ) VALUES (
             ?1, ?2, ?3, 'user', ?4, 'schedule.publication.committed',
             'schedule_publication', ?5, ?6, ?7, 1, ?8, ?9, ?10
           )`,
        )
        .bind(
          auditId,
          input.organizationId,
          input.command.eventId,
          this.#actorId,
          identity.snapshotId,
          this.#requestId,
          input.command.commandId,
          JSON.stringify({
            from_publication_version:
              input.previousSnapshot.event.publicationVersion,
            published_session_count: projection.sessions.length,
            schedule_version: result.snapshot.event.version,
            to_publication_version: identity.publicationVersion,
          }),
          JSON.stringify({
            snapshot_sha256: identity.snapshotSha256,
            soft_warning_override: input.command.softWarningOverride ?? null,
          }),
          now,
        ),
      this.#database
        .prepare(
          `INSERT INTO outbox_events (
             id, organization_id, event_id, aggregate_type, aggregate_id,
             event_type, idempotency_key, payload_json, status, attempt_count,
             available_at, created_at, updated_at
           ) VALUES (
             ?1, ?2, ?3, 'schedule_publication', ?4,
             'schedule.publication.committed', ?5, ?6, 'pending', 0, ?7, ?7, ?7
           )`,
        )
        .bind(
          outboxId,
          input.organizationId,
          input.command.eventId,
          identity.snapshotId,
          `schedule.publication:${input.command.commandId}`,
          JSON.stringify(payload),
          now,
        ),
      this.#database
        .prepare(
          `INSERT INTO authority_cache_invalidations (
             organization_id, event_id, status, invalidation_version,
             publication_version, surfaces_json, attempt_count,
             created_at, updated_at
           ) VALUES (?1, ?2, 'pending', 1, ?3, ?4, 0, ?5, ?5)
           ON CONFLICT (organization_id, event_id) DO UPDATE SET
             status = 'pending',
             invalidation_version = authority_cache_invalidations.invalidation_version + 1,
             publication_version = excluded.publication_version,
             surfaces_json = excluded.surfaces_json,
             attempt_count = 0,
             updated_at = excluded.updated_at,
             published_at = NULL,
             enqueued_at = NULL,
             processed_at = NULL,
             last_error_code = NULL`,
        )
        .bind(
          input.organizationId,
          input.command.eventId,
          identity.publicationVersion,
          JSON.stringify(["schedule", "gallery", "feed"]),
          now,
        ),
      this.#completeReceiptStatement(input, result, now),
    ];
    await this.#database.batch(statements);
    return identity;
  }

  async #commitDraftChange(input: CommitInput): Promise<void> {
    const result = scheduleCommandResultSchema.parse(input.result);
    const change = changedPublicSession(
      input.command,
      input.previousSnapshot,
      result.snapshot,
    );
    const now = new Date().toISOString();
    if (!change) {
      await this.#database.batch([
        this.#completeReceiptStatement(input, result, now),
      ]);
      return;
    }
    const factIdentity = `${input.organizationId}:${input.command.commandId}:${change.prior.id}:${change.changeType}`;
    const factId = await stableId("pubchg", factIdentity);
    const auditId = await stableId("aud", factIdentity);
    const outboxId = await stableId("out", factIdentity);
    const payload = {
      actor: { id: this.#actorId, type: "user" as const },
      changeType: change.changeType,
      commandId: input.command.commandId,
      eventId: input.command.eventId,
      kind: "schedule.public_change.recorded",
      nextDraftSession: change.draft,
      previousPublicSession: change.prior,
      requestId: this.#requestId,
      sessionId: change.prior.id,
      sourcePublicationVersion: change.sourcePublicationVersion,
      version: 1,
    };
    await this.#database.batch([
      this.#database
        .prepare(
          `INSERT INTO schedule_public_changes (
             id, organization_id, event_id, session_id, command_id,
             request_id, actor_type, actor_id,
             source_publication_version, change_type,
             previous_public_session_json, next_draft_session_json,
             occurred_at, created_at
           ) VALUES (
             ?1, ?2, ?3, ?4, ?5, ?6, 'user', ?7,
             ?8, ?9, ?10, ?11, ?12, ?12
           )`,
        )
        .bind(
          factId,
          input.organizationId,
          input.command.eventId,
          change.prior.id,
          input.command.commandId,
          this.#requestId,
          this.#actorId,
          change.sourcePublicationVersion,
          change.changeType,
          JSON.stringify(change.prior),
          JSON.stringify(change.draft),
          now,
        ),
      this.#database
        .prepare(
          `INSERT INTO audit_events (
             id, organization_id, event_id, actor_type, actor_id, action,
             entity_type, entity_id, request_id, command_id,
             redaction_version, safe_diff_json, metadata_json, created_at
           ) VALUES (
             ?1, ?2, ?3, 'user', ?4, 'schedule.public_change.recorded',
             'schedule_session', ?5, ?6, ?7, 1, ?8, ?9, ?10
           )`,
        )
        .bind(
          auditId,
          input.organizationId,
          input.command.eventId,
          this.#actorId,
          change.prior.id,
          this.#requestId,
          input.command.commandId,
          JSON.stringify({
            change_type: change.changeType,
            source_publication_version: change.sourcePublicationVersion,
          }),
          JSON.stringify({ publication_change_id: factId }),
          now,
        ),
      this.#database
        .prepare(
          `INSERT INTO outbox_events (
             id, organization_id, event_id, aggregate_type, aggregate_id,
             event_type, idempotency_key, payload_json, status, attempt_count,
             available_at, created_at, updated_at
           ) VALUES (
             ?1, ?2, ?3, 'schedule_session', ?4,
             'schedule.public_change.recorded', ?5, ?6, 'pending', 0, ?7, ?7, ?7
           )`,
        )
        .bind(
          outboxId,
          input.organizationId,
          input.command.eventId,
          change.prior.id,
          `schedule.public_change:${input.command.commandId}:${change.prior.id}`,
          JSON.stringify(payload),
          now,
        ),
      this.#completeReceiptStatement(input, result, now),
    ]);
    await this.repairCalendarChange(
      input.command.eventId,
      input.command.commandId,
    );
  }

  #calendarChangeIntent(fact: PublicChangeRow): CalendarChangeIntent {
    const previous = scheduleSessionSchema.parse(
      JSON.parse(fact.previous_public_session_json) as unknown,
    );
    if (!previous.slot) {
      throw new Error(
        "A public calendar change is missing its prior placement.",
      );
    }
    const actor =
      fact.actor_type === "system"
        ? ({ id: null, type: "system" } as const)
        : { id: fact.actor_id, type: fact.actor_type };
    return calendarChangeIntentSchema.parse({
      actor,
      changeType: fact.change_type,
      commandId: fact.command_id,
      eventId: fact.event_id,
      kind: "calendar.change",
      occurredAt: fact.occurred_at,
      organizationId: fact.organization_id,
      previousPlacement: {
        endAt: previous.slot.endAt,
        roomId: previous.slot.roomId,
        startAt: previous.slot.startAt,
      },
      requestId: fact.request_id,
      sessionId: fact.session_id,
      sourcePublicationVersion: fact.source_publication_version,
      version: 1,
    });
  }

  #completeReceiptStatement(
    input: CommitInput,
    result: ScheduleCommandResult,
    now: string,
  ): D1PreparedStatement {
    return this.#database
      .prepare(
        `UPDATE schedule_command_receipts
         SET state = 'complete', result_json = ?3, updated_at = ?4
         WHERE event_id = ?1 AND command_id = ?2 AND state = 'applying'`,
      )
      .bind(
        input.command.eventId,
        input.command.commandId,
        JSON.stringify({
          actorId: this.#actorId,
          command: input.command,
          previousSnapshot: input.previousSnapshot,
          requestId: this.#requestId,
          result,
          version: 3,
        }),
        now,
      );
  }

  async #publicationIdentity(
    snapshot: ScheduleSnapshot,
    projection: PublicScheduleProjection,
    commandId: string,
  ): Promise<PublicationIdentity> {
    const body = canonicalJson({ projection, snapshot });
    const snapshotSha256 = await sha256Hex(body);
    return {
      publicationVersion: snapshot.event.publicationVersion,
      snapshotId: await stableId(
        "pub",
        `${snapshot.event.eventId}:${snapshot.event.publicationVersion}:${commandId}:${snapshotSha256}`,
      ),
      snapshotSha256,
    };
  }

  #latest(eventId: string): Promise<ExistingPublicationRow | null> {
    return this.#database
      .prepare(
        `SELECT publication_version FROM schedule_publications
         WHERE event_id = ? ORDER BY publication_version DESC LIMIT 1`,
      )
      .bind(eventId)
      .first<ExistingPublicationRow>();
  }
}
