export interface PortalTaskView {
  approvalRequired: boolean;
  assignmentState:
    "approved" | "complete" | "incomplete" | "rejected" | "submitted";
  description: string;
  dueLabel: string;
  id: string;
  required: boolean;
  sourceStatus:
    | "complete"
    | "in_progress"
    | "not_started"
    | "rejected"
    | "submitted"
    | "waived";
  status: "complete" | "open" | "overdue";
  title: string;
}

export interface PortalSessionView {
  coSpeakers: string[];
  format: string;
  id: string;
  room: string | null;
  scheduleLabel: string | null;
  title: string;
  track: string;
}

export interface SpeakerPortalView {
  completedTasks: number;
  contactEmail: string;
  countdownLabel: string;
  countdownValue: string;
  daysRemaining: number | null;
  eventDateLabel: string;
  eventName: string;
  location: string;
  outstandingTasks: number;
  overdueTasks: number;
  readinessStatus: "not_configured" | "outstanding" | "overdue" | "ready";
  sessions: PortalSessionView[];
  speakerName: string;
  tasks: PortalTaskView[];
  totalTasks: number;
}

function eventDateLabel(
  event: SpeakerPortalBootstrapResponse["event"],
): string {
  if (!event.starts_at) return "Dates to be announced";
  const formatter = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "long",
    timeZone: event.timezone,
    year: "numeric",
  });
  const start = new Date(event.starts_at);
  if (!event.ends_at) return formatter.format(start);
  return formatter.formatRange(start, new Date(event.ends_at));
}

function taskDueLabel(
  task: SpeakerPortalBootstrapResponse["tasks"][number],
  timezone: string,
): string {
  const withRequirement = (value: string) =>
    task.required ? value : `Optional · ${value.toLocaleLowerCase("en-US")}`;
  if (task.assignment_state === "approved") return withRequirement("Approved");
  if (task.assignment_state === "complete") return withRequirement("Complete");
  if (task.assignment_state === "submitted") {
    return withRequirement(
      task.approval_required ? "Submitted · awaiting approval" : "Submitted",
    );
  }
  const state =
    task.assignment_state === "rejected" ? "Changes requested" : null;
  if (!task.due_at) {
    const label = state ?? (task.status === "overdue" ? "Overdue" : "Open");
    return task.required
      ? label
      : `Optional · ${label.toLocaleLowerCase("en-US")}`;
  }
  const due = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone: timezone,
  }).format(new Date(task.due_at));
  const label = state
    ? `${state} · due ${due}`
    : task.status === "overdue"
      ? `Overdue · due ${due}`
      : `Due ${due}`;
  return task.required
    ? label
    : `Optional · ${label.toLocaleLowerCase("en-US")}`;
}

function eventCountdown(response: SpeakerPortalBootstrapResponse): {
  label: string;
  value: string;
} {
  const generated = Date.parse(response.generated_at);
  const starts = response.event.starts_at
    ? Date.parse(response.event.starts_at)
    : null;
  const ends = response.event.ends_at
    ? Date.parse(response.event.ends_at)
    : null;
  if (
    response.event.status === "archived" ||
    (ends !== null && generated >= ends)
  ) {
    return { label: "event ended", value: "Ended" };
  }
  if (starts !== null && generated >= starts) {
    return { label: "event underway", value: "Now" };
  }
  if (response.event.days_remaining === null) {
    return { label: "schedule pending", value: "—" };
  }
  if (response.event.days_remaining === 0) {
    return { label: "event begins today", value: "Today" };
  }
  return {
    label: response.event.days_remaining === 1 ? "day to go" : "days to go",
    value: String(response.event.days_remaining),
  };
}

export function speakerPortalView(
  response: SpeakerPortalBootstrapResponse,
): SpeakerPortalView {
  const countdown = eventCountdown(response);
  const scheduleFormatter = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "long",
    timeZone: response.event.timezone,
    weekday: "long",
  });
  return {
    completedTasks: response.readiness.required_complete,
    contactEmail: response.speaker.email,
    countdownLabel: countdown.label,
    countdownValue: countdown.value,
    daysRemaining: response.event.days_remaining,
    eventDateLabel: eventDateLabel(response.event),
    eventName: response.event.name,
    location: response.event.venue ?? "Location to be announced",
    outstandingTasks: response.readiness.outstanding_task_count,
    overdueTasks: response.readiness.overdue_task_count,
    readinessStatus: response.readiness.status,
    sessions: response.sessions.map((session) => ({
      coSpeakers: session.co_speakers,
      format: session.format,
      id: session.id,
      room: session.schedule?.room ?? null,
      scheduleLabel: session.schedule
        ? scheduleFormatter.format(new Date(session.schedule.starts_at))
        : null,
      title: session.title,
      track: session.track,
    })),
    speakerName: response.speaker.display_name,
    tasks: response.tasks.map((task) => ({
      approvalRequired: task.approval_required,
      assignmentState: task.assignment_state,
      description: task.description,
      dueLabel: taskDueLabel(task, response.event.timezone),
      id: task.id,
      required: task.required,
      sourceStatus: task.source_status,
      status: task.status,
      title: task.title,
    })),
    totalTasks: response.readiness.required_total,
  };
}

