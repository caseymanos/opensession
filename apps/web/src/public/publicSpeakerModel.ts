import {
  publicScheduleProjectionSchema,
  type PublicScheduleProjection,
  type PublicSessionView,
} from "@sessionbox-killer/contracts";

import { publicScheduleProjectionFixture } from "./publicScheduleModel";
import { publicSpeakerSlug } from "./publicSpeakerRoutes";

export interface PublishedSpeakerLinkView {
  label: "Bluesky" | "LinkedIn" | "Website";
  url: string;
}

export interface PublishedSpeakerProfileView {
  bio?: string;
  company: string;
  headshot?: {
    alt: string;
    url: string;
  };
  links: PublishedSpeakerLinkView[];
  name: string;
  pronouns?: string;
  sessionIds: string[];
  slug: string;
  title: string;
}

export interface PublicSpeakerProjection {
  event: PublicScheduleProjection["event"];
  generatedAt: string;
  sessions: PublicSessionView[];
  speakers: PublishedSpeakerProfileView[];
  version: number;
}

const speakers: PublishedSpeakerProfileView[] = [
  {
    bio: "Casey brings builders together around the operating practices that turn promising AI work into durable products.",
    company: "OpenSession",
    links: [{ label: "Website", url: "https://opensession.dev" }],
    name: "Casey Manos",
    sessionIds: ["opening-state-ai-engineering"],
    slug: "casey-manos",
    title: "Conference chair",
  },
  {
    bio: "Mina builds reliability systems for production AI teams. Her work turns evaluation signals into practical operating decisions without losing the humans in the loop.",
    company: "Relay",
    headshot: {
      alt: "Illustrated portrait of Mina Okafor",
      url: "/speakers/mina-okafor.svg",
    },
    links: [
      { label: "Website", url: "https://mina.example.com" },
      { label: "LinkedIn", url: "https://www.linkedin.com/in/mina-okafor" },
    ],
    name: "Mina Okafor",
    pronouns: "she/her",
    sessionIds: ["reliability-gap-production-agents"],
    slug: "mina-okafor",
    title: "Principal engineer",
  },
  {
    bio: "Sam leads evaluation programs that connect benchmark results to the messy evidence teams see in production.",
    company: "SignalBench",
    headshot: {
      alt: "Illustrated portrait of Sam Rivera",
      url: "/speakers/sam-rivera.svg",
    },
    links: [
      { label: "Website", url: "https://sam.example.com" },
      { label: "Bluesky", url: "https://bsky.app/profile/sam.example.com" },
    ],
    name: "Sam Rivera",
    pronouns: "they/them",
    sessionIds: ["benchmarks-after-benchmark", "eval-suite-lying"],
    slug: "sam-rivera",
    title: "Evaluation lead",
  },
  {
    bio: "Alex designs human checkpoints for AI products where speed, judgment, and accountability all matter.",
    company: "Threadline",
    headshot: {
      alt: "Illustrated portrait of Alex Chen",
      url: "/speakers/alex-chen.svg",
    },
    links: [
      { label: "LinkedIn", url: "https://www.linkedin.com/in/alex-chen" },
    ],
    name: "Alex Chen",
    pronouns: "they/them",
    sessionIds: ["human-checkpoints-scale"],
    slug: "alex-chen",
    title: "Product lead",
  },
  {
    bio: "Priya is an applied scientist focused on evaluation quality, model behavior, and the gap between metrics and user outcomes.",
    company: "Verity Labs",
    headshot: {
      alt: "Illustrated portrait of Priya Nair",
      url: "/speakers/priya-nair.svg",
    },
    links: [{ label: "Website", url: "https://priya.example.com" }],
    name: "Priya Nair",
    pronouns: "she/her",
    sessionIds: ["eval-suite-lying"],
    slug: "priya-nair",
    title: "Applied scientist",
  },
  {
    bio: "Ren builds infrastructure that makes model capability dependable, observable, and easier for product teams to evolve.",
    company: "Glyph",
    headshot: {
      alt: "Illustrated portrait of Ren Ito",
      url: "/speakers/ren-ito.svg",
    },
    links: [{ label: "Website", url: "https://ren.example.com" }],
    name: "Ren Ito",
    sessionIds: ["agent-runtime-product"],
    slug: "ren-ito",
    title: "Founder",
  },
  {
    bio: "Noor studies how research ideas survive the transition from promising result to reliable system.",
    company: "Northstar AI",
    links: [],
    name: "Noor Malik",
    pronouns: "she/her",
    sessionIds: ["benchmarks-after-benchmark"],
    slug: "noor-malik",
    title: "Research engineer",
  },
  {
    bio: "Elena helps developer teams make tools easier to understand when schemas, retries, and partial execution collide.",
    company: "Circuit House",
    headshot: {
      alt: "Illustrated portrait of Elena Vasquez",
      url: "/speakers/elena-vasquez.svg",
    },
    links: [{ label: "Website", url: "https://elena.example.com" }],
    name: "Elena Vasquez",
    sessionIds: ["tool-calling-failures"],
    slug: "elena-vasquez",
    title: "Developer experience lead",
  },
  {
    company: "Threadline",
    links: [],
    name: "Jo Bell",
    pronouns: "she/her",
    sessionIds: ["human-checkpoints-scale"],
    slug: "jo-bell",
    title: "Staff designer",
  },
  {
    bio: "Tariq builds small-model infrastructure for teams balancing latency, privacy, and control in production.",
    company: "PocketML",
    links: [],
    name: "Tariq Owens",
    sessionIds: ["small-models-serious-systems"],
    slug: "tariq-owens",
    title: "Infrastructure lead",
  },
];

