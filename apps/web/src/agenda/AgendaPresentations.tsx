import {
  AlertTriangle,
  CalendarDays,
  Clock3,
  MapPin,
  Users,
} from "lucide-react";

import { StatusPill } from "@sessionbox-killer/ui";

import {
  agendaRooms,
  agendaTimes,
  type AgendaDay,
  type AgendaSessionView,
  type AgendaView,
  type ScheduledSessionView,
} from "./agendaModel";

const tracks: AgendaSessionView["track"][] = [
  "AI Engineering",
  "Evaluation",
  "Infrastructure",
  "Product",
];

const trackTone: Record<AgendaSessionView["track"], string> = {
  "AI Engineering": "ai",
  Evaluation: "eval",
  Infrastructure: "infra",
  Product: "product",
};

function dayLabel(day: AgendaDay) {
  return day === "tuesday" ? "Tuesday, August 18" : "Wednesday, August 19";
}

function roomName(roomId: string) {
  return agendaRooms.find((room) => room.id === roomId)?.name ?? "Room pending";
}

function timeLabel(session: ScheduledSessionView) {
  return agendaTimes[session.slot - 1] ?? "Time pending";
}

function sortSessions(sessions: ScheduledSessionView[]) {
  return [...sessions].sort((left, right) => {
    if (left.day !== right.day) {
      return left.day === "tuesday" ? -1 : 1;
    }
    return left.slot - right.slot;
  });
}

function SessionRow({
  onSelect,
  session,
}: {
  onSelect: () => void;
  session: ScheduledSessionView;
}) {
  return (
    <button
      className={`agenda-view-session is-${trackTone[session.track]}`}
      onClick={onSelect}
      type="button"
    >
      <span className="agenda-view-session-time">
        <strong>{timeLabel(session)}</strong>
        <small>{session.durationMinutes} min</small>
      </span>
      <span className="agenda-view-session-main">
        <small>{session.track}</small>
        <strong>{session.title}</strong>
        <em>
          <Users aria-hidden="true" size={13} /> {session.speakers.join(" · ")}
        </em>
      </span>
      <span className="agenda-view-session-room">
        <MapPin aria-hidden="true" size={14} /> {roomName(session.roomId)}
      </span>
      {session.status === "conflict" ? (
        <StatusPill tone="warning">
          <AlertTriangle aria-hidden="true" size={12} /> Conflict
        </StatusPill>
      ) : null}
    </button>
  );
}

function EmptyGroup({ label }: { label: string }) {
  return (
    <div className="agenda-view-empty">
      <CalendarDays aria-hidden="true" size={19} />
      <span>
        <strong>No placed sessions</strong>
        <small>{label} is intentionally empty in this draft.</small>
      </span>
    </div>
  );
}

function Group({
  eyebrow,
  onSelect,
  sessions,
  title,
}: {
  eyebrow: string;
  onSelect: (session: ScheduledSessionView) => void;
  sessions: ScheduledSessionView[];
  title: string;
}) {
  return (
    <section className="agenda-view-group">
      <header>
        <div>
          <p className="overline">{eyebrow}</p>
          <h3>{title}</h3>
        </div>
        <span>{sessions.length}</span>
      </header>
      <div className="agenda-view-session-list">
        {sortSessions(sessions).map((session) => (
          <SessionRow
            key={session.id}
            onSelect={() => onSelect(session)}
            session={session}
          />
        ))}
        {sessions.length === 0 ? <EmptyGroup label={title} /> : null}
      </div>
    </section>
  );
}

export function AgendaPresentation({
  day,
  onSelect,
  scheduled,
  view,
}: {
  day: AgendaDay;
  onSelect: (session: ScheduledSessionView) => void;
  scheduled: ScheduledSessionView[];
  view: Exclude<AgendaView, "day">;
}) {
  if (view === "list") {
    return (
      <div className="agenda-view-stack" data-view="list">
        {(["tuesday", "wednesday"] as AgendaDay[]).map((agendaDay) => (
          <Group
            eyebrow="Chronological list"
            key={agendaDay}
            onSelect={onSelect}
            sessions={scheduled.filter((session) => session.day === agendaDay)}
            title={dayLabel(agendaDay)}
          />
        ))}
      </div>
    );
  }

  if (view === "week") {
    return (
      <div className="agenda-week-view" data-view="week">
        {(["tuesday", "wednesday"] as AgendaDay[]).map((agendaDay) => (
          <Group
            eyebrow="Week overview"
            key={agendaDay}
            onSelect={onSelect}
            sessions={scheduled.filter((session) => session.day === agendaDay)}
            title={dayLabel(agendaDay)}
          />
        ))}
      </div>
    );
  }

  if (view === "track") {
    return (
      <div className="agenda-view-stack" data-view="track">
        {tracks.map((track) => (
          <Group
            eyebrow="Track view"
            key={track}
            onSelect={onSelect}
            sessions={scheduled.filter(
              (session) => session.day === day && session.track === track,
            )}
            title={track}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="agenda-room-view" data-view="room">
      {agendaRooms.map((room) => (
        <Group
          eyebrow={`${room.capacity} seats · ${dayLabel(day)}`}
          key={room.id}
          onSelect={onSelect}
          sessions={scheduled.filter(
            (session) => session.day === day && session.roomId === room.id,
          )}
          title={room.name}
        />
      ))}
    </div>
  );
}

export function AgendaViewSwitcher({
  onChange,
  value,
}: {
  onChange: (view: AgendaView) => void;
  value: AgendaView;
}) {
  const options: { label: string; value: AgendaView }[] = [
    { label: "List", value: "list" },
    { label: "Day", value: "day" },
    { label: "Week", value: "week" },
    { label: "Track", value: "track" },
    { label: "Room", value: "room" },
  ];

  return (
    <div className="agenda-view-switcher" aria-label="Agenda view">
      {options.map((option) => (
        <button
          aria-pressed={value === option.value}
          key={option.value}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function AgendaViewContext({
  day,
  room,
  track,
  view,
}: {
  day: AgendaDay;
  room: string;
  track: string;
  view: AgendaView;
}) {
  return (
    <p className="agenda-view-context" role="status">
      <Clock3 aria-hidden="true" size={14} />
      <span>
        <strong>{view.charAt(0).toUpperCase() + view.slice(1)} view</strong>
        {view === "list" || view === "week" ? "Both event days" : dayLabel(day)}
        {track !== "all" ? ` · ${track}` : ""}
        {room !== "all" ? ` · ${roomName(room)}` : ""}
      </span>
    </p>
  );
}
