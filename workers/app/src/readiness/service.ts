import {
  readinessDashboardResponseSchema,
  type ReadinessDashboardQuery,
  type ReadinessDashboardResponse,
  type ReadinessDashboardSpeaker,
} from "@sessionbox-killer/contracts/readiness";
import { evaluateScheduleConflicts } from "@sessionbox-killer/domain";

import { D1ScheduleProjectionRepository } from "../schedule/d1-repository.js";
import { TaskReadService, type TaskEventScope } from "../tasks/service.js";

const maximumDefinitions = 500;
const maximumSessions = 10_000;
const maximumTracks = 500;
const readinessProjectionTables = [
  "contacts",
  "event_contacts",
  "submissions",
  "reviews",
  "sessions",
  "session_participants",
  "task_definitions",
  "task_assignments",
  "schedule_slots",
  "tracks",
] as const;

interface EventRow {
  name: string;
  projected_at: string;
}

interface ContactRow {
  company: string | null;
  contact_id: string;
  portal_state: ReadinessDashboardSpeaker["portal_state"];
}

interface SessionRow {
  contact_id: string;
  id: string;
  title: string;
  track_id: string | null;
  track_name: string | null;
}

interface OptionRow {
  id: string;
  name: string;
}

interface CountRow {
  count: number;
}

interface ProjectionRow {
  as_of: string | null;
  authority_ready_at: string | null;
  full_scan_required: number | null;
  pending_repairs: number;
  watermark_count: number;
  webhook_status: string | null;
}

function speakerStatusRank(speaker: ReadinessDashboardSpeaker): number {
  if (speaker.readiness.status === "overdue") return 0;
  if (speaker.readiness.status === "outstanding") return 1;
  if (speaker.readiness.status === "not_configured") return 2;
  return 3;
}

function compareSpeakers(
  left: ReadinessDashboardSpeaker,
  right: ReadinessDashboardSpeaker,
): number {
  const rank = speakerStatusRank(left) - speakerStatusRank(right);
  if (rank !== 0) return rank;
  const overdue = right.readiness.overdue_count - left.readiness.overdue_count;
  if (overdue !== 0) return overdue;
  const outstanding =
    right.readiness.outstanding_count - left.readiness.outstanding_count;
  if (outstanding !== 0) return outstanding;
  const leftDue = left.readiness.next_due?.at ?? "9999";
  const rightDue = right.readiness.next_due?.at ?? "9999";
  const due = leftDue.localeCompare(rightDue);
  return due !== 0
    ? due
    : left.display_name.localeCompare(right.display_name, undefined, {
        sensitivity: "base",
      });
}

function matchesQuery(
  speaker: ReadinessDashboardSpeaker,
  query: ReadinessDashboardQuery,
  now: Date,
): boolean {
  if (
    query.readiness !== "all" &&
    speaker.readiness.status !== query.readiness
  ) {
    return false;
  }
  if (query.portal !== "all" && speaker.portal_state !== query.portal) {
    return false;
  }
  if (
    query.track !== "all" &&
    !speaker.sessions.some(({ track }) => track?.id === query.track)
  ) {
    return false;
  }
  if (
    query.task !== "all" &&
    !speaker.task_definition_ids.includes(query.task)
  ) {
    return false;
  }
  const nextDue = speaker.readiness.next_due?.at ?? null;
  if (query.due === "overdue" && speaker.readiness.overdue_count === 0) {
    return false;
  }
  if (query.due === "complete" && speaker.readiness.status !== "ready") {
    return false;
  }
  if (
    query.due === "no_due" &&
    (nextDue !== null || speaker.readiness.status === "ready")
  ) {
    return false;
  }
  if (query.due === "next_7_days") {
    const sevenDays = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000);
    if (
      nextDue === null ||
      new Date(nextDue).getTime() < now.getTime() ||
      new Date(nextDue).getTime() > sevenDays.getTime()
    ) {
      return false;
    }
  }
  if (query.q) {
    const haystack = [
      speaker.display_name,
      speaker.email,
      speaker.company,
      ...speaker.sessions.map(({ title, track }) =>
        track ? `${title} ${track.name}` : title,
      ),
    ]
      .join(" ")
      .toLocaleLowerCase();
    if (!haystack.includes(query.q.toLocaleLowerCase())) return false;
  }
  return true;
}

export class ReadinessDashboardService {
  readonly #database: D1Database;
  readonly #now: () => Date;

  constructor(database: D1Database, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#now = now;
  }

