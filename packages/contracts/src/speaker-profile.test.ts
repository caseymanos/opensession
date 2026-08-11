import { describe, expect, it } from "vitest";

import {
  apiErrorResponseSchema,
  speakerProfileResponseSchema,
  speakerProfileSaveCommandSchema,
} from "./index";

const incompleteProfile = {
  audit: [],
  fields: {
    bio: "",
    bluesky_url: "",
    company: "",
    display_name: "A speaker",
    headshot_alt: "",
    linkedin_url: "",
    pronouns: "",
    title: "",
    website_url: "",
  },
  headshot: null,
  policy: {
    accepted_content_types: ["image/jpeg", "image/png", "image/webp"],
    max_bytes: 8 * 1024 * 1024,
    min_height: 1200,
    min_width: 1200,
    scope: "organization",
  },
  publication_state: "draft",
  profile_id: "contact_1",
  reuse_scope: "organization",
  upload_context: {
    event_id: "event_1",
    organization_id: "org_1",
    owner_contact_id: "contact_1",
    purpose: "headshot",
  },
  updated_at: null,
  version: 1,
};

describe("speaker profile contract", () => {
  it("reads an incomplete draft so the editor can repair it", () => {
    expect(
      speakerProfileResponseSchema.safeParse(incompleteProfile).success,
    ).toBe(true);
  });

  it("rejects an incomplete save while allowing a profile without a headshot", () => {
    const base = {
      command_id: "command_1",
      expected_version: 1,
      fields: incompleteProfile.fields,
      reuse_organization: true,
    };
    expect(speakerProfileSaveCommandSchema.safeParse(base).success).toBe(false);
    expect(
      speakerProfileSaveCommandSchema.safeParse({
        ...base,
        fields: {
          ...incompleteProfile.fields,
          bio: "A short biography.",
          company: "OpenSession",
          title: "Engineer",
        },
      }).success,
    ).toBe(true);
  });

  it("requires alt text when a new headshot is attached", () => {
    expect(
      speakerProfileSaveCommandSchema.safeParse({
        command_id: "command_1",
        expected_version: 1,
        fields: {
          ...incompleteProfile.fields,
          bio: "A short biography.",
          company: "OpenSession",
          title: "Engineer",
        },
        headshot_file_id: "file_1",
        reuse_organization: true,
      }).success,
    ).toBe(false);
  });

  it("keeps outcome-unknown errors strict and typed", () => {
    expect(
      apiErrorResponseSchema.parse({
        error: {
          code: "profile_outcome_unknown",
          message: "Refresh before retrying.",
          retryable: true,
        },
        request_id: "req_1",
      }),
    ).toMatchObject({ error: { retryable: true } });
    expect(
      apiErrorResponseSchema.safeParse({
        error: {
          code: "profile_outcome_unknown",
          message: "Refresh before retrying.",
          retryable: true,
          provider_record_id: "rec_private",
        },
        request_id: "req_1",
      }).success,
    ).toBe(false);
  });
});
