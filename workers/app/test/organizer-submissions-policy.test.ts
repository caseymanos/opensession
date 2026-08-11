import type {
  OrganizerSubmissionCommand,
  OrganizerSubmissionStatus,
} from "@sessionbox-killer/contracts";
import { describe, expect, it } from "vitest";

import {
  allowedSubmissionCommands,
  nextSubmissionStatus,
  OrganizerSubmissionValidationError,
} from "../src/organizer-submissions/policy";

const statuses: readonly OrganizerSubmissionStatus[] = [
  "draft",
  "submitted",
  "in_review",
  "accepted",
  "waitlisted",
  "declined",
  "withdrawn",
];

function command(
  type: "reopen" | "start_review" | "withdraw",
): OrganizerSubmissionCommand {
  return {
    commandId: `command_${type}`,
    expectedVersion: 1,
    reason: "Organizer lifecycle reason.",
    submissionId: "submission_policy",
    type,
  };
}

describe("organizer submission lifecycle policy", () => {
  it("allows only the defined lifecycle transitions", () => {
    const legal = new Map<string, OrganizerSubmissionStatus>([
      ["submitted:start_review", "in_review"],
      ["accepted:reopen", "submitted"],
      ["waitlisted:reopen", "submitted"],
      ["declined:reopen", "submitted"],
      ["withdrawn:reopen", "submitted"],
      ["submitted:withdraw", "withdrawn"],
      ["in_review:withdraw", "withdrawn"],
      ["accepted:withdraw", "withdrawn"],
      ["waitlisted:withdraw", "withdrawn"],
      ["declined:withdraw", "withdrawn"],
    ]);

    for (const status of statuses) {
      for (const type of ["start_review", "reopen", "withdraw"] as const) {
        const expected = legal.get(`${status}:${type}`);
        if (expected) {
          expect(nextSubmissionStatus(status, command(type))).toBe(expected);
        } else {
          expect(() => nextSubmissionStatus(status, command(type))).toThrow(
            OrganizerSubmissionValidationError,
          );
        }
      }
    }
  });

  it("permits notes in every lifecycle state and exposes matching capabilities", () => {
    for (const status of statuses) {
      const addNote: OrganizerSubmissionCommand = {
        body: "Organizer-only context.",
        commandId: "command_add_note",
        expectedVersion: 1,
        submissionId: "submission_policy",
        type: "add_note",
      };
      expect(nextSubmissionStatus(status, addNote)).toBe(status);
      expect(allowedSubmissionCommands(status)).toContain("add_note");
    }
    expect(allowedSubmissionCommands("submitted")).toEqual([
      "add_note",
      "start_review",
      "withdraw",
    ]);
    expect(allowedSubmissionCommands("withdrawn")).toEqual([
      "add_note",
      "reopen",
    ]);
  });
});
