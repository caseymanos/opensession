import { describe, expect, it } from "vitest";

import {
  speakerPortalBootstrapResponseSchema,
  speakerPortalBrandSchema,
  speakerPortalInvitationRequestSchema,
  speakerPortalSlugSchema,
} from "./portal";

describe("speaker portal contracts", () => {
  it("accepts a bounded provider-neutral portal read model", () => {
    expect(
      speakerPortalBootstrapResponseSchema.parse({
        event: {
          brand: {
            accent: "#cde878",
            background: "#f5f2ea",
            ink: "#10201d",
          },
          days_remaining: 9,
          ends_at: "2026-08-20T00:00:00.000Z",
          id: "evt_ai_summit",
          name: "AI Engineer Summit",
          slug: "ai-engineer-summit",
          starts_at: "2026-08-18T16:00:00.000Z",
          status: "published",
          timezone: "America/Los_Angeles",
          venue: "Fort Mason Center",
        },
        generated_at: "2026-08-09T16:00:00.000Z",
        portal_status: "active",
        readiness: {
          next_due_at: "2026-08-11T23:59:00.000Z",
          outstanding_task_count: 2,
          overdue_task_count: 1,
          policy: {
            configuration: "configured",
            explanation:
              "One or more required tasks still need completion or approval.",
            next_due: {
              at: "2026-08-11T23:59:00.000Z",
              local_date: "2026-08-11",
              local_time: "16:59",
              timezone: "America/Los_Angeles",
            },
            outstanding_count: 2,
            overdue_count: 1,
            ratio: { complete: 1, percent: 33, total: 3 },
            status: "overdue",
          },
          required_complete: 1,
          required_total: 3,
          status: "overdue",
        },
        sessions: [
          {
            co_speakers: ["Alex Chen"],
            confirmed_state: "confirmed",
            duration_minutes: 30,
            format: "Talk",
            friendly_id: "SES-01",
            id: "session_reliability",
            role: "speaker",
            schedule: {
              ends_at: "2026-08-18T18:00:00.000Z",
              room: "Cowell Theater",
              starts_at: "2026-08-18T17:30:00.000Z",
            },
            source_status: "published",
            title: "Reliable agents in production",
            track: "AI Engineering",
          },
        ],
        speaker: {
          contact_id: "contact_speaker",
          display_name: "Mina Okafor",
          email: "mina@example.test",
        },
        tasks: [
          {
            approval_required: false,
            assignment_state: "incomplete",
            completed_at: null,
            description: "Upload a square image.",
            due_at: "2026-08-01T23:59:00.000Z",
            id: "assignment_headshot",
            required: true,
            session_id: null,
            source_status: "not_started",
            status: "overdue",
            title: "Add your headshot",
          },
        ],
      }),
    ).toBeTruthy();
  });

  it("rejects provider fields, unsafe slugs, and invalid readiness totals", () => {
    expect(speakerPortalSlugSchema.safeParse("../other-event").success).toBe(
      false,
    );
    expect(
      speakerPortalInvitationRequestSchema.safeParse({
        email: "speaker@example.test",
        organization_id: "caller-controlled",
        turnstile_action: "sign_in",
        turnstile_token: "challenge",
      }).success,
    ).toBe(false);

    const invalid = speakerPortalBootstrapResponseSchema.safeParse({
      event: {
        brand: {
          accent: "#cde878",
          background: "#f5f2ea",
          ink: "#10201d",
        },
        days_remaining: null,
        ends_at: null,
        id: "event_one",
        name: "Event One",
        slug: "event-one",
        starts_at: null,
        status: "draft",
        timezone: "UTC",
        venue: null,
      },
      generated_at: "2026-08-09T16:00:00.000Z",
      portal_status: "active",
      readiness: {
        next_due_at: null,
        outstanding_task_count: 0,
        overdue_task_count: 0,
        policy: {
          configuration: "configured",
          explanation:
            "Every required task is complete, including required approvals.",
          next_due: null,
          outstanding_count: 0,
          overdue_count: 0,
          ratio: { complete: 1, percent: 100, total: 1 },
          status: "ready",
        },
        required_complete: 2,
        required_total: 1,
        status: "ready",
      },
      sessions: [],
      speaker: {
        contact_id: "contact_one",
        display_name: "Speaker One",
        email: "speaker@example.test",
      },
      tasks: [],
    });
    expect(invalid.success).toBe(false);
    expect(
      speakerPortalBrandSchema.safeParse({
        accent: "#ffffff",
        background: "#ffffff",
        ink: "#ffffff",
      }).success,
    ).toBe(false);
    expect(
      speakerPortalBrandSchema.safeParse({
        accent: "#ffffff",
        background: "#ffffff",
        ink: "#767676",
      }).success,
    ).toBe(true);
  });
});
