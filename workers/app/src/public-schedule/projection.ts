import {
  publicScheduleProjectionSchema,
  type PublicScheduleProjection,
  type PublicSessionView,
  type PublicSpeakerView,
} from "@sessionbox-killer/contracts";

interface EventRow {
  brand_json: string;
  ends_at: string | null;
  id: string;
  name: string;
  organization_id: string;
  projected_at: string;
  published_version: number;
  slug: string;
  starts_at: string | null;
  timezone: string;
  venue: string | null;
}

interface SessionRow {
  abstract: string | null;
  end_at: string;
  format_name: string | null;
  friendly_id: string;
  format_projected_at: string | null;
  room_id: string;
  room_name: string;
  room_projected_at: string;
  session_id: string;
  session_projected_at: string;
  slot_projected_at: string;
  start_at: string;
  title: string;
  track_name: string | null;
  track_projected_at: string | null;
}

interface SpeakerRow {
  company: string | null;
  contact_projected_at: string;
  display_name: string;
  participant_projected_at: string;
  participant_role: string;
  session_id: string;
  title: string | null;
}

interface PublicationRow {
  event_id: string;
  public_projection_json: string;
}

export interface PublicScheduleReadResult {
  eventId: string;
  projection: PublicScheduleProjection;
}

export interface PublicScheduleProjectionReader {
  readBySlug(slug: string): Promise<PublicScheduleReadResult | null>;
}

function publicSummary(brandJson: string): string {
  const value: unknown = JSON.parse(brandJson);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "Explore the latest published program.";
  }
  const record = value as Record<string, unknown>;
  const summary = record.publicSummary ?? record.summary;
  return typeof summary === "string" && summary.trim()
    ? summary.trim()
    : "Explore the latest published program.";
}

function eventDates(event: EventRow): string {
  if (!event.starts_at || !event.ends_at) {
    return "Dates to be announced";
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "long",
    timeZone: event.timezone,
    year: "numeric",
  });
  return formatter.formatRange(
    new Date(event.starts_at),
    new Date(event.ends_at),
  );
}

function localDate(value: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  if (!year || !month || !day) {
    throw new Error("Unable to derive the public schedule day.");
  }
  return `${year}-${month}-${day}`;
}

function projectedAt(values: (string | null)[]): string {
  const timestamps = values.filter((value): value is string => value !== null);
  timestamps.sort();
  const latest = timestamps.at(-1);
  if (!latest) {
    throw new Error("Public projection does not have a projection timestamp.");
  }
  return latest;
}

function speakerView(row: SpeakerRow): PublicSpeakerView {
  return {
    company: row.company ?? "",
    name: row.display_name,
    role: row.title ?? row.participant_role,
  };
}

export class D1PublicScheduleProjectionReader implements PublicScheduleProjectionReader {
  readonly #database: D1Database;

  constructor(database: D1Database) {
    this.#database = database;
  }

  async readBySlug(slug: string): Promise<PublicScheduleReadResult | null> {
    const committed = await this.#database
      .prepare(
        `SELECT publication.event_id, publication.public_projection_json
         FROM schedule_publications AS publication
         JOIN p_events AS event
           ON event.organization_id = publication.organization_id
          AND event.id = publication.event_id
         WHERE event.slug = ? AND event.source_deleted_at IS NULL
           AND publication.publication_version = (
             SELECT MAX(candidate.publication_version)
             FROM schedule_publications AS candidate
             WHERE candidate.organization_id = publication.organization_id
               AND candidate.event_id = publication.event_id
           )
         ORDER BY publication.organization_id, publication.event_id
         LIMIT 2`,
      )
      .bind(slug)
      .all<PublicationRow>();
    if (committed.results.length > 1) {
      throw new Error("Public event slug resolves to multiple organizations.");
    }
    const publication = committed.results[0];
    if (publication) {
      return {
        eventId: publication.event_id,
        projection: publicScheduleProjectionSchema.parse(
          JSON.parse(publication.public_projection_json) as unknown,
        ),
      };
    }

    const live = await this.#readLiveEvent("slug", slug);
    if (!live) return null;
    const applying = await this.#database
      .prepare(
        `SELECT 1 FROM schedule_command_receipts
         WHERE event_id = ? AND state = 'applying' LIMIT 1`,
      )
      .bind(live.eventId)
      .first<{ 1: number }>();
    return applying ? null : live;
  }

  readLiveByEventId(eventId: string): Promise<PublicScheduleReadResult | null> {
    return this.#readLiveEvent("id", eventId);
  }

