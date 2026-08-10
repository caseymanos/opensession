export interface AgendaSessionView {
  durationMinutes: number;
  format: string;
  id: string;
  speakers: string[];
  title: string;
  track: "AI Engineering" | "Evaluation" | "Infrastructure" | "Product";
}

export type AgendaDay = "tuesday" | "wednesday";
export type AgendaView = "day" | "list" | "room" | "track" | "week";

export interface ScheduledSessionView extends AgendaSessionView {
  day: AgendaDay;
  roomId: string;
  slot: number;
  span: number;
  status?: "conflict";
}

export interface AgendaRoomView {
  capacity: number;
  id: string;
  name: string;
}

export const agendaRooms: AgendaRoomView[] = [
  { capacity: 280, id: "cowell", name: "Cowell Theater" },
  { capacity: 120, id: "gallery", name: "Gallery 308" },
  { capacity: 80, id: "firehouse", name: "Firehouse" },
];

export const agendaTimes = [
  "9:00 AM",
  "9:30 AM",
  "10:00 AM",
  "10:30 AM",
  "11:00 AM",
  "11:30 AM",
  "12:00 PM",
  "12:30 PM",
  "1:00 PM",
];

export const unscheduledSessionFixture: AgendaSessionView[] = [
  {
    durationMinutes: 30,
    format: "Talk",
    id: "session-eval-suite",
    speakers: ["Priya Nair"],
    title: "Your Eval Suite Is Lying to You",
    track: "Evaluation",
  },
  {
    durationMinutes: 45,
    format: "Talk",
    id: "session-human-checkpoints",
    speakers: ["Alex Chen", "Jo Bell"],
    title: "Designing Human Checkpoints That Scale",
    track: "Product",
  },
  {
    durationMinutes: 30,
    format: "Talk",
    id: "session-small-models",
    speakers: ["Tariq Owens"],
    title: "Small Models, Serious Systems",
    track: "Infrastructure",
  },
  {
    durationMinutes: 60,
    format: "Workshop",
    id: "session-tool-failures",
    speakers: ["Elena Vasquez"],
    title: "A Field Guide to Tool-Calling Failures",
    track: "AI Engineering",
  },
];

export const scheduledSessionFixture: ScheduledSessionView[] = [
  {
    day: "tuesday",
    durationMinutes: 30,
    format: "Talk",
    id: "session-opening",
    roomId: "cowell",
    slot: 1,
    span: 1,
    speakers: ["Casey Manos"],
    title: "Opening & State of AI Engineering",
    track: "AI Engineering",
  },
  {
    day: "tuesday",
    durationMinutes: 60,
    format: "Talk",
    id: "session-reliability",
    roomId: "cowell",
    slot: 4,
    span: 2,
    speakers: ["Mina Okafor"],
    title: "The Reliability Gap in Production Agents",
    track: "AI Engineering",
  },
  {
    day: "tuesday",
    durationMinutes: 45,
    format: "Panel",
    id: "session-benchmarks",
    roomId: "gallery",
    slot: 2,
    span: 2,
    speakers: ["Sam Rivera", "Noor Malik"],
    title: "Benchmarks After the Benchmark",
    track: "Evaluation",
  },
  {
    day: "tuesday",
    durationMinutes: 30,
    format: "Talk",
    id: "session-runtime",
    roomId: "firehouse",
    slot: 4,
    span: 1,
    speakers: ["Ren Ito"],
    status: "conflict",
    title: "The Agent Runtime Is the Product",
    track: "Infrastructure",
  },
];

export const publishableScheduledSessionFixture: ScheduledSessionView[] = [
  ...scheduledSessionFixture.map((session) => {
    const cleanSession = { ...session };
    delete cleanSession.status;
    return cleanSession;
  }),
  {
    day: "tuesday",
    durationMinutes: 45,
    format: "Talk",
    id: "session-human-checkpoints",
    roomId: "firehouse",
    slot: 6,
    span: 2,
    speakers: ["Alex Chen", "Jo Bell"],
    title: "Designing Human Checkpoints That Scale",
    track: "Product",
  },
  {
    day: "wednesday",
    durationMinutes: 30,
    format: "Talk",
    id: "session-eval-suite",
    roomId: "gallery",
    slot: 2,
    span: 1,
    speakers: ["Priya Nair"],
    title: "Your Eval Suite Is Lying to You",
    track: "Evaluation",
  },
  {
    day: "wednesday",
    durationMinutes: 30,
    format: "Talk",
    id: "session-small-models",
    roomId: "cowell",
    slot: 4,
    span: 1,
    speakers: ["Tariq Owens"],
    title: "Small Models, Serious Systems",
    track: "Infrastructure",
  },
  {
    day: "wednesday",
    durationMinutes: 60,
    format: "Workshop",
    id: "session-tool-failures",
    roomId: "firehouse",
    slot: 5,
    span: 2,
    speakers: ["Elena Vasquez"],
    title: "A Field Guide to Tool-Calling Failures",
    track: "AI Engineering",
  },
];
