import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  applicableTaskAssignments,
  evaluateTaskReadiness,
  previewTaskBackfill,
  resolveEventLocalDue,
  submitTaskAssignment,
  TaskDomainError,
  transitionTaskAssignment,
  validateTaskSubmissionResponse,
  type TaskAssignment,
  type TaskDefinition,
  type TaskTargetingSnapshot,
} from "./tasks";

function definition(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    approvalRequired: false,
    description: "A task for the speaker.",
    due: null,
    eventId: "event_one",
    id: "definition_one",
    kind: "ack",
    name: "Code of conduct",
    required: true,
    target: {
      assignmentScope: "contact",
      contact: {
        excludeContactIds: [],
        includeContactIds: [],
        roles: ["speaker"],
      },
      session: null,
    },
    version: 1,
    ...overrides,
  };
}

function snapshot(): TaskTargetingSnapshot {
  return {
    contacts: [
      { contactId: "contact_alpha", roles: ["speaker"] },
      { contactId: "contact_beta", roles: ["moderator", "speaker"] },
      { contactId: "contact_chair", roles: ["chair"] },
    ],
    eventId: "event_one",
    sessions: [
      {
        formatId: "format_talk",
        participants: [
          { contactId: "contact_alpha", role: "speaker" },
          { contactId: "contact_chair", role: "chair" },
        ],
        sessionId: "session_alpha",
        state: "accepted",
        trackId: "track_platform",
      },
      {
        formatId: "format_panel",
        participants: [
          { contactId: "contact_beta", role: "speaker" },
          { contactId: "contact_alpha", role: "moderator" },
        ],
        sessionId: "session_beta",
        state: "scheduled",
        trackId: "track_product",
      },
    ],
  };
}

function assignment(overrides: Partial<TaskAssignment> = {}): TaskAssignment {
  return {
    approvalRequired: false,
    assignmentId: "assignment_one",
    contactId: "contact_alpha",
    definitionId: "definition_one",
    dueAt: null,
    eventId: "event_one",
    history: [],
    required: true,
    sessionId: null,
    state: "incomplete",
    version: 1,
    ...overrides,
  };
}

