import { describe, expect, it } from "vitest";

import {
  taskAssignmentReviewCommandSchema,
  taskAssignmentResponseEnvelopeSchema,
  taskAssignmentSubmissionCommandSchema,
  taskBackfillPreviewSchema,
  taskDefinitionCommandSchema,
  taskDefinitionDraftSchema,
  taskReadinessSchema,
  taskTargetRuleSchema,
} from "./tasks";

const target = {
  assignment_scope: "session" as const,
  contact: {
    exclude_contact_ids: [],
    include_contact_ids: [],
    roles: ["speaker" as const],
  },
  session: {
    format_ids: ["format_talk"],
    include_session_ids: [],
    participant_roles: ["speaker" as const],
    track_ids: ["track_platform"],
  },
};

const definition = {
  approval_required: true,
  configuration: {
    extensions: ["pdf", "pptx"],
    kind: "file" as const,
    max_bytes: 52_428_800,
    max_files: 1,
    private: true as const,
  },
  description: "Upload final slides for the assigned session.",
  due: {
    disambiguation: "later" as const,
    local_date: "2026-11-01",
    local_time: "01:30",
  },
  id: "definition_slides",
  name: "Final slides",
  required: true,
  target,
};

describe("task contracts", () => {
  it("accepts acknowledgement, link, form, and private file definitions", () => {
    const values = [
      {
        acknowledgement_label: "I agree",
        kind: "ack" as const,
      },
      {
        acknowledgement_label: "I reviewed the guide",
        kind: "link" as const,
        url: "https://example.test/speaker-guide",
      },
      {
        fields: [
          {
            help_text: "Shown to the host.",
            id: "field_pronunciation",
            label: "Name pronunciation",
            options: [],
            required: true,
            type: "text" as const,
          },
        ],
        kind: "form" as const,
      },
      definition.configuration,
    ];
    values.forEach((configuration, index) => {
      expect(
        taskDefinitionDraftSchema.safeParse({
          ...definition,
          configuration,
          id: `definition_${index}`,
        }).success,
      ).toBe(true);
    });
  });

  it("rejects invalid targeting, provider fields, and public file tasks", () => {
    expect(
      taskTargetRuleSchema.safeParse({
        ...target,
        assignment_scope: "contact",
      }).success,
    ).toBe(false);
    expect(
      taskDefinitionDraftSchema.safeParse({
        ...definition,
        airtable_record_id: "rec_private",
      }).success,
    ).toBe(false);
    expect(
      taskDefinitionDraftSchema.safeParse({
        ...definition,
        configuration: { ...definition.configuration, private: false },
      }).success,
    ).toBe(false);
    expect(
      taskDefinitionDraftSchema.safeParse({
        ...definition,
        configuration: {
          acknowledgement_label: "Open the unsafe link",
          kind: "link",
          url: "javascript:alert(document.domain)",
        },
      }).success,
    ).toBe(false);
  });

  it("requires explicit optimistic concurrency and preview intent", () => {
    expect(
      taskDefinitionCommandSchema.parse({
        backfill_preview_id: "preview_tasks_v2",
        command_id: "command_definition_v2",
        definition,
        expected_version: 1,
        type: "upsert_definition",
      }),
    ).toBeTruthy();
    expect(
      taskDefinitionCommandSchema.safeParse({
        command_id: "command_missing_version",
        definition,
        type: "upsert_definition",
      }).success,
    ).toBe(false);
  });

  it("enforces actor identity and bounded assignment history", () => {
    const history = {
      actor_id: "contact_speaker",
      actor_type: "speaker" as const,
      at: "2026-08-10T18:00:00.000Z",
      command_id: "command_submit",
      from: "incomplete" as const,
      reason: null,
      to: "submitted" as const,
      version: 2,
    };
    expect(
      taskAssignmentResponseEnvelopeSchema.parse({
        history: [history],
        schema_version: 1,
        state: "submitted",
        version: 2,
      }),
    ).toBeTruthy();
    expect(
      taskAssignmentResponseEnvelopeSchema.safeParse({
        history: [{ ...history, actor_id: null }],
        schema_version: 1,
        state: "submitted",
        version: 2,
      }).success,
    ).toBe(false);
  });

  it("bounds typed submissions and requires reasons for every review", () => {
    expect(
      taskAssignmentSubmissionCommandSchema.parse({
        command_id: "command_submit_slides",
        expected_version: 2,
        response: {
          acknowledged: true,
          file_ids: ["file_slides_v2"],
          kind: "file",
          notes: "Captions are embedded.",
        },
        type: "submit_assignment",
      }),
    ).toBeTruthy();
    expect(
      taskAssignmentSubmissionCommandSchema.safeParse({
        command_id: "command_duplicate_files",
        expected_version: 2,
        response: {
          acknowledged: true,
          file_ids: ["file_slides_v2", "file_slides_v2"],
          kind: "file",
          notes: "",
        },
        type: "submit_assignment",
      }).success,
    ).toBe(false);
    expect(
      taskAssignmentReviewCommandSchema.safeParse({
        command_id: "command_approve_without_reason",
        decision: "approve",
        expected_version: 3,
        reason: "",
        type: "review_assignment",
      }).success,
    ).toBe(false);
  });

  it("accepts the response-history envelope while retaining v1 reads", () => {
    expect(
      taskAssignmentResponseEnvelopeSchema.parse({
        current_response: { acknowledged: true, kind: "ack" },
        history: [],
        response_history: [
          {
            actor_id: "contact_speaker",
            at: "2026-08-10T18:00:00.000Z",
            command_id: "command_typed_response",
            response: { acknowledged: true, kind: "ack" },
            version: 2,
          },
        ],
        schema_version: 2,
        state: "complete",
        version: 2,
      }),
    ).toBeTruthy();
  });

  it("makes zero-required readiness explainable and never ready", () => {
    expect(
      taskReadinessSchema.parse({
        configuration: "optional_only",
        explanation: "Only optional tasks are assigned.",
        next_due: null,
        outstanding_count: 0,
        overdue_count: 0,
        ratio: { complete: 0, percent: null, total: 0 },
        status: "not_configured",
      }),
    ).toBeTruthy();
    expect(
      taskReadinessSchema.safeParse({
        configuration: "optional_only",
        explanation: "No required tasks.",
        next_due: null,
        outstanding_count: 0,
        overdue_count: 0,
        ratio: { complete: 0, percent: null, total: 0 },
        status: "ready",
      }).success,
    ).toBe(false);
  });

  it("documents additive backfill without destructive assignment removal", () => {
    expect(
      taskBackfillPreviewSchema.parse({
        create: [],
        no_longer_targeted: [
          {
            assignment_id: "assignment_preserved",
            contact_id: "contact_speaker",
            definition_id: "definition_slides",
            event_id: "event_summit",
            session_id: "session_agents",
          },
        ],
        policy: "additive_preserve_existing",
        preserve: [],
        preview_id: "preview_tasks_v2",
      }),
    ).toBeTruthy();
  });
});
