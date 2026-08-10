import {
  scheduleSnapshotSchema,
  type ParticipantConflictRole,
  type ScheduleSnapshot,
  type SessionLifecycleState,
} from "@sessionbox-killer/contracts";

export type AgendaDay = string;
export type AgendaView = "day" | "list" | "room" | "track" | "week";
export type AgendaTrackTone = "ai" | "eval" | "infra" | "product";

export interface AgendaParticipantView {
  displayName: string;
  personId: string;
  role: ParticipantConflictRole;
}

export interface AgendaSessionView {
  abstract: string;
  durationMinutes: number;
  format: string;
  formatId: string;
  id: string;
  participants: AgendaParticipantView[];
  speakers: string[];
  state: SessionLifecycleState;
  title: string;
  track: string;
  trackId: string;
  tone: AgendaTrackTone;
}

export interface ScheduledSessionView extends AgendaSessionView {
  day: AgendaDay;
  endAt: string;
  publicationVersion: number;
  roomId: string;
  slot: number;
  slotVersion: number;
  span: number;
  startAt: string;
  status?: "conflict";
}

export interface AgendaRoomView {
  capacity: number;
  id: string;
  name: string;
  order: number;
}

export interface AgendaTrackView {
  id: string;
  name: string;
  order: number;
  tone: AgendaTrackTone;
}

export interface AgendaDayView {
  businessEnd: string;
  businessStart: string;
  date: AgendaDay;
  fullLabel: string;
  shortDate: string;
  shortWeekday: string;
  times: string[];
}

export interface AgendaScheduleView {
  days: AgendaDayView[];
  eventId: string;
  formats: { defaultDurationMinutes: number; id: string; name: string }[];
  publicationVersion: number;
  rooms: AgendaRoomView[];
  scheduled: ScheduledSessionView[];
  slug: string;
  snapMinutes: number;
  timezone: string;
  tracks: AgendaTrackView[];
  unscheduled: AgendaSessionView[];
  version: number;
}

const trackTones: AgendaTrackTone[] = ["ai", "eval", "infra", "product"];

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing ${label}.`);
  return value;
}

function minutesFromLocalTime(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
}

function formatLocalTime(totalMinutes: number) {
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  const period = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${String(minute).padStart(2, "0")} ${period}`;
}

function localTimeFromLabel(value: string) {
  const match = /^(\d{1,2}):(\d{2}) (AM|PM)$/.exec(value);
  if (!match) throw new Error(`Invalid agenda time ${value}.`);
  const hour = (Number(match[1]) % 12) + (match[3] === "PM" ? 12 : 0);
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

function localParts(instant: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).formatToParts(new Date(instant));
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  };
}

export function agendaLocalDateTimeToUtc(
  date: AgendaDay,
  timeLabel: string,
  timezone: string,
) {
  const localTime = localTimeFromLabel(timeLabel);
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = localTime.split(":").map(Number);
  const desired = Date.UTC(
    year ?? 0,
    (month ?? 1) - 1,
    day ?? 1,
    hour ?? 0,
    minute ?? 0,
  );
  let candidate = desired;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const candidateParts = localParts(
      new Date(candidate).toISOString(),
      timezone,
    );
    const [candidateYear, candidateMonth, candidateDay] = candidateParts.date
      .split("-")
      .map(Number);
    const [candidateHour, candidateMinute] = candidateParts.time
      .split(":")
      .map(Number);
    const represented = Date.UTC(
      candidateYear ?? 0,
      (candidateMonth ?? 1) - 1,
      candidateDay ?? 1,
      candidateHour ?? 0,
      candidateMinute ?? 0,
    );
    candidate += desired - represented;
  }
  const result = new Date(candidate).toISOString();
  const represented = localParts(result, timezone);
  if (represented.date !== date || represented.time !== localTime) {
    throw new Error(`${date} ${timeLabel} does not exist in ${timezone}.`);
  }
  return result;
}