export interface SpeakerProfileView {
  bio: string;
  blueskyUrl: string;
  company: string;
  displayName: string;
  headshotAlt: string;
  headshotFileName: string;
  headshotUrl: string;
  linkedinUrl: string;
  pronouns: string;
  title: string;
  websiteUrl: string;
}

export const speakerPortalFixture: SpeakerPortalView = {
  completedTasks: 3,
  contactEmail: "mina@example.com",
  countdownLabel: "days to go",
  countdownValue: "9",
  daysRemaining: 9,
  eventDateLabel: "August 18–19, 2026",
  eventName: "AI Engineer Summit",
  location: "Fort Mason Center · San Francisco",
  outstandingTasks: 3,
  overdueTasks: 1,
  readinessStatus: "overdue",
  sessions: [
    {
      coSpeakers: [],
      format: "30-minute talk",
      id: "session-reliability-gap",
      room: "Cowell Theater",
      scheduleLabel: "Tuesday, August 18 · 10:30 AM",
      title: "The Reliability Gap in Production Agents",
      track: "AI Engineering",
    },
  ],
  speakerName: "Mina Okafor",
  tasks: [
    {
      approvalRequired: false,
      assignmentState: "incomplete",
      description: "Upload a square image at least 1200px wide.",
      dueLabel: "Overdue by 2 days",
      id: "headshot",
      required: true,
      sourceStatus: "not_started",
      status: "overdue",
      title: "Add your headshot",
    },
    {
      approvalRequired: false,
      assignmentState: "incomplete",
      description: "Review how your name, company, and bio appear publicly.",
      dueLabel: "Due August 11",
      id: "profile",
      required: true,
      sourceStatus: "in_progress",
      status: "open",
      title: "Confirm your public profile",
    },
    {
      approvalRequired: true,
      assignmentState: "submitted",
      description:
        "Your latest deck is submitted and waiting for program-team approval.",
      dueLabel: "Submitted · awaiting approval",
      id: "final-slides",
      required: true,
      sourceStatus: "submitted",
      status: "open",
      title: "Final presentation",
    },
    {
      approvalRequired: false,
      assignmentState: "complete",
      description: "Speaker agreement signed August 3.",
      dueLabel: "Complete",
      id: "agreement",
      required: true,
      sourceStatus: "complete",
      status: "complete",
      title: "Sign the speaker agreement",
    },
    {
      approvalRequired: false,
      assignmentState: "complete",
      description: "Travel details received August 4.",
      dueLabel: "Complete",
      id: "travel",
      required: true,
      sourceStatus: "complete",
      status: "complete",
      title: "Share travel details",
    },
    {
      approvalRequired: false,
      assignmentState: "complete",
      description: "AV and accessibility needs received August 5.",
      dueLabel: "Complete",
      id: "av",
      required: true,
      sourceStatus: "complete",
      status: "complete",
      title: "Tell us what you need on stage",
    },
  ],
  totalTasks: 6,
};

export const speakerProfileFixture: SpeakerProfileView = {
  bio: "Mina builds reliability systems for production AI teams. Her work turns evaluation signals into practical operating decisions without losing the humans in the loop.",
  blueskyUrl: "https://bsky.app/profile/mina.builds",
  company: "Northstar Labs",
  displayName: "Mina Okafor",
  headshotAlt: "Mina Okafor smiling against a warm coral background",
  headshotFileName: "mina-okafor-headshot.jpg",
  headshotUrl: "/speakers/mina-okafor.svg",
  linkedinUrl: "https://www.linkedin.com/in/mina-okafor",
  pronouns: "she/her",
  title: "VP, AI Reliability",
  websiteUrl: "https://mina.builds",
};
import type { SpeakerPortalBootstrapResponse } from "@sessionbox-killer/contracts/portal";
