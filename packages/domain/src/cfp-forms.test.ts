import { describe, expect, it } from "vitest";

import {
  assertCfpFormTransition,
  nextCfpDraftVersion,
  validateCfpForm,
  type CfpFormFieldDefinition,
} from "./cfp-forms";

function field(
  patch: Partial<CfpFormFieldDefinition> = {},
): CfpFormFieldDefinition {
  return {
    helpText: "",
    id: "field_track",
    key: "track",
    label: "Track",
    options: ["AI", "Infrastructure"],
    order: 1,
    required: true,
    rules: [],
    type: "single_select",
    validation: {},
    ...patch,
  };
}

describe("CFP form domain", () => {
  it("returns stable, field-addressable publication diagnostics", () => {
    const diagnostics = validateCfpForm([
      field({ options: ["AI", "ai"] }),
      field({
        id: "field_details",
        key: "details",
        label: "Details",
        options: ["not-allowed"],
        order: 1,
        rules: [
          {
            effect: "show",
            id: "rule_details",
            operator: "equals",
            sourceKey: "missing",
            value: "AI",
          },
        ],
        type: "long_text",
        validation: {},
      }),
    ]);

    expect(diagnostics.map(({ code }) => code)).toEqual([
      "invalid_options",
      "invalid_order",
      "missing_source",
      "duplicate_option",
    ]);
    expect(diagnostics.every(({ path }) => path.startsWith("fields."))).toBe(
      true,
    );
  });

  it("advances publication versions monotonically", () => {
    expect(
      nextCfpDraftVersion([
        { status: "closed", version: 1 },
        { status: "published", version: 2 },
      ]),
    ).toBe(3);
    expect(nextCfpDraftVersion([])).toBe(1);
  });

  it("allows only immutable publication lifecycle transitions", () => {
    expect(() => assertCfpFormTransition("draft", "published")).not.toThrow();
    expect(() => assertCfpFormTransition("published", "closed")).not.toThrow();
    expect(() => assertCfpFormTransition("closed", "draft")).toThrow(
      "cannot change from closed to draft",
    );
    expect(() => assertCfpFormTransition("published", "draft")).toThrow(
      "cannot change from published to draft",
    );
  });

  it("bounds adversarial rule diagnostics while retaining the form-level limit", () => {
    const diagnostics = validateCfpForm(
      Array.from({ length: 10 }, (_, index) =>
        field({
          id: `field_${index + 1}`,
          key: `field_${index + 1}`,
          label: `Field ${index + 1}`,
          options: [],
          order: index + 1,
          rules: Array.from({ length: 64 }, () => ({
            effect: "show" as const,
            id: "duplicate_rule",
            operator: "equals" as const,
            sourceKey: "missing_source",
            value: "missing",
          })),
          type: "short_text",
        }),
      ),
    );

    expect(diagnostics).toHaveLength(512);
    expect(diagnostics[0]?.code).toBe("too_many_rules");
  });
});