export const publicSpeakerProjectionFixture: PublicSpeakerProjection = {
  event: publicScheduleProjectionFixture.event,
  generatedAt: publicScheduleProjectionFixture.generatedAt,
  sessions: publicScheduleProjectionFixture.sessions.filter(
    (session) =>
      session.publicationStatus === "published" &&
      session.publicationVersion === publicScheduleProjectionFixture.version,
  ),
  speakers,
  version: publicScheduleProjectionFixture.version,
};

export function sessionsForPublishedSpeaker(
  projection: PublicSpeakerProjection,
  speaker: PublishedSpeakerProfileView,
) {
  const sessionIds = new Set(speaker.sessionIds);
  return projection.sessions
    .filter(
      (session) =>
        sessionIds.has(session.id) &&
        session.publicationStatus === "published" &&
        session.publicationVersion === projection.version,
    )
    .sort((left, right) => left.startAt.localeCompare(right.startAt));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]) {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSafePublicAssetPath(value: string) {
  return (
    value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")
  );
}

function isSafePublicLink(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function isPublishedSpeaker(
  value: unknown,
): value is PublishedSpeakerProfileView {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, [
      "bio",
      "company",
      "headshot",
      "links",
      "name",
      "pronouns",
      "sessionIds",
      "slug",
      "title",
    ]) ||
    typeof value.company !== "string" ||
    typeof value.name !== "string" ||
    typeof value.slug !== "string" ||
    typeof value.title !== "string" ||
    (value.bio !== undefined && typeof value.bio !== "string") ||
    (value.pronouns !== undefined && typeof value.pronouns !== "string") ||
    !Array.isArray(value.sessionIds) ||
    !value.sessionIds.every((id) => typeof id === "string") ||
    !Array.isArray(value.links)
  ) {
    return false;
  }
  if (value.slug !== publicSpeakerSlug(value.name)) return false;
  if (
    value.headshot !== undefined &&
    (!isRecord(value.headshot) ||
      !hasOnlyKeys(value.headshot, ["alt", "url"]) ||
      typeof value.headshot.alt !== "string" ||
      !value.headshot.alt.trim() ||
      typeof value.headshot.url !== "string" ||
      !isSafePublicAssetPath(value.headshot.url))
  ) {
    return false;
  }
  return value.links.every(
    (link) =>
      isRecord(link) &&
      hasOnlyKeys(link, ["label", "url"]) &&
      (link.label === "Bluesky" ||
        link.label === "LinkedIn" ||
        link.label === "Website") &&
      typeof link.url === "string" &&
      isSafePublicLink(link.url),
  );
}

export function isPublicSpeakerProjection(
  value: unknown,
): value is PublicSpeakerProjection {
  if (!isRecord(value)) return false;
  const schedule = publicScheduleProjectionSchema.safeParse({
    event: value.event,
    generatedAt: value.generatedAt,
    sessions: value.sessions,
    version: value.version,
  });
  if (
    !hasOnlyKeys(value, [
      "event",
      "generatedAt",
      "sessions",
      "speakers",
      "version",
    ]) ||
    !isRecord(value.event) ||
    !hasOnlyKeys(value.event, [
      "dates",
      "location",
      "name",
      "slug",
      "summary",
      "timezone",
    ]) ||
    typeof value.event.slug !== "string" ||
    typeof value.event.name !== "string" ||
    typeof value.event.dates !== "string" ||
    typeof value.event.location !== "string" ||
    typeof value.event.summary !== "string" ||
    typeof value.event.timezone !== "string" ||
    typeof value.generatedAt !== "string" ||
    typeof value.version !== "number" ||
    !Array.isArray(value.sessions) ||
    !Array.isArray(value.speakers) ||
    !value.speakers.every(isPublishedSpeaker) ||
    !schedule.success
  ) {
    return false;
  }
  const sessionById = new Map(
    schedule.data.sessions.map((session) => [session.id, session]),
  );
  const profileByName = new Map(
    value.speakers.map((speaker) => [speaker.name, speaker]),
  );
  return (
    schedule.data.sessions.every(
      (session) =>
        session.publicationStatus === "published" &&
        session.publicationVersion === value.version &&
        session.speakers.every((speaker) =>
          profileByName.get(speaker.name)?.sessionIds.includes(session.id),
        ),
    ) &&
    value.speakers.every((speaker) =>
      speaker.sessionIds.every((sessionId) =>
        sessionById
          .get(sessionId)
          ?.speakers.some(
            (sessionSpeaker) => sessionSpeaker.name === speaker.name,
          ),
      ),
    )
  );
}