  async #readLiveEvent(
    selector: "id" | "slug",
    value: string,
  ): Promise<PublicScheduleReadResult | null> {
    const eventResult = await this.#database
      .prepare(
        `SELECT id, organization_id, name, slug, timezone, starts_at, ends_at,
                venue, brand_json, published_version, projected_at
         FROM p_events
         WHERE ${selector} = ? AND status = 'published' AND published_version > 0
           AND source_deleted_at IS NULL
         ORDER BY organization_id, id
         LIMIT 2`,
      )
      .bind(value)
      .all<EventRow>();

    const event = eventResult.results[0];
    if (!event) {
      return null;
    }
    if (eventResult.results.length > 1) {
      throw new Error("Public event slug resolves to multiple organizations.");
    }

    return this.#buildLiveProjection(event);
  }

  async #buildLiveProjection(
    event: EventRow,
  ): Promise<PublicScheduleReadResult> {
    const [sessionResult, speakerResult] = await Promise.all([
      this.#database
        .prepare(
          `SELECT s.id AS session_id, s.friendly_id, s.title, s.abstract,
                  s.projected_at AS session_projected_at,
                  slot.starts_at AS start_at, slot.ends_at AS end_at,
                  slot.projected_at AS slot_projected_at,
                  room.id AS room_id, room.name AS room_name,
                  room.projected_at AS room_projected_at,
                  track.name AS track_name,
                  track.projected_at AS track_projected_at,
                  format.name AS format_name,
                  format.projected_at AS format_projected_at
           FROM p_sessions AS s
           JOIN p_schedule_slots AS slot
             ON slot.organization_id = s.organization_id
            AND slot.event_id = s.event_id
            AND slot.session_id = s.id
            AND slot.published_version = ?
            AND slot.source_deleted_at IS NULL
           JOIN p_rooms AS room
             ON room.organization_id = s.organization_id
            AND room.event_id = s.event_id
            AND room.id = slot.room_id
            AND room.source_deleted_at IS NULL
           LEFT JOIN p_tracks AS track
             ON track.organization_id = s.organization_id
            AND track.event_id = s.event_id
            AND track.id = s.track_id
            AND track.source_deleted_at IS NULL
           LEFT JOIN p_formats AS format
             ON format.organization_id = s.organization_id
            AND format.event_id = s.event_id
            AND format.id = s.format_id
            AND format.source_deleted_at IS NULL
           WHERE s.organization_id = ? AND s.event_id = ?
             AND s.status = 'published' AND s.is_public = 1
             AND s.source_deleted_at IS NULL
           ORDER BY slot.starts_at, room.name, s.friendly_id
           LIMIT 2001`,
        )
        .bind(event.published_version, event.organization_id, event.id)
        .all<SessionRow>(),
      this.#database
        .prepare(
          `SELECT participant.session_id, participant.role AS participant_role,
                  participant.projected_at AS participant_projected_at,
                  contact.display_name, contact.company, contact.title,
                  contact.projected_at AS contact_projected_at
           FROM p_session_participants AS participant
           JOIN p_sessions AS session
             ON session.organization_id = participant.organization_id
            AND session.event_id = participant.event_id
            AND session.id = participant.session_id
            AND session.status = 'published'
            AND session.is_public = 1
            AND session.source_deleted_at IS NULL
           JOIN p_schedule_slots AS slot
             ON slot.organization_id = participant.organization_id
            AND slot.event_id = participant.event_id
            AND slot.session_id = participant.session_id
            AND slot.published_version = ?
            AND slot.source_deleted_at IS NULL
           JOIN p_contacts AS contact
             ON contact.organization_id = participant.organization_id
            AND contact.id = participant.contact_id
            AND contact.source_deleted_at IS NULL
           WHERE participant.organization_id = ? AND participant.event_id = ?
             AND participant.confirmed_state = 'confirmed'
             AND participant.source_deleted_at IS NULL
           ORDER BY participant.session_id, participant.sort_order, contact.display_name
           LIMIT 10001`,
        )
        .bind(event.published_version, event.organization_id, event.id)
        .all<SpeakerRow>(),
    ]);

    if (sessionResult.results.length > 2_000) {
      throw new Error(
        "Public schedule exceeds the 2,000-session response limit.",
      );
    }
    if (speakerResult.results.length > 10_000) {
      throw new Error(
        "Public schedule exceeds the 10,000-speaker response limit.",
      );
    }

    const speakersBySession = new Map<string, PublicSpeakerView[]>();
    for (const row of speakerResult.results) {
      const current = speakersBySession.get(row.session_id) ?? [];
      current.push(speakerView(row));
      speakersBySession.set(row.session_id, current);
    }

    const sessions: PublicSessionView[] = sessionResult.results.map((row) => ({
      abstract: row.abstract ?? "",
      day: localDate(row.start_at, event.timezone),
      endAt: row.end_at,
      format: row.format_name ?? "Session",
      id: row.friendly_id,
      publicationStatus: "published",
      publicationVersion: event.published_version,
      roomId: row.room_id,
      roomName: row.room_name,
      speakers: speakersBySession.get(row.session_id) ?? [],
      startAt: row.start_at,
      title: row.title,
      track: row.track_name ?? "General",
    }));

    const generatedAt = projectedAt([
      event.projected_at,
      ...sessionResult.results.flatMap((row) => [
        row.session_projected_at,
        row.slot_projected_at,
        row.room_projected_at,
        row.track_projected_at,
        row.format_projected_at,
      ]),
      ...speakerResult.results.flatMap((row) => [
        row.participant_projected_at,
        row.contact_projected_at,
      ]),
    ]);

    const projection = publicScheduleProjectionSchema.parse({
      event: {
        dates: eventDates(event),
        location: event.venue ?? "Venue to be announced",
        name: event.name,
        slug: event.slug,
        summary: publicSummary(event.brand_json),
        timezone: event.timezone,
      },
      generatedAt,
      sessions,
      version: event.published_version,
    });

    return { eventId: event.id, projection };
  }
}
