export type DecisionState =
  "accepted" | "declined" | "undecided" | "waitlisted";

export type ReviewState = "conflict" | "pending" | "submitted";

export interface CriterionScoreView {
  criterion: string;
  score: number;
  weight: number;
}

export interface RawReviewView {
  conflictReason?: string;
  criteria: CriterionScoreView[];
  note?: string;
  overallScore?: number;
  reviewer: string;
  status: ReviewState;
  submittedAt?: string;
}

export interface DecisionHistoryView {
  action: Exclude<DecisionState, "undecided">;
  actor: string;
  audience: string;
  messageMode: "recorded_only" | "send_queued";
  privateNote?: string;
  reason: string;
  template?: string;
  time: string;
}

export interface DecisionSubmissionView {
  aggregateScore?: number;
  decision: DecisionState;
  format: string;
  history: DecisionHistoryView[];
  id: string;
  reviews: RawReviewView[];
  speakerCount: number;
  title: string;
  track: string;
}

export const decisionSubmissionsFixture: DecisionSubmissionView[] = [
  {
    aggregateScore: 4.38,
    decision: "undecided",
    format: "30-minute talk",
    history: [],
    id: "AES-1042",
    reviews: [
      {
        criteria: [
          { criterion: "Audience value", score: 5, weight: 40 },
          { criterion: "Specificity & evidence", score: 4, weight: 35 },
          { criterion: "Originality", score: 4, weight: 25 },
        ],
        note: "Strong operating detail and a clear audience takeaway.",
        overallScore: 4.4,
        reviewer: "Maya Singh",
        status: "submitted",
        submittedAt: "Aug 9 · 11:42 AM",
      },
      {
        criteria: [
          { criterion: "Audience value", score: 4, weight: 40 },
          { criterion: "Specificity & evidence", score: 5, weight: 35 },
          { criterion: "Originality", score: 4, weight: 25 },
        ],
        note: "The evidence is unusually concrete. Tighten the opening claim.",
        overallScore: 4.35,
        reviewer: "Theo Martin",
        status: "submitted",
        submittedAt: "Aug 9 · 1:08 PM",
      },
      {
        criteria: [],
        reviewer: "Drew Kim",
        status: "pending",
      },
      {
        conflictReason: "Prior advisory relationship with the speaker",
        criteria: [],
        reviewer: "Sam Rivera",
        status: "conflict",
      },
    ],
    speakerCount: 2,
    title: "The Reliability Gap in Production Agents",
    track: "AI Engineering",
  },
  {
    aggregateScore: 4.02,
    decision: "undecided",
    format: "30-minute talk",
    history: [],
    id: "AES-1081",
    reviews: [
      {
        criteria: [],
        overallScore: 4.2,
        reviewer: "Priya Das",
        status: "submitted",
        submittedAt: "Aug 8 · 4:42 PM",
      },
      {
        criteria: [],
        overallScore: 3.95,
        reviewer: "Noah Williams",
        status: "submitted",
        submittedAt: "Aug 9 · 9:16 AM",
      },
      {
        criteria: [],
        overallScore: 3.9,
        reviewer: "Leah Gardner",
        status: "submitted",
        submittedAt: "Aug 9 · 2:02 PM",
      },
    ],
    speakerCount: 1,
    title: "Your Eval Suite Is Lying to You",
    track: "Evaluation",
  },
  {
    aggregateScore: 4.61,
    decision: "accepted",
    format: "45-minute talk",
    history: [
      {
        action: "accepted",
        actor: "Casey Manos",
        audience: "Primary speaker + 1 co-speaker",
        messageMode: "send_queued",
        privateNote: "Anchor the product track with this session.",
        reason: "Strongest fit for the Product program",
        template: "Acceptance · AI Engineer Summit",
        time: "Aug 9 · 3:18 PM",
      },
    ],
    id: "AES-1120",
    reviews: [
      {
        criteria: [],
        overallScore: 4.75,
        reviewer: "Casey Brooks",
        status: "submitted",
        submittedAt: "Aug 9 · 10:02 AM",
      },
      {
        criteria: [],
        overallScore: 4.6,
        reviewer: "Inez Park",
        status: "submitted",
        submittedAt: "Aug 9 · 11:10 AM",
      },
      {
        criteria: [],
        overallScore: 4.48,
        reviewer: "Omar Ali",
        status: "submitted",
        submittedAt: "Aug 9 · 12:44 PM",
      },
    ],
    speakerCount: 2,
    title: "Designing Human Checkpoints That Scale",
    track: "Product · Track D",
  },
  {
    aggregateScore: 3.88,
    decision: "waitlisted",
    format: "20-minute talk",
    history: [
      {
        action: "waitlisted",
        actor: "Casey Manos",
        audience: "Primary speaker",
        messageMode: "recorded_only",
        privateNote: "Revisit after the first acceptance deadline.",
        reason: "Strong proposal; room capacity is unresolved",
        time: "Aug 9 · 4:05 PM",
      },
    ],
    id: "AES-1164",
    reviews: [
      {
        criteria: [],
        overallScore: 4.0,
        reviewer: "Sam Rivera",
        status: "submitted",
        submittedAt: "Aug 9 · 1:20 PM",
      },
      {
        criteria: [],
        overallScore: 3.76,
        reviewer: "Leah Gardner",
        status: "submitted",
        submittedAt: "Aug 9 · 2:11 PM",
      },
    ],
    speakerCount: 1,
    title: "Small Models, Serious Systems",
    track: "Infrastructure",
  },
  {
    decision: "undecided",
    format: "30-minute talk",
    history: [],
    id: "AES-1192",
    reviews: [
      { criteria: [], reviewer: "Maya Singh", status: "pending" },
      { criteria: [], reviewer: "Theo Martin", status: "pending" },
    ],
    speakerCount: 1,
    title: "Beyond the Agent Demo",
    track: "AI Engineering",
  },
];

export function reviewSummary(submission: DecisionSubmissionView) {
  const scoreBearing = submission.reviews.filter(
    (review) => review.status !== "conflict",
  );
  const submitted = scoreBearing.filter(
    (review) => review.status === "submitted",
  );
  const scores = submitted.flatMap((review) =>
    review.overallScore === undefined ? [] : [review.overallScore],
  );

  return {
    applicableCount: scoreBearing.length,
    conflictCount: submission.reviews.length - scoreBearing.length,
    max: scores.length ? Math.max(...scores) : undefined,
    min: scores.length ? Math.min(...scores) : undefined,
    missingCount: scoreBearing.length - submitted.length,
    submittedCount: submitted.length,
  };
}
