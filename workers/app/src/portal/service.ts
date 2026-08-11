import {
  speakerPortalBootstrapResponseSchema,
  type SpeakerPortalBootstrapResponse,
  type SpeakerPortalBrand,
  type SpeakerPortalSession,
  type SpeakerPortalTask,
} from "@sessionbox-killer/contracts/portal";

import { hasEventPermission, loadEventAccess } from "../auth/authorization";
import type { AuthenticatedSession } from "../auth/service";
import { safeSpeakerPortalBrand } from "./brand";

const maximumTasks = 500;
const maximumSessions = 200;
const maximumCoSpeakers = 50;

interface PortalEventRow {
  brand_json: string;
  ends_at: string | null;
  id: string;
  name: string;
  organization_id: string;
  slug: string;
  starts_at: string | null;
  status: "archived" | "closed" | "draft" | "open" | "published";
  timezone: string;
  venue: string | null;
}

interface SpeakerRow {
  contact_id: string;
  display_name: string;
  email_normalized: string;
  portal_state: "active" | "invited";
}

interface TaskRow {
  approval_required: number;
  approved_at: string | null;
  completed_at: string | null;
  description: string | null;
  due_at: string | null;
  id: string;
  required: number;
  session_id: string | null;
  status:
    | "complete"
    | "in_progress"
    | "not_started"
    | "rejected"
    | "submitted"
    | "waived";
  title: string;
}

interface SessionRow {
  confirmed_state: "confirmed" | "pending";
  duration_minutes: number | null;
  ends_at: string | null;
  format_name: string | null;
  friendly_id: string;
  id: string;
  role: "chair" | "moderator" | "speaker";
  room_name: string | null;
  starts_at: string | null;
  status: "accepted" | "draft" | "published" | "scheduled";
  title: string;
  track_name: string | null;
}

interface CoSpeakerRow {
  display_name: string;
  session_id: string;
}

export type SpeakerPortalAccessErrorCode =
  | "portal_access_denied"
  | "portal_event_not_found"
  | "portal_projection_invalid";

export class SpeakerPortalAccessError extends Error {
  readonly code: SpeakerPortalAccessErrorCode;

  constructor(code: SpeakerPortalAccessErrorCode, message: string) {
    super(message);
    this.name = "SpeakerPortalAccessError";
    this.code = code;
  }
}

export interface SpeakerPortalEventScope {
  readonly brand: SpeakerPortalBrand;
  readonly endsAt: string | null;
  readonly eventId: string;
  readonly name: string;
  readonly organizationId: string;
  readonly slug: string;
  readonly startsAt: string | null;
  readonly status: PortalEventRow["status"];
  readonly timezone: string;
  readonly venue: string | null;
}

function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new SpeakerPortalAccessError(
      "portal_projection_invalid",
      "The speaker portal configuration is temporarily unavailable.",
    );
  }
}

function localDateNumber(value: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((item) => item.type === type)?.value);
  const year = part("year");
  const month = part("month");
  const day = part("day");
  if (![year, month, day].every(Number.isInteger)) {
    throw new SpeakerPortalAccessError(
      "portal_projection_invalid",
      "The speaker portal configuration is temporarily unavailable.",
    );
  }
  return Date.UTC(year, month - 1, day);
}

function daysRemaining(
  startsAt: string | null,
  timezone: string,
  now: Date,
): number | null {
  if (startsAt === null) return null;
  const start = new Date(startsAt);
  if (!Number.isFinite(start.getTime())) {
    throw new SpeakerPortalAccessError(
      "portal_projection_invalid",
      "The speaker portal configuration is temporarily unavailable.",
    );
  }
  const millisecondsPerDay = 24 * 60 * 60 * 1_000;
  return Math.max(
    0,
    Math.round(
      (localDateNumber(start, timezone) - localDateNumber(now, timezone)) /
        millisecondsPerDay,
    ),
  );
}

function validDate(value: string | null): string | null {
  if (value === null) return null;
  if (!Number.isFinite(Date.parse(value))) {
    throw new SpeakerPortalAccessError(
      "portal_projection_invalid",
      "The speaker portal data is temporarily unavailable.",
    );
  }
  return value;
}