describe("task targeting and materialization", () => {
  it("matches contact and session rules without crossing events", async () => {
    const contactDrafts = await applicableTaskAssignments(
      [
        definition({
          target: {
            assignmentScope: "contact",
            contact: {
              excludeContactIds: ["contact_beta"],
              includeContactIds: [],
              roles: ["speaker"],
            },
            session: null,
          },
        }),
        definition({ eventId: "event_foreign", id: "definition_foreign" }),
      ],
      snapshot(),
      "America/Los_Angeles",
    );
    expect(contactDrafts).toHaveLength(1);
    expect(contactDrafts[0]).toMatchObject({
      contactId: "contact_alpha",
      sessionId: null,
    });

    const sessionDrafts = await applicableTaskAssignments(
      [
        definition({
          id: "definition_session",
          target: {
            assignmentScope: "session",
            contact: {
              excludeContactIds: [],
              includeContactIds: [],
              roles: ["speaker"],
            },
            session: {
              formatIds: ["format_panel"],
              includeSessionIds: [],
              participantRoles: ["speaker"],
              trackIds: ["track_product"],
            },
          },
        }),
      ],
      snapshot(),
      "America/Los_Angeles",
    );
    expect(sessionDrafts).toEqual([
      expect.objectContaining({
        contactId: "contact_beta",
        sessionId: "session_beta",
      }),
    ]);
  });

  it("materializes stable identities and resolves due dates once", async () => {
    const task = definition({
      due: {
        disambiguation: "earlier",
        localDate: "2026-11-01",
        localTime: "01:30",
      },
    });
    const first = await applicableTaskAssignments(
      [task],
      snapshot(),
      "America/Los_Angeles",
    );
    const replay = await applicableTaskAssignments(
      [task],
      snapshot(),
      "America/Los_Angeles",
    );
    expect(replay).toEqual(first);
    expect(new Set(first.map(({ assignmentId }) => assignmentId)).size).toBe(
      first.length,
    );
    expect(first[0]?.dueAt).toBe("2026-11-01T08:30:00.000Z");
  });

  it("fails closed before an unbounded materialization plan is created", async () => {
    await expect(
      applicableTaskAssignments(
        [definition()],
        {
          contacts: Array.from({ length: 5_001 }, (_, index) => ({
            contactId: `contact_${index}`,
            roles: ["speaker" as const],
          })),
          eventId: "event_one",
          sessions: [],
        },
        "UTC",
      ),
    ).rejects.toThrow("5000-assignment materialization limit");
  });

  it("previews additive backfill and preserves out-of-target history", async () => {
    const current = await applicableTaskAssignments(
      [definition()],
      snapshot(),
      "UTC",
    );
    const preview = await previewTaskBackfill(
      [
        definition({
          target: {
            assignmentScope: "contact",
            contact: {
              excludeContactIds: [],
              includeContactIds: ["contact_beta"],
              roles: ["speaker"],
            },
            session: null,
          },
          version: 2,
        }),
      ],
      snapshot(),
      "UTC",
      [
        ...(current[0] ? [current[0]] : []),
        {
          assignmentId: "assignment_historic",
          contactId: "contact_removed",
          definitionId: "definition_one",
          eventId: "event_one",
          sessionId: null,
        },
        {
          assignmentId: "assignment_foreign",
          contactId: "contact_beta",
          definitionId: "definition_one",
          eventId: "event_foreign",
          sessionId: null,
        },
      ],
    );
    expect(preview.policy).toBe("additive_preserve_existing");
    expect(preview.create).toEqual([
      expect.objectContaining({ contactId: "contact_beta" }),
    ]);
    expect(preview.noLongerTargeted.map(({ contactId }) => contactId)).toEqual([
      "contact_alpha",
      "contact_removed",
    ]);
    expect(JSON.stringify(preview)).not.toContain("event_foreign");
    expect(preview.previewId).toMatch(/^tbp_[0-9a-f]{36}$/);

    const changedAssignmentPolicy = await previewTaskBackfill(
      [
        definition({
          approvalRequired: true,
          required: false,
          target: {
            assignmentScope: "contact",
            contact: {
              excludeContactIds: [],
              includeContactIds: ["contact_beta"],
              roles: ["speaker"],
            },
            session: null,
          },
          version: 2,
        }),
      ],
      snapshot(),
      "UTC",
      [
        ...(current[0] ? [current[0]] : []),
        {
          assignmentId: "assignment_historic",
          contactId: "contact_removed",
          definitionId: "definition_one",
          eventId: "event_one",
          sessionId: null,
        },
      ],
    );
    expect(changedAssignmentPolicy.previewId).not.toBe(preview.previewId);
  });
});

