export interface PortalTaskView {
  description: string;
  dueLabel: string;
  id: string;
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
  eventDateLabel: string;
  eventName: string;
  location: string;
  sessions: PortalSessionView[];
  speakerName: string;
  tasks: PortalTaskView[];
  totalTasks: number;
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
  eventDateLabel: "August 18–19, 2026",
  eventName: "AI Engineer Summit",
  location: "Fort Mason Center · San Francisco",
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
      description: "Upload a square image at least 1200px wide.",
      dueLabel: "Overdue by 2 days",
      id: "headshot",
      status: "overdue",
      title: "Add your headshot",
    },
    {
      description: "Review how your name, company, and bio appear publicly.",
      dueLabel: "Due August 11",
      id: "profile",
      status: "open",
      title: "Confirm your public profile",
    },
    {
      description:
        "Your latest deck is submitted and waiting for program-team approval.",
      dueLabel: "Submitted · awaiting approval",
      id: "final-slides",
      status: "open",
      title: "Final presentation",
    },
    {
      description: "Speaker agreement signed August 3.",
      dueLabel: "Complete",
      id: "agreement",
      status: "complete",
      title: "Sign the speaker agreement",
    },
    {
      description: "Travel details received August 4.",
      dueLabel: "Complete",
      id: "travel",
      status: "complete",
      title: "Share travel details",
    },
    {
      description: "AV and accessibility needs received August 5.",
      dueLabel: "Complete",
      id: "av",
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
  headshotUrl: "",
  linkedinUrl: "https://www.linkedin.com/in/mina-okafor",
  pronouns: "she/her",
  title: "VP, AI Reliability",
  websiteUrl: "https://mina.builds",
};
