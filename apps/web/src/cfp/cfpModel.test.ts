import type { OrganizerCfpForm } from "@sessionbox-killer/contracts";
import { describe, expect, it } from "vitest";

import { cfpBuilderBlocksFromForm } from "./cfpModel";

function formWithType(
  type: OrganizerCfpForm["fields"][number]["type"],
): OrganizerCfpForm {
  return {
    editAfterClose: false,
    fields: [
      {
        helpText: "Confirm before submitting.",
        id: "field_confirmation",
        key: "confirmation",
        label: "I confirm",
        options: [],
        order: 1,
        required: true,
        rules: [],
        type,
        validation: {},
      },
    ],
    id: "form_cfp_v2",
    name: "Call for proposals",
    publishedAt: null,
    sourceVersion: 3,
    status: "draft",
    submissionLimit: null,
    version: 2,
    welcomeContent: "Welcome",
  };
}

describe("CFP builder model", () => {
  it("round-trips checkbox blocks from the authoritative form", () => {
    expect(cfpBuilderBlocksFromForm(formWithType("checkbox"))).toEqual([
      expect.objectContaining({
        id: "field_confirmation",
        key: "confirmation",
        required: true,
        type: "checkbox",
      }),
    ]);
  });

  it("keeps participant identity in the dedicated participant workflow", () => {
    expect(() => cfpBuilderBlocksFromForm(formWithType("participant"))).toThrow(
      "participant field is not supported by this builder",
    );
  });
});
