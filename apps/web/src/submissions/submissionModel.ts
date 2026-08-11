export type SubmissionStatus =
  | "draft"
  | "submitted"
  | "under_review"
  | "accepted"
  | "waitlisted"
  | "declined"
  | "withdrawn";

export interface SubmissionAnswerView {
  label: string;
  value: string;
}

export interface SubmissionParticipantView {
  company: string;
  name: string;
  role: string;
}

export interface SubmissionReviewView {
  reviewer: string;
  score?: number;
  status: "assigned" | "submitted" | "conflict";
  summary: string;
}

export interface SubmissionHistoryView {
  actor: string;
  detail: string;
  id: string;
  time: string;
  title: string;
}

export interface SubmissionNoteView {
  actor: string;
  id: string;
  text: string;
  time: string;
}

export interface SubmissionView {
  aggregateScore?: number;
  answers: SubmissionAnswerView[];
  format: string;
  formVersion: string;
  history: SubmissionHistoryView[];
  id: string;
  lastActivity: string;
  notes: SubmissionNoteView[];
  participants: SubmissionParticipantView[];
  reference?: string;
  reviewCount: number;
  reviewersAssigned: number;
  reviews: SubmissionReviewView[];
  routing: string[];
  status: SubmissionStatus;
  submittedAt?: string;
  submitter: string;
  title: string;
  track: string;
  trackId?: string | null;
  version?: number;
}

const productionAnswers: SubmissionAnswerView[] = [
  {
    label: "Abstract",
    value:
      "A field guide to building agent systems that remain understandable under partial failure. We will trace one production workflow from tool call to recovery, including durable checkpoints, idempotent commands, and the operator experience when a dependency is late.",
  },
  {
    label: "What will attendees learn?",
    value:
      "How to choose checkpoint boundaries, expose trustworthy recovery states, and measure reliability without hiding failure behind retries.",
  },
  {
    label: "Audience level",
    value: "Intermediate — practical architecture experience is helpful.",
  },
  {
    label: "Prior presentation",
    value:
      "A shorter version was presented internally at Northstar Labs. This proposal adds the incident walkthrough and operating model.",
  },
];

