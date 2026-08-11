import { describe, expect, it } from "vitest";

import type {
  OrganizerSubmissionCommandResult,
  OrganizerSubmissionDetail,
} from "@sessionbox-killer/contracts";

import {
  applyOrganizerSubmissionResult,
  organizerSubmissionDetailView,
  organizerStatusToView,
  viewStatusToOrganizer,
} from "./organizerSubmissionAdapter";

const detail: OrganizerSubmissionDetail = {
  allowedCommands: ["withdraw", "add_note"],
  answerSnapshot: {
    answers: [
      {
        fieldKey: "private_file",
        fieldType: "file",
        formVersion: 2,
        label: "Private attachment",
        order: 2,
        redacted: true,
        value: null,
      },
      {
        fieldKey: "outcomes",
        fieldType: "multi_select",
        formVersion: 2,
        label: "Outcomes",
        order: 1,
        redacted: false,
        value: ["Safer retries", "Clear recovery"],
      },
    ],
    formVersion: 2,
    state: "submitted",
  },
  history: [
    {
      action: "start_review",
      actor: { displayName: "Owen Organizer", id: "user_organizer" },
      commandId: "command_review",
      createdAt: "2026-08-10T19:00:00.000Z",
      fromStatus: "submitted",
      id: "activity_review",
      reason: "Eligibility complete.",
      toStatus: "in_review",
    },
  ],
  notes: [],
  participants: [
    {
      contact: {
        company: "Northstar Labs",
        displayName: "Mina Okafor",
        email: "mina@example.com",
        id: "contact_mina",
        title: "Principal Engineer",
      },
      id: "participant_mina",
      isPrimary: true,
      order: 0,
      role: "Primary speaker",
    },
  ],
  projection: {
    asOf: "2026-08-10T19:00:00.000Z",
    pendingRepairs: 0,
    reasons: [],
    state: "current",
  },
  reviews: [],
  submission: {
    id: "submission_alpha",
    lastActivityAt: "2026-08-10T19:00:00.000Z",
    reference: "AI-1042",
    reviews: { aggregateScore: null, assigned: 0, submitted: 0 },
    routing: { reviewerGroupId: null, routeKey: "reliability" },
    status: "in_review",
    submitter: {
      company: "Northstar Labs",
      displayName: "Mina Okafor",
      email: "mina@example.com",
      id: "contact_mina",
      title: "Principal Engineer",
    },
    title: "Durable agent systems",
    track: { id: "track_reliability", name: "Reliability" },
    version: 2,
  },
  submittedAt: "2026-08-09T18:00:00.000Z",
};

describe("organizer submission adapter", () => {
  it("maps the canonical in_review status only at the UI boundary", () => {
    expect(organizerStatusToView("in_review")).toBe("under_review");
    expect(viewStatusToOrganizer("under_review")).toBe("in_review");
    expect(organizerStatusToView("accepted")).toBe("accepted");
  });

  it("maps immutable detail, redaction, participants and history", () => {
    const view = organizerSubmissionDetailView(detail);

    expect(view).toMatchObject({
      id: "submission_alpha",
      reference: "AI-1042",
      status: "under_review",
      submitter: "Mina Okafor",
      trackId: "track_reliability",
      version: 2,
    });
    expect(view.answers).toEqual([
      { label: "Outcomes", value: "Safer retries, Clear recovery" },
      { label: "Private attachment", value: "Private answer redacted" },
    ]);
    expect(view.history[0]).toMatchObject({
      detail: "Eligibility complete.",
      title: "Moved to review",
    });
  });

  it("applies durable results without inventing authority history", () => {
    const current = organizerSubmissionDetailView(detail);
    const result: OrganizerSubmissionCommandResult = {
      appliedAt: "2026-08-10T19:05:00.000Z",
      commandId: "command_note",
      note: {
        actor: { displayName: "Owen Organizer", id: "user_organizer" },
        body: "Keep in the reliability group.",
        createdAt: "2026-08-10T19:05:00.000Z",
        id: "note_alpha",
        version: 1,
      },
      outcome: "applied",
      projection: "repair_pending",
      status: "in_review",
      submissionId: "submission_alpha",
      version: 3,
    };

    const next = applyOrganizerSubmissionResult(current, result);
    expect(next).toMatchObject({ status: "under_review", version: 3 });
    expect(next.notes).toEqual([
      expect.objectContaining({
        id: "note_alpha",
        text: "Keep in the reliability group.",
      }),
    ]);
    expect(next.history).toEqual(current.history);
  });
});
