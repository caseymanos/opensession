import { describe, expect, it, vi } from "vitest";
import { speakerPortalBootstrapResponseSchema } from "@sessionbox-killer/contracts/portal";

import {
  readSpeakerPortal,
  requestSpeakerPortalLink,
  SpeakerPortalApiError,
} from "./portalClient";
import { speakerPortalView } from "./portalModel";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

const bootstrap = {
  event: {
    brand: {
      accent: "#cde878",
      background: "#f5f2ea",
      ink: "#10201d",
    },
    days_remaining: 8,
    ends_at: "2026-08-20T23:00:00.000Z",
    id: "evt_summit",
    name: "Open Session Summit",
    slug: "open-session-summit",
    starts_at: "2026-08-18T16:00:00.000Z",
    status: "published",
    timezone: "America/Los_Angeles",
    venue: "Pier 27",
  },
  generated_at: "2026-08-10T16:00:00.000Z",
  portal_status: "active",
  readiness: {
    next_due_at: "2026-08-09T16:00:00.000Z",
    outstanding_task_count: 1,
    overdue_task_count: 1,
    policy: {
      configuration: "configured",
      explanation:
        "At least one required task is incomplete after its event-local due time.",
      next_due: {
        at: "2026-08-09T16:00:00.000Z",
        local_date: "2026-08-09",
        local_time: "09:00",
        timezone: "America/Los_Angeles",
      },
      outstanding_count: 1,
      overdue_count: 1,
      ratio: { complete: 0, percent: 0, total: 1 },
      status: "overdue",
    },
    required_complete: 0,
    required_total: 1,
    status: "overdue",
  },
  sessions: [
    {
      co_speakers: ["Taylor Speaker"],
      confirmed_state: "confirmed",
      duration_minutes: 45,
      format: "Talk",
      friendly_id: "OSS-101",
      id: "session_shared",
      role: "speaker",
      schedule: {
        ends_at: "2026-08-18T18:45:00.000Z",
        room: "Main Hall",
        starts_at: "2026-08-18T18:00:00.000Z",
      },
      source_status: "scheduled",
      title: "Authority Without Coupling",
      track: "Architecture",
    },
  ],
  speaker: {
    contact_id: "contact_one",
    display_name: "Sam Speaker",
    email: "speaker@example.test",
  },
  tasks: [
    {
      approval_required: false,
      assignment_state: "incomplete",
      completed_at: null,
      description: "Confirm your public biography.",
      due_at: "2026-08-09T16:00:00.000Z",
      id: "task_bio",
      required: true,
      session_id: null,
      source_status: "not_started",
      status: "overdue",
      title: "Review your biography",
    },
  ],
} as const;

describe("speaker portal client", () => {
  it("loads the typed event bootstrap and maps it into the portal shell", async () => {
    const fetcher = vi.fn(async () => response(bootstrap));
    const result = await readSpeakerPortal("open-session-summit", fetcher);
    const view = speakerPortalView(result);

    expect(fetcher).toHaveBeenCalledWith(
      "/api/portal/open-session-summit/bootstrap",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(view).toMatchObject({
      daysRemaining: 8,
      eventName: "Open Session Summit",
      outstandingTasks: 1,
      overdueTasks: 1,
      speakerName: "Sam Speaker",
    });
    expect(view.sessions[0]).toMatchObject({
      coSpeakers: ["Taylor Speaker"],
      room: "Main Hall",
    });
    expect(view.tasks[0]?.dueLabel).toContain("Overdue");
  });

  it("requests only an event-slug-scoped recovery link", async () => {
    const fetcher = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () =>
      response(
        {
          accepted: true,
          message:
            "If that address can access this event, a private link is on its way.",
        },
        202,
      ),
    );

    await expect(
      requestSpeakerPortalLink(
        "open-session-summit",
        "speaker@example.test",
        "verified-challenge",
        fetcher,
      ),
    ).resolves.toMatchObject({ accepted: true });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/portal/open-session-summit/invitations",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      email: "speaker@example.test",
      turnstile_action: "sign_in",
      turnstile_token: "verified-challenge",
    });
  });

  it("preserves authoritative task and readiness states", () => {
    const view = speakerPortalView(
      speakerPortalBootstrapResponseSchema.parse({
        ...bootstrap,
        readiness: {
          next_due_at: null,
          outstanding_task_count: 0,
          overdue_task_count: 0,
          policy: {
            configuration: "optional_only",
            explanation:
              "Only optional tasks are assigned; readiness is not configured until at least one task is required.",
            next_due: null,
            outstanding_count: 0,
            overdue_count: 0,
            ratio: { complete: 0, percent: null, total: 0 },
            status: "not_configured",
          },
          required_complete: 0,
          required_total: 0,
          status: "not_configured",
        },
        tasks: [
          {
            approval_required: true,
            assignment_state: "submitted",
            completed_at: null,
            description: "Optional supporting material.",
            due_at: "2026-08-17T16:00:00.000Z",
            id: "task_optional_material",
            required: false,
            session_id: null,
            source_status: "submitted",
            status: "open",
            title: "Share supporting material",
          },
        ],
      }),
    );

    expect(view.readinessStatus).toBe("not_configured");
    expect(view.tasks[0]).toMatchObject({
      approvalRequired: true,
      dueLabel: "Optional · submitted · awaiting approval",
      required: false,
      sourceStatus: "submitted",
    });
  });

  it("distinguishes today, underway, and ended event timing", () => {
    const timing = (generatedAt: string) =>
      speakerPortalView(
        speakerPortalBootstrapResponseSchema.parse({
          ...bootstrap,
          event: { ...bootstrap.event, days_remaining: 0 },
          generated_at: generatedAt,
        }),
      );

    expect(timing("2026-08-17T16:00:00.000Z")).toMatchObject({
      countdownLabel: "event begins today",
      countdownValue: "Today",
    });
    expect(timing("2026-08-19T16:00:00.000Z")).toMatchObject({
      countdownLabel: "event underway",
      countdownValue: "Now",
    });
    expect(timing("2026-08-21T16:00:00.000Z")).toMatchObject({
      countdownLabel: "event ended",
      countdownValue: "Ended",
    });
  });

  it("fails closed on an unsafe slug, denied account, or malformed model", async () => {
    await expect(readSpeakerPortal("../foreign", vi.fn())).rejects.toThrow();
    await expect(
      readSpeakerPortal(
        "open-session-summit",
        vi.fn(async () =>
          response(
            {
              error: {
                code: "portal_access_denied",
                message: "This account cannot access the event.",
              },
            },
            403,
          ),
        ),
      ),
    ).rejects.toMatchObject({
      code: "portal_access_denied",
      status: 403,
    });
    await expect(
      readSpeakerPortal(
        "open-session-summit",
        vi.fn(async () => response({ ...bootstrap, speaker: null })),
      ),
    ).rejects.toBeInstanceOf(SpeakerPortalApiError);
  });
});
