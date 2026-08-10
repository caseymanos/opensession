import { describe, expect, it } from "vitest";

import { inspectFeatureFlags, isFeatureEnabled } from "../src/features";

describe("operational feature flags", () => {
  it("preserves independent valid flag values", () => {
    const value = {
      ai: false,
      embeds: true,
      email: false,
      integrations: true,
      webhooks: false,
      writes: true,
    };

    expect(inspectFeatureFlags(value)).toEqual({ flags: value, valid: true });
    expect(isFeatureEnabled(value, "embeds")).toBe(true);
    expect(isFeatureEnabled(value, "email")).toBe(false);
  });

  it("fails closed when configuration is incomplete or invalid", () => {
    const inspection = inspectFeatureFlags({ writes: true });

    expect(inspection.valid).toBe(false);
    expect(Object.values(inspection.flags).every((value) => !value)).toBe(true);
    expect(isFeatureEnabled("invalid", "writes")).toBe(false);
  });
});
