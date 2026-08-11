import { describe, expect, it } from "vitest";

import { apiAccessEventKey } from "./apiAccessRoute";

describe("API access route", () => {
  it("resolves the workspace and visual fixture", () => {
    expect(apiAccessEventKey("/app/ai-engineer-summit/integrations")).toBe(
      "ai-engineer-summit",
    );
    expect(apiAccessEventKey("/app/event_alpha/integrations/")).toBe(
      "event_alpha",
    );
    expect(apiAccessEventKey("/fixtures/api-access/default")).toBe(
      "ai-engineer-summit",
    );
  });

  it("rejects extra segments and encoded path separators", () => {
    expect(
      apiAccessEventKey("/app/event_alpha/integrations/api-access"),
    ).toBeNull();
    expect(apiAccessEventKey("/app/%2Fetc/integrations")).toBeNull();
    expect(apiAccessEventKey("/app/!/integrations")).toBeNull();
  });
});
