import {
  publicSpeakerProjectionSchema,
  type PublicSpeakerProfile,
  type PublicSpeakerProjection as ContractPublicSpeakerProjection,
} from "@sessionbox-killer/contracts";

import { publicScheduleProjectionFixture } from "./publicScheduleModel";
import { publicSpeakerSlug } from "./publicSpeakerRoutes";

export type PublishedSpeakerLinkView = PublicSpeakerProfile["links"][number];
export type PublishedSpeakerProfileView = PublicSpeakerProfile;
export type PublicSpeakerProjection = ContractPublicSpeakerProjection;

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
      url: "/api/v1/public/events/ai-engineer-summit/speakers/mina-okafor/headshot?v=fixture-1",
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
      url: "/api/v1/public/events/ai-engineer-summit/speakers/sam-rivera/headshot?v=fixture-1",
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
      url: "/api/v1/public/events/ai-engineer-summit/speakers/alex-chen/headshot?v=fixture-1",
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
      url: "/api/v1/public/events/ai-engineer-summit/speakers/priya-nair/headshot?v=fixture-1",
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
      url: "/api/v1/public/events/ai-engineer-summit/speakers/ren-ito/headshot?v=fixture-1",
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
      url: "/api/v1/public/events/ai-engineer-summit/speakers/elena-vasquez/headshot?v=fixture-1",
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

export function parsePublicSpeakerProjection(
  value: unknown,
): PublicSpeakerProjection | null {
  const projection = publicSpeakerProjectionSchema.safeParse(value);
  if (!projection.success) return null;
  const parsed = projection.data;
  const sessionById = new Map(
    parsed.sessions.map((session) => [session.id, session]),
  );
  const profileByName = new Map(
    parsed.speakers.map((speaker) => [speaker.name, speaker]),
  );
  const names = new Set(parsed.speakers.map((speaker) => speaker.name));
  const slugs = new Set(parsed.speakers.map((speaker) => speaker.slug));
  const valid =
    names.size === parsed.speakers.length &&
    slugs.size === parsed.speakers.length &&
    parsed.speakers.every(
      (speaker) => speaker.slug === publicSpeakerSlug(speaker.name),
    ) &&
    parsed.sessions.every(
      (session) =>
        session.publicationStatus === "published" &&
        session.publicationVersion === parsed.version &&
        session.speakers.every((speaker) =>
          profileByName.get(speaker.name)?.sessionIds.includes(session.id),
        ),
    ) &&
    parsed.speakers.every((speaker) =>
      speaker.sessionIds.every((sessionId) =>
        sessionById
          .get(sessionId)
          ?.speakers.some(
            (sessionSpeaker) => sessionSpeaker.name === speaker.name,
          ),
      ),
    );
  return valid ? parsed : null;
}
