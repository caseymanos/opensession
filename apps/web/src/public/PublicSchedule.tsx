import { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Bookmark,
  BookmarkCheck,
  CalendarDays,
  Check,
  Clock3,
  Download,
  ExternalLink,
  Filter,
  Globe2,
  MapPin,
  Search,
  Share2,
  Sparkles,
  Ticket,
  Users,
} from "lucide-react";

import {
  Button,
  ProductWordmark,
  SelectField,
  StatePanel,
  StatusPill,
  TextField,
  ToastRegion,
  type ToastMessage,
} from "@sessionbox-killer/ui";
import {
  publicScheduleProjectionSchema,
  type PublicScheduleProjection,
} from "@sessionbox-killer/contracts";

import {
  publicScheduleProjectionFixture,
  sessionsInPublishedProjection,
  type PublicScheduleDay,
  type PublicSessionView,
} from "./publicScheduleModel";
import {
  findItineraryConflicts,
  itineraryCalendarHref,
  personalItineraryStorageKey,
  restorePersonalItinerary,
  selectedSessionsForItinerary,
  serializePersonalItinerary,
} from "./personalItineraryModel";
import { publicSpeakerSlug } from "./publicSpeakerRoutes";

import "./public-schedule.css";

const PublicProjectionContext = createContext<PublicScheduleProjection | null>(
  null,
);

interface PublicItineraryContextValue {
  persistenceAvailable: boolean;
  reconciledCount: number;
  selectedIds: ReadonlySet<string>;
  toggleSession: (sessionId: string) => void;
}

const PublicItineraryContext =
  createContext<PublicItineraryContextValue | null>(null);

const trackClass: Record<string, string> = {
  "AI Engineering": "ai",
  Evaluation: "evaluation",
  Infrastructure: "infrastructure",
  Product: "product",
};

function usePublicProjection() {
  const projection = useContext(PublicProjectionContext);
  if (!projection) {
    throw new Error("Public projection context is unavailable.");
  }
  return projection;
}

function usePublicItinerary() {
  const itinerary = useContext(PublicItineraryContext);
  if (!itinerary) {
    throw new Error("Public itinerary context is unavailable.");
  }
  return itinerary;
}

function trackClassName(track: string) {
  return trackClass[track] ?? "general";
}

interface PublicDayDetails {
  date: string;
  label: string;
  short: string;
  value: PublicScheduleDay;
}

function scheduleDays(
  projection: PublicScheduleProjection,
): PublicDayDetails[] {
  const sessions = sessionsInPublishedProjection(projection);
  const byDay = new Map<PublicScheduleDay, string>();
  for (const session of sessions) {
    if (!byDay.has(session.day)) {
      byDay.set(session.day, session.startAt);
    }
  }
  return [...byDay.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([value, startAt]) => {
      const date = new Date(startAt);
      return {
        date: new Intl.DateTimeFormat("en-US", {
          day: "numeric",
          month: "long",
          timeZone: projection.event.timezone,
        }).format(date),
        label: new Intl.DateTimeFormat("en-US", {
          timeZone: projection.event.timezone,
          weekday: "long",
        }).format(date),
        short: new Intl.DateTimeFormat("en-US", {
          timeZone: projection.event.timezone,
          weekday: "short",
        }).format(date),
        value,
      };
    });
}

function projectionRooms(projection: PublicScheduleProjection) {
  const rooms = new Map<string, string>();
  for (const session of sessionsInPublishedProjection(projection)) {
    rooms.set(session.roomId, session.roomName);
  }
  return [...rooms.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function projectionTracks(projection: PublicScheduleProjection) {
  return [
    ...new Set(
      sessionsInPublishedProjection(projection).map((session) => session.track),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

interface PublicUrlState {
  day: PublicScheduleDay;
  q: string;
  room: string;
  track: string;
  view: "mine" | "schedule";
}

function getPublicUrlState(
  projection: PublicScheduleProjection,
): PublicUrlState {
  const params = new URLSearchParams(window.location.search);
  const days = scheduleDays(projection);
  const defaultDay = days[0]?.value ?? "";
  const candidateDay = params.get("day");
  const candidateRoom = params.get("room");
  const candidateTrack = params.get("track");
  const rooms = projectionRooms(projection);
  const tracks = projectionTracks(projection);

  return {
    day:
      candidateDay && days.some((day) => day.value === candidateDay)
        ? candidateDay
        : defaultDay,
    q: params.get("q")?.slice(0, 120) ?? "",
    room:
      candidateRoom && rooms.some((room) => room.id === candidateRoom)
        ? candidateRoom
        : "all",
    track:
      candidateTrack && tracks.includes(candidateTrack)
        ? candidateTrack
        : "all",
    view: params.get("view") === "mine" ? "mine" : "schedule",
  };
}

function updatePublicUrl(
  patch: Partial<PublicUrlState>,
  defaultDay: PublicScheduleDay,
  mode: "push" | "replace" = "replace",
) {
  const params = new URLSearchParams(window.location.search);
  for (const [key, rawValue] of Object.entries(patch)) {
    const value = rawValue.trim();
    if (
      !value ||
      value === "all" ||
      (key === "day" && value === defaultDay) ||
      (key === "view" && value === "schedule")
    ) {
      params.delete(key);
    } else {
      params.set(key, value);
    }
  }
  const query = params.toString();
  window.history[mode === "push" ? "pushState" : "replaceState"](
    null,
    "",
    query ? `${window.location.pathname}?${query}` : window.location.pathname,
  );
}

function formatTime(value: string, timezone: string) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  }).format(new Date(value));
}

function formatLongDate(value: string, timezone: string) {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "long",
    timeZone: timezone,
    weekday: "long",
  }).format(new Date(value));
}