export const submissionFixture: SubmissionView[] = [
  {
    aggregateScore: 4.42,
    answers: productionAnswers,
    format: "30-minute talk",
    formVersion: "CFP form v2 · submitted snapshot",
    history: [
      {
        actor: "Mina Okafor",
        detail: "Submitted from the speaker portal using CFP form v2.",
        id: "history-1042-submitted",
        time: "Jul 28 · 9:14 AM",
        title: "Submitted",
      },
      {
        actor: "Casey Manos",
        detail: "Moved into review after eligibility check.",
        id: "history-1042-review",
        time: "Jul 29 · 10:32 AM",
        title: "Under review",
      },
      {
        actor: "Jordan Lee",
        detail: "Added Maya Singh as the fourth reviewer.",
        id: "history-1042-routing",
        time: "Today · 11:42 AM",
        title: "Review routing updated",
      },
    ],
    id: "AI-1042",
    lastActivity: "8 min ago",
    notes: [
      {
        actor: "Jordan Lee",
        id: "note-1042-1",
        text: "Strong anchor for the reliability block. Confirm the live-demo fallback before acceptance.",
        time: "Today · 11:45 AM",
      },
    ],
    participants: [
      {
        company: "Northstar Labs",
        name: "Mina Okafor",
        role: "Primary speaker",
      },
      {
        company: "Northstar Labs",
        name: "Theo Martin",
        role: "Co-speaker",
      },
    ],
    reviewCount: 3,
    reviewersAssigned: 4,
    reviews: [
      {
        reviewer: "Maya Singh",
        score: 4.6,
        status: "submitted",
        summary: "Specific, credible, and unusually clear about recovery UX.",
      },
      {
        reviewer: "Alex Chen",
        score: 4.35,
        status: "submitted",
        summary: "Strong production evidence; tighten the opening setup.",
      },
      {
        reviewer: "Priya Nair",
        score: 4.3,
        status: "submitted",
        summary: "Excellent fit for the systems track.",
      },
      {
        reviewer: "Sam Rivera",
        status: "assigned",
        summary: "Review due tomorrow at 5 PM.",
      },
    ],
    routing: ["Production Systems", "Reliability", "30-minute talk"],
    status: "under_review",
    submittedAt: "July 28, 2026 at 9:14 AM",
    submitter: "Mina Okafor",
    title: "From Prototype to Production: Reliable Agent Systems",
    track: "Production Systems",
  },
  {
    answers: [],
    format: "45-minute talk",
    formVersion: "CFP form v2 · submitted snapshot",
    history: [],
    id: "AI-1068",
    lastActivity: "34 min ago",
    notes: [],
    participants: [
      { company: "Sequence", name: "Jamie Park", role: "Primary speaker" },
    ],
    reviewCount: 0,
    reviewersAssigned: 3,
    reviews: [],
    routing: ["Agent Architecture", "45-minute talk"],
    status: "submitted",
    submittedAt: "August 7, 2026 at 2:28 PM",
    submitter: "Jamie Park",
    title: "Context Is a Product Decision",
    track: "Agent Architecture",
  },
  {
    aggregateScore: 4.71,
    answers: [],
    format: "30-minute talk",
    formVersion: "CFP form v1 · submitted snapshot",
    history: [],
    id: "AI-1017",
    lastActivity: "Yesterday",
    notes: [],
    participants: [
      { company: "Arcade", name: "Alex Chen", role: "Primary speaker" },
    ],
    reviewCount: 4,
    reviewersAssigned: 4,
    reviews: [],
    routing: ["Human Systems", "30-minute talk"],
    status: "accepted",
    submittedAt: "July 20, 2026 at 4:03 PM",
    submitter: "Alex Chen",
    title: "Designing Human Checkpoints That Scale",
    track: "Human Systems",
  },
  {
    aggregateScore: 4.08,
    answers: [],
    format: "Lightning talk",
    formVersion: "CFP form v2 · submitted snapshot",
    history: [],
    id: "AI-1114",
    lastActivity: "Yesterday",
    notes: [],
    participants: [
      { company: "Helix", name: "Priya Nair", role: "Primary speaker" },
    ],
    reviewCount: 3,
    reviewersAssigned: 3,
    reviews: [],
    routing: ["Evaluation", "Lightning talk"],
    status: "waitlisted",
    submittedAt: "August 1, 2026 at 11:19 AM",
    submitter: "Priya Nair",
    title: "What Your Agent Eval Is Actually Measuring",
    track: "Evaluation",
  },
  {
    aggregateScore: 3.14,
    answers: [],
    format: "30-minute talk",
    formVersion: "CFP form v2 · submitted snapshot",
    history: [],
    id: "AI-1091",
    lastActivity: "Aug 5",
    notes: [],
    participants: [
      { company: "Independent", name: "Chris Wu", role: "Primary speaker" },
    ],
    reviewCount: 3,
    reviewersAssigned: 3,
    reviews: [],
    routing: ["Developer Experience", "30-minute talk"],
    status: "declined",
    submittedAt: "July 31, 2026 at 8:42 PM",
    submitter: "Chris Wu",
    title: "The Agent CLI You Will Replace Next Year",
    track: "Developer Experience",
  },
  {
    answers: [],
    format: "Workshop",
    formVersion: "CFP form v2 · draft snapshot",
    history: [],
    id: "AI-1133",
    lastActivity: "Aug 4",
    notes: [],
    participants: [
      { company: "Tandem", name: "Noor Rahman", role: "Primary speaker" },
    ],
    reviewCount: 0,
    reviewersAssigned: 0,
    reviews: [],
    routing: ["Workshops"],
    status: "withdrawn",
    submitter: "Noor Rahman",
    title: "Building a Durable Research Partner",
    track: "Workshops",
  },
];

export const submissionStatusLabels: Record<SubmissionStatus, string> = {
  accepted: "Accepted",
  declined: "Declined",
  draft: "Draft",
  submitted: "Submitted",
  under_review: "Under review",
  waitlisted: "Waitlisted",
  withdrawn: "Withdrawn",
};

export function submissionStatusTone(status: SubmissionStatus) {
  if (status === "accepted") return "success" as const;
  if (status === "submitted" || status === "under_review") {
    return "preview" as const;
  }
  if (status === "declined" || status === "withdrawn") {
    return "warning" as const;
  }
  return "neutral" as const;
}
