import { describe, expect, it } from "vitest";

import { workspaceEventSlug } from "./agendaRoute";

describe("agenda workspace routing", () => {
  it("extracts the event slug only from a canonical workspace agenda path", () => {
    expect(workspaceEventSlug("/app/ai-engineer-summit/agenda")).toBe(
      "ai-engineer-summit",
    );
    expect(workspaceEventSlug("/app/ai%2Deurope/agenda/")).toBe("ai-europe");
    expect(workspaceEventSlug("/fixtures/agenda/ready")).toBeNull();
    expect(workspaceEventSlug("/app/event/reviews")).toBeNull();
    expect(workspaceEventSlug("/app/%/agenda")).toBeNull();
  });
});
