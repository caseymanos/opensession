import { describe, expect, it } from "vitest";

import {
  coordinatedDeletionResponseSchema,
  privacyExportRequestSchema,
  privacyPolicyResponseSchema,
} from "./privacy";

describe("privacy contracts", () => {
  it("normalizes bounded export input without accepting extra authority", () => {
    expect(
      privacyExportRequestSchema.parse({ email: " Subject@Example.Test " }),
    ).toEqual({ email: "Subject@Example.Test" });
    expect(
      privacyExportRequestSchema.safeParse({
        email: "subject@example.test",
        organization_id: "attacker_scope",
      }).success,
    ).toBe(false);
  });

  it("requires the policy to keep partial deletion disabled", () => {
    expect(
      privacyPolicyResponseSchema.safeParse({
        deletion: {
          completion_target_days: 30,
          mode: "coordinated_operator_request",
          partial_delete_api: true,
          reason: "unsafe",
          required_steps: ["one", "two", "three", "four"],
        },
        export: {
          format: "application/json",
          mode: "organization_owner_api",
          scope: "one_organization",
        },
        policy_version: "2026-08-11",
        retention: [
          { category: "one", policy: "one" },
          { category: "two", policy: "two" },
          { category: "three", policy: "three" },
        ],
      }).success,
    ).toBe(false);
  });

  it("keeps the coordinated deletion response non-successful", () => {
    expect(
      coordinatedDeletionResponseSchema.parse({
        accepted: false,
        code: "coordinated_deletion_required",
        message: "Use the coordinated privacy runbook.",
        policy_url: "/api/v1/privacy/policy",
      }).accepted,
    ).toBe(false);
  });
});
