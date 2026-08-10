export type PublicCfpStep =
  | "welcome"
  | "account"
  | "submission"
  | "participants"
  | "review"
  | "confirmation";

export type PublicCfpSaveState =
  "idle" | "local" | "saving" | "saved" | "offline" | "failed";

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
  maxSubmissions: number | null;
  opensAt: string | null;
  opensLabel: string;
  resources: { href: string; label: string }[];
  timezoneLabel: string;
  tracks: PublicCfpTrackView[];
  welcomeContent?: string;
}

const uiFieldKeyByApiKey: Readonly<Record<string, string>> = {
  workshop_prerequisites: "workshopPrerequisites",
};

function uiFieldKey(key: string): string {
  return uiFieldKeyByApiKey[key] ?? key;
}

function zonedDateParts(value: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "long",
    timeZone: timezone,
    year: "numeric",
  }).formatToParts(new Date(value));
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function eventDateLabel(
  startsAt: string | null,
  endsAt: string | null,
  timezone: string,
): string {
  if (!startsAt) return "Dates to be announced";
  const start = zonedDateParts(startsAt, timezone);
  if (!endsAt) return `${start.month} ${start.day}, ${start.year}`;
  const end = zonedDateParts(endsAt, timezone);
  if (start.year === end.year && start.month === end.month) {
    return start.day === end.day
      ? `${start.month} ${start.day}, ${start.year}`
      : `${start.month} ${start.day}–${end.day}, ${start.year}`;
  }
  return `${start.month} ${start.day}, ${start.year}–${end.month} ${end.day}, ${end.year}`;
}

export function publicCfpEventFromConfiguration(
  configuration: PublicCfpConfigurationResponse,
): PublicCfpEventView {
  const { event, form } = configuration;
  const dateTimeLabel = (value: string) =>
    new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      month: "long",
      timeZone: event.timezone,
      timeZoneName: "short",
      weekday: "long",
    }).format(new Date(value));
  return {
    closesLabel: dateTimeLabel(event.cfpClosesAt),
    contactEmail: "hello@opensessionboard.com",
    eventDateLabel: eventDateLabel(
      event.startsAt,
      event.endsAt,
      event.timezone,
    ),
    eventName: event.name,
    formats: configuration.formats,
    location: event.venue || "Location to be announced",
    maxSubmissions: form.submissionLimit,
    opensAt: event.cfpOpensAt,
    opensLabel: event.cfpOpensAt
      ? dateTimeLabel(event.cfpOpensAt)
      : "Date to be announced",
    resources: [
      { href: "#program-notes", label: "What makes a strong proposal" },
      { href: "#selection", label: "How selections work" },
      {
        href: "mailto:hello@opensessionboard.com",
        label: "Contact the program team",
      },
    ],
    timezoneLabel: event.timezone,
    tracks: configuration.tracks.map((track) => ({
      defaultReviewerGroupId: "",
      description: track.description,
      routeKey: track.selection,
      selection: track.selection,
      submissionTrack: track.selection,
    })),
    welcomeContent: form.welcomeContent,
  };
}

export function publicCfpRuleFieldsFromConfiguration(
  configuration: PublicCfpConfigurationResponse,
): CfpRuleField[] {
  return configuration.form.fields.map((field) => ({
    key: uiFieldKey(field.key),
    label: field.label,
    options: field.options,
    required: field.required,
    rules: field.rules.map((rule) => ({
      ...rule,
      sourceKey: uiFieldKey(rule.sourceKey),
    })),
    type: field.type,
  }));
}

