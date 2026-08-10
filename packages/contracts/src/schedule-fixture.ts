import type { ScheduleSnapshot } from "@sessionbox-killer/domain";

export const scheduleSnapshotFixture = {
  event: {
    days: [
      {
        businessEnd: "17:00",
        businessStart: "09:00",
        date: "2026-09-15",
      },
      {
        businessEnd: "17:00",
        businessStart: "09:00",
        date: "2026-09-16",
      },
    ],
    eventId: "event_ai_engineering_summit",
    publicationVersion: 4,
    slug: "ai-engineering-summit",
    snapMinutes: 15,
    timezone: "America/Los_Angeles",
    version: 7,
  },
  formats: [
    { defaultDurationMinutes: 30, id: "format_talk", name: "Talk", order: 0 },
    { defaultDurationMinutes: 45, id: "format_panel", name: "Panel", order: 1 },
    {
      defaultDurationMinutes: 60,
      id: "format_workshop",
      name: "Workshop",
      order: 2,
    },
  ],
  rooms: [
    { capacity: 280, id: "room_cowell", name: "Cowell Theater", order: 0 },
    { capacity: 120, id: "room_gallery", name: "Gallery 308", order: 1 },
    { capacity: 80, id: "room_firehouse", name: "Firehouse", order: 2 },
  ],
  sessions: [
    {
      abstract:
        "A practical opening tour of the systems behind reliable agents.",
      durationMinutes: 30,
      formatId: "format_talk",
      id: "session_opening",
      participants: [
        {
          displayName: "Alex Chen",
          personId: "person_alex",
          role: "speaker",
        },
      ],
      slot: {
        endAt: "2026-09-15T17:30:00.000Z",
        publicationVersion: 4,
        roomId: "room_cowell",
        startAt: "2026-09-15T17:00:00.000Z",
        version: 4,
      },
      state: "published",
      title: "Opening the reliable-agent stack",
      trackId: "track_ai_engineering",
    },
    {
      abstract: "A live discussion of benchmarks after the benchmark.",
      durationMinutes: 45,
      formatId: "format_panel",
      id: "session_benchmarks",
      participants: [
        {
          displayName: "Alex Chen",
          personId: "person_alex",
          role: "moderator",
        },
        {
          displayName: "Noor Malik",
          personId: "person_noor",
          role: "speaker",
        },
      ],
      slot: {
        endAt: "2026-09-15T17:45:00.000Z",
        publicationVersion: 0,
        roomId: "room_gallery",
        startAt: "2026-09-15T17:00:00.000Z",
        version: 7,
      },
      state: "scheduled",
      title: "Benchmarks after the benchmark",
      trackId: "track_evaluation",
    },
    {
      abstract: "A field guide to diagnosing tool-calling failures.",
      durationMinutes: 60,
      formatId: "format_workshop",
      id: "session_tool_failures",
      participants: [
        {
          displayName: "Elena Vasquez",
          personId: "person_elena",
          role: "chair",
        },
      ],
      slot: {
        endAt: "2026-09-16T20:00:00.000Z",
        publicationVersion: 0,
        roomId: "room_firehouse",
        startAt: "2026-09-16T19:00:00.000Z",
        version: 7,
      },
      state: "scheduled",
      title: "A field guide to tool-calling failures",
      trackId: "track_ai_engineering",
    },
    {
      abstract: "How smaller models can anchor serious production systems.",
      durationMinutes: 30,
      formatId: "format_talk",
      id: "session_small_models",
      participants: [
        {
          displayName: "Tariq Owens",
          personId: "person_tariq",
          role: "speaker",
        },
      ],
      slot: null,
      state: "accepted_unscheduled",
      title: "Small models, serious systems",
      trackId: "track_infrastructure",
    },
  ],
  tracks: [
    { id: "track_ai_engineering", name: "AI Engineering", order: 0 },
    { id: "track_evaluation", name: "Evaluation", order: 1 },
    { id: "track_infrastructure", name: "Infrastructure", order: 2 },
  ],
} as const satisfies ScheduleSnapshot;

export const scheduleFilterFixture = {
  day: "2026-09-15",
  formatIds: ["format_talk", "format_panel"],
  roomIds: ["room_cowell", "room_gallery"],
  states: ["accepted_unscheduled", "scheduled"],
  trackIds: ["track_ai_engineering", "track_evaluation"],
} as const;