function dateLabels(date: string) {
  const value = new Date(`${date}T12:00:00.000Z`);
  return {
    fullLabel: new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      month: "long",
      timeZone: "UTC",
      weekday: "long",
    }).format(value),
    shortDate: new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    }).format(value),
    shortWeekday: new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      weekday: "short",
    }).format(value),
  };
}

function dayTimes(
  businessStart: string,
  businessEnd: string,
  snapMinutes: number,
) {
  const times: string[] = [];
  for (
    let minute = minutesFromLocalTime(businessStart);
    minute < minutesFromLocalTime(businessEnd);
    minute += snapMinutes
  ) {
    times.push(formatLocalTime(minute));
  }
  return times;
}

export function scheduleSnapshotToAgendaView(
  input: ScheduleSnapshot,
  conflictSessionIds: readonly string[] = [],
): AgendaScheduleView {
  const snapshot = scheduleSnapshotSchema.parse(input);
  const rooms = [...snapshot.rooms].sort(
    (left, right) => left.order - right.order,
  );
  const tracks = [...snapshot.tracks]
    .sort((left, right) => left.order - right.order)
    .map((track, index) => ({
      ...track,
      tone: required(trackTones[index % trackTones.length], "track tone"),
    }));
  const formats = [...snapshot.formats].sort(
    (left, right) => left.order - right.order,
  );
  const days = snapshot.event.days.map((day) => ({
    ...day,
    ...dateLabels(day.date),
    times: dayTimes(
      day.businessStart,
      day.businessEnd,
      snapshot.event.snapMinutes,
    ),
  }));
  const conflictIds = new Set(conflictSessionIds);

  const sessions = snapshot.sessions.map((session) => {
    const track = required(
      tracks.find((candidate) => candidate.id === session.trackId),
      `track ${session.trackId}`,
    );
    const format = required(
      formats.find((candidate) => candidate.id === session.formatId),
      `format ${session.formatId}`,
    );
    const base: AgendaSessionView = {
      abstract: session.abstract,
      durationMinutes: session.durationMinutes,
      format: format.name,
      formatId: format.id,
      id: session.id,
      participants: session.participants.map((participant) => ({
        ...participant,
      })),
      speakers: session.participants
        .filter(({ role }) => role === "speaker")
        .map(({ displayName }) => displayName),
      state: session.state,
      title: session.title,
      track: track.name,
      trackId: track.id,
      tone: track.tone,
    };
    if (!session.slot) return base;

    const start = localParts(session.slot.startAt, snapshot.event.timezone);
    const day = required(
      days.find((candidate) => candidate.date === start.date),
      `event day ${start.date}`,
    );
    const startMinutes = minutesFromLocalTime(start.time);
    const slot =
      (startMinutes - minutesFromLocalTime(day.businessStart)) /
        snapshot.event.snapMinutes +
      1;
    return {
      ...base,
      day: day.date,
      endAt: session.slot.endAt,
      publicationVersion: session.slot.publicationVersion,
      roomId: session.slot.roomId,
      slot,
      slotVersion: session.slot.version,
      span: session.durationMinutes / snapshot.event.snapMinutes,
      startAt: session.slot.startAt,
      ...(conflictIds.has(session.id) ? { status: "conflict" as const } : {}),
    };
  });

  return {
    days,
    eventId: snapshot.event.eventId,
    formats,
    publicationVersion: snapshot.event.publicationVersion,
    rooms,
    scheduled: sessions.filter(
      (session): session is ScheduledSessionView => "slot" in session,
    ),
    slug: snapshot.event.slug,
    snapMinutes: snapshot.event.snapMinutes,
    timezone: snapshot.event.timezone,
    tracks,
    unscheduled: sessions.filter(
      (session) => session.state === "accepted_unscheduled",
    ),
    version: snapshot.event.version,
  };
}

