import { describe, expect, it, vi } from "vitest";

import {
  isAppEnvironment,
  shouldShowDemoReset,
  shouldShowEnvironmentBanner,
} from "./environment";

describe("environment UI guards", () => {
  it("accepts only supported runtime environments", () => {
    expect(isAppEnvironment("local")).toBe(true);
    expect(isAppEnvironment("preview")).toBe(true);
    expect(isAppEnvironment("production")).toBe(true);
    expect(isAppEnvironment("staging")).toBe(false);
  });

  it("never exposes environment controls for non-demo production data", () => {
    expect(
      shouldShowEnvironmentBanner({
        environment: "production",
        isDemoEvent: false,
      }),
    ).toBe(false);
    expect(shouldShowDemoReset({ isDemoEvent: false, onReset: vi.fn() })).toBe(
      false,
    );
  });

  it("shows isolated environments and an explicitly wired demo reset", () => {
    expect(
      shouldShowEnvironmentBanner({
        environment: "preview",
        isDemoEvent: false,
      }),
    ).toBe(true);
    expect(shouldShowDemoReset({ isDemoEvent: true, onReset: vi.fn() })).toBe(
      true,
    );
    expect(shouldShowDemoReset({ isDemoEvent: true, onReset: undefined })).toBe(
      false,
    );
  });
});
