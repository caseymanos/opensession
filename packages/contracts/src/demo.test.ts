import { describe, expect, it } from "vitest";

import { demoRoleProvisioningRequestSchema } from "./demo";

const fingerprint = "a".repeat(64);

function request(identities: unknown[]) {
  return {
    confirmation: "PROVISION AI ENGINEER SUMMIT DEMO ROLES",
    fixture_fingerprint: fingerprint,
    identities,
  };
}

describe("demo role provisioning contract", () => {
  it("accepts exactly one runtime alias for each supported role", () => {
    const parsed = demoRoleProvisioningRequestSchema.parse(
      request([
        { email: "Owner+Organizer@Example.Test", role: "organizer" },
        { email: "owner+reviewer@example.test", role: "reviewer" },
        { email: "owner+speaker@example.test", role: "speaker" },
      ]),
    );

    expect(parsed.identities.map(({ email }) => email)).toEqual([
      "Owner+Organizer@Example.Test",
      "owner+reviewer@example.test",
      "owner+speaker@example.test",
    ]);
  });

  it.each([
    request([
      { email: "organizer@example.test", role: "organizer" },
      { email: "reviewer@example.test", role: "reviewer" },
    ]),
    request([
      { email: "organizer@example.test", role: "organizer" },
      { email: "reviewer@example.test", role: "reviewer" },
      { email: "second-reviewer@example.test", role: "reviewer" },
    ]),
    request([
      { email: "same@example.test", role: "organizer" },
      { email: "SAME@example.test", role: "reviewer" },
      { email: "speaker@example.test", role: "speaker" },
    ]),
    {
      ...request([
        { email: "organizer@example.test", role: "organizer" },
        { email: "reviewer@example.test", role: "reviewer" },
        { email: "speaker@example.test", role: "speaker" },
      ]),
      organization_id: "org_other",
    },
  ])(
    "rejects count, role, normalized collision, and extra scope drift",
    (input) => {
      expect(demoRoleProvisioningRequestSchema.safeParse(input).success).toBe(
        false,
      );
    },
  );
});
