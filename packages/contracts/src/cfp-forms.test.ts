import { describe, expect, it } from "vitest";

import {
  cfpFormEntityTag,
  cfpFormVersionFromEntityTag,
  organizerCfpFormSaveRequestSchema,
  publicCfpConfigurationResponseSchema,
} from "./cfp-forms";

const field = {
  helpText: "Keep it concrete.",
  id: "field_title",
  key: "title",
  label: "Session title",
  options: [],
  order: 1,
  required: true,
  rules: [],
  type: "short_text" as const,
  validation: { maxLength: 100, minLength: 8 },
};

describe("CFP form contracts", () => {
  it("accepts strict organizer saves and rejects provider-shaped leakage", () => {
    const request = {
      commandId: "save_cfp_v2",
      expectedFormId: "form_v2_draft",
      expectedSourceVersion: 3,
      form: {
        editAfterClose: false,
        fields: [field],
        name: "Call for proposals",
        submissionLimit: 3,
        welcomeContent: "Share the session only you can give.",
      },
    };
    expect(organizerCfpFormSaveRequestSchema.parse(request)).toEqual(request);
    expect(
      organizerCfpFormSaveRequestSchema.safeParse({
        ...request,
        airtableRecordId: "rec_provider_leak",
      }).success,
    ).toBe(false);
  });

  it("supports every canonical builder block in public configuration", () => {
    const fields = [
      "checkbox",
      "file",
      "long_text",
      "multi_select",
      "participant",
      "section",
      "short_text",
      "single_select",
      "url",
    ].map((type, index) => ({
      helpText: field.helpText,
      key: `field_${index + 1}`,
      label: `Field ${index + 1}`,
      options:
        type === "multi_select" || type === "single_select" ? ["One"] : [],
      required: type !== "section",
      rules: field.rules,
      type,
      validation:
        type === "short_text" || type === "long_text" || type === "url"
          ? {}
          : {},
    }));
    const result = publicCfpConfigurationResponseSchema.safeParse({
      acceptingSubmissions: true,
      event: {
        cfpClosesAt: "2026-08-22T00:00:00.000Z",
        cfpOpensAt: null,
        endsAt: null,
        name: "AI Engineer Summit",
        slug: "ai-engineer-summit",
        startsAt: null,
        timezone: "America/Los_Angeles",
        venue: "",
      },
      form: {
        editAfterClose: false,
        fields,
        name: "Call for proposals",
        status: "published",
        submissionLimit: null,
        version: 2,
        welcomeContent: "Welcome",
      },
      formats: ["Talk"],
      tracks: [{ description: "", selection: "AI" }],
    });
    expect(result.success).toBe(true);
  });

  it("round-trips strong form entity tags and rejects weak or malformed tags", () => {
    const tag = cfpFormEntityTag({ id: "form_v2", sourceVersion: 7 });
    expect(tag).toBe('"cfp-form:form_v2:7"');
    expect(cfpFormVersionFromEntityTag(tag)).toEqual({
      formId: "form_v2",
      sourceVersion: 7,
    });
    expect(cfpFormVersionFromEntityTag('W/"cfp-form:form_v2:7"')).toBeNull();
    expect(cfpFormVersionFromEntityTag('"cfp-form:form_v2:0"')).toBeNull();
  });
});