  async read(
    event: TaskEventScope,
    query: ReadinessDashboardQuery,
  ): Promise<ReadinessDashboardResponse> {
    const now = this.#now();
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString();
    const placeholders = readinessProjectionTables
      .map((_, index) => `?${index + 3}`)
      .join(", ");
    const taskReadService = new TaskReadService(this.#database, () => now);
    const scheduleRepository = new D1ScheduleProjectionRepository(
      this.#database,
    );

    const [
      taskReadiness,
      eventRow,
      contacts,
      sessions,
      taskOptions,
      trackOptions,
      newSubmissions,
      reviewsRemaining,
      acceptedUnscheduled,
      projection,
      scheduleResult,
    ] = await Promise.all([
      taskReadService.readiness(event),
      this.#database
        .prepare(
          `SELECT name, projected_at FROM p_events
           WHERE organization_id = ?1 AND id = ?2
             AND source_deleted_at IS NULL LIMIT 1`,
        )
        .bind(event.organizationId, event.eventId)
        .first<EventRow>(),
      this.#database
        .prepare(
          `SELECT event_contact.contact_id, event_contact.portal_state,
                  contact.company
           FROM p_event_contacts AS event_contact
           JOIN p_contacts AS contact
             ON contact.organization_id = event_contact.organization_id
            AND contact.id = event_contact.contact_id
            AND contact.source_deleted_at IS NULL
           WHERE event_contact.organization_id = ?1
             AND event_contact.event_id = ?2
             AND event_contact.source_deleted_at IS NULL
             AND EXISTS (
               SELECT 1 FROM json_each(event_contact.roles_json)
               WHERE json_each.value = 'speaker'
             )
           ORDER BY event_contact.contact_id LIMIT 5001`,
        )
        .bind(event.organizationId, event.eventId)
        .all<ContactRow>(),
      this.#database
        .prepare(
          `SELECT participant.contact_id, session.id, session.title,
                  track.id AS track_id, track.name AS track_name
           FROM p_session_participants AS participant
           JOIN p_sessions AS session
             ON session.organization_id = participant.organization_id
            AND session.event_id = participant.event_id
            AND session.id = participant.session_id
            AND session.source_deleted_at IS NULL
            AND session.status <> 'canceled'
           LEFT JOIN p_tracks AS track
             ON track.organization_id = session.organization_id
            AND track.event_id = session.event_id
            AND track.id = session.track_id
            AND track.source_deleted_at IS NULL
           WHERE participant.organization_id = ?1
             AND participant.event_id = ?2
             AND participant.role = 'speaker'
             AND participant.confirmed_state <> 'declined'
             AND participant.source_deleted_at IS NULL
           ORDER BY participant.contact_id, session.title, session.id
           LIMIT ?3`,
        )
        .bind(event.organizationId, event.eventId, maximumSessions + 1)
        .all<SessionRow>(),
      this.#database
        .prepare(
          `SELECT id, name FROM p_task_definitions
           WHERE organization_id = ?1 AND event_id = ?2
             AND source_deleted_at IS NULL
           ORDER BY name, id LIMIT ?3`,
        )
        .bind(event.organizationId, event.eventId, maximumDefinitions + 1)
        .all<OptionRow>(),
      this.#database
        .prepare(
          `SELECT id, name FROM p_tracks
           WHERE organization_id = ?1 AND event_id = ?2
             AND source_deleted_at IS NULL
           ORDER BY sort_order, name, id LIMIT ?3`,
        )
        .bind(event.organizationId, event.eventId, maximumTracks + 1)
        .all<OptionRow>(),
      this.#database
        .prepare(
          `SELECT COUNT(*) AS count FROM p_submissions
           WHERE organization_id = ?1 AND event_id = ?2
             AND submitted_at >= ?3 AND status <> 'draft'
             AND status <> 'withdrawn' AND source_deleted_at IS NULL`,
        )
        .bind(event.organizationId, event.eventId, since)
        .first<CountRow>(),
      this.#database
        .prepare(
          `SELECT COUNT(*) AS count FROM p_reviews
           WHERE organization_id = ?1 AND event_id = ?2
             AND status IN ('assigned', 'draft')
             AND source_deleted_at IS NULL`,
        )
        .bind(event.organizationId, event.eventId)
        .first<CountRow>(),
      this.#database
        .prepare(
          `SELECT COUNT(*) AS count FROM p_sessions AS session
           WHERE session.organization_id = ?1 AND session.event_id = ?2
             AND session.status = 'accepted'
             AND session.source_deleted_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM p_schedule_slots AS slot
               WHERE slot.organization_id = session.organization_id
                 AND slot.event_id = session.event_id
                 AND slot.session_id = session.id
                 AND slot.source_deleted_at IS NULL
             )`,
        )
        .bind(event.organizationId, event.eventId)
        .first<CountRow>(),
      this.#database
        .prepare(
          `SELECT tenant.authority_ready_at,
                  COALESCE(MIN(watermark.updated_at),
                           tenant.authority_ready_at, event.projected_at) AS as_of,
                  COUNT(DISTINCT watermark.table_key) AS watermark_count,
                  webhook.status AS webhook_status,
                  webhook.full_scan_required,
                  (
                    SELECT COUNT(*) FROM projection_repairs AS repair
                    WHERE repair.organization_id = ?1
                      AND (repair.event_id = ?2 OR repair.event_id IS NULL)
                      AND repair.provider_table_key IN (${placeholders})
                      AND repair.status <> 'complete'
                  ) AS pending_repairs
           FROM p_events AS event
           JOIN tenant_registry AS tenant
             ON tenant.organization_id = event.organization_id
            AND tenant.status = 'active'
           LEFT JOIN projection_watermarks AS watermark
             ON watermark.organization_id = event.organization_id
            AND watermark.provider = 'airtable'
            AND watermark.base_key = tenant.base_key
            AND watermark.table_key IN (${placeholders})
           LEFT JOIN airtable_webhooks AS webhook
             ON webhook.base_key = tenant.base_key
           WHERE event.organization_id = ?1 AND event.id = ?2
             AND event.source_deleted_at IS NULL
           GROUP BY tenant.organization_id LIMIT 1`,
        )
        .bind(event.organizationId, event.eventId, ...readinessProjectionTables)
        .first<ProjectionRow>(),
      scheduleRepository
        .read(event.eventId)
        .then((schedule) => ({ available: schedule !== null, schedule }))
        .catch(() => ({ available: false, schedule: null })),
    ]);

    if (!eventRow || !projection) {
      throw new Error("Readiness event projection is unavailable.");
    }
    if (
      contacts.results.length > 5_000 ||
      sessions.results.length > maximumSessions ||
      taskOptions.results.length > maximumDefinitions ||
      trackOptions.results.length > maximumTracks
    ) {
      throw new Error("Readiness projection exceeds its bounded read limits.");
    }

    const contactById = new Map(
      contacts.results.map((contact) => [contact.contact_id, contact]),
    );
    const sessionsByContact = new Map<string, SessionRow[]>();
    for (const session of sessions.results) {
      const current = sessionsByContact.get(session.contact_id) ?? [];
      current.push(session);
      sessionsByContact.set(session.contact_id, current);
    }

    const allSpeakers: ReadinessDashboardSpeaker[] = taskReadiness.speakers.map(
      (speaker) => {
        const contact = contactById.get(speaker.contact_id);
        if (!contact) {
          throw new Error(
            `Readiness contact ${speaker.contact_id} is missing its event projection.`,
          );
        }
        return {
          company: contact.company?.trim() ?? "",
          contact_id: speaker.contact_id,
          display_name: speaker.display_name,
          email: speaker.email,
          portal_state: contact.portal_state,
          readiness: speaker.readiness,
          sessions: (sessionsByContact.get(speaker.contact_id) ?? []).map(
            (session) => ({
              id: session.id,
              title: session.title,
              track:
                session.track_id && session.track_name
                  ? { id: session.track_id, name: session.track_name }
                  : null,
            }),
          ),
          task_definition_ids: Array.from(
            new Set(
              speaker.assignments.map((assignment) => assignment.definition_id),
            ),
          ).sort(),
        };
      },
    );
    const orderedSpeakers = allSpeakers.toSorted(compareSpeakers);
    const filteredSpeakers = orderedSpeakers.filter((speaker) =>
      matchesQuery(speaker, query, now),
    );
    const totalPages = Math.ceil(filteredSpeakers.length / query.page_size);
    const offset = (query.page - 1) * query.page_size;
    const reasons: ReadinessDashboardResponse["projection"]["reasons"] = [];
    if (
      !projection.authority_ready_at ||
      projection.watermark_count !== readinessProjectionTables.length
    ) {
      reasons.push("upstream_rebuilding");
    }
    if (
      projection.webhook_status &&
      (projection.webhook_status !== "active" ||
        projection.full_scan_required === 1)
    ) {
      reasons.push("synchronization_delayed");
    }
    if (projection.pending_repairs > 0) reasons.push("repair_pending");
    if (!scheduleResult.available) reasons.push("schedule_unavailable");

    return readinessDashboardResponseSchema.parse({
      attention: orderedSpeakers
        .filter(({ readiness }) => readiness.status !== "ready")
        .slice(0, 5),
      event: {
        id: event.eventId,
        name: eventRow.name,
        slug: event.slug,
        timezone: event.timezone,
      },
      filters: {
        tasks: taskOptions.results,
        tracks: trackOptions.results,
      },
      generated_at: taskReadiness.generated_at,
      metrics: {
        accepted_unscheduled: acceptedUnscheduled?.count ?? 0,
        hard_conflicts: scheduleResult.schedule
          ? evaluateScheduleConflicts(scheduleResult.schedule).hardConflicts
              .length
          : null,
        new_submissions: newSubmissions?.count ?? 0,
        overdue_assignments: allSpeakers.reduce(
          (sum, speaker) => sum + speaker.readiness.overdue_count,
          0,
        ),
        reviews_remaining: reviewsRemaining?.count ?? 0,
        speakers_ready: allSpeakers.filter(
          ({ readiness }) => readiness.status === "ready",
        ).length,
        speakers_total: allSpeakers.length,
      },
      page: {
        number: query.page,
        size: query.page_size,
        total: filteredSpeakers.length,
        total_pages: totalPages,
      },
      projection: {
        as_of: projection.as_of ?? eventRow.projected_at,
        pending_repairs: projection.pending_repairs,
        reasons,
        state:
          reasons.includes("upstream_rebuilding") ||
          reasons.includes("repair_pending") ||
          reasons.includes("schedule_unavailable")
            ? "partial"
            : reasons.length > 0
              ? "stale"
              : "current",
      },
      speakers: filteredSpeakers.slice(offset, offset + query.page_size),
    });
  }
}