describe("task assignment transitions", () => {
  it("submits and replaces typed responses without losing state history", () => {
    const initial = assignment({ approvalRequired: true });
    const submitted = submitTaskAssignment(initial, {
      actorId: "contact_alpha",
      actorType: "speaker",
      at: "2026-08-10T18:00:00.000Z",
      commandId: "command_submit_typed",
      expectedVersion: 1,
    });
    const replacement = submitTaskAssignment(submitted, {
      actorId: "contact_alpha",
      actorType: "speaker",
      at: "2026-08-10T19:00:00.000Z",
      commandId: "command_replace_typed",
      expectedVersion: 2,
    });

    expect(replacement).toMatchObject({ state: "submitted", version: 3 });
    expect(replacement.history).toEqual([
      expect.objectContaining({ from: "incomplete", to: "submitted" }),
      expect.objectContaining({ from: "submitted", to: "submitted" }),
    ]);
  });

  it("validates configured form and file responses", () => {
    expect(() =>
      validateTaskSubmissionResponse(
        {
          fields: [
            {
              id: "field_name",
              options: [],
              required: true,
              type: "text",
            },
          ],
          kind: "form",
        },
        {
          answers: [{ fieldId: "field_name", value: "  " }],
          kind: "form",
        },
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid_response" }));
    expect(() =>
      validateTaskSubmissionResponse(
        { kind: "file", maxFiles: 1 },
        {
          acknowledged: true,
          fileIds: ["file_one", "file_two"],
          kind: "file",
          notes: "",
        },
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid_response" }));
  });

  it("keeps approval-required submissions outstanding until approval", () => {
    const initial = assignment({ approvalRequired: true });
    const submitted = transitionTaskAssignment(initial, {
      actorId: "contact_alpha",
      actorType: "speaker",
      at: "2026-08-10T18:00:00.000Z",
      commandId: "command_submit",
      expectedVersion: 1,
      reason: null,
      to: "submitted",
    });
    expect(submitted).toMatchObject({ state: "submitted", version: 2 });
    expect(
      evaluateTaskReadiness([submitted], "UTC", new Date("2026-08-10T19:00Z"))
        .status,
    ).toBe("outstanding");

    const approved = transitionTaskAssignment(submitted, {
      actorId: "user_organizer",
      actorType: "organizer",
      at: "2026-08-10T19:00:00.000Z",
      commandId: "command_approve",
      expectedVersion: 2,
      reason: "Reviewed the submitted response.",
      to: "approved",
    });
    expect(approved.history).toEqual([
      expect.objectContaining({ from: "incomplete", to: "submitted" }),
      expect.objectContaining({ from: "submitted", to: "approved" }),
    ]);
    expect(
      evaluateTaskReadiness([approved], "UTC", new Date("2026-08-10T19:00Z"))
        .status,
    ).toBe("ready");
  });

  it("rejects stale, illegal, and unexplained transitions", () => {
    const initial = assignment({ approvalRequired: true });
    expect(() =>
      transitionTaskAssignment(initial, {
        actorId: "user_organizer",
        actorType: "organizer",
        at: "2026-08-10T18:00:00.000Z",
        commandId: "command_stale",
        expectedVersion: 2,
        reason: null,
        to: "approved",
      }),
    ).toThrowError(expect.objectContaining({ code: "version_conflict" }));
    expect(() =>
      transitionTaskAssignment(initial, {
        actorId: "contact_alpha",
        actorType: "speaker",
        at: "2026-08-10T18:00:00.000Z",
        commandId: "command_speaker_approve",
        expectedVersion: 1,
        reason: null,
        to: "approved",
      }),
    ).toThrowError(expect.objectContaining({ code: "illegal_transition" }));

    const submitted = assignment({
      approvalRequired: true,
      state: "submitted",
      version: 2,
    });
    expect(() =>
      transitionTaskAssignment(submitted, {
        actorId: "user_organizer",
        actorType: "organizer",
        at: "2026-08-10T18:00:00.000Z",
        commandId: "command_reject",
        expectedVersion: 2,
        reason: null,
        to: "rejected",
      }),
    ).toThrowError(expect.objectContaining({ code: "reason_required" }));
  });

  it("allows rejected work to be resubmitted with complete history", () => {
    const rejected = assignment({
      history: [
        {
          actorId: "user_organizer",
          actorType: "organizer",
          at: "2026-08-10T18:00:00.000Z",
          commandId: "command_rejected",
          from: "submitted",
          reason: "Please replace the draft.",
          to: "rejected",
          version: 3,
        },
      ],
      state: "rejected",
      version: 3,
    });
    const result = transitionTaskAssignment(rejected, {
      actorId: "contact_alpha",
      actorType: "speaker",
      at: "2026-08-11T18:00:00.000Z",
      commandId: "command_resubmit",
      expectedVersion: 3,
      reason: null,
      to: "submitted",
    });
    expect(result.history).toHaveLength(2);
    expect(result.history[1]).toMatchObject({
      from: "rejected",
      to: "submitted",
      version: 4,
    });
  });
});

describe("event-local due dates and readiness", () => {
  it("requires DST disambiguation and rejects nonexistent local times", () => {
    expect(
      resolveEventLocalDue(
        {
          disambiguation: "earlier",
          localDate: "2026-11-01",
          localTime: "01:30",
        },
        "America/Los_Angeles",
      ),
    ).toBe("2026-11-01T08:30:00.000Z");
    expect(
      resolveEventLocalDue(
        {
          disambiguation: "later",
          localDate: "2026-11-01",
          localTime: "01:30",
        },
        "America/Los_Angeles",
      ),
    ).toBe("2026-11-01T09:30:00.000Z");
    expect(() =>
      resolveEventLocalDue(
        {
          disambiguation: "reject",
          localDate: "2026-11-01",
          localTime: "01:30",
        },
        "America/Los_Angeles",
      ),
    ).toThrowError(expect.objectContaining({ code: "ambiguous_local_due" }));
    expect(() =>
      resolveEventLocalDue(
        {
          disambiguation: "earlier",
          localDate: "2026-03-08",
          localTime: "02:30",
        },
        "America/Los_Angeles",
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid_local_due" }));
  });

  it("never marks zero-task or optional-only speakers ready", () => {
    expect(
      evaluateTaskReadiness([], "America/New_York", new Date()).status,
    ).toBe("not_configured");
    expect(
      evaluateTaskReadiness(
        [assignment({ required: false, state: "complete" })],
        "America/New_York",
        new Date(),
      ),
    ).toMatchObject({
      configuration: "optional_only",
      ratio: { complete: 0, percent: null, total: 0 },
      status: "not_configured",
    });
  });

  it("uses a strict due boundary and reports next due in the event timezone", () => {
    const dueAt = "2026-03-08T07:00:00.000Z";
    const open = assignment({ dueAt });
    expect(
      evaluateTaskReadiness([open], "America/New_York", new Date(dueAt)),
    ).toMatchObject({
      nextDue: {
        at: dueAt,
        localDate: "2026-03-08",
        localTime: "03:00",
        timezone: "America/New_York",
      },
      overdueCount: 0,
      status: "outstanding",
    });
    expect(
      evaluateTaskReadiness(
        [open],
        "America/New_York",
        new Date(Date.parse(dueAt) + 1),
      ).status,
    ).toBe("overdue");
  });

  it("satisfies ready exactly when every required assignment is satisfied", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            approvalRequired: fc.boolean(),
            required: fc.boolean(),
            state: fc.constantFrom(
              "approved" as const,
              "complete" as const,
              "incomplete" as const,
              "rejected" as const,
              "submitted" as const,
            ),
          }),
          { maxLength: 40 },
        ),
        (states) => {
          const assignments = states.map((state, index) =>
            assignment({
              ...state,
              assignmentId: `assignment_${index}`,
            }),
          );
          const required = assignments.filter(({ required }) => required);
          const expectedReady =
            required.length > 0 &&
            required.every((item) =>
              item.approvalRequired
                ? item.state === "approved"
                : item.state === "complete" || item.state === "approved",
            );
          const result = evaluateTaskReadiness(
            assignments,
            "UTC",
            new Date("2026-08-10T00:00:00.000Z"),
          );
          expect(result.status === "ready").toBe(expectedReady);
          if (required.length === 0) {
            expect(result.status).toBe("not_configured");
          }
        },
      ),
    );
  });
});

it("exposes typed domain errors", () => {
  expect(new TaskDomainError("illegal_transition", "invalid")).toMatchObject({
    code: "illegal_transition",
    name: "TaskDomainError",
  });
});
