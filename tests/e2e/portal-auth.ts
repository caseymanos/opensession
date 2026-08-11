import { expect, type Page } from "@playwright/test";

export const portalCsrfToken =
  "portal-e2e-csrf-token-that-is-at-least-forty-characters";

export const portalBootstrapFixture = {
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
    venue: "Fort Mason Center · San Francisco",
  },
  generated_at: "2026-08-09T16:00:00.000Z",
  portal_status: "active",
  readiness: {
    next_due_at: "2026-08-07T23:59:00.000Z",
    outstanding_task_count: 2,
    overdue_task_count: 1,
    required_complete: 1,
    required_total: 3,
    status: "overdue",
  },
  sessions: [
    {
      co_speakers: [],
      confirmed_state: "confirmed",
      duration_minutes: 30,
      format: "30-minute talk",
      friendly_id: "SES-01",
      id: "session_reliability_gap",
      role: "speaker",
      schedule: {
        ends_at: "2026-08-18T18:00:00.000Z",
        room: "Cowell Theater",
        starts_at: "2026-08-18T17:30:00.000Z",
      },
      source_status: "published",
      title: "The Reliability Gap in Production Agents",
      track: "AI Engineering",
    },
  ],
  speaker: {
    contact_id: "contact_mina",
    display_name: "Mina Okafor",
    email: "mina@example.com",
  },
  tasks: [
    {
      approval_required: false,
      completed_at: null,
      description: "Upload a square image at least 1200px wide.",
      due_at: "2026-08-07T23:59:00.000Z",
      id: "assignment_headshot",
      required: true,
      session_id: null,
      source_status: "not_started",
      status: "overdue",
      title: "Add your headshot",
    },
    {
      approval_required: false,
      completed_at: null,
      description: "Review how your name, company, and bio appear publicly.",
      due_at: "2026-08-11T23:59:00.000Z",
      id: "assignment_profile",
      required: true,
      session_id: null,
      source_status: "in_progress",
      status: "open",
      title: "Confirm your public profile",
    },
    {
      approval_required: false,
      completed_at: "2026-08-03T20:00:00.000Z",
      description: "Speaker agreement signed August 3.",
      due_at: null,
      id: "assignment_agreement",
      required: true,
      session_id: null,
      source_status: "complete",
      status: "complete",
      title: "Sign the speaker agreement",
    },
  ],
} as const;

export async function mockPortalAuth(page: Page) {
  let signedOut = false;
  await page.context().addCookies([
    {
      httpOnly: false,
      name: "__Host-opensession-csrf",
      sameSite: "Lax",
      secure: true,
      url: "https://127.0.0.1:8787",
      value: portalCsrfToken,
    },
  ]);
  await page.route("**/api/portal/*/bootstrap", async (route) => {
    if (signedOut) {
      await route.fulfill({
        json: {
          error: {
            code: "invalid_session",
            message: "Authentication is required.",
          },
        },
        status: 401,
      });
      return;
    }
    await route.fulfill({ json: portalBootstrapFixture, status: 200 });
  });
  await page.route("**/api/auth/logout", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe(portalCsrfToken);
    signedOut = true;
    await route.fulfill({ status: 204 });
  });
}