const participants = {
  alex: { displayName: "Alex Chen", personId: "speaker-alex", role: "speaker" },
  casey: {
    displayName: "Casey Manos",
    personId: "person-casey",
    role: "chair",
  },
  elena: {
    displayName: "Elena Vasquez",
    personId: "speaker-elena",
    role: "speaker",
  },
  jon: { displayName: "Jon Bell", personId: "speaker-jon", role: "speaker" },
  mina: {
    displayName: "Mina Okafor",
    personId: "speaker-mina",
    role: "speaker",
  },
  noor: {
    displayName: "Noor Malik",
    personId: "speaker-noor",
    role: "speaker",
  },
  priya: {
    displayName: "Priya Nair",
    personId: "speaker-priya",
    role: "speaker",
  },
  ren: { displayName: "Ren Ito", personId: "speaker-ren", role: "speaker" },
  sam: { displayName: "Sam Rivera", personId: "person-sam", role: "moderator" },
  tariq: {
    displayName: "Tariq Owens",
    personId: "speaker-tariq",
    role: "speaker",
  },
} as const;

export const agendaScheduleSnapshotFixture = scheduleSnapshotSchema.parse({
  event: {
    days: [
      { businessEnd: "13:30", businessStart: "09:00", date: "2026-08-18" },
      { businessEnd: "13:30", businessStart: "09:00", date: "2026-08-19" },
    ],
    eventId: "event-ai-engineer-summit",
    publicationVersion: 2,
    slug: "ai-engineer-summit",
    snapMinutes: 15,
    timezone: "America/Los_Angeles",
    version: 7,
  },
  formats: [
    { defaultDurationMinutes: 30, id: "talk", name: "Talk", order: 0 },
    { defaultDurationMinutes: 45, id: "panel", name: "Panel", order: 1 },
    { defaultDurationMinutes: 60, id: "workshop", name: "Workshop", order: 2 },
  ],
  rooms: [
    { capacity: 280, id: "cowell", name: "Cowell Theater", order: 0 },
    { capacity: 120, id: "gallery", name: "Gallery 308", order: 1 },
    { capacity: 80, id: "firehouse", name: "Firehouse", order: 2 },
  ],
  sessions: [
    {
      abstract:
        "A practical opening tour of the systems behind reliable agents.",
      durationMinutes: 30,
      formatId: "talk",
      id: "session-opening",
      participants: [participants.casey],
      slot: {
        endAt: "2026-08-18T16:30:00.000Z",
        publicationVersion: 0,
        roomId: "cowell",
        startAt: "2026-08-18T16:00:00.000Z",
        version: 7,
      },
      state: "scheduled",
      title: "Opening & State of AI Engineering",
      trackId: "ai-engineering",
    },
    {
      abstract: "A production-focused study of reliability in agent systems.",
      durationMinutes: 60,
      formatId: "talk",
      id: "session-reliability",
      participants: [participants.mina],
      slot: {
        endAt: "2026-08-18T18:30:00.000Z",
        publicationVersion: 0,
        roomId: "cowell",
        startAt: "2026-08-18T17:30:00.000Z",
        version: 7,
      },
      state: "scheduled",
      title: "The Reliability Gap in Production Agents",
      trackId: "ai-engineering",
    },
    {
      abstract: "A live discussion of benchmarks after the benchmark.",
      durationMinutes: 45,
      formatId: "panel",
      id: "session-benchmarks",
      participants: [participants.sam, participants.noor],
      slot: {
        endAt: "2026-08-18T17:15:00.000Z",
        publicationVersion: 0,
        roomId: "gallery",
        startAt: "2026-08-18T16:30:00.000Z",
        version: 7,
      },
      state: "scheduled",
      title: "Benchmarks After the Benchmark",
      trackId: "evaluation",
    },
    {
      abstract: "Why runtime design determines the agent product experience.",
      durationMinutes: 30,
      formatId: "talk",
      id: "session-runtime",
      participants: [participants.ren],
      slot: {
        endAt: "2026-08-18T18:00:00.000Z",
        publicationVersion: 0,
        roomId: "firehouse",
        startAt: "2026-08-18T17:30:00.000Z",
        version: 7,
      },
      state: "scheduled",
      title: "The Agent Runtime Is the Product",
      trackId: "infrastructure",
    },
    {
      abstract:
        "A practical framework for detecting misleading evaluation suites.",
      durationMinutes: 30,
      formatId: "talk",
      id: "session-eval-suite",
      participants: [participants.priya],
      slot: null,
      state: "accepted_unscheduled",
      title: "Your Eval Suite Is Lying to You",
      trackId: "evaluation",
    },
    {
      abstract:
        "Patterns for introducing human judgment without creating bottlenecks.",
      durationMinutes: 45,
      formatId: "talk",
      id: "session-human-checkpoints",
      participants: [participants.alex, participants.jon],
      slot: null,
      state: "accepted_unscheduled",
      title: "Designing Human Checkpoints That Scale",
      trackId: "product",
    },
    {
      abstract: "How smaller models can anchor serious production systems.",
      durationMinutes: 30,
      formatId: "talk",
      id: "session-small-models",
      participants: [participants.tariq],
      slot: null,
      state: "accepted_unscheduled",
      title: "Small Models, Serious Systems",
      trackId: "infrastructure",
    },
    {
      abstract: "A field guide to diagnosing tool-calling failures.",
      durationMinutes: 60,
      formatId: "workshop",
      id: "session-tool-failures",
      participants: [participants.elena],
      slot: null,
      state: "accepted_unscheduled",
      title: "A Field Guide to Tool-Calling Failures",
      trackId: "ai-engineering",
    },
  ],
  tracks: [
    { id: "ai-engineering", name: "AI Engineering", order: 0 },
    { id: "evaluation", name: "Evaluation", order: 1 },
    { id: "infrastructure", name: "Infrastructure", order: 2 },
    { id: "product", name: "Product", order: 3 },
  ],
});