function timeZoneLabel(timezone: string) {
  return timezone === "America/Los_Angeles"
    ? "Pacific time"
    : timezone.replaceAll("_", " ");
}

function formatCalendarDate(value: string) {
  return new Date(value)
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.\d{3}/, "");
}

function durationMinutes(session: PublicSessionView) {
  return Math.round(
    (new Date(session.endAt).getTime() - new Date(session.startAt).getTime()) /
      60_000,
  );
}

function calendarDescription(session: PublicSessionView) {
  return `${session.abstract}\n\nSpeakers: ${session.speakers
    .map((speaker) => speaker.name)
    .join(", ")}`;
}

function calendarDownloadHref(
  session: PublicSessionView,
  projection: PublicScheduleProjection,
) {
  return itineraryCalendarHref(projection, [session]);
}

function googleCalendarHref(
  session: PublicSessionView,
  projection: PublicScheduleProjection,
) {
  const event = projection.event;
  const params = new URLSearchParams({
    action: "TEMPLATE",
    dates: `${formatCalendarDate(session.startAt)}/${formatCalendarDate(session.endAt)}`,
    details: calendarDescription(session),
    location: `${session.roomName}, ${event.location}`,
    text: session.title,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function readPersonalItinerary(projection: PublicScheduleProjection) {
  try {
    const restored = restorePersonalItinerary(
      window.localStorage.getItem(
        personalItineraryStorageKey(projection.event.slug),
      ),
      projection,
    );
    return {
      persistenceAvailable: true,
      reconciledCount: restored.removedCount,
      sessionIds: restored.sessionIds,
    };
  } catch {
    return {
      persistenceAvailable: false,
      reconciledCount: 0,
      sessionIds: [] as string[],
    };
  }
}

function usePersonalItinerary(projection: PublicScheduleProjection) {
  const [initial] = useState(() => readPersonalItinerary(projection));
  const [selectedIds, setSelectedIds] = useState(initial.sessionIds);
  const [persistenceAvailable, setPersistenceAvailable] = useState(
    initial.persistenceAvailable,
  );
  const [reconciledCount, setReconciledCount] = useState(
    initial.reconciledCount,
  );
  const storageKey = personalItineraryStorageKey(projection.event.slug);

  useEffect(() => {
    if (!persistenceAvailable) {
      return;
    }
    try {
      window.localStorage.setItem(
        storageKey,
        serializePersonalItinerary(projection, selectedIds),
      );
    } catch {
      queueMicrotask(() => setPersistenceAvailable(false));
    }
  }, [persistenceAvailable, projection, selectedIds, storageKey]);

  useEffect(() => {
    if (!persistenceAvailable) {
      return;
    }
    function synchronizeFromAnotherTab(event: StorageEvent) {
      if (
        event.key !== storageKey ||
        event.storageArea !== window.localStorage
      ) {
        return;
      }
      const restored = restorePersonalItinerary(event.newValue, projection);
      setSelectedIds(restored.sessionIds);
      setReconciledCount(restored.removedCount);
    }

    window.addEventListener("storage", synchronizeFromAnotherTab);
    return () =>
      window.removeEventListener("storage", synchronizeFromAnotherTab);
  }, [persistenceAvailable, projection, storageKey]);

  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  return useMemo<PublicItineraryContextValue>(
    () => ({
      persistenceAvailable,
      reconciledCount,
      selectedIds: selectedIdSet,
      toggleSession(sessionId) {
        setReconciledCount(0);
        setSelectedIds((current) =>
          current.includes(sessionId)
            ? current.filter((id) => id !== sessionId)
            : [...current, sessionId],
        );
      },
    }),
    [persistenceAvailable, reconciledCount, selectedIdSet],
  );
}

function PublicHeader() {
  const { event } = usePublicProjection();

  return (
    <header className="public-header">
      <a
        aria-label="OpenSession public schedule home"
        className="public-wordmark"
        href={`/e/${event.slug}`}
      >
        <ProductWordmark />
      </a>
      <nav aria-label="Public program">
        <a href={`/e/${event.slug}`}>Schedule</a>
        <a href={`/e/${event.slug}?view=mine`}>My schedule</a>
        <a href={`/e/${event.slug}/speakers`}>Speakers</a>
      </nav>
      <a className="public-organizer-link" href={`/app/${event.slug}/home`}>
        Organizer sign in <ArrowRight aria-hidden="true" size={14} />
      </a>
    </header>
  );
}

function PublicEventIntro() {
  const { event, version } = usePublicProjection();

  return (
    <section className="public-event-intro" aria-labelledby="public-title">
      <div className="public-event-meta">
        <StatusPill tone="success">
          <Check aria-hidden="true" size={12} /> Program live
        </StatusPill>
        <span>Public version {version}</span>
      </div>
      <div className="public-event-intro-grid">
        <div>
          <p className="overline">Published program</p>
          <h1 id="public-title">{event.name}</h1>
          <p>{event.summary}</p>
        </div>
        <dl>
          <div>
            <dt>
              <CalendarDays aria-hidden="true" size={16} /> Dates
            </dt>
            <dd>{event.dates}</dd>
          </div>
          <div>
            <dt>
              <MapPin aria-hidden="true" size={16} /> Venue
            </dt>
            <dd>{event.location}</dd>
          </div>
          <div>
            <dt>
              <Globe2 aria-hidden="true" size={16} /> Times
            </dt>
            <dd>{timeZoneLabel(event.timezone)}</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

function PublicSessionCard({ session }: { session: PublicSessionView }) {
  const projection = usePublicProjection();
  const itinerary = usePublicItinerary();
  const query = new URLSearchParams(window.location.search);
  query.delete("state");
  const href = `/e/${projection.event.slug}/sessions/${session.id}${query.size ? `?${query.toString()}` : ""}`;
  const speakerNames = session.speakers
    .map((speaker) => speaker.name)
    .join(" · ");
  const isSelected = itinerary.selectedIds.has(session.id);

  return (
    <article
      className={`public-session-card is-${trackClassName(session.track)}`}
      aria-labelledby={`${session.id}-title`}
    >
      <a href={href}>
        <time dateTime={session.startAt}>
          <strong>
            {formatTime(session.startAt, projection.event.timezone)}
          </strong>
          <span>{durationMinutes(session)} min</span>
        </time>
        <span className="public-session-card-main">
          <small>{session.track}</small>
          <h3 id={`${session.id}-title`}>{session.title}</h3>
          <span>
            <Users aria-hidden="true" size={14} /> {speakerNames}
          </span>
        </span>
        <span className="public-session-card-meta">
          <span>
            <MapPin aria-hidden="true" size={14} /> {session.roomName}
          </span>
          <span>
            <Ticket aria-hidden="true" size={14} /> {session.format}
          </span>
        </span>
        <span className="public-session-card-arrow" aria-hidden="true">
          <ArrowRight size={17} />
        </span>
      </a>
      <div className="public-session-card-actions">
        <button
          aria-label={`${isSelected ? "Remove" : "Add"} ${session.title} ${
            isSelected ? "from" : "to"
          } my schedule`}
          aria-pressed={isSelected}
          onClick={() => itinerary.toggleSession(session.id)}
          type="button"
        >
          {isSelected ? (
            <BookmarkCheck aria-hidden="true" size={16} />
          ) : (
            <Bookmark aria-hidden="true" size={16} />
          )}
          <span>{isSelected ? "Saved" : "Add"}</span>
        </button>
      </div>
    </article>
  );
}

function PublicItinerarySessionCard({
  conflictingSessions,
  session,
}: {
  conflictingSessions: PublicSessionView[];
  session: PublicSessionView;
}) {
  const projection = usePublicProjection();
  const itinerary = usePublicItinerary();
  const detailParams = new URLSearchParams(window.location.search);
  detailParams.set("view", "mine");
  detailParams.delete("state");
  const detailHref = `/e/${projection.event.slug}/sessions/${session.id}?${detailParams.toString()}`;

  return (
    <article
      className={`public-itinerary-card is-${trackClassName(session.track)}`}
      aria-labelledby={`${session.id}-itinerary-title`}
    >
      <div className="public-itinerary-card-kicker">
        <span>{session.track}</span>
        <span>{session.format}</span>
      </div>
      <h4 id={`${session.id}-itinerary-title`}>
        <a href={detailHref}>{session.title}</a>
      </h4>
      <p>{session.abstract}</p>
      <dl>
        <div>
          <dt>Date and time</dt>
          <dd>
            <time dateTime={session.startAt}>
              {formatLongDate(session.startAt, projection.event.timezone)},{" "}
              {formatTime(session.startAt, projection.event.timezone)}–
              {formatTime(session.endAt, projection.event.timezone)}
            </time>
          </dd>
        </div>
        <div>
          <dt>Room</dt>
          <dd>{session.roomName}</dd>
        </div>
      </dl>
      <div className="public-itinerary-speakers">
        <strong>Speaker{session.speakers.length === 1 ? "" : "s"}</strong>
        <ul>
          {session.speakers.map((speaker) => (
            <li key={`${speaker.name}-${speaker.company}`}>
              <span>{speaker.name}</span>
              <small>
                {speaker.role} · {speaker.company}
              </small>
            </li>
          ))}
        </ul>
      </div>
      {conflictingSessions.length > 0 ? (
        <p className="public-itinerary-card-conflict">
          <AlertTriangle aria-hidden="true" size={15} /> Overlaps with{` `}
          {conflictingSessions.map((item) => item.title).join(", ")}
        </p>
      ) : null}
      <button
        className="public-itinerary-remove"
        onClick={() => itinerary.toggleSession(session.id)}
        type="button"
      >
        <BookmarkCheck aria-hidden="true" size={16} /> Remove from my schedule
      </button>
    </article>
  );
}

function PersonalItineraryView({
  onBrowseSchedule,
}: {
  onBrowseSchedule: () => void;
}) {
  const projection = usePublicProjection();
  const itinerary = usePublicItinerary();
  const selectedSessions = useMemo(
    () => selectedSessionsForItinerary(projection, itinerary.selectedIds),
    [itinerary.selectedIds, projection],
  );
  const conflicts = useMemo(
    () => findItineraryConflicts(selectedSessions),
    [selectedSessions],
  );
  const sessionsById = new Map(
    selectedSessions.map((session) => [session.id, session]),
  );
  const conflictPartners = new Map<string, PublicSessionView[]>();
  for (const conflict of conflicts) {
    const first = sessionsById.get(conflict.firstSessionId);
    const second = sessionsById.get(conflict.secondSessionId);
    if (!first || !second) {
      continue;
    }
    conflictPartners.set(first.id, [
      ...(conflictPartners.get(first.id) ?? []),
      second,
    ]);
    conflictPartners.set(second.id, [
      ...(conflictPartners.get(second.id) ?? []),
      first,
    ]);
  }
  const groups = new Map<PublicScheduleDay, PublicSessionView[]>();
  for (const session of selectedSessions) {
    groups.set(session.day, [...(groups.get(session.day) ?? []), session]);
  }

  return (
    <section className="public-itinerary" aria-labelledby="my-schedule-title">
      <header className="public-itinerary-heading">
        <div>
          <p className="overline">Your event plan</p>
          <h3 id="my-schedule-title">My schedule</h3>
          <p>
            {selectedSessions.length} saved session
            {selectedSessions.length === 1 ? "" : "s"} across {groups.size} day
            {groups.size === 1 ? "" : "s"}.
          </p>
        </div>
        {selectedSessions.length > 0 ? (
          <a
            className="ui-button ui-button--primary"
            download={`${projection.event.slug}-my-schedule.ics`}
            href={itineraryCalendarHref(projection, selectedSessions)}
          >
            <Download aria-hidden="true" size={16} /> Export my schedule
          </a>
        ) : null}
      </header>

      {!itinerary.persistenceAvailable ? (
        <div className="public-itinerary-notice is-warning" role="status">
          <AlertTriangle aria-hidden="true" size={17} />
          <span>
            <strong>Saved for this visit only.</strong> Browser storage is
            unavailable, so this schedule cannot survive a reload.
          </span>
        </div>
      ) : null}
      {itinerary.reconciledCount > 0 ? (
        <div className="public-itinerary-notice" role="status">
          <Check aria-hidden="true" size={17} />
          <span>
            <strong>Your schedule is current.</strong>{" "}
            {itinerary.reconciledCount} unavailable session
            {itinerary.reconciledCount === 1 ? " was" : "s were"} removed from
            the latest published program.
          </span>
        </div>
      ) : null}
      {conflicts.length > 0 ? (
        <div className="public-itinerary-notice is-conflict" role="alert">
          <AlertTriangle aria-hidden="true" size={17} />
          <span>
            <strong>
              {conflicts.length} time conflict
              {conflicts.length === 1 ? "" : "s"} to resolve.
            </strong>{" "}
            You can keep both sessions, but you will need to choose which one to
            attend.
          </span>
        </div>
      ) : null}

      {selectedSessions.length === 0 ? (
        <div className="public-itinerary-empty">
          <StatePanel
            action={
              <Button onClick={onBrowseSchedule} variant="secondary">
                Browse all sessions <ArrowRight aria-hidden="true" size={15} />
              </Button>
            }
            description="Use the Add button on any session to build a plan that stays on this device."
            state="empty"
            title="Your schedule is open"
          />
        </div>
      ) : (
        <div className="public-itinerary-days">
          {[...groups.entries()].map(([scheduleDay, sessions]) => {
            const firstSession = sessions[0];
            if (!firstSession) {
              return null;
            }
            return (
              <section
                className="public-itinerary-day"
                key={scheduleDay}
                aria-labelledby={`itinerary-day-${scheduleDay}`}
              >
                <header>
                  <p className="overline">Day plan</p>
                  <h3 id={`itinerary-day-${scheduleDay}`}>
                    {formatLongDate(
                      firstSession.startAt,
                      projection.event.timezone,
                    )}
                  </h3>
                  <span>
                    {sessions.length} session{sessions.length === 1 ? "" : "s"}
                  </span>
                </header>
                <div className="public-itinerary-list">
                  {sessions.map((session) => (
                    <PublicItinerarySessionCard
                      conflictingSessions={
                        conflictPartners.get(session.id) ?? []
                      }
                      key={session.id}
                      session={session}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}

type PublicScheduleFixtureState = "empty" | "error";

function PublicScheduleList({
  fixtureState,
}: {
  fixtureState?: PublicScheduleFixtureState | undefined;
}) {
  const projection = usePublicProjection();
  const initialUrlState = getPublicUrlState(projection);
  const publishedSessions = useMemo(
    () => sessionsInPublishedProjection(projection),
    [projection],
  );
  const days = useMemo(() => scheduleDays(projection), [projection]);
  const rooms = useMemo(() => projectionRooms(projection), [projection]);
  const tracks = useMemo(() => projectionTracks(projection), [projection]);
  const defaultDay = days[0]?.value ?? "";
  const [day, setDay] = useState<PublicScheduleDay>(initialUrlState.day);
  const [query, setQuery] = useState(initialUrlState.q);
  const [room, setRoom] = useState(initialUrlState.room);
  const [track, setTrack] = useState(initialUrlState.track);
  const [view, setView] = useState(initialUrlState.view);

  useEffect(() => {
    function synchronizeFromHistory() {
      const next = getPublicUrlState(projection);
      setDay(next.day);
      setQuery(next.q);
      setRoom(next.room);
      setTrack(next.track);
      setView(next.view);
    }

    window.addEventListener("popstate", synchronizeFromHistory);
    return () => window.removeEventListener("popstate", synchronizeFromHistory);
  }, [projection]);

  const visibleSessions = useMemo(() => {
    if (fixtureState === "empty") {
      return [];
    }
    const normalizedQuery = query.trim().toLowerCase();
    return publishedSessions
      .filter(
        (session) =>
          session.day === day &&
          (room === "all" || session.roomId === room) &&
          (track === "all" || session.track === track) &&
          (!normalizedQuery ||
            `${session.title} ${session.abstract} ${session.speakers
              .map((speaker) => speaker.name)
              .join(" ")}`
              .toLowerCase()
              .includes(normalizedQuery)),
      )
      .sort(
        (left, right) =>
          new Date(left.startAt).getTime() - new Date(right.startAt).getTime(),
      );
  }, [day, fixtureState, publishedSessions, query, room, track]);

  function clearFilters() {
    setQuery("");
    setRoom("all");
    setTrack("all");
    updatePublicUrl({ q: "", room: "all", track: "all" }, defaultDay);
  }

  function selectView(nextView: PublicUrlState["view"]) {
    if (nextView === view) {
      return;
    }
    setView(nextView);
    updatePublicUrl({ view: nextView }, defaultDay, "push");
  }

  if (fixtureState === "error") {
    return (
      <div className="public-state-wrap">
        <StatePanel
          description="The last published program could not be loaded. Your link is still valid; try the schedule again."
          onRetry={() => window.location.assign(`/e/${projection.event.slug}`)}
          state="error"
          title="We couldn’t load the public schedule"
        />
      </div>
    );
  }

  if (fixtureState === "empty" || publishedSessions.length === 0) {
    return (
      <div className="public-state-wrap">
        <StatePanel
          action={
            <a
              className="public-text-link"
              href={`/e/${projection.event.slug}`}
            >
              Check the latest program{" "}
              <ArrowRight aria-hidden="true" size={14} />
            </a>
          }
          description="The program team is placing the final sessions. This page will update as soon as a public version is ready."
          state="empty"
          title="The published program is coming soon"
        />
      </div>
    );
  }

  return (
    <section className="public-schedule" aria-labelledby="schedule-title">
      <header className="public-schedule-heading">
        <div>
          <p className="overline">Explore the program</p>
          <h2 id="schedule-title">Plan your visit.</h2>
        </div>
        <p>
          <Sparkles aria-hidden="true" size={15} /> {publishedSessions.length}{" "}
          published sessions
        </p>
      </header>

      <div className="public-view-switcher" aria-label="Program view">
        <button
          aria-pressed={view === "schedule"}
          onClick={() => selectView("schedule")}
          type="button"
        >
          <CalendarDays aria-hidden="true" size={16} />
          <span>
            <strong>All sessions</strong>
            <small>Browse the published program</small>
          </span>
        </button>
        <button
          aria-pressed={view === "mine"}
          onClick={() => selectView("mine")}
          type="button"
        >
          <BookmarkCheck aria-hidden="true" size={16} />
          <span>
            <strong>My schedule</strong>
            <small>Review and export saved sessions</small>
          </span>
        </button>
      </div>

      {view === "mine" ? (
        <PersonalItineraryView
          onBrowseSchedule={() => selectView("schedule")}
        />
      ) : (
        <>
          <div className="public-day-switcher" aria-label="Schedule day">
            {days.map((details) => {
              const scheduleDay = details.value;
              const count = publishedSessions.filter(
                (session) => session.day === scheduleDay,
              ).length;
              return (
                <button
                  aria-pressed={day === scheduleDay}
                  key={scheduleDay}
                  onClick={() => {
                    setDay(scheduleDay);
                    updatePublicUrl({ day: scheduleDay }, defaultDay, "push");
                  }}
                  type="button"
                >
                  <span>
                    <strong>{details.label}</strong>
                    <small>{details.date}</small>
                  </span>
                  <em>{count}</em>
                </button>
              );
            })}
          </div>

          <div className="public-filters">
            <div className="public-search-field">
              <Search aria-hidden="true" size={17} />
              <TextField
                id="public-session-search"
                label="Search the schedule"
                onChange={(event) => {
                  setQuery(event.target.value);
                  updatePublicUrl({ q: event.target.value }, defaultDay);
                }}
                placeholder="Search sessions or speakers"
                type="search"
                value={query}
              />
            </div>
            <SelectField
              id="public-track"
              label="Track"
              onChange={(event) => {
                setTrack(event.target.value);
                updatePublicUrl({ track: event.target.value }, defaultDay);
              }}
              options={[
                { label: "All tracks", value: "all" },
                ...tracks.map((item) => ({ label: item, value: item })),
              ]}
              value={track}
            />
            <SelectField
              id="public-room"
              label="Room"
              onChange={(event) => {
                setRoom(event.target.value);
                updatePublicUrl({ room: event.target.value }, defaultDay);
              }}
              options={[
                { label: "All rooms", value: "all" },
                ...rooms.map((item) => ({
                  label: item.name,
                  value: item.id,
                })),
              ]}
              value={room}
            />
          </div>

          <div className="public-results-bar" role="status">
            <span>
              <Filter aria-hidden="true" size={14} />
              <strong>
                {days.find((details) => details.value === day)?.label},{` `}
                {days.find((details) => details.value === day)?.date}
              </strong>
              {visibleSessions.length} session
              {visibleSessions.length === 1 ? "" : "s"}
            </span>
            {query || room !== "all" || track !== "all" ? (
              <button onClick={clearFilters} type="button">
                Clear filters
              </button>
            ) : null}
          </div>

          {visibleSessions.length > 0 ? (
            <div className="public-session-list">
              {visibleSessions.map((session) => (
                <PublicSessionCard key={session.id} session={session} />
              ))}
            </div>
          ) : (
            <div className="public-no-results">
              <StatePanel
                description={`Try a different search, track, or room for ${days.find((details) => details.value === day)?.label ?? "this day"}.`}
                state="empty"
                title="No sessions match this view"
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}

function speakerInitials(name: string) {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2);
}

function PublicSessionDetail({ session }: { session: PublicSessionView }) {
  const projection = usePublicProjection();
  const itinerary = usePublicItinerary();
  const event = projection.event;
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const backParams = new URLSearchParams(window.location.search);
  backParams.delete("state");
  const backHref = `/e/${event.slug}${backParams.size ? `?${backParams.toString()}` : ""}`;
  const isSelected = itinerary.selectedIds.has(session.id);

  function copySessionLink() {
    if (!navigator.clipboard) {
      setToasts([
        {
          id: "public-link-copy-error",
          message: "Copy the URL from your browser to share this session.",
          title: "Couldn’t copy automatically",
          tone: "error",
        },
      ]);
      return;
    }

    void navigator.clipboard
      .writeText(window.location.href)
      .then(() => {
        setToasts([
          {
            id: "public-link-copied",
            message: "The current public session URL is ready to share.",
            title: "Session link copied",
            tone: "success",
          },
        ]);
      })
      .catch(() => {
        setToasts([
          {
            id: "public-link-copy-error",
            message: "Copy the URL from your browser to share this session.",
            title: "Couldn’t copy automatically",
            tone: "error",
          },
        ]);
      });
  }

  return (
    <>
      <main className="public-detail" id="public-content">
        <a className="public-back-link" href={backHref}>
          <ArrowLeft aria-hidden="true" size={15} /> Back to schedule
        </a>

        <article
          className={`public-detail-hero is-${trackClassName(session.track)}`}
        >
          <div className="public-detail-kicker">
            <StatusPill tone="preview">{session.track}</StatusPill>
            <span>{session.format}</span>
          </div>
          <h1>{session.title}</h1>
          <p className="public-detail-speaker-line">
            {session.speakers.map((speaker) => speaker.name).join(" · ")}
          </p>
          <div className="public-detail-time">
            <CalendarDays aria-hidden="true" size={19} />
            <span>
              <strong>{formatLongDate(session.startAt, event.timezone)}</strong>
              <small>
                {formatTime(session.startAt, event.timezone)}–
                {formatTime(session.endAt, event.timezone)} ·{` `}
                {timeZoneLabel(event.timezone)}
              </small>
            </span>
          </div>
        </article>

        <div className="public-detail-layout">
          <div className="public-detail-main">
            <section aria-labelledby="about-session-title">
              <p className="overline">About this session</p>
              <h2 id="about-session-title">What you’ll learn</h2>
              <p>{session.abstract}</p>
            </section>

            <section aria-labelledby="speakers-title">
              <p className="overline">On stage</p>
              <h2 id="speakers-title">
                Speaker{session.speakers.length === 1 ? "" : "s"}
              </h2>
              <div className="public-speaker-list">
                {session.speakers.map((speaker) => (
                  <article key={speaker.name}>
                    <a
                      href={`/e/${event.slug}/speakers/${publicSpeakerSlug(speaker.name)}`}
                    >
                      <span aria-hidden="true">
                        {speakerInitials(speaker.name)}
                      </span>
                      <div>
                        <h3>{speaker.name}</h3>
                        <p>
                          {speaker.role} · {speaker.company}
                        </p>
                      </div>
                    </a>
                  </article>
                ))}
              </div>
            </section>
          </div>

          <aside className="public-detail-aside" aria-label="Session details">
            <dl>
              <div>
                <dt>
                  <MapPin aria-hidden="true" size={16} /> Room
                </dt>
                <dd>{session.roomName}</dd>
              </div>
              <div>
                <dt>
                  <Clock3 aria-hidden="true" size={16} /> Duration
                </dt>
                <dd>{durationMinutes(session)} minutes</dd>
              </div>
              <div>
                <dt>
                  <Ticket aria-hidden="true" size={16} /> Format
                </dt>
                <dd>{session.format}</dd>
              </div>
            </dl>
            <div className="public-calendar-actions">
              <p className="overline">Save your seat</p>
              <h2>Plan this session</h2>
              <Button
                onClick={() => itinerary.toggleSession(session.id)}
                variant={isSelected ? "secondary" : "primary"}
              >
                {isSelected ? (
                  <BookmarkCheck aria-hidden="true" size={16} />
                ) : (
                  <Bookmark aria-hidden="true" size={16} />
                )}
                {isSelected ? "Remove from my schedule" : "Add to my schedule"}
              </Button>
              <a
                className="ui-button ui-button--secondary"
                download={`${session.id}.ics`}
                href={calendarDownloadHref(session, projection)}
              >
                <Download aria-hidden="true" size={16} /> Download .ics
              </a>
              <a
                className="ui-button ui-button--secondary"
                href={googleCalendarHref(session, projection)}
                rel="noreferrer"
                target="_blank"
              >
                <ExternalLink aria-hidden="true" size={16} /> Google Calendar
              </a>
              <Button onClick={copySessionLink} variant="secondary">
                <Share2 aria-hidden="true" size={16} /> Copy session link
              </Button>
            </div>
            <p className="public-version-note">
              <Check aria-hidden="true" size={14} /> Current in public version
              {` `}
              {projection.version}
            </p>
          </aside>
        </div>
      </main>

      <ToastRegion
        messages={toasts}
        onDismiss={(id) =>
          setToasts((current) => current.filter((toast) => toast.id !== id))
        }
      />
    </>
  );
}

function PublicNotFound({ sessionId }: { sessionId?: string }) {
  const { event } = usePublicProjection();
  return (
    <main className="public-not-found" id="public-content">
      <StatePanel
        action={
          <a className="public-text-link" href={`/e/${event.slug}`}>
            Return to the published schedule{` `}
            <ArrowRight aria-hidden="true" size={14} />
          </a>
        }
        description={
          sessionId
            ? "This session is not part of the current public version. It may have moved or been removed."
            : "This public event link does not match an available program."
        }
        state="error"
        title={sessionId ? "Session not found" : "Program not found"}
      />
    </main>
  );
}

function currentRoute() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  return {
    eventSlug: parts[0] === "e" ? parts[1] : undefined,
    sessionId: parts[2] === "sessions" ? parts[3] : undefined,
  };
}

type PublicProjectionLoadState =
  | { status: "error" }
  | { status: "loading" }
  | { status: "not-found" }
  | { projection: PublicScheduleProjection; status: "ready" };

function PublicFooter() {
  return (
    <footer className="public-footer">
      <ProductWordmark />
      <p>Built for the people who make gatherings matter.</p>
      <span>© 2026 OpenSession</span>
    </footer>
  );
}

function PublicProjectionState({
  state,
}: {
  state: Exclude<PublicProjectionLoadState["status"], "ready">;
}) {
  const isLoading = state === "loading";
  const isNotFound = state === "not-found";
  return (
    <div className="public-program">
      <a className="skip-link" href="#public-content">
        Skip to schedule
      </a>
      <header className="public-header">
        <a aria-label="OpenSession home" className="public-wordmark" href="/">
          <ProductWordmark />
        </a>
      </header>
      <main className="public-state-wrap" id="public-content">
        <StatePanel
          description={
            isLoading
              ? "Fetching the latest published program."
              : isNotFound
                ? "This public event link does not match an available program."
                : "The latest published program could not be loaded. Your link is still valid."
          }
          onRetry={
            state === "error" ? () => window.location.reload() : undefined
          }
          state={isLoading ? "loading" : "error"}
          title={
            isLoading
              ? "Loading the public schedule"
              : isNotFound
                ? "Program not found"
                : "We couldn’t load the public schedule"
          }
        />
      </main>
      <PublicFooter />
    </div>
  );
}

function PublicProgram({
  fixtureState,
  projection,
  route,
}: {
  fixtureState?: PublicScheduleFixtureState | undefined;
  projection: PublicScheduleProjection;
  route: ReturnType<typeof currentRoute>;
}) {
  const itinerary = usePersonalItinerary(projection);
  const publishedSessions = sessionsInPublishedProjection(projection);
  const session = route.sessionId
    ? publishedSessions.find((item) => item.id === route.sessionId)
    : undefined;

  return (
    <PublicProjectionContext.Provider value={projection}>
      <PublicItineraryContext.Provider value={itinerary}>
        <div className="public-program">
          <a className="skip-link" href="#public-content">
            Skip to schedule
          </a>
          <PublicHeader />
          {route.eventSlug !== projection.event.slug ? (
            <PublicNotFound />
          ) : route.sessionId ? (
            session ? (
              <PublicSessionDetail session={session} />
            ) : (
              <PublicNotFound sessionId={route.sessionId} />
            )
          ) : (
            <main id="public-content">
              <PublicEventIntro />
              <PublicScheduleList fixtureState={fixtureState} />
            </main>
          )}
          <PublicFooter />
        </div>
      </PublicItineraryContext.Provider>
    </PublicProjectionContext.Provider>
  );
}

export function PublicSchedule({
  fixtureState,
}: {
  fixtureState?: PublicScheduleFixtureState | undefined;
}) {
  const route = fixtureState
    ? {
        eventSlug: publicScheduleProjectionFixture.event.slug,
        sessionId: undefined,
      }
    : currentRoute();
  const [loadState, setLoadState] = useState<PublicProjectionLoadState>({
    status: "loading",
  });

  useEffect(() => {
    if (fixtureState) {
      return;
    }
    if (!route.eventSlug) {
      return;
    }

    const controller = new AbortController();

    async function loadProjection() {
      try {
        const response = await fetch(
          `/api/v1/public/events/${encodeURIComponent(route.eventSlug ?? "")}/schedule`,
          {
            headers: { Accept: "application/json" },
            signal: controller.signal,
          },
        );
        if (response.status === 404) {
          setLoadState({ status: "not-found" });
          return;
        }
        if (!response.ok) {
          throw new Error(`Public schedule request failed: ${response.status}`);
        }
        const payload: unknown = await response.json();
        const parsed = publicScheduleProjectionSchema.safeParse(payload);
        if (!parsed.success || parsed.data.event.slug !== route.eventSlug) {
          throw new Error(
            "Public schedule response did not match its contract.",
          );
        }
        setLoadState({ projection: parsed.data, status: "ready" });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setLoadState({ status: "error" });
      }
    }

    void loadProjection();
    return () => controller.abort();
  }, [fixtureState, route.eventSlug]);

  if (!fixtureState && !route.eventSlug) {
    return <PublicProjectionState state="not-found" />;
  }

  let projection: PublicScheduleProjection;
  if (fixtureState) {
    projection = publicScheduleProjectionFixture;
  } else {
    if (loadState.status !== "ready") {
      return <PublicProjectionState state={loadState.status} />;
    }
    projection = loadState.projection;
  }

  return (
    <PublicProgram
      fixtureState={fixtureState}
      projection={projection}
      route={route}
    />
  );
}
