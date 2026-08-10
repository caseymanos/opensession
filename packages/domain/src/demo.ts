export const demoOrganizationId = "org_ai_engineer_summit";
export const demoEventId = "evt_ai_engineer_summit_2026";
export const demoEventSlug = "ai-engineer-summit";
export const demoEventName = "AI Engineer Summit 2026";
export const demoEventDateLabel = "October 13–14, 2026";
export const demoEventStartsAt = "2026-10-13T16:00:00.000Z";
export const demoEventEndsAt = "2026-10-15T00:00:00.000Z";
export const demoResetPhrase = "RESET AI ENGINEER SUMMIT 2026";
export const demoSeedVersion = 1;

export const demoOrganizationRootFields = {
  "Default timezone": "America/Los_Angeles",
  Name: "OpenSession Demo Organization",
  Slug: "opensession-demo",
} as const;

export const demoEventRootFields = {
  "Brand JSON": JSON.stringify({
    accent: "#cde878",
    background: "#f5f2ea",
    ink: "#10201d",
  }),
  "CFP closes": "2026-08-22T00:00:00.000Z",
  "CFP opens": "2026-06-01T16:00:00.000Z",
  End: demoEventEndsAt,
  "Is demo": true,
  Name: demoEventName,
  "Published version": 3,
  "Schedule days JSON": JSON.stringify([
    {
      businessEnd: "17:00",
      businessStart: "09:00",
      date: "2026-10-13",
    },
    {
      businessEnd: "17:00",
      businessStart: "09:00",
      date: "2026-10-14",
    },
  ]),
  "Schedule snap minutes": 15,
  "Schedule version": 3,
  Slug: demoEventSlug,
  Start: demoEventStartsAt,
  Status: "published",
  Timezone: "America/Los_Angeles",
  Venue: "Fort Mason Center · San Francisco",
} as const;
