import {
  scheduleSnapshotSchema,
  type ScheduleSnapshot,
} from "@sessionbox-killer/contracts";

interface EventRow {
  id: string;
  organization_id: string;
  published_version: number;
  schedule_days_json: string;
  schedule_snap_minutes: number;
  schedule_version: number;
  slug: string;
  timezone: string;
}

interface RoomRow {
  capacity: number | null;
  id: string;
  name: string;
  sort_order: number;
}

interface TrackRow {
  id: string;
  name: string;
  sort_order: number;
}

interface FormatRow {
  default_duration_minutes: number | null;
  id: string;
  name: string;
  sort_order: number;
}

interface SessionRow {
  abstract: string | null;
  duration_minutes: number | null;
  ends_at: string | null;
  expected_attendance: number | null;
  format_id: string | null;
  id: string;
  is_public: number;
  override_reason: string | null;
  published_version: number | null;
  room_id: string | null;
  starts_at: string | null;
  status: string;
  title: string;
  track_id: string | null;
  version: number | null;
}

interface ParticipantRow {
  contact_id: string;
  display_name: string;
  missing_required_task_count: number;
  readiness_state: "missing_required_tasks" | "not_configured" | "ready";
  role: string;
  session_id: string;
}

interface ApplyingReceiptRow {
  result_json: string;
}

function previousCommittedSnapshot(value: string): ScheduleSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("D1 schedule receipt contains invalid JSON.");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !("version" in parsed) ||
    (parsed.version !== 1 && parsed.version !== 2) ||
    !("previousSnapshot" in parsed)
  ) {
    return null;
  }
  return scheduleSnapshotSchema.parse(parsed.previousSnapshot);
}

function parseScheduleDays(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("D1 schedule days projection contains invalid JSON.");
  }
}

function lifecycleState(status: string) {
  return status === "accepted" ? "accepted_unscheduled" : status;
}

function slotForSession(row: SessionRow) {
  if (row.status === "accepted" || row.status === "canceled") return null;
  if (
    row.room_id === null ||
    row.starts_at === null ||
    row.ends_at === null ||
    row.version === null ||
    row.published_version === null
  ) {
    throw new Error(`D1 schedule session ${row.id} is missing its slot.`);
  }
  return {
    endAt: row.ends_at,
    overrideReason: row.override_reason?.trim() || null,
    publicationVersion: row.published_version,
    roomId: row.room_id,
    startAt: row.starts_at,
    version: row.version,
  };
}

export class D1ScheduleProjectionRepository {
  readonly #database: D1Database;

  constructor(database: D1Database) {
    this.#database = database;
  }

