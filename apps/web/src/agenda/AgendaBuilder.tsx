import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type DragEvent,
} from "react";
import {
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Clock3,
  Eye,
  Filter,
  GripVertical,
  MapPin,
  Printer,
  SlidersHorizontal,
  Sparkles,
  Users,
} from "lucide-react";

import type {
  ScheduleCommandPort,
  ScheduleSnapshot,
} from "@sessionbox-killer/contracts";

import {
  Button,
  Dialog,
  Drawer,
  LiveRegion,
  SelectField,
  StatePanel,
  StatusPill,
  TextField,
  ToastRegion,
  type ToastMessage,
} from "@sessionbox-killer/ui";

import {
  agendaLocalDateTimeToUtc,
  agendaScheduleView as agendaScheduleFixtureView,
  readyAgendaScheduleView,
  scheduleSnapshotToAgendaView,
  type AgendaDay,
  type AgendaDayView,
  type AgendaScheduleView,
  type AgendaSessionView,
  type AgendaView,
  type ScheduledSessionView,
} from "./agendaModel";
import {
  AgendaPresentation,
  AgendaViewContext,
  AgendaViewSwitcher,
} from "./AgendaPresentations";

import "./agenda-builder.css";
import "./agenda-publish-views.css";

interface AgendaUrlState {
  day: AgendaDay;
  room: string;
  track: string;
  view: AgendaView;
}

export type AgendaFixtureState =
  | "default"
  | "empty"
  | "placement-failed"
  | "published"
  | "ready"
  | "ready-readonly";

interface AgendaDragTarget {
  conflict: boolean;
  roomId: string;
  slot: number;
}

function getAgendaUrlState(schedule: AgendaScheduleView): AgendaUrlState {
  const params = new URLSearchParams(window.location.search);
  const candidateView = params.get("view");
  const candidateRoom = params.get("room");
  const candidateTrack = params.get("track");
  const candidateDay = params.get("day");
  const matchedDay = schedule.days.find(
    (day) =>
      day.date === candidateDay ||
      day.fullLabel.toLowerCase().startsWith(candidateDay?.toLowerCase() ?? ""),
  );
  const view: AgendaView =
    candidateView === "list" ||
    candidateView === "week" ||
    candidateView === "track" ||
    candidateView === "room"
      ? candidateView
      : "day";

  return {
    day: matchedDay?.date ?? schedule.days[0]?.date ?? "",
    room:
      candidateRoom && schedule.rooms.some((room) => room.id === candidateRoom)
        ? candidateRoom
        : "all",
    track:
      candidateTrack &&
      schedule.tracks.some((track) => track.name === candidateTrack)
        ? candidateTrack
        : "all",
    view,
  };
}

function agendaDay(days: readonly AgendaDayView[], day: AgendaDay) {
  return days.find((candidate) => candidate.date === day) ?? days[0];
}

function replaceAgendaUrl(patch: Partial<AgendaUrlState>) {
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(patch)) {
    if (!value || value === "all" || (key === "view" && value === "day")) {
      params.delete(key);
    } else {
      params.set(key, value);
    }
  }
  const query = params.toString();
  window.history.replaceState(
    null,
    "",
    query ? `${window.location.pathname}?${query}` : window.location.pathname,
  );
}

function UnscheduledCard({
  onDragEnd,
  onDragStart,
  onSchedule,
  session,
}: {
  onDragEnd: () => void;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onSchedule: () => void;
  session: AgendaSessionView;
}) {
  return (
    <article
      className={`agenda-unscheduled-card is-${session.tone}`}
      draggable
      onDragEnd={onDragEnd}
      onDragStart={onDragStart}
    >
      <div className="agenda-card-top">
        <span>
          <GripVertical aria-hidden="true" size={16} /> {session.track}
        </span>
        <span>{session.durationMinutes} min</span>
      </div>
      <h3>{session.title}</h3>
      <p>
        <Users aria-hidden="true" size={14} /> {session.speakers.join(" · ")}
      </p>
      <div>
        <span>{session.format}</span>
        <button onClick={onSchedule} type="button">
          Schedule…
        </button>
      </div>
    </article>
  );
}

function ScheduledCard({
  days,
  onSelect,
  saving,
  session,
}: {
  days: readonly AgendaDayView[];
  onSelect: () => void;
  saving: boolean;
  session: ScheduledSessionView;
}) {
  return (
    <button
      className={`agenda-scheduled-card is-${session.tone} ${session.status ? `is-${session.status}` : ""} ${saving ? "is-saving" : ""}`}
      onClick={onSelect}
      style={{ gridRow: `${session.slot} / span ${session.span}` }}
      type="button"
    >
      <span>
        {agendaDay(days, session.day)?.times[session.slot - 1]} ·{" "}
        {session.durationMinutes}m
      </span>
      <strong>{session.title}</strong>
      <small>{session.speakers.join(" · ")}</small>
      {session.status === "conflict" ? (
        <em>
          <AlertTriangle aria-hidden="true" size={12} /> Speaker conflict
        </em>
      ) : null}
      {saving ? (
        <em>
          <Clock3 aria-hidden="true" size={12} /> Saving placement…
        </em>
      ) : null}
    </button>
  );
}

