export type PublicCfpStep =
  | "welcome"
  | "account"
  | "submission"
  | "participants"
  | "review"
  | "confirmation";

export type PublicCfpSaveState =
  "idle" | "saving" | "saved" | "offline" | "failed";

export interface PublicCfpSpeakerDraft {
  email: string;
  id: string;
  name: string;
  role: string;
}

export interface PublicCfpDraft {
  abstract: string;
  consent: boolean;
  defaultReviewerGroupId: string;
  email: string;
  format: string;
  outcomes: string;
  routeKey: string;
  speakers: PublicCfpSpeakerDraft[];
  step: PublicCfpStep;
  submissionTrack: string;
  title: string;
  track: string;
  verified: boolean;
  workshopPrerequisites: string;
}

export interface PublicCfpTrackView extends CfpTrackRoute {
  description: string;
}

export interface PublicCfpEventView {
  closesLabel: string;
  contactEmail: string;
  eventDateLabel: string;
  eventName: string;
  formats: string[];
  location: string;
  maxSubmissions: number;
  resources: { href: string; label: string }[];
  timezoneLabel: string;
  tracks: PublicCfpTrackView[];
}

export const publicCfpTrackRoutes: PublicCfpTrackView[] = [
  {
    defaultReviewerGroupId: "group-ai-engineering",
    description:
      "Architecture, orchestration, reliability, and evaluation in production.",
    routeKey: "ai-engineering",
    selection: "AI Engineering",
    submissionTrack: "AI Engineering",
  },
  {
    defaultReviewerGroupId: "group-evaluation",
    description:
      "Measurement systems, evaluation practice, and quality operations.",
    routeKey: "evaluation",
    selection: "Evaluation",
    submissionTrack: "Evaluation",
  },
  {
    defaultReviewerGroupId: "group-infrastructure",
    description:
      "Platforms, inference, tooling, security, and developer infrastructure.",
    routeKey: "infrastructure",
    selection: "Infrastructure",
    submissionTrack: "Infrastructure",
  },
  {
    aliases: ["Track D", "Product · Track D"],
    defaultReviewerGroupId: "group-product",
    description:
      "Human workflows, product strategy, and responsible deployment.",
    routeKey: "product-track-d",
    selection: "Product",
    submissionTrack: "Product · Track D",
  },
];

export const publicCfpEventFixture: PublicCfpEventView = {
  closesLabel: "Friday, August 21 at 5:00 PM PDT",
  contactEmail: "program@aiengineersummit.com",
  eventDateLabel: "October 13–14, 2026",
  eventName: "AI Engineer Summit",
  formats: ["30-minute talk", "45-minute talk", "90-minute workshop"],
  location: "Fort Mason Center · San Francisco",
  maxSubmissions: 3,
  resources: [
    { href: "#program-notes", label: "What makes a strong proposal" },
    { href: "#selection", label: "How selections work" },
    {
      href: "mailto:program@aiengineersummit.com",
      label: "Contact the program team",
    },
  ],
  timezoneLabel: "America/Los_Angeles",
  tracks: publicCfpTrackRoutes,
};

export const publicCfpRuleFields: CfpRuleField[] = [
  {
    key: "title",
    label: "Session title",
    required: true,
    type: "short_text",
  },
  {
    key: "abstract",
    label: "Abstract",
    required: true,
    type: "long_text",
  },
  {
    key: "outcomes",
    label: "Attendee outcomes",
    required: true,
    type: "long_text",
  },
  {
    key: "track",
    label: "Track",
    options: publicCfpTrackRoutes.map((track) => track.selection),
    required: true,
    type: "single_select",
  },
  {
    key: "format",
    label: "Format",
    options: ["30-minute talk", "45-minute talk", "90-minute workshop"],
    required: true,
    type: "single_select",
  },
  {
    key: "workshopPrerequisites",
    label: "Workshop prerequisites",
    required: false,
    rules: [
      {
        effect: "show",
        id: "show-workshop-prerequisites",
        operator: "equals",
        sourceKey: "format",
        value: "90-minute workshop",
      },
      {
        effect: "require",
        id: "require-workshop-prerequisites",
        operator: "equals",
        sourceKey: "format",
        value: "90-minute workshop",
      },
    ],
    type: "long_text",
  },
];

export const emptyPublicCfpDraft: PublicCfpDraft = {
  abstract: "",
  consent: false,
  defaultReviewerGroupId: "group-ai-engineering",
  email: "",
  format: "30-minute talk",
  outcomes: "",
  routeKey: "ai-engineering",
  speakers: [],
  step: "welcome",
  submissionTrack: "AI Engineering",
  title: "",
  track: "AI Engineering",
  verified: false,
  workshopPrerequisites: "",
};

export const resumedPublicCfpDraft: PublicCfpDraft = {
  abstract:
    "Agent systems fail in production for reasons that rarely appear in benchmarks. This session turns incident patterns into practical architecture and observability techniques.",
  consent: false,
  defaultReviewerGroupId: "group-ai-engineering",
  email: "mina@example.com",
  format: "30-minute talk",
  outcomes:
    "Recognize common reliability failure modes.\nChoose useful human checkpoints.\nInstrument retries so incidents remain explainable.",
  routeKey: "ai-engineering",
  speakers: [
    {
      email: "mina@example.com",
      id: "speaker-primary",
      name: "Mina Okafor",
      role: "Principal engineer",
    },
  ],
  step: "participants",
  submissionTrack: "AI Engineering",
  title: "The Reliability Gap in Production Agents",
  track: "AI Engineering",
  verified: true,
  workshopPrerequisites: "",
};

export const publicCfpSteps: { id: PublicCfpStep; label: string }[] = [
  { id: "welcome", label: "Welcome" },
  { id: "account", label: "Account" },
  { id: "submission", label: "Submission" },
  { id: "participants", label: "Participants" },
  { id: "review", label: "Review" },
  { id: "confirmation", label: "Confirmation" },
];
import type { CfpRuleField, CfpTrackRoute } from "@sessionbox-killer/domain";