function withReadyPlacements(snapshot: ScheduleSnapshot): ScheduleSnapshot {
  const slots = {
    "session-eval-suite": {
      endAt: "2026-08-19T17:00:00.000Z",
      publicationVersion: 0,
      roomId: "gallery",
      startAt: "2026-08-19T16:30:00.000Z",
      version: 7,
    },
    "session-human-checkpoints": {
      endAt: "2026-08-18T19:15:00.000Z",
      publicationVersion: 0,
      roomId: "firehouse",
      startAt: "2026-08-18T18:30:00.000Z",
      version: 7,
    },
    "session-small-models": {
      endAt: "2026-08-19T18:00:00.000Z",
      publicationVersion: 0,
      roomId: "cowell",
      startAt: "2026-08-19T17:30:00.000Z",
      version: 7,
    },
    "session-tool-failures": {
      endAt: "2026-08-19T19:00:00.000Z",
      publicationVersion: 0,
      roomId: "firehouse",
      startAt: "2026-08-19T18:00:00.000Z",
      version: 7,
    },
  } as const;
  return scheduleSnapshotSchema.parse({
    ...snapshot,
    event: { ...snapshot.event, publicationVersion: 3 },
    sessions: snapshot.sessions.map((session) => {
      const slot = slots[session.id as keyof typeof slots];
      return slot ? { ...session, slot, state: "scheduled" as const } : session;
    }),
  });
}

export const readyAgendaScheduleSnapshotFixture = withReadyPlacements(
  agendaScheduleSnapshotFixture,
);

export const agendaScheduleView = scheduleSnapshotToAgendaView(
  agendaScheduleSnapshotFixture,
  ["session-runtime"],
);
export const readyAgendaScheduleView = scheduleSnapshotToAgendaView(
  readyAgendaScheduleSnapshotFixture,
);

export const agendaDays = agendaScheduleView.days;
export const agendaRooms = agendaScheduleView.rooms;
export const agendaTimes = required(agendaDays[0], "first event day").times;
export const agendaTracks = agendaScheduleView.tracks;
export const unscheduledSessionFixture = agendaScheduleView.unscheduled;
export const scheduledSessionFixture = agendaScheduleView.scheduled;
export const publishableScheduledSessionFixture =
  readyAgendaScheduleView.scheduled;
