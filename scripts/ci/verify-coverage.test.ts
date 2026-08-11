import { describe, expect, it } from "vitest";
import { coveragePolicyFailures } from "./verify-coverage.ts";

const thresholds = { statements: 80, branches: 70, functions: 85, lines: 80 };

function file(covered: number, total = 10) {
  return {
    statements: { covered, total },
    branches: { covered, total },
    functions: { covered, total },
    lines: { covered, total },
  };
}

describe("merged coverage policy", () => {
  it("aggregates scoped files before checking thresholds", () => {
    const failures = coveragePolicyFailures(
      {
        total: file(9),
        "/repo/packages/example/a.ts": file(10),
        "/repo/packages/example/b.ts": file(7),
      },
      "/repo",
      {
        global: thresholds,
        groups: [
          {
            glob: "packages/example/**.ts",
            matches: (path) => path.startsWith("packages/example/"),
            thresholds,
          },
        ],
      },
    );
    expect(failures).toEqual([]);
  });

  it("fails closed on missing groups and under-threshold totals", () => {
    const failures = coveragePolicyFailures({ total: file(7) }, "/repo", {
      global: thresholds,
      groups: [
        {
          glob: "workers/example.ts",
          matches: (path) => path === "workers/example.ts",
          thresholds,
        },
      ],
    });
    expect(failures).toContain("total statements: 70.00% < 80%");
    expect(failures).toContain(
      "workers/example.ts: no coverage files matched.",
    );
  });
});
