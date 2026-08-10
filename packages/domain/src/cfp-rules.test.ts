import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  evaluateCfpRules,
  resolveCfpTrackRoute,
  validateCfpRules,
  visibleFieldTransitions,
  type CfpRuleField,
  type CfpTrackRoute,
} from "./cfp-rules";

const workshopFields: CfpRuleField[] = [
  {
    key: "session_format",
    label: "Session format",
    options: ["Talk", "Workshop"],
    required: true,
    type: "single_select",
  },
  {
    key: "workshop_prerequisites",
    label: "Workshop prerequisites",
    required: false,
    rules: [
      {
        effect: "show",
        id: "show-for-workshop",
        operator: "equals",
        sourceKey: "session_format",
        value: "Workshop",
      },
      {
        effect: "require",
        id: "require-for-workshop",
        operator: "equals",
        sourceKey: "session_format",
        value: "Workshop",
      },
    ],
    type: "long_text",
  },
];

describe("CFP conditional rules", () => {
  it("evaluates the Workshop hide/show/require snapshot", () => {
    const talk = evaluateCfpRules(workshopFields, {
      session_format: "Talk",
      workshop_prerequisites: "Install the SDK.",
    });
    const workshop = evaluateCfpRules(workshopFields, {
      session_format: "Workshop",
      workshop_prerequisites: "Install the SDK.",
    });

    expect({ talk, workshop }).toMatchInlineSnapshot(`
      {
        "talk": {
          "answers": {
            "session_format": "Talk",
          },
          "clearedKeys": [
            "workshop_prerequisites",
          ],
          "fields": [
            {
              "key": "session_format",
              "required": true,
              "visible": true,
            },
            {
              "key": "workshop_prerequisites",
              "required": false,
              "visible": false,
            },
          ],
        },
        "workshop": {
          "answers": {
            "session_format": "Workshop",
            "workshop_prerequisites": "Install the SDK.",
          },
          "clearedKeys": [],
          "fields": [
            {
              "key": "session_format",
              "required": true,
              "visible": true,
            },
            {
              "key": "workshop_prerequisites",
              "required": true,
              "visible": true,
            },
          ],
        },
      }
    `);
  });

  it("reports accessible visibility transitions without treating initial render as a change", () => {
    const talk = evaluateCfpRules(workshopFields, {
      session_format: "Talk",
    });
    const workshop = evaluateCfpRules(workshopFields, {
      session_format: "Workshop",
    });

    expect(visibleFieldTransitions([], talk.fields)).toEqual([]);
    expect(visibleFieldTransitions(talk.fields, workshop.fields)).toEqual([
      { key: "workshop_prerequisites", visible: true },
    ]);
  });

  it("clears every answer whenever its show condition does not match", () => {
    fc.assert(
      fc.property(
        fc.string().filter((value) => value !== "Workshop"),
        fc.string(),
        (format, prerequisites) => {
          const result = evaluateCfpRules(workshopFields, {
            session_format: format,
            workshop_prerequisites: prerequisites,
          });
          expect(result.answers).not.toHaveProperty("workshop_prerequisites");
          expect(result.clearedKeys).toEqual(["workshop_prerequisites"]);
        },
      ),
    );
  });

  it("preserves every visible answer for a matching single or multiple choice", () => {
    fc.assert(
      fc.property(fc.string(), (prerequisites) => {
        const result = evaluateCfpRules(workshopFields, {
          session_format: "Workshop",
          workshop_prerequisites: prerequisites,
        });
        expect(result.answers.workshop_prerequisites).toBe(prerequisites);
        expect(result.clearedKeys).toEqual([]);
      }),
    );

    const multiFields: CfpRuleField[] = [
      {
        key: "topics",
        label: "Topics",
        options: ["Security", "Performance"],
        required: false,
        type: "multi_select",
      },
      {
        key: "threat_model",
        label: "Threat model",
        required: false,
        rules: [
          {
            effect: "show",
            id: "show-security",
            operator: "includes",
            sourceKey: "topics",
            value: "Security",
          },
        ],
        type: "file",
      },
    ];
    expect(
      evaluateCfpRules(multiFields, {
        threat_model: "upload-1",
        topics: ["Performance", "Security"],
      }).answers.threat_model,
    ).toBe("upload-1");
  });
});

describe("CFP rule publication validation", () => {
  it("accepts valid prior choice rules", () => {
    expect(validateCfpRules(workshopFields)).toEqual([]);
  });

  it("returns precise diagnostics for forward, deleted, incompatible, and removed-option references", () => {
    const fields: CfpRuleField[] = [
      {
        key: "conditional",
        label: "Conditional answer",
        required: false,
        rules: [
          {
            effect: "show",
            id: "forward",
            operator: "equals",
            sourceKey: "later_choice",
            value: "Removed",
          },
          {
            effect: "show",
            id: "deleted",
            operator: "equals",
            sourceKey: "deleted_choice",
            value: "Yes",
          },
          {
            effect: "show",
            id: "not-choice",
            operator: "equals",
            sourceKey: "plain_text",
            value: "Yes",
          },
        ],
        type: "long_text",
      },
      {
        key: "plain_text",
        label: "Plain text",
        required: false,
        type: "short_text",
      },
      {
        key: "later_choice",
        label: "Later choice",
        options: ["Current"],
        required: false,
        type: "single_select",
      },
    ];

    expect(validateCfpRules(fields).map(({ code, ruleId }) => [code, ruleId]))
      .toMatchInlineSnapshot(`
        [
          [
            "forward_reference",
            "forward",
          ],
          [
            "missing_option",
            "forward",
          ],
          [
            "missing_source",
            "deleted",
          ],
          [
            "forward_reference",
            "not-choice",
          ],
          [
            "source_not_choice",
            "not-choice",
          ],
        ]
      `);
  });

  it("detects cycles independently from forward-reference validation", () => {
    const fields: CfpRuleField[] = [
      {
        key: "a",
        label: "A",
        options: ["Yes"],
        required: false,
        rules: [
          {
            effect: "show",
            id: "a-needs-b",
            operator: "equals",
            sourceKey: "b",
            value: "Yes",
          },
        ],
        type: "single_select",
      },
      {
        key: "b",
        label: "B",
        options: ["Yes"],
        required: false,
        rules: [
          {
            effect: "show",
            id: "b-needs-a",
            operator: "equals",
            sourceKey: "a",
            value: "Yes",
          },
        ],
        type: "single_select",
      },
    ];

    expect(validateCfpRules(fields)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "cyclic_reference",
          message:
            "Conditional rules contain a cycle: a → b → a. Rules may only reference an earlier field.",
        }),
        expect.objectContaining({ code: "forward_reference" }),
      ]),
    );
  });
});

describe("CFP track routing", () => {
  const routes: CfpTrackRoute[] = [
    {
      aliases: ["Track D", "Product · Track D"],
      defaultReviewerGroupId: "group-product",
      routeKey: "product-track-d",
      selection: "Product",
      submissionTrack: "Product · Track D",
    },
  ];

  it.each(["Product", "product", " Track D ", "Product · Track D"])(
    "resolves %s to one canonical route",
    (selection) => {
      expect(resolveCfpTrackRoute(routes, selection)).toMatchObject({
        defaultReviewerGroupId: "group-product",
        routeKey: "product-track-d",
        submissionTrack: "Product · Track D",
      });
    },
  );

  it("fails closed for an unmapped track", () => {
    expect(resolveCfpTrackRoute(routes, "Unknown")).toBeNull();
  });
});