  async read(eventId: string): Promise<ScheduleSnapshot | null> {
    const applyingReceipt = await this.#database
      .prepare(
        `SELECT result_json
         FROM schedule_command_receipts
         WHERE event_id = ? AND state = 'applying'
         ORDER BY created_at, command_id
         LIMIT 1`,
      )
      .bind(eventId)
      .first<ApplyingReceiptRow>();
    if (applyingReceipt) {
      const previous = previousCommittedSnapshot(applyingReceipt.result_json);
      if (previous) return previous;
    }

    const event = await this.#database
      .prepare(
        `SELECT id, organization_id, slug, timezone, schedule_days_json,
                schedule_snap_minutes, schedule_version, published_version
         FROM p_events
         WHERE id = ? AND source_deleted_at IS NULL`,
      )
      .bind(eventId)
      .first<EventRow>();
    if (!event) return null;

    const [roomRows, trackRows, formatRows, sessionRows, participantRows] =
      await Promise.all([
        this.#database
          .prepare(
            `SELECT id, name, capacity, sort_order
             FROM p_rooms
             WHERE organization_id = ? AND event_id = ?
               AND source_deleted_at IS NULL
             ORDER BY sort_order, id
             LIMIT 65`,
          )
          .bind(event.organization_id, event.id)
          .all<RoomRow>(),
        this.#database
          .prepare(
            `SELECT id, name, sort_order
             FROM p_tracks
             WHERE organization_id = ? AND event_id = ?
               AND source_deleted_at IS NULL
             ORDER BY sort_order, id
             LIMIT 65`,
          )
          .bind(event.organization_id, event.id)
          .all<TrackRow>(),
        this.#database
          .prepare(
            `SELECT id, name, default_duration_minutes, sort_order
             FROM p_formats
             WHERE organization_id = ? AND event_id = ?
               AND source_deleted_at IS NULL
             ORDER BY sort_order, id
             LIMIT 65`,
          )
          .bind(event.organization_id, event.id)
          .all<FormatRow>(),
        this.#database
          .prepare(
            `SELECT session.id, session.title, session.abstract, session.status,
                    session.is_public,
                    session.track_id, session.format_id,
                    session.duration_minutes, session.expected_attendance,
                    slot.room_id, slot.override_reason,
                    slot.starts_at, slot.ends_at, slot.version,
                    slot.published_version
             FROM p_sessions AS session
             LEFT JOIN p_schedule_slots AS slot
               ON slot.organization_id = session.organization_id
              AND slot.event_id = session.event_id
              AND slot.session_id = session.id
              AND slot.source_deleted_at IS NULL
             WHERE session.organization_id = ? AND session.event_id = ?
               AND session.status IN ('accepted', 'scheduled', 'published', 'canceled')
               AND session.source_deleted_at IS NULL
             ORDER BY session.id
             LIMIT 2001`,
          )
          .bind(event.organization_id, event.id)
          .all<SessionRow>(),
        this.#database
          .prepare(
            `SELECT participant.session_id, participant.contact_id,
                    participant.role, contact.display_name,
                    CASE
                      WHEN COUNT(assignment.id) = 0 THEN 'not_configured'
                      WHEN SUM(
                        CASE
                          WHEN assignment.status = 'waived' OR (
                            assignment.status = 'complete' AND (
                              definition.approval_required = 0 OR
                              assignment.approved_at IS NOT NULL
                            )
                          ) THEN 0
                          ELSE 1
                        END
                      ) = 0 THEN 'ready'
                      ELSE 'missing_required_tasks'
                    END AS readiness_state,
                    SUM(
                      CASE
                        WHEN assignment.id IS NULL OR
                          assignment.status = 'waived' OR (
                            assignment.status = 'complete' AND (
                              definition.approval_required = 0 OR
                              assignment.approved_at IS NOT NULL
                            )
                          ) THEN 0
                        ELSE 1
                      END
                    ) AS missing_required_task_count
             FROM p_session_participants AS participant
             JOIN p_contacts AS contact
               ON contact.organization_id = participant.organization_id
              AND contact.id = participant.contact_id
              AND contact.source_deleted_at IS NULL
             JOIN p_sessions AS session
               ON session.organization_id = participant.organization_id
              AND session.event_id = participant.event_id
              AND session.id = participant.session_id
              AND session.status IN ('accepted', 'scheduled', 'published', 'canceled')
              AND session.source_deleted_at IS NULL
             LEFT JOIN p_task_assignments AS assignment
               ON assignment.organization_id = participant.organization_id
              AND assignment.event_id = participant.event_id
              AND assignment.contact_id = participant.contact_id
              AND assignment.required = 1
              AND (
                assignment.session_id IS NULL OR
                assignment.session_id = participant.session_id
              )
              AND assignment.source_deleted_at IS NULL
             LEFT JOIN p_task_definitions AS definition
               ON definition.organization_id = assignment.organization_id
              AND definition.event_id = assignment.event_id
              AND definition.id = assignment.definition_id
              AND definition.source_deleted_at IS NULL
             WHERE participant.organization_id = ? AND participant.event_id = ?
               AND participant.confirmed_state <> 'declined'
               AND participant.source_deleted_at IS NULL
             GROUP BY participant.id, participant.session_id,
                      participant.contact_id, participant.role,
                      participant.sort_order, contact.display_name
             ORDER BY participant.session_id, participant.sort_order,
                      participant.id
             LIMIT 10001`,
          )
          .bind(event.organization_id, event.id)
          .all<ParticipantRow>(),
      ]);

    if (
      roomRows.results.length > 64 ||
      trackRows.results.length > 64 ||
      formatRows.results.length > 64 ||
      sessionRows.results.length > 2_000 ||
      participantRows.results.length > 10_000
    ) {
      throw new Error(
        "D1 schedule projection exceeds its bounded read limits.",
      );
    }

    const participantsBySession = new Map<
      string,
      {
        displayName: string;
        personId: string;
        readiness: {
          missingRequiredTaskCount: number;
          state: ParticipantRow["readiness_state"];
        };
        role: string;
      }[]
    >();
    for (const participant of participantRows.results) {
      const participants =
        participantsBySession.get(participant.session_id) ?? [];
      participants.push({
        displayName: participant.display_name,
        personId: participant.contact_id,
        readiness: {
          missingRequiredTaskCount: participant.missing_required_task_count,
          state: participant.readiness_state,
        },
        role: participant.role,
      });
      participantsBySession.set(participant.session_id, participants);
    }

    return scheduleSnapshotSchema.parse({
      event: {
        days: parseScheduleDays(event.schedule_days_json),
        eventId: event.id,
        publicationVersion: event.published_version,
        slug: event.slug,
        snapMinutes: event.schedule_snap_minutes,
        timezone: event.timezone,
        version: event.schedule_version,
      },
      formats: formatRows.results.map((format) => ({
        defaultDurationMinutes: format.default_duration_minutes,
        id: format.id,
        name: format.name,
        order: format.sort_order - 1,
      })),
      rooms: roomRows.results.map((room) => ({
        capacity: room.capacity,
        id: room.id,
        name: room.name,
        order: room.sort_order - 1,
      })),
      sessions: sessionRows.results.map((session) => ({
        abstract: session.abstract ?? "",
        durationMinutes: session.duration_minutes,
        expectedAttendance: session.expected_attendance,
        formatId: session.format_id,
        id: session.id,
        isPublic: session.is_public === 1,
        participants: participantsBySession.get(session.id) ?? [],
        slot: slotForSession(session),
        state: lifecycleState(session.status),
        title: session.title,
        trackId: session.track_id,
      })),
      tracks: trackRows.results.map((track) => ({
        id: track.id,
        name: track.name,
        order: track.sort_order - 1,
      })),
    });
  }
}
