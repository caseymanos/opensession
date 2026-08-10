import type { PublicScheduleProjection } from "@sessionbox-killer/contracts";

export type {
  PublicScheduleDay,
  PublicScheduleProjection,
  PublicSessionTrack,
  PublicSessionView,
  PublicSpeakerView,
} from "@sessionbox-killer/contracts";

const publishedVersion = 4;

export const publicScheduleProjectionFixture: PublicScheduleProjection = {
  event: {
    dates: "August 18–19, 2026",
    location: "Fort Mason Center · San Francisco",
    name: "AI Engineer Summit",
    slug: "ai-engineer-summit",
    summary:
      "Two focused days for the people building reliable, useful AI systems.",
    timezone: "America/Los_Angeles",
  },
  generatedAt: "2026-08-09T04:45:30.000Z",
  sessions: [
    {
      abstract:
        "A clear-eyed opening on what changed in AI engineering this year, which practices survived contact with production, and where the community should place its attention next.",
      day: "2026-08-18",
      endAt: "2026-08-18T09:30:00-07:00",
      format: "Talk",
      id: "opening-state-ai-engineering",
      publicationStatus: "published",
      publicationVersion: publishedVersion,
      roomId: "cowell",
      roomName: "Cowell Theater",
      speakers: [
        {
          company: "OpenSession",
          name: "Casey Manos",
          role: "Conference chair",
        },
      ],
      startAt: "2026-08-18T09:00:00-07:00",
      title: "Opening & State of AI Engineering",
      track: "AI Engineering",
    },
    {
      abstract:
        "Benchmarks are useful until teams optimize for the score instead of the outcome. This panel maps the failure modes and shows how leading evaluation teams combine offline suites with production evidence.",
      day: "2026-08-18",
      endAt: "2026-08-18T10:15:00-07:00",
      format: "Panel",
      id: "benchmarks-after-benchmark",
      publicationStatus: "published",
      publicationVersion: publishedVersion,
      roomId: "gallery",
      roomName: "Gallery 308",
      speakers: [
        {
          company: "SignalBench",
          name: "Sam Rivera",
          role: "Evaluation lead",
        },
        {
          company: "Northstar AI",
          name: "Noor Malik",
          role: "Research engineer",
        },
      ],
      startAt: "2026-08-18T09:30:00-07:00",
      title: "Benchmarks After the Benchmark",
      track: "Evaluation",
    },
    {
      abstract:
        "Production agents fail in the seams between models, tools, retries, and human intervention. Learn a practical reliability model drawn from incident reviews and the controls that reduce user-visible failure.",
      day: "2026-08-18",
      endAt: "2026-08-18T11:30:00-07:00",
      format: "Talk",
      id: "reliability-gap-production-agents",
      publicationStatus: "published",
      publicationVersion: publishedVersion,
      roomId: "cowell",
      roomName: "Cowell Theater",
      speakers: [
        {
          company: "Relay",
          name: "Mina Okafor",
          role: "Principal engineer",
        },
      ],
      startAt: "2026-08-18T10:30:00-07:00",
      title: "The Reliability Gap in Production Agents",
      track: "AI Engineering",
    },
    {
      abstract:
        "Human review does not have to become the bottleneck. This talk offers concrete checkpoint patterns that match risk, preserve momentum, and leave a useful audit trail for the decisions that matter.",
      day: "2026-08-18",
      endAt: "2026-08-18T12:15:00-07:00",
      format: "Talk",
      id: "human-checkpoints-scale",
      publicationStatus: "published",
      publicationVersion: publishedVersion,
      roomId: "firehouse",
      roomName: "Firehouse",
      speakers: [
        {
          company: "Threadline",
          name: "Alex Chen",
          role: "Product lead",
        },
        {
          company: "Threadline",
          name: "Jo Bell",
          role: "Staff designer",
        },
      ],
      startAt: "2026-08-18T11:30:00-07:00",
      title: "Designing Human Checkpoints That Scale",
      track: "Product",
    },
    {
      abstract:
        "The runtime is where model capability becomes product behavior. Ren breaks down isolation, state, tool execution, and observability choices—and the architecture that keeps them evolvable.",
      day: "2026-08-18",
      endAt: "2026-08-18T13:30:00-07:00",
      format: "Talk",
      id: "agent-runtime-product",
      publicationStatus: "published",
      publicationVersion: publishedVersion,
      roomId: "firehouse",
      roomName: "Firehouse",
      speakers: [
        {
          company: "Glyph",
          name: "Ren Ito",
          role: "Founder",
        },
      ],
      startAt: "2026-08-18T13:00:00-07:00",
      title: "The Agent Runtime Is the Product",
      track: "Infrastructure",
    },
    {
      abstract:
        "A hands-on diagnosis of evaluation suites that look rigorous but miss the failures users actually experience. Leave with a method for identifying leakage, brittle graders, and false confidence.",
      day: "2026-08-19",
      endAt: "2026-08-19T10:00:00-07:00",
      format: "Talk",
      id: "eval-suite-lying",
      publicationStatus: "published",
      publicationVersion: publishedVersion,
      roomId: "gallery",
      roomName: "Gallery 308",
      speakers: [
        {
          company: "Verity Labs",
          name: "Priya Nair",
          role: "Applied scientist",
        },
        {
          company: "SignalBench",
          name: "Sam Rivera",
          role: "Evaluation lead",
        },
      ],
      startAt: "2026-08-19T09:30:00-07:00",
      title: "Your Eval Suite Is Lying to You",
      track: "Evaluation",
    },
    {
      abstract:
        "Smaller models can be the strongest production choice when latency, privacy, and controllability matter. See the routing, distillation, and measurement practices that make them dependable.",
      day: "2026-08-19",
      endAt: "2026-08-19T11:00:00-07:00",
      format: "Talk",
      id: "small-models-serious-systems",
      publicationStatus: "published",
      publicationVersion: publishedVersion,
      roomId: "cowell",
      roomName: "Cowell Theater",
      speakers: [
        {
          company: "PocketML",
          name: "Tariq Owens",
          role: "Infrastructure lead",
        },
      ],
      startAt: "2026-08-19T10:30:00-07:00",
      title: "Small Models, Serious Systems",
      track: "Infrastructure",
    },
    {
      abstract:
        "Bring a laptop and work through the tool-calling failures that consume the most debugging time: ambiguous schemas, partial execution, retries, stale state, and unhelpful traces.",
      day: "2026-08-19",
      endAt: "2026-08-19T12:00:00-07:00",
      format: "Workshop",
      id: "tool-calling-failures",
      publicationStatus: "published",
      publicationVersion: publishedVersion,
      roomId: "firehouse",
      roomName: "Firehouse",
      speakers: [
        {
          company: "Circuit House",
          name: "Elena Vasquez",
          role: "Developer experience",
        },
      ],
      startAt: "2026-08-19T11:00:00-07:00",
      title: "A Field Guide to Tool-Calling Failures",
      track: "AI Engineering",
    },
    {
      abstract: "Superseded by the current published placement.",
      day: "2026-08-18",
      endAt: "2026-08-18T11:00:00-07:00",
      format: "Talk",
      id: "agent-runtime-product-v3",
      publicationStatus: "superseded",
      publicationVersion: 3,
      roomId: "firehouse",
      roomName: "Firehouse",
      speakers: [
        {
          company: "Glyph",
          name: "Ren Ito",
          role: "Founder",
        },
      ],
      startAt: "2026-08-18T10:30:00-07:00",
      title: "The Agent Runtime Is the Product",
      track: "Infrastructure",
    },
    {
      abstract: "This session was removed before public version 4.",
      day: "2026-08-19",
      endAt: "2026-08-19T13:00:00-07:00",
      format: "Talk",
      id: "canceled-eval-patterns",
      publicationStatus: "canceled",
      publicationVersion: 3,
      roomId: "gallery",
      roomName: "Gallery 308",
      speakers: [
        {
          company: "Archive",
          name: "Morgan Lee",
          role: "Researcher",
        },
      ],
      startAt: "2026-08-19T12:30:00-07:00",
      title: "Evaluation Patterns We Retired",
      track: "Evaluation",
    },
  ],
  version: publishedVersion,
};

export function sessionsInPublishedProjection(
  projection: PublicScheduleProjection,
) {
  return projection.sessions.filter(
    (session) =>
      session.publicationStatus === "published" &&
      session.publicationVersion === projection.version,
  );
}