function completeTask(row: TaskRow): boolean {
  return (
    row.status === "waived" ||
    (row.status === "complete" &&
      (row.approval_required === 0 || row.approved_at !== null))
  );
}

function taskView(row: TaskRow, now: Date): SpeakerPortalTask {
  const dueAt = validDate(row.due_at);
  const completedAt = validDate(row.completed_at);
  const complete = completeTask(row);
  const overdue =
    row.required === 1 &&
    !complete &&
    dueAt !== null &&
    Date.parse(dueAt) < now.getTime();
  return {
    approval_required: row.approval_required === 1,
    completed_at: completedAt,
    description: row.description ?? "",
    due_at: dueAt,
    id: row.id,
    required: row.required === 1,
    session_id: row.session_id,
    source_status: row.status,
    status: complete ? "complete" : overdue ? "overdue" : "open",
    title: row.title,
  };
}

export class D1SpeakerPortalEventResolver {
  readonly #database: D1Database;

  constructor(database: D1Database) {
    this.#database = database;
  }

  async resolve(slug: string): Promise<SpeakerPortalEventScope | null> {
    const result = await this.#database
      .prepare(
        `SELECT event.id, event.organization_id, event.name, event.slug,
                event.timezone, event.starts_at, event.ends_at, event.venue,
                event.status, event.brand_json
         FROM p_events event
         JOIN tenant_registry tenant
           ON tenant.organization_id = event.organization_id
          AND tenant.status = 'active'
          AND tenant.authority_ready_at IS NOT NULL
         WHERE event.slug = ?1
           AND event.source_deleted_at IS NULL
         ORDER BY event.organization_id, event.id
         LIMIT 2`,
      )
      .bind(slug)
      .all<PortalEventRow>();
    const row = result.results[0];
    if (!row) return null;
    if (result.results.length > 1) {
      throw new SpeakerPortalAccessError(
        "portal_projection_invalid",
        "The speaker portal configuration is temporarily unavailable.",
      );
    }
    assertTimezone(row.timezone);
    return {
      brand: safeSpeakerPortalBrand(row.brand_json),
      endsAt: validDate(row.ends_at),
      eventId: row.id,
      name: row.name,
      organizationId: row.organization_id,
      slug: row.slug,
      startsAt: validDate(row.starts_at),
      status: row.status,
      timezone: row.timezone,
      venue: row.venue,
    };
  }
}

export interface SpeakerPortalServiceOptions {
  readonly database: D1Database;
  readonly now?: () => Date;
}

export class D1SpeakerPortalService {
  readonly #database: D1Database;
  readonly #now: () => Date;
  readonly #resolver: D1SpeakerPortalEventResolver;

  constructor(options: SpeakerPortalServiceOptions) {
    this.#database = options.database;
    this.#now = options.now ?? (() => new Date());
    this.#resolver = new D1SpeakerPortalEventResolver(options.database);
  }

  async bootstrap(
    session: AuthenticatedSession,
    slug: string,
    requestId: string,
  ): Promise<SpeakerPortalBootstrapResponse> {
    const event = await this.#resolver.resolve(slug);
    if (!event) {
      throw new SpeakerPortalAccessError(
        "portal_event_not_found",
        "The requested speaker portal does not exist.",
      );
    }
    const access = await loadEventAccess(
      this.#database,
      session.user,
      event.organizationId,
      event.eventId,
    );
    if (
      !access.speakerContactId ||
      !hasEventPermission(access, "portal:read:self")
    ) {
      await this.#recordDenied(session, event, requestId);
      throw new SpeakerPortalAccessError(
        "portal_access_denied",
        "This account does not have access to the requested speaker portal.",
      );
    }

    const speaker = await this.#authorizedSpeaker(
      session,
      event,
      access.speakerContactId,
    );
    if (!speaker) {
      await this.#recordDenied(session, event, requestId);
      throw new SpeakerPortalAccessError(
        "portal_access_denied",
        "This account does not have access to the requested speaker portal.",
      );
    }