export function AgendaBuilder({
  commandPort,
  fixtureState = "default",
  initialSnapshot,
}: {
  commandPort?: Pick<ScheduleCommandPort, "execute"> | undefined;
  fixtureState?: AgendaFixtureState | undefined;
  initialSnapshot?: ScheduleSnapshot | undefined;
} = {}) {
  const readyFixture =
    fixtureState === "ready" ||
    fixtureState === "published" ||
    fixtureState === "ready-readonly";
  const initialScheduleView = useMemo(
    () =>
      initialSnapshot
        ? scheduleSnapshotToAgendaView(initialSnapshot)
        : readyFixture
          ? readyAgendaScheduleView
          : agendaScheduleFixtureView,
    [initialSnapshot, readyFixture],
  );
  const [agendaScheduleView, setAgendaScheduleView] =
    useState(initialScheduleView);
  const initialUrlState = getAgendaUrlState(initialScheduleView);
  const emptyFixture = fixtureState === "empty";
  const readOnly = fixtureState === "ready-readonly";
  const publicationPreviewOnly = Boolean(commandPort);
  const placementShouldFail = fixtureState === "placement-failed";
  const [day, setDay] = useState<AgendaDay>(initialUrlState.day);
  const [view, setView] = useState<AgendaView>(initialUrlState.view);
  const [trackFilter, setTrackFilter] = useState(initialUrlState.track);
  const [roomFilter, setRoomFilter] = useState(initialUrlState.room);
  const [search, setSearch] = useState("");
  const [selectedSession, setSelectedSession] =
    useState<AgendaSessionView | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sessionOpen, setSessionOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [scheduled, setScheduled] = useState(initialScheduleView.scheduled);
  const [unscheduledSessions, setUnscheduledSessions] = useState(
    initialScheduleView.unscheduled,
  );
  const [selectedScheduled, setSelectedScheduled] =
    useState<ScheduledSessionView | null>(null);
  const [publishedVersion, setPublishedVersion] = useState(
    initialScheduleView.publicationVersion,
  );
  const [scheduleVersion, setScheduleVersion] = useState(
    initialScheduleView.version,
  );
  const [published, setPublished] = useState(
    fixtureState === "published" ||
      Boolean(
        initialSnapshot &&
        initialScheduleView.publicationVersion > 0 &&
        initialScheduleView.scheduled.length > 0 &&
        initialScheduleView.scheduled.every(
          ({ publicationVersion }) =>
            publicationVersion === initialScheduleView.publicationVersion,
        ),
      ),
  );
  const [hasUnpublishedChanges, setHasUnpublishedChanges] = useState(false);
  const [savingPlacementIds, setSavingPlacementIds] = useState<string[]>([]);
  const [conflictValidationPending, setConflictValidationPending] =
    useState(false);
  const [room, setRoom] = useState(
    initialScheduleView.rooms.find((candidate) => candidate.id === "gallery")
      ?.id ??
      initialScheduleView.rooms[0]?.id ??
      "",
  );
  const [start, setStart] = useState(() => {
    const firstDay = initialScheduleView.days[0];
    return firstDay?.times.includes("11:30 AM")
      ? "11:30 AM"
      : (firstDay?.times[0] ?? "9:00 AM");
  });
  const [duration, setDuration] = useState("30");
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [draggedSession, setDraggedSession] =
    useState<AgendaSessionView | null>(null);
  const [dragTarget, setDragTarget] = useState<AgendaDragTarget | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [placementError, setPlacementError] = useState("");
  const agendaDays = agendaScheduleView.days;
  const agendaRooms = agendaScheduleView.rooms;
  const agendaTracks = agendaScheduleView.tracks;
  const agendaTimes = agendaDays[0]?.times ?? [];
  const activeDay = agendaDay(agendaDays, day);
  const activeTimes = activeDay?.times ?? agendaTimes;
  const gridStyle = {
    "--agenda-room-count": agendaRooms.length,
    "--agenda-slot-count": activeTimes.length,
  } as CSSProperties;
  const timeLabelStride = Math.max(
    1,
    Math.ceil(30 / agendaScheduleView.snapMinutes),
  );

  const unscheduled = useMemo(
    () =>
      unscheduledSessions.filter((session) =>
        `${session.title} ${session.speakers.join(" ")} ${session.track}`
          .toLowerCase()
          .includes(search.toLowerCase()),
      ),
    [search, unscheduledSessions],
  );
  const filteredScheduled = useMemo(
    () =>
      scheduled.filter(
        (session) =>
          (trackFilter === "all" || session.track === trackFilter) &&
          (roomFilter === "all" || session.roomId === roomFilter),
      ),
    [roomFilter, scheduled, trackFilter],
  );
  const visibleScheduled = useMemo(
    () => filteredScheduled.filter((session) => session.day === day),
    [day, filteredScheduled],
  );
  const hasSessionsOnEveryDay = agendaDays.every((agendaDay) =>
    scheduled.some((session) => session.day === agendaDay.date),
  );
  const hardConflictCount = scheduled.filter(
    (session) => session.status === "conflict",
  ).length;
  const missingPlacementCount = unscheduledSessions.length;
  const publishable =
    hardConflictCount === 0 &&
    missingPlacementCount === 0 &&
    hasSessionsOnEveryDay &&
    !conflictValidationPending;
  const blockerCategoryCount =
    Number(hardConflictCount > 0) +
    Number(missingPlacementCount > 0) +
    Number(!hasSessionsOnEveryDay) +
    Number(conflictValidationPending);

  useEffect(() => {
    if (!draggedSession) {
      return;
    }
    const draggedTitle = draggedSession.title;

    function cancelDrag(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }
      setDraggedSession(null);
      setDragTarget(null);
      setAnnouncement(`Placement canceled for ${draggedTitle}.`);
    }

    window.addEventListener("keydown", cancelDrag);
    return () => window.removeEventListener("keydown", cancelDrag);
  }, [draggedSession]);

  function targetHasConflict(
    session: AgendaSessionView,
    roomId: string,
    slot: number,
  ) {
    const span = Math.max(
      1,
      Math.round(session.durationMinutes / agendaScheduleView.snapMinutes),
    );
    return visibleScheduled.some(
      (placed) =>
        placed.roomId === roomId &&
        placed.slot < slot + span &&
        slot < placed.slot + placed.span,
    );
  }

  function startDrag(
    event: DragEvent<HTMLElement>,
    session: AgendaSessionView,
  ) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", session.id);
    setDraggedSession(session);
    setDragTarget(null);
    setPlacementError("");
    setAnnouncement(
      `${session.title} picked up. Choose a room and time, or press Escape to cancel.`,
    );
  }

  function endDrag() {
    if (draggedSession) {
      setAnnouncement(`Placement canceled for ${draggedSession.title}.`);
    }
    setDraggedSession(null);
    setDragTarget(null);
  }

  function sessionFromDrag(event: DragEvent<HTMLElement>) {
    const draggedId = event.dataTransfer.getData("text/plain");
    return (
      draggedSession ??
      unscheduledSessions.find((session) => session.id === draggedId) ??
      null
    );
  }

  function updateDragTarget(
    event: DragEvent<HTMLElement>,
    roomId: string,
    slot: number,
  ) {
    const session = sessionFromDrag(event);
    if (!session) {
      return;
    }
    const conflict = targetHasConflict(session, roomId, slot);
    setDraggedSession(session);
    setDragTarget({ conflict, roomId, slot });
    setAnnouncement(
      `${activeTimes[slot - 1]} in ${agendaRooms.find((item) => item.id === roomId)?.name}${conflict ? ". Possible overlap." : ". Available placement."}`,
    );
  }

  function dropSession(
    event: DragEvent<HTMLElement>,
    roomId: string,
    slot: number,
  ) {
    event.preventDefault();
    const session = sessionFromDrag(event);
    if (!session) {
      return;
    }
    setSelectedSession(session);
    setRoom(roomId);
    setStart(activeTimes[slot - 1] ?? activeTimes[0] ?? "9:00 AM");
    setDuration(String(session.durationMinutes));
    setDraggedSession(null);
    setDragTarget(null);
    setPlacementError("");
    setScheduleOpen(true);
    setAnnouncement(
      `${session.title} targeted for ${activeTimes[slot - 1]} in ${agendaRooms.find((item) => item.id === roomId)?.name}. Review and save the placement.`,
    );
  }

  function openSchedule(session: AgendaSessionView) {
    setSelectedSession(session);
    if (!agendaRooms.some((candidate) => candidate.id === room)) {
      setRoom(agendaRooms[0]?.id ?? "");
    }
    if (!activeTimes.includes(start)) {
      setStart(activeTimes[0] ?? "9:00 AM");
    }
    setDuration(String(session.durationMinutes));
    setPlacementError("");
    setScheduleOpen(true);
  }

  async function placeSession() {
    if (!selectedSession) {
      return;
    }
    const slot = Math.max(1, activeTimes.indexOf(start) + 1);
    const startAt = agendaLocalDateTimeToUtc(
      day,
      start,
      agendaScheduleView.timezone,
    );
    const endAt = new Date(
      Date.parse(startAt) + Number(duration) * 60_000,
    ).toISOString();
    const previousPlacement = scheduled.find(
      (session) => session.id === selectedSession.id,
    );
    const next: ScheduledSessionView = {
      ...selectedSession,
      day,
      durationMinutes: Number(duration),
      endAt,
      publicationVersion: 0,
      roomId: room,
      slot,
      slotVersion: scheduleVersion + 1,
      span: Math.max(
        1,
        Math.round(Number(duration) / agendaScheduleView.snapMinutes),
      ),
      startAt,
      ...(previousPlacement?.status === "conflict"
        ? { status: "conflict" as const }
        : {}),
    };
    const existingPlacement = Boolean(previousPlacement);
    const previousScheduled = scheduled;
    const previousUnscheduled = unscheduledSessions;
    setPlacementError("");
    setScheduled((current) =>
      existingPlacement
        ? current.map((session) =>
            session.id === selectedSession.id ? next : session,
          )
        : [...current, next],
    );
    setUnscheduledSessions((current) =>
      current.filter((session) => session.id !== selectedSession.id),
    );
    if (published) {
      setHasUnpublishedChanges(true);
    }
    setSavingPlacementIds((current) =>
      current.includes(selectedSession.id)
        ? current
        : [...current, selectedSession.id],
    );
    setConflictValidationPending(true);
    setScheduleOpen(false);
    setToasts([
      {
        id: "agenda-saving",
        title: "Saving placement",
        message: `${selectedSession.title} is pending authoritative confirmation for ${start} in ${agendaRooms.find((item) => item.id === room)?.name}.`,
      },
    ]);
    try {
      if (!commandPort || placementShouldFail) {
        await new Promise((resolve) => window.setTimeout(resolve, 700));
      }
      if (placementShouldFail) {
        throw new Error("Fixture placement failure");
      }
      if (commandPort) {
        const result = await commandPort.execute({
          commandId: crypto.randomUUID(),
          durationMinutes: Number(duration),
          eventId: agendaScheduleView.eventId,
          expectedVersion: scheduleVersion,
          roomId: room,
          sessionId: selectedSession.id,
          startAt,
          type: existingPlacement ? "reschedule_session" : "place_session",
        });
        const conflictIds = previousScheduled
          .filter((session) => session.status === "conflict")
          .map((session) => session.id);
        const authoritative = scheduleSnapshotToAgendaView(
          result.snapshot,
          conflictIds,
        );
        setAgendaScheduleView(authoritative);
        setScheduled(authoritative.scheduled);
        setUnscheduledSessions(authoritative.unscheduled);
        setPublishedVersion(authoritative.publicationVersion);
        setScheduleVersion(authoritative.version);
      } else {
        setScheduleVersion((current) => current + 1);
      }
      setToasts([
        {
          id: "agenda-saved",
          title: existingPlacement ? "Placement updated" : "Session scheduled",
          message: `${selectedSession.title} is placed at ${start} in ${agendaRooms.find((item) => item.id === room)?.name}. Conflict checks are pending.${published ? " Public version remains unchanged until you republish." : ""}`,
          tone: "success",
        },
      ]);
      setSavingPlacementIds((current) =>
        current.filter((sessionId) => sessionId !== next.id),
      );
      setConflictValidationPending(false);
    } catch {
      setScheduled(previousScheduled);
      setUnscheduledSessions(previousUnscheduled);
      setSavingPlacementIds((current) =>
        current.filter((sessionId) => sessionId !== next.id),
      );
      setConflictValidationPending(false);
      setPlacementError(
        "The placement could not be saved. Your day, time, room, and duration are preserved so you can retry.",
      );
      setScheduleOpen(true);
      setAnnouncement(
        `Could not save ${next.title}. The attempted placement is still available.`,
      );
      setToasts([
        {
          id: "agenda-save-failed",
          message:
            "No schedule change was committed. Review the preserved values and retry.",
          title: "Placement not saved",
          tone: "error",
        },
      ]);
    }
  }

  function changeDay(nextDay: AgendaDay) {
    setDay(nextDay);
    const nextTimes = agendaDay(agendaDays, nextDay)?.times ?? agendaTimes;
    if (!nextTimes.includes(start)) {
      setStart(nextTimes[0] ?? "9:00 AM");
    }
    replaceAgendaUrl({ day: nextDay });
  }

  function changeView(nextView: AgendaView) {
    setView(nextView);
    replaceAgendaUrl({ view: nextView });
  }

  function selectScheduled(session: ScheduledSessionView) {
    setSelectedScheduled(session);
    setSessionOpen(true);
  }

  function editScheduled() {
    if (!selectedScheduled || readOnly) {
      return;
    }

    setSelectedSession(selectedScheduled);
    changeDay(selectedScheduled.day);
    setRoom(selectedScheduled.roomId);
    setStart(
      agendaDay(agendaDays, selectedScheduled.day)?.times[
        selectedScheduled.slot - 1
      ] ??
        agendaTimes[0] ??
        "9:00 AM",
    );
    setDuration(String(selectedScheduled.durationMinutes));
    setSessionOpen(false);
    setScheduleOpen(true);
  }

  function publishAgenda() {
    if (!publishable || publicationPreviewOnly) {
      return;
    }

    setPublishedVersion((current) => current + 1);
    setPublished(true);
    setHasUnpublishedChanges(false);
    setPublishOpen(false);
    setToasts([
      {
        id: "agenda-published",
        message:
          "The public schedule snapshot is current. Calendar and cache invalidation are queued at the contract boundary.",
        title: `Agenda version ${publishedVersion + 1} published`,
        tone: "success",
      },
    ]);
  }

  return (
    <div className={readOnly ? "agenda-page agenda-readonly" : "agenda-page"}>
      <header className="agenda-header">
        <div>
          <p className="overline">Publish · Agenda</p>
          <h1>Build the room, minute by minute.</h1>
          <p>
            Place accepted sessions with visible constraints. Every drag action
            has an equivalent keyboard path.
          </p>
        </div>
        <div className="agenda-header-actions">
          {readOnly ? (
            <StatusPill tone="preview">
              <Eye aria-hidden="true" size={16} /> Read-only preview
            </StatusPill>
          ) : (
            <>
              <Button
                variant="secondary"
                onClick={() => setConflictsOpen(true)}
              >
                <CircleAlert aria-hidden="true" size={16} /> {hardConflictCount}{" "}
                hard conflict{hardConflictCount === 1 ? "" : "s"}
              </Button>
              <Button onClick={() => setPublishOpen(true)}>
                <Sparkles aria-hidden="true" size={16} /> Preview publish
              </Button>
            </>
          )}
        </div>
      </header>

      <div
        className={
          published && !hasUnpublishedChanges
            ? "agenda-publication-state is-published"
            : "agenda-publication-state"
        }
        role="status"
      >
        {published && !hasUnpublishedChanges ? (
          <CheckCircle2 aria-hidden="true" size={17} />
        ) : (
          <Eye aria-hidden="true" size={17} />
        )}
        <span>
          <strong>
            {published
              ? hasUnpublishedChanges
                ? `Draft changes after public version ${publishedVersion}`
                : `Public version ${publishedVersion}`
              : `Draft based on public version ${publishedVersion}`}
          </strong>
          {published
            ? hasUnpublishedChanges
              ? "Republish to update the public program and downstream calendars."
              : "Snapshot created just now · public program refresh queued"
            : readOnly
              ? "Controls are hidden while stakeholders inspect this snapshot."
              : "Organizer edits remain private until every blocker is resolved."}
        </span>
        <a href={`/e/${agendaScheduleView.slug}`}>Open public program</a>
      </div>

      {emptyFixture ? (
        <div className="agenda-empty-state">
          <StatePanel
            action={
              <Button
                onClick={() => window.location.assign(window.location.pathname)}
              >
                Return to accepted sessions
              </Button>
            }
            description="Accept sessions first, then return here to place them into rooms and publish a public version."
            state="empty"
            title="No sessions are ready to schedule"
          />
        </div>
      ) : null}

      {!emptyFixture ? (
        <>
          <div className="agenda-view-toolbar">
            <AgendaViewSwitcher onChange={changeView} value={view} />
            <AgendaViewContext
              day={day}
              days={agendaDays}
              room={roomFilter}
              rooms={agendaRooms}
              track={trackFilter}
              view={view}
            />
            <div className="agenda-view-toolbar-actions">
              <Button onClick={() => setFiltersOpen(true)} variant="secondary">
                <SlidersHorizontal aria-hidden="true" size={15} /> Filters
              </Button>
              <Button onClick={() => window.print()} variant="secondary">
                <Printer aria-hidden="true" size={15} /> Print
              </Button>
            </div>
          </div>

          <section className="agenda-drilldowns" aria-label="Agenda blockers">
            <button
              className={
                missingPlacementCount > 0
                  ? "agenda-drilldown is-blocking"
                  : "agenda-drilldown"
              }
              onClick={() =>
                document
                  .getElementById("agenda-rail-title")
                  ?.scrollIntoView({ behavior: "smooth" })
              }
              type="button"
            >
              <span>
                <CalendarDays aria-hidden="true" size={16} />
              </span>
              <span>
                <strong>Unscheduled accepted</strong>
                <small>Open the placement queue</small>
              </span>
              <em>{missingPlacementCount}</em>
            </button>
            <button
              className={
                missingPlacementCount > 0
                  ? "agenda-drilldown is-blocking"
                  : "agenda-drilldown"
              }
              onClick={() =>
                document
                  .getElementById("agenda-rail-title")
                  ?.scrollIntoView({ behavior: "smooth" })
              }
              type="button"
            >
              <span>
                <MapPin aria-hidden="true" size={16} />
              </span>
              <span>
                <strong>Missing room or time</strong>
                <small>Blocks public inclusion</small>
              </span>
              <em>{missingPlacementCount}</em>
            </button>
            <button
              className={
                hardConflictCount > 0
                  ? "agenda-drilldown is-blocking"
                  : "agenda-drilldown"
              }
              onClick={() => setConflictsOpen(true)}
              type="button"
            >
              <span>
                <AlertTriangle aria-hidden="true" size={16} />
              </span>
              <span>
                <strong>Hard conflicts</strong>
                <small>Inspect overlapping people</small>
              </span>
              <em>{hardConflictCount}</em>
            </button>
          </section>

          <div className="agenda-toolbar">
            <div className="agenda-days" aria-label="Agenda day">
              {agendaDays.map((agendaDay) => (
                <button
                  aria-pressed={day === agendaDay.date}
                  key={agendaDay.date}
                  onClick={() => changeDay(agendaDay.date)}
                  type="button"
                >
                  <strong>{agendaDay.shortWeekday}</strong>
                  <span>{agendaDay.shortDate}</span>
                </button>
              ))}
            </div>
            <span className="agenda-timezone">
              <Clock3 aria-hidden="true" size={15} />{" "}
              {agendaScheduleView.timezone}
            </span>
            <button
              className="agenda-filter-button"
              onClick={() => setFiltersOpen(true)}
              type="button"
            >
              <SlidersHorizontal aria-hidden="true" size={16} /> View options{" "}
              <ChevronDown aria-hidden="true" size={15} />
            </button>
          </div>

          <div className="agenda-layout">
            <aside className="agenda-rail" aria-labelledby="agenda-rail-title">
              <div className="agenda-rail-heading">
                <div>
                  <p className="overline">Accepted</p>
                  <h2 id="agenda-rail-title">Unscheduled</h2>
                </div>
                <span>{unscheduled.length}</span>
              </div>
              <TextField
                id="agenda-search"
                label="Search sessions"
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Title, speaker, track…"
                value={search}
              />
              <button
                className="agenda-track-filter"
                onClick={() => setFiltersOpen(true)}
                type="button"
              >
                <Filter aria-hidden="true" size={14} />{" "}
                {trackFilter === "all" ? "All tracks" : trackFilter}{" "}
                <ChevronDown aria-hidden="true" size={14} />
              </button>
              <div className="agenda-unscheduled-list">
                {unscheduled.map((session) => (
                  <UnscheduledCard
                    key={session.id}
                    onDragEnd={endDrag}
                    onDragStart={(event) => startDrag(event, session)}
                    onSchedule={() => openSchedule(session)}
                    session={session}
                  />
                ))}
              </div>
              {unscheduled.length === 0 ? (
                <p className="agenda-empty-search">
                  {search
                    ? "No unscheduled sessions match this search."
                    : "Every accepted session has a room and time."}
                </p>
              ) : null}
            </aside>

            {view === "day" ? (
              <section
                className="agenda-grid-panel"
                aria-labelledby="agenda-grid-title"
              >
                <div className="agenda-grid-heading">
                  <div>
                    <p className="overline">{activeDay?.fullLabel}</p>
                    <h2 id="agenda-grid-title">Room schedule</h2>
                  </div>
                  <span>
                    {visibleScheduled.length} placed · {missingPlacementCount}{" "}
                    unscheduled
                  </span>
                </div>
                <div
                  className="agenda-grid-scroll"
                  style={gridStyle}
                  tabIndex={0}
                  aria-label="Room schedule grid, scroll horizontally for more rooms"
                >
                  <div className="agenda-room-headers">
                    <span className="agenda-time-corner">PT</span>
                    {agendaRooms.map((agendaRoom) => (
                      <div key={agendaRoom.id}>
                        <MapPin aria-hidden="true" size={14} />
                        <span>
                          <strong>{agendaRoom.name}</strong>
                          <small>{agendaRoom.capacity} seats</small>
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="agenda-grid-body">
                    <div className="agenda-time-axis">
                      {activeTimes.map((time, index) => (
                        <span key={time}>
                          {index % timeLabelStride === 0 ? time : ""}
                        </span>
                      ))}
                    </div>
                    {agendaRooms.map((agendaRoom) => (
                      <div
                        className="agenda-room-track"
                        data-room={agendaRoom.id}
                        key={agendaRoom.id}
                      >
                        {activeTimes.map((time, index) => {
                          const slot = index + 1;
                          const active =
                            dragTarget?.roomId === agendaRoom.id &&
                            dragTarget.slot === slot;
                          return (
                            <div
                              aria-hidden="true"
                              className={`agenda-drop-slot${active ? " is-active" : ""}${active && dragTarget.conflict ? " has-conflict" : ""}`}
                              data-room={agendaRoom.id}
                              data-slot={slot}
                              data-time={time}
                              key={`${agendaRoom.id}-${time}`}
                              onDragEnter={(event) =>
                                updateDragTarget(event, agendaRoom.id, slot)
                              }
                              onDragOver={(event) => {
                                if (!sessionFromDrag(event)) {
                                  return;
                                }
                                event.preventDefault();
                                event.dataTransfer.dropEffect = "move";
                                updateDragTarget(event, agendaRoom.id, slot);
                              }}
                              onDrop={(event) =>
                                dropSession(event, agendaRoom.id, slot)
                              }
                              style={{ gridRow: String(slot) }}
                            >
                              {active ? (
                                <span>
                                  {dragTarget.conflict
                                    ? "Possible overlap"
                                    : `Drop at ${time}`}
                                </span>
                              ) : null}
                            </div>
                          );
                        })}
                        {visibleScheduled
                          .filter((session) => session.roomId === agendaRoom.id)
                          .map((session) => (
                            <ScheduledCard
                              days={agendaDays}
                              key={session.id}
                              onSelect={() => selectScheduled(session)}
                              saving={savingPlacementIds.includes(session.id)}
                              session={session}
                            />
                          ))}
                      </div>
                    ))}
                  </div>
                </div>
                <p className="agenda-grid-help">
                  <GripVertical aria-hidden="true" size={14} /> Drag a session
                  into a room, or use its Schedule… action for the same
                  validation.
                </p>
              </section>
            ) : (
              <section
                className="agenda-alternate-panel"
                aria-labelledby="agenda-alternate-title"
              >
                <div className="agenda-alternate-heading">
                  <div>
                    <p className="overline">Canonical agenda view</p>
                    <h2 id="agenda-alternate-title">
                      {view.charAt(0).toUpperCase() + view.slice(1)} schedule
                    </h2>
                  </div>
                  <span>{filteredScheduled.length} matching placements</span>
                </div>
                <AgendaPresentation
                  day={day}
                  days={agendaDays}
                  onSelect={selectScheduled}
                  rooms={agendaRooms}
                  scheduled={filteredScheduled}
                  tracks={agendaTracks}
                  view={view}
                />
              </section>
            )}
          </div>

          <Dialog
            description="Choose the same day, time, room, and duration used by drag placement."
            onClose={() => setScheduleOpen(false)}
            open={scheduleOpen}
            title={
              selectedSession
                ? `Schedule “${selectedSession.title}”`
                : "Schedule session"
            }
          >
            <div className="agenda-schedule-form">
              <div className="agenda-session-summary">
                <span className={`is-${selectedSession?.tone ?? "ai"}`} />
                <div>
                  <strong>{selectedSession?.title}</strong>
                  <small>{selectedSession?.speakers.join(" · ")}</small>
                </div>
              </div>
              {placementError ? (
                <div className="agenda-placement-error" role="alert">
                  <AlertTriangle aria-hidden="true" size={17} />
                  <span>
                    <strong>Placement not saved</strong>
                    <small>{placementError}</small>
                  </span>
                </div>
              ) : null}
              <SelectField
                id="agenda-day"
                label="Day"
                options={agendaDays.map((agendaDay) => ({
                  label: agendaDay.fullLabel,
                  value: agendaDay.date,
                }))}
                value={day}
                onChange={(event) => changeDay(event.target.value as AgendaDay)}
              />
              <div className="agenda-schedule-pair">
                <SelectField
                  id="agenda-start"
                  label="Start time"
                  options={activeTimes.map((time) => ({
                    label: time,
                    value: time,
                  }))}
                  value={start}
                  onChange={(event) => setStart(event.target.value)}
                />
                <SelectField
                  id="agenda-duration"
                  label="Duration"
                  options={agendaScheduleView.formats.map((format) => ({
                    label: `${format.defaultDurationMinutes} minutes`,
                    value: String(format.defaultDurationMinutes),
                  }))}
                  value={duration}
                  onChange={(event) => setDuration(event.target.value)}
                />
              </div>
              <SelectField
                id="agenda-room"
                label="Room"
                options={agendaRooms.map((item) => ({
                  label: `${item.name} · ${item.capacity} seats`,
                  value: item.id,
                }))}
                value={room}
                onChange={(event) => setRoom(event.target.value)}
              />
              <div className="agenda-validation-pending">
                <Clock3 aria-hidden="true" size={16} />
                <span>
                  <strong>Conflict validation runs after save</strong>
                  <small>
                    Publication stays blocked until the authoritative room and
                    participant checks return.
                  </small>
                </span>
              </div>
              <div className="agenda-dialog-actions">
                <Button
                  variant="secondary"
                  onClick={() => setScheduleOpen(false)}
                >
                  Cancel
                </Button>
                <Button onClick={placeSession}>Schedule session</Button>
              </div>
            </div>
          </Dialog>

          <Drawer
            description="Filters are encoded in the URL so this exact organizer view can be shared."
            onClose={() => setFiltersOpen(false)}
            open={filtersOpen}
            title="Agenda view options"
          >
            <div className="agenda-filter-form">
              <SelectField
                id="agenda-view-track"
                label="Track"
                onChange={(event) => {
                  setTrackFilter(event.target.value);
                  replaceAgendaUrl({ track: event.target.value });
                }}
                options={[
                  { label: "All tracks", value: "all" },
                  ...agendaTracks.map((track) => ({
                    label: track.name,
                    value: track.name,
                  })),
                ]}
                value={trackFilter}
              />
              <SelectField
                id="agenda-view-room"
                label="Room"
                onChange={(event) => {
                  setRoomFilter(event.target.value);
                  replaceAgendaUrl({ room: event.target.value });
                }}
                options={[
                  { label: "All rooms", value: "all" },
                  ...agendaRooms.map((agendaRoom) => ({
                    label: agendaRoom.name,
                    value: agendaRoom.id,
                  })),
                ]}
                value={roomFilter}
              />
              <p className="agenda-filter-summary">
                {filteredScheduled.length} placements match this view. Local
                times remain in {agendaScheduleView.timezone} across every
                presentation.
              </p>
              <div className="agenda-filter-actions">
                <Button
                  onClick={() => {
                    setTrackFilter("all");
                    setRoomFilter("all");
                    replaceAgendaUrl({ room: "all", track: "all" });
                  }}
                  variant="secondary"
                >
                  Reset filters
                </Button>
                <Button onClick={() => setFiltersOpen(false)}>Done</Button>
              </div>
            </div>
          </Drawer>

          <Drawer
            description="Inspect placement and publication impact without leaving the agenda."
            onClose={() => setSessionOpen(false)}
            open={sessionOpen}
            title="Session placement"
          >
            {selectedScheduled ? (
              <div className="agenda-session-detail">
                <header>
                  <StatusPill tone="preview">
                    {selectedScheduled.track}
                  </StatusPill>
                  <h3>{selectedScheduled.title}</h3>
                  <p>{selectedScheduled.speakers.join(" · ")}</p>
                </header>
                <div className="agenda-session-detail-meta">
                  <span>
                    <strong>
                      {agendaDay(agendaDays, selectedScheduled.day)?.fullLabel}
                    </strong>
                    <small>
                      {
                        agendaDay(agendaDays, selectedScheduled.day)?.times[
                          selectedScheduled.slot - 1
                        ]
                      }{" "}
                      · {selectedScheduled.durationMinutes} minutes
                    </small>
                  </span>
                  <span>
                    <strong>
                      {agendaRooms.find(
                        (agendaRoom) =>
                          agendaRoom.id === selectedScheduled.roomId,
                      )?.name ?? "Room pending"}
                    </strong>
                    <small>
                      {selectedScheduled.format} · {selectedScheduled.track}
                    </small>
                  </span>
                </div>
                <div className="agenda-publication-impact">
                  <Eye aria-hidden="true" size={17} />
                  <span>
                    <strong>
                      {published
                        ? `Included in public version ${publishedVersion}`
                        : "Not public until the next publish"}
                    </strong>
                    <small>
                      Moving or canceling a published session creates a calendar
                      update path and audit entry after the authoritative
                      command.
                    </small>
                  </span>
                </div>
                <div className="agenda-session-detail-actions">
                  <Button
                    onClick={() => setSessionOpen(false)}
                    variant="secondary"
                  >
                    Close
                  </Button>
                  {!readOnly ? (
                    <Button onClick={editScheduled}>Edit placement</Button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </Drawer>

          <Drawer
            description="Hard conflicts block publishing. Soft warnings need acknowledgement."
            onClose={() => setConflictsOpen(false)}
            open={conflictsOpen}
            title="Agenda conflicts"
          >
            <div className="agenda-conflicts">
              {hardConflictCount > 0 ? (
                <article>
                  <span>
                    <AlertTriangle aria-hidden="true" size={17} />
                  </span>
                  <div>
                    <StatusPill tone="warning">Hard conflict</StatusPill>
                    <h3>Ren Ito is scheduled twice at 10:30 AM</h3>
                    <p>
                      “The Agent Runtime Is the Product” overlaps a panel in
                      Gallery 308 by 30 minutes.
                    </p>
                    <button
                      onClick={() => {
                        const conflict = scheduled.find(
                          (session) => session.status === "conflict",
                        );
                        if (conflict) {
                          setConflictsOpen(false);
                          selectScheduled(conflict);
                        }
                      }}
                      type="button"
                    >
                      Open affected session{" "}
                      <ArrowRight aria-hidden="true" size={14} />
                    </button>
                  </div>
                </article>
              ) : (
                <div className="agenda-publish-version">
                  <span>
                    <Check aria-hidden="true" size={16} />
                  </span>
                  <span>
                    <strong>No hard conflicts</strong>
                    <small>
                      Room and participant placement checks are clear in this
                      projection.
                    </small>
                  </span>
                </div>
              )}
              <p>
                {hardConflictCount} hard conflicts · 0 room conflicts · 2
                travel-time warnings
              </p>
            </div>
          </Drawer>

          <Dialog
            description={
              publicationPreviewOnly
                ? "Review publishing readiness here. This preview does not create a public schedule snapshot."
                : "Resolve every publishing blocker before making this agenda public."
            }
            onClose={() => setPublishOpen(false)}
            open={publishOpen}
            title="Publish agenda preview"
          >
            <div className="agenda-publish-preview">
              <div>
                <StatusPill tone={publishable ? "success" : "warning"}>
                  {publishable ? "Ready" : "Not ready"}
                </StatusPill>
                <strong>
                  {publishable
                    ? publicationPreviewOnly
                      ? `Version ${publishedVersion + 1} is ready for authoritative publication`
                      : `Version ${publishedVersion + 1} can go public`
                    : `${blockerCategoryCount} blocker categories need attention`}
                </strong>
              </div>
              <div className="agenda-publish-version">
                <span>
                  {publishable ? (
                    <Check aria-hidden="true" size={16} />
                  ) : (
                    <Eye aria-hidden="true" size={16} />
                  )}
                </span>
                <span>
                  <strong>
                    Public version {publishedVersion} → {publishedVersion + 1}
                  </strong>
                  <small>
                    {scheduled.length} placed sessions · local event times · one
                    immutable public snapshot
                  </small>
                </span>
              </div>
              <ul>
                {hardConflictCount > 0 ? (
                  <li>
                    <AlertTriangle aria-hidden="true" size={15} />{" "}
                    {hardConflictCount} hard speaker conflict
                    {hardConflictCount === 1 ? "" : "s"}
                  </li>
                ) : null}
                {missingPlacementCount > 0 ? (
                  <li>
                    <CircleAlert aria-hidden="true" size={15} />{" "}
                    {missingPlacementCount} accepted sessions are missing a room
                    or time
                  </li>
                ) : null}
                {!hasSessionsOnEveryDay ? (
                  <li>
                    <CalendarDays aria-hidden="true" size={15} /> One or more
                    event days have no sessions yet
                  </li>
                ) : null}
                {conflictValidationPending ? (
                  <li>
                    <Clock3 aria-hidden="true" size={15} /> Placement conflict
                    validation is pending
                  </li>
                ) : null}
                {publishable ? (
                  <>
                    <li>
                      <Check aria-hidden="true" size={15} /> Every accepted
                      public session has a room and time
                    </li>
                    <li>
                      <Check aria-hidden="true" size={15} /> Participant and
                      room conflicts are clear
                    </li>
                    <li>
                      <Check aria-hidden="true" size={15} /> Public schedule,
                      gallery, feed, and calendar invalidation are ready for the
                      authoritative publication command
                    </li>
                  </>
                ) : null}
              </ul>
              <div>
                <Button
                  variant="secondary"
                  onClick={() => setPublishOpen(false)}
                >
                  Keep scheduling
                </Button>
                {publicationPreviewOnly ? (
                  <Button onClick={() => setPublishOpen(false)}>
                    Close preview
                  </Button>
                ) : (
                  <Button disabled={!publishable} onClick={publishAgenda}>
                    Publish version {publishedVersion + 1}
                  </Button>
                )}
              </div>
            </div>
          </Dialog>
        </>
      ) : null}

      <ToastRegion
        messages={toasts}
        onDismiss={(id) =>
          setToasts((current) => current.filter((toast) => toast.id !== id))
        }
      />
      <LiveRegion message={announcement} />
    </div>
  );
}
