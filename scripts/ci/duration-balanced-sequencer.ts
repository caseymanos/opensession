import { relative } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";

export const testDurationWeights: Readonly<Record<string, number>> = {
  "scripts/d1/schema.test.ts": 132,
  "workers/app/test/authority-completion.test.ts": 121,
  "workers/app/test/base-authority.test.ts": 44,
  "workers/app/test/agenda-coordinator-workerd.test.ts": 17,
  "workers/app/test/organizer-submissions-runtime.test.ts": 14,
  "scripts/cloudflare/demo-bootstrap.test.ts": 12,
  "workers/app/test/cfp-submission-authority.test.ts": 12,
  "workers/app/test/auth-runtime.test.ts": 8,
  "workers/app/test/email-delivery.test.ts": 7,
  "workers/app/test/campaign-service-workerd.test.ts": 6,
};

export function balanceTestFiles(
  paths: readonly string[],
  shardCount: number,
  weights: Readonly<Record<string, number>> = testDurationWeights,
): string[][] {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new TypeError("Shard count must be a positive integer.");
  }
  const shards = Array.from({ length: shardCount }, () => ({
    paths: [] as string[],
    weight: 0,
  }));
  const sorted = [...paths].sort((left, right) => {
    const weightDifference = (weights[right] ?? 1) - (weights[left] ?? 1);
    return weightDifference || left.localeCompare(right, "en-US");
  });
  for (const path of sorted) {
    const target = shards.reduce((best, shard) =>
      shard.weight < best.weight ? shard : best,
    );
    target.paths.push(path);
    target.weight += weights[path] ?? 1;
  }
  return shards.map(({ paths: shardPaths }) => shardPaths.sort());
}

export default class DurationBalancedSequencer extends BaseSequencer {
  override async shard(
    files: TestSpecification[],
  ): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard;
    if (!shard) return files;
    const specifications = new Map(
      files.map((specification) => [
        relative(this.ctx.config.root, specification.moduleId).replaceAll(
          "\\",
          "/",
        ),
        specification,
      ]),
    );
    const paths = balanceTestFiles([...specifications.keys()], shard.count)[
      shard.index - 1
    ];
    if (!paths)
      throw new RangeError("Shard index is outside the configured range.");
    return paths.map((path) => {
      const specification = specifications.get(path);
      if (!specification)
        throw new Error(`Missing test specification for ${path}.`);
      return specification;
    });
  }
}
