import { describe, expect, it } from "vitest";

import {
  organizerSubmissionAnswerSchema,
  organizerSubmissionCommandResponseSchema,
  organizerSubmissionCommandSchema,
  organizerSubmissionListQuerySchema,
  organizerSubmissionProjectionSchema,
} from "./organizer-submissions.js";

const baseCommand = {
  commandId: "command_submission_01",
  expectedVersion: 3,
  submissionId: "submission_01",
} as const;

describe("organizer submission contracts", () => {
  it("accepts bounded filters and rejects unknown or oversized query input", () => {
    expect(
      organizerSubmissionListQuerySchema.parse({
        pageSize: 25,
        search: "reliable agents",
        status: "in_review",
        track: "track_agents",
      }),
    ).toEqual({
      pageSize: 25,
      search: "reliable agents",
      status: "in_review",
      track: "track_agents",
    });
    expect(
      organizerSubmissionListQuerySchema.safeParse({ pageSize: 101 }).success,
    ).toBe(false);
    expect(
      organizerSubmissionListQuerySchema.safeParse({
        pageSize: 25,
        providerRecordId: "rec_private",
      }).success,
    ).toBe(false);
  });

  it("requires reasons for every lifecycle command and bounds organizer notes", () => {
    for (const type of ["start_review", "reopen", "withdraw"] as const) {
      expect(
        organizerSubmissionCommandSchema.safeParse({
          ...baseCommand,
          reason: "Eligibility check completed.",
          type,
        }).success,
      ).toBe(true);
      expect(
        organizerSubmissionCommandSchema.safeParse({
          ...baseCommand,
          reason: "   ",
          type,
        }).success,
      ).toBe(false);
    }
    expect(
      organizerSubmissionCommandSchema.safeParse({
        ...baseCommand,
        body: "Keep this in the reliability block.",
        type: "add_note",
      }).success,
    ).toBe(true);
    expect(
      organizerSubmissionCommandSchema.safeParse({
        ...baseCommand,
        body: "x".repeat(4_001),
        type: "add_note",
      }).success,
    ).toBe(false);
  });

  it("keeps redacted answer values and degraded projection states explicit", () => {
    expect(
      organizerSubmissionAnswerSchema.safeParse({
        fieldKey: "slides_file",
        fieldType: "file",
        formVersion: 2,
        label: "Slides",
        order: 3,
        redacted: true,
        value: null,
      }).success,
    ).toBe(true);
    expect(
      organizerSubmissionAnswerSchema.safeParse({
        fieldKey: "slides_file",
        fieldType: "file",
        formVersion: 2,
        label: "Slides",
        order: 3,
        redacted: false,
        value: null,
      }).success,
    ).toBe(false);
    expect(
      organizerSubmissionProjectionSchema.safeParse({
        asOf: "2026-08-10T12:00:00.000Z",
        pendingRepairs: 1,
        reasons: ["repair_pending"],
        state: "partial",
      }).success,
    ).toBe(true);
    expect(
      organizerSubmissionProjectionSchema.safeParse({
        asOf: "2026-08-10T12:00:00.000Z",
        pendingRepairs: 0,
        reasons: [],
        state: "stale",
      }).success,
    ).toBe(false);
  });

  it("keeps command failures discriminated from standard HTTP errors", () => {
    expect(
      organizerSubmissionCommandResponseSchema.parse({
        error: {
          actualVersion: 4,
          code: "submission_version_conflict",
          expectedVersion: 3,
          message: "The submission changed.",
        },
        ok: false,
      }),
    ).toMatchObject({
      error: { code: "submission_version_conflict" },
      ok: false,
    });
    expect(
      organizerSubmissionCommandResponseSchema.safeParse({
        error: { code: "forbidden", message: "Denied." },
        ok: false,
      }).success,
    ).toBe(false);
  });
});
