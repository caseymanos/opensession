import { describe, expect, it } from "vitest";

import { isEnvironment } from "./index";

describe("isEnvironment", () => {
  it.each(["local", "preview", "production"])("accepts %s", (value) => {
    expect(isEnvironment(value)).toBe(true);
  });

  it("rejects unknown environment names", () => {
    expect(isEnvironment("staging")).toBe(false);
  });
});