    const [taskResult, sessionResult, coSpeakerResult] = await Promise.all([
      this.#tasks(event, speaker.contact_id),
      this.#sessions(event, speaker.contact_id),
      this.#coSpeakers(event, speaker.contact_id),
    ]);
    if (taskResult.length > maximumTasks) {
      throw new SpeakerPortalAccessError(
        "portal_projection_invalid",
        "The speaker portal contains too many tasks to display safely.",
      );
    }
    if (sessionResult.length > maximumSessions) {
      throw new SpeakerPortalAccessError(
        "portal_projection_invalid",
        "The speaker portal contains too many sessions to display safely.",
      );
    }
    if (coSpeakerResult.length > maximumSessions * (maximumCoSpeakers + 1)) {
      throw new SpeakerPortalAccessError(
        "portal_projection_invalid",
        "The speaker portal contains too many participants to display safely.",
      );
    }

    const finalSpeaker = await this.#authorizedSpeaker(
      session,
      event,
      speaker.contact_id,
    );
    if (!finalSpeaker || finalSpeaker.portal_state !== speaker.portal_state) {
      await this.#recordDenied(session, event, requestId);
      throw new SpeakerPortalAccessError(
        "portal_access_denied",
        "This account does not have access to the requested speaker portal.",
      );
    }

    const now = this.#now();
    const tasks = taskResult.map((row) => taskView(row, now));
    const requiredTasks = tasks.filter(({ required }) => required);
    const incompleteRequired = requiredTasks.filter(
      ({ status }) => status !== "complete",
    );
    const overdueTasks = incompleteRequired.filter(
      ({ status }) => status === "overdue",
    );
    const nextDueAt =
      incompleteRequired
        .map(({ due_at: dueAt }) => dueAt)
        .filter((dueAt): dueAt is string => dueAt !== null)
        .sort()[0] ?? null;
    const coSpeakersBySession = new Map<string, string[]>();
    for (const row of coSpeakerResult) {
      const current = coSpeakersBySession.get(row.session_id) ?? [];
      if (!current.includes(row.display_name)) current.push(row.display_name);
      if (current.length > maximumCoSpeakers) {
        throw new SpeakerPortalAccessError(
          "portal_projection_invalid",
          "A speaker portal session contains too many participants.",
        );
      }
      coSpeakersBySession.set(row.session_id, current);
    }
    const sessions: SpeakerPortalSession[] = sessionResult.map((row) => {
      const startsAt = validDate(row.starts_at);
      const endsAt = validDate(row.ends_at);
      const roomName = row.room_name?.trim() || null;
      if (
        (startsAt === null) !== (endsAt === null) ||
        (startsAt === null) !== (roomName === null)
      ) {
        throw new SpeakerPortalAccessError(
          "portal_projection_invalid",
          "A speaker portal session has an incomplete schedule.",
        );
      }
      return {
        co_speakers: coSpeakersBySession.get(row.id) ?? [],
        confirmed_state: row.confirmed_state,
        duration_minutes: row.duration_minutes,
        format: row.format_name ?? "Session",
        friendly_id: row.friendly_id,
        id: row.id,
        role: row.role,
        schedule:
          startsAt && endsAt && roomName
            ? { ends_at: endsAt, room: roomName, starts_at: startsAt }
            : null,
        source_status: row.status,
        title: row.title,
        track: row.track_name ?? "General",
      };
    });
    const requiredComplete = requiredTasks.length - incompleteRequired.length;
    const readinessStatus =
      requiredTasks.length === 0
        ? "not_configured"
        : overdueTasks.length > 0
          ? "overdue"
          : incompleteRequired.length > 0
            ? "outstanding"
            : "ready";

    return speakerPortalBootstrapResponseSchema.parse({
      event: {
        brand: event.brand,
        days_remaining: daysRemaining(event.startsAt, event.timezone, now),
        ends_at: event.endsAt,
        id: event.eventId,
        name: event.name,
        slug: event.slug,
        starts_at: event.startsAt,
        status: event.status,
        timezone: event.timezone,
        venue: event.venue,
      },
      generated_at: now.toISOString(),
      portal_status: speaker.portal_state,
      readiness: {
        next_due_at: nextDueAt,
        outstanding_task_count: incompleteRequired.length,
        overdue_task_count: overdueTasks.length,
        required_complete: requiredComplete,
        required_total: requiredTasks.length,
        status: readinessStatus,
      },
      sessions,
      speaker: {
        contact_id: speaker.contact_id,
        display_name: speaker.display_name,
        email: speaker.email_normalized,
      },
      tasks,
    });
  }

  async #authorizedSpeaker(
    session: AuthenticatedSession,
    event: SpeakerPortalEventScope,
    contactId: string,
  ): Promise<SpeakerRow | null> {
    return this.#database
      .prepare(
        `SELECT contact.id AS contact_id, contact.email_normalized,
                contact.display_name, event_contact.portal_state
         FROM p_event_contacts event_contact
         JOIN p_contacts contact
           ON contact.organization_id = event_contact.organization_id
          AND contact.id = event_contact.contact_id
          AND contact.source_deleted_at IS NULL
         JOIN p_events event
           ON event.organization_id = event_contact.organization_id
          AND event.id = event_contact.event_id
          AND event.source_deleted_at IS NULL
         JOIN tenant_registry tenant
           ON tenant.organization_id = event_contact.organization_id
          AND tenant.status = 'active'
          AND tenant.authority_ready_at IS NOT NULL
         JOIN users user
           ON user.id = ?4
          AND user.status = 'active'
          AND user.email_normalized = contact.email_normalized COLLATE NOCASE
         WHERE event_contact.organization_id = ?1
           AND event_contact.event_id = ?2
           AND event_contact.contact_id = ?3
           AND event_contact.portal_state IN ('invited', 'active')
           AND event_contact.source_deleted_at IS NULL
           AND contact.email_normalized = ?5 COLLATE NOCASE
           AND EXISTS (
             SELECT 1 FROM json_each(event_contact.roles_json)
             WHERE json_each.value = 'speaker'
           )
         LIMIT 1`,
      )
      .bind(
        event.organizationId,
        event.eventId,
        contactId,
        session.user.id,
        session.user.email,
      )
      .first<SpeakerRow>();
  }

  async #tasks(
    event: SpeakerPortalEventScope,
    contactId: string,
  ): Promise<TaskRow[]> {
    const result = await this.#database
      .prepare(
        `SELECT assignment.id, assignment.session_id, assignment.due_at,
                assignment.required, assignment.status,
                assignment.completed_at, assignment.approved_at,
                definition.name AS title, definition.description,
                definition.approval_required
         FROM p_task_assignments assignment
         JOIN p_task_definitions definition
           ON definition.organization_id = assignment.organization_id
          AND definition.event_id = assignment.event_id
          AND definition.id = assignment.definition_id
          AND definition.source_deleted_at IS NULL
         WHERE assignment.organization_id = ?1
           AND assignment.event_id = ?2
           AND assignment.contact_id = ?3
           AND assignment.source_deleted_at IS NULL
         ORDER BY
           CASE WHEN assignment.due_at IS NULL THEN 1 ELSE 0 END,
           assignment.due_at, definition.name, assignment.id
         LIMIT ?4`,
      )
      .bind(event.organizationId, event.eventId, contactId, maximumTasks + 1)
      .all<TaskRow>();
    return result.results;
  }

  async #sessions(
    event: SpeakerPortalEventScope,
    contactId: string,
  ): Promise<SessionRow[]> {
    const result = await this.#database
      .prepare(
        `WITH assigned AS (
           SELECT participant.session_id,
                  CASE MIN(CASE participant.role
                    WHEN 'speaker' THEN 0 WHEN 'moderator' THEN 1 ELSE 2 END)
                    WHEN 0 THEN 'speaker' WHEN 1 THEN 'moderator' ELSE 'chair'
                  END AS role,
                  CASE MAX(CASE participant.confirmed_state
                    WHEN 'confirmed' THEN 1 ELSE 0 END)
                    WHEN 1 THEN 'confirmed' ELSE 'pending'
                  END AS confirmed_state
           FROM p_session_participants participant
           WHERE participant.organization_id = ?1
             AND participant.event_id = ?2
             AND participant.contact_id = ?3
             AND participant.confirmed_state != 'declined'
             AND participant.source_deleted_at IS NULL
           GROUP BY participant.session_id
         )
         SELECT session.id, session.friendly_id, session.title, session.status,
                session.duration_minutes, assigned.role, assigned.confirmed_state,
                track.name AS track_name, format.name AS format_name,
                slot.starts_at, slot.ends_at, room.name AS room_name
         FROM assigned
         JOIN p_sessions session
           ON session.organization_id = ?1
          AND session.event_id = ?2
          AND session.id = assigned.session_id
          AND session.status != 'canceled'
          AND session.source_deleted_at IS NULL
         LEFT JOIN p_tracks track
           ON track.organization_id = session.organization_id
          AND track.event_id = session.event_id
          AND track.id = session.track_id
          AND track.source_deleted_at IS NULL
         LEFT JOIN p_formats format
           ON format.organization_id = session.organization_id
          AND format.event_id = session.event_id
          AND format.id = session.format_id
          AND format.source_deleted_at IS NULL
         LEFT JOIN p_schedule_slots slot
           ON slot.organization_id = session.organization_id
          AND slot.event_id = session.event_id
          AND slot.session_id = session.id
          AND slot.source_deleted_at IS NULL
         LEFT JOIN p_rooms room
           ON room.organization_id = slot.organization_id
          AND room.event_id = slot.event_id
          AND room.id = slot.room_id
          AND room.source_deleted_at IS NULL
         ORDER BY CASE WHEN slot.starts_at IS NULL THEN 1 ELSE 0 END,
                  slot.starts_at, session.friendly_id, session.id
         LIMIT ?4`,
      )
      .bind(event.organizationId, event.eventId, contactId, maximumSessions + 1)
      .all<SessionRow>();
    return result.results;
  }

  async #coSpeakers(
    event: SpeakerPortalEventScope,
    contactId: string,
  ): Promise<CoSpeakerRow[]> {
    const result = await this.#database
      .prepare(
        `SELECT other.session_id, contact.display_name
         FROM p_session_participants own
         JOIN p_session_participants other
           ON other.organization_id = own.organization_id
          AND other.event_id = own.event_id
          AND other.session_id = own.session_id
          AND other.contact_id != own.contact_id
          AND other.role = 'speaker'
          AND other.confirmed_state != 'declined'
          AND other.source_deleted_at IS NULL
         JOIN p_contacts contact
           ON contact.organization_id = other.organization_id
          AND contact.id = other.contact_id
          AND contact.source_deleted_at IS NULL
         JOIN p_sessions session
           ON session.organization_id = other.organization_id
          AND session.event_id = other.event_id
          AND session.id = other.session_id
          AND session.status != 'canceled'
          AND session.source_deleted_at IS NULL
         WHERE own.organization_id = ?1
           AND own.event_id = ?2
           AND own.contact_id = ?3
           AND own.confirmed_state != 'declined'
           AND own.source_deleted_at IS NULL
         GROUP BY other.session_id, other.contact_id, contact.display_name
         ORDER BY other.session_id, MIN(other.sort_order), contact.display_name
         LIMIT ?4`,
      )
      .bind(
        event.organizationId,
        event.eventId,
        contactId,
        maximumSessions * (maximumCoSpeakers + 1) + 1,
      )
      .all<CoSpeakerRow>();
    return result.results;
  }

  async #recordDenied(
    session: AuthenticatedSession,
    event: SpeakerPortalEventScope,
    requestId: string,
  ): Promise<void> {
    try {
      await this.#database
        .prepare(
          `INSERT INTO audit_events (
             id, organization_id, event_id, actor_type, actor_id, action,
             entity_type, entity_id, request_id, redaction_version,
             safe_diff_json, metadata_json, created_at
           ) VALUES (?1, ?2, ?3, 'user', ?4, 'portal.access.denied',
                     'event', ?3, ?5, 1, '{}', ?6, ?7)`,
        )
        .bind(
          `aud_${crypto.randomUUID()}`,
          event.organizationId,
          event.eventId,
          session.user.id,
          requestId,
          JSON.stringify({ reason: "speaker_relationship_inactive" }),
          this.#now().toISOString(),
        )
        .run();
    } catch {
      // Authorization still fails closed when operational audit storage is unavailable.
    }
  }
}
