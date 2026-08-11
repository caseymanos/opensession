import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  balanceTestFiles,
  testDurationWeights,
} from "./duration-balanced-sequencer.ts";

describe("duration-balanced test sharding", () => {
  it("keeps every test in exactly one deterministic shard", () => {
    const paths = [
      "scripts/d1/schema.test.ts",
      "workers/app/test/authority-completion.test.ts",
      "workers/app/test/base-authority.test.ts",
      ...Array.from({ length: 12 }, (_, index) => `test-${index}.test.ts`),
    ];
    for (const shardCount of [3, 4]) {
      const first = balanceTestFiles(paths, shardCount);
      const second = balanceTestFiles(paths, shardCount);
      expect(second).toEqual(first);
      expect(first.flat().sort()).toEqual([...paths].sort());
      expect(new Set(first.flat()).size).toBe(paths.length);
      expect(
        first.filter((shard) => shard.includes("scripts/d1/schema.test.ts")),
      ).toHaveLength(1);
      expect(
        first.filter((shard) =>
          shard.includes("workers/app/test/authority-completion.test.ts"),
        ),
      ).toHaveLength(1);
    }
  });

  it("keeps measured test paths anchored to real files", () => {
    expect(
      Object.keys(testDurationWeights).every((path) => existsSync(path)),
    ).toBe(true);
  });
});
