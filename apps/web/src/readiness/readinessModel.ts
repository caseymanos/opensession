import {
  scheduleSnapshotSchema,
  type ScheduleSnapshot,
} from "@sessionbox-killer/contracts";

import { agendaScheduleSnapshotFixture } from "../agenda/agendaModel";

export interface SpeakerReadinessView {
  company: string;
  completedRequired: number;
  email: string;
  id: string;
  name: string;
  nextDue: string;
  overdueCount: number;
  portalState: "active" | "invited" | "not_invited" | "revoked";
  sessions: string[];
  totalRequired: number;
  track: string;
}

const speakerReadinessBaseFixture: SpeakerReadinessView[] = [
  {
    company: "Daybreak Labs",
    completedRequired: 3,
    email: "mina@example.com",
    id: "speaker-mina",
    name: "Mina Okafor",
    nextDue: "Headshot · Aug 11",
    overdueCount: 1,
    portalState: "active",
    sessions: ["The Reliability Gap in Production Agents"],
    totalRequired: 4,
    track: "AI Engineering",
  },
  {
    company: "Common Thread",
    completedRequired: 4,
    email: "jon@example.com",
    id: "speaker-jon",
    name: "Jon Bell",
    nextDue: "Complete",
    overdueCount: 0,
    portalState: "active",
    sessions: ["Designing Human Checkpoints That Scale"],
    totalRequired: 4,
    track: "Product",
  },
  {
    company: "Signal Bench",
    completedRequired: 2,
    email: "priya@example.com",
    id: "speaker-priya",
    name: "Priya Nair",
    nextDue: "Agreement · Aug 9",
    overdueCount: 2,
    portalState: "active",
    sessions: ["Your Eval Suite Is Lying to You"],
    totalRequired: 4,
    track: "Evaluation",
  },
  {
    company: "Independent",
    completedRequired: 0,
    email: "alex@example.com",
    id: "speaker-alex",
    name: "Alex Chen",
    nextDue: "No required tasks",
    overdueCount: 0,
    portalState: "active",
    sessions: ["Designing Human Checkpoints That Scale"],
    totalRequired: 0,
    track: "Product",
  },
  {
    company: "Northstar AI",
    completedRequired: 4,
    email: "tariq@example.com",
    id: "speaker-tariq",
    name: "Tariq Owens",
    nextDue: "Complete",
    overdueCount: 0,
    portalState: "active",
    sessions: ["Small Models, Serious Systems"],
    totalRequired: 4,
    track: "Infrastructure",
  },
  {
    company: "Boundary Systems",
    completedRequired: 3,
    email: "elena@example.com",
    id: "speaker-elena",
    name: "Elena Vasquez",
    nextDue: "Slides · Aug 14",
    overdueCount: 0,
    portalState: "invited",
    sessions: ["A Field Guide to Tool-Calling Failures"],
    totalRequired: 4,
    track: "AI Engineering",
  },
  {
    company: "Meridian",
    completedRequired: 4,
    email: "ren@example.com",
    id: "speaker-ren",
    name: "Ren Ito",
    nextDue: "Complete",
    overdueCount: 0,
    portalState: "active",
    sessions: ["The Agent Runtime Is the Product"],
    totalRequired: 4,
    track: "Infrastructure",
  },
  {
    company: "Lakehouse Works",
    completedRequired: 1,
    email: "noor@example.com",
    id: "speaker-noor",
    name: "Noor Malik",
    nextDue: "Profile · Aug 12",
    overdueCount: 0,
    portalState: "not_invited",
    sessions: ["Benchmarks After the Benchmark"],
    totalRequired: 4,
    track: "Evaluation",
  },
];

export interface SpeakerScheduleFacts {
  acceptedUnscheduledCount: number;
  sessionTitlesBySpeakerId: ReadonlyMap<string, string[]>;
}

export function speakerScheduleFactsFromSnapshot(
  input: ScheduleSnapshot,
): SpeakerScheduleFacts {
  const snapshot = scheduleSnapshotSchema.parse(input);
  const sessionTitlesBySpeakerId = new Map<string, string[]>();
  for (const session of snapshot.sessions) {
    for (const participant of session.participants) {
      if (participant.role !== "speaker") continue;
      const titles = sessionTitlesBySpeakerId.get(participant.personId) ?? [];
      sessionTitlesBySpeakerId.set(participant.personId, [
        ...titles,
        session.title,
      ]);
    }
  }
  return {
    acceptedUnscheduledCount: snapshot.sessions.filter(
      ({ state }) => state === "accepted_unscheduled",
    ).length,
    sessionTitlesBySpeakerId,
  };
}

export const agendaSpeakerScheduleFacts = speakerScheduleFactsFromSnapshot(
  agendaScheduleSnapshotFixture,
);

export const speakerReadinessFixture: SpeakerReadinessView[] =
  speakerReadinessBaseFixture.map((speaker) => ({
    ...speaker,
    sessions:
      agendaSpeakerScheduleFacts.sessionTitlesBySpeakerId.get(speaker.id) ?? [],
  }));