export function publicCfpConfigurationSupportsFlow(
  configuration: PublicCfpConfigurationResponse,
): boolean {
  const expectedTypes = new Map([
    ["abstract", "long_text"],
    ["format", "single_select"],
    ["outcomes", "long_text"],
    ["title", "short_text"],
    ["track", "single_select"],
    ["workshop_prerequisites", "long_text"],
  ]);
  if (configuration.form.fields.length !== expectedTypes.size) return false;
  if (
    configuration.form.fields.some(
      (field) =>
        expectedTypes.get(field.key) !== field.type ||
        field.required !== (field.key !== "workshop_prerequisites"),
    )
  ) {
    return false;
  }
  const trackField = configuration.form.fields.find(
    (field) => field.key === "track",
  );
  const formatField = configuration.form.fields.find(
    (field) => field.key === "format",
  );
  const unrelatedRules = configuration.form.fields.some(
    (field) => field.key !== "workshop_prerequisites" && field.rules.length > 0,
  );
  const workshopField = configuration.form.fields.find(
    (field) => field.key === "workshop_prerequisites",
  );
  const workshopRules = workshopField?.rules ?? [];
  const supportedWorkshopRules =
    workshopRules.length === 0 ||
    (workshopRules.length === 2 &&
      new Set(workshopRules.map((rule) => rule.effect)).size === 2 &&
      workshopRules.every(
        (rule) =>
          (rule.effect === "show" || rule.effect === "require") &&
          rule.operator === "equals" &&
          rule.sourceKey === "format" &&
          typeof rule.value === "string" &&
          configuration.formats.includes(rule.value),
      ) &&
      workshopRules[0]?.value === workshopRules[1]?.value);
  return (
    !unrelatedRules &&
    supportedWorkshopRules &&
    JSON.stringify(trackField?.options) ===
      JSON.stringify(configuration.tracks.map((track) => track.selection)) &&
    JSON.stringify(formatField?.options) ===
      JSON.stringify(configuration.formats)
  );
}

export function publicCfpDraftForConfiguration(
  draft: PublicCfpDraft,
  configuration: PublicCfpConfigurationResponse,
): PublicCfpDraft {
  const track = configuration.tracks[0]?.selection ?? "";
  return {
    ...draft,
    defaultReviewerGroupId: "",
    format: configuration.formats[0] ?? "",
    routeKey: track,
    submissionTrack: track,
    track,
  };
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
  opensAt: "2026-07-01T16:00:00.000Z",
  opensLabel: "Wednesday, July 1 at 9:00 AM PDT",
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

function answerText(
  answers: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const value = answers[key];
  return typeof value === "string" ? value : "";
}

export function publicCfpDraftContent(
  draft: PublicCfpDraft,
): PublicCfpDraftContent {
  return {
    answers: {
      abstract: draft.abstract,
      format: draft.format,
      outcomes: draft.outcomes,
      title: draft.title,
      track: draft.track,
      workshop_prerequisites: draft.workshopPrerequisites,
    },
    participants: draft.speakers,
  };
}

export function publicCfpDraftFromServer(
  draft: PublicCfpOwnedDraft,
  email: string,
): PublicCfpDraft {
  const track = answerText(draft.content.answers, "track");
  const route = resolveCfpTrackRoute(publicCfpTrackRoutes, track);
  return {
    abstract: answerText(draft.content.answers, "abstract"),
    consent: false,
    defaultReviewerGroupId: route?.defaultReviewerGroupId ?? "",
    email,
    format: answerText(draft.content.answers, "format"),
    outcomes: answerText(draft.content.answers, "outcomes"),
    routeKey: route?.routeKey ?? "",
    speakers: draft.content.participants,
    step: "submission",
    submissionTrack: route?.submissionTrack ?? track,
    title: answerText(draft.content.answers, "title"),
    track,
    verified: true,
    workshopPrerequisites: answerText(
      draft.content.answers,
      "workshop_prerequisites",
    ),
  };
}
import type {
  PublicCfpConfigurationResponse,
  PublicCfpDraftContent,
  PublicCfpOwnedDraft,
} from "@sessionbox-killer/contracts";
import {
  resolveCfpTrackRoute,
  type CfpRuleField,
  type CfpTrackRoute,
} from "@sessionbox-killer/domain";
