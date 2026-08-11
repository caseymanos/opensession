import { readFile } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { pathToFileURL } from "node:url";
import {
  coverageMetrics,
  globalCoverageThresholds,
  groupedCoverageThresholds,
  type CoverageMetric,
  type CoverageThresholds,
} from "./coverage-policy.ts";

interface MetricSummary {
  covered: number;
  total: number;
}
type FileSummary = Record<CoverageMetric, MetricSummary>;
type CoverageSummary = Record<string, FileSummary>;

interface CoverageGroup {
  glob: string;
  matches: (path: string) => boolean;
  thresholds: CoverageThresholds;
}

interface CoveragePolicy {
  global: CoverageThresholds;
  groups: readonly CoverageGroup[];
}

const defaultPolicy: CoveragePolicy = {
  global: globalCoverageThresholds,
  groups: groupedCoverageThresholds,
};

function percentage(summary: MetricSummary): number {
  return summary.total === 0 ? 100 : (summary.covered / summary.total) * 100;
}

function normalizedPath(path: string, root: string): string {
  return (isAbsolute(path) ? relative(root, path) : path).replaceAll("\\", "/");
}

function aggregate(files: FileSummary[]): FileSummary {
  return Object.fromEntries(
    coverageMetrics.map((metric) => [
      metric,
      files.reduce(
        (result, file) => ({
          covered: result.covered + file[metric].covered,
          total: result.total + file[metric].total,
        }),
        { covered: 0, total: 0 },
      ),
    ]),
  ) as FileSummary;
}

function thresholdFailures(
  label: string,
  summary: FileSummary,
  thresholds: CoverageThresholds,
): string[] {
  return coverageMetrics.flatMap((metric) => {
    const actual = percentage(summary[metric]);
    const required = thresholds[metric];
    return actual + Number.EPSILON < required
      ? [`${label} ${metric}: ${actual.toFixed(2)}% < ${required}%`]
      : [];
  });
}

export function coveragePolicyFailures(
  summary: CoverageSummary,
  root = process.cwd(),
  policy: CoveragePolicy = defaultPolicy,
): string[] {
  if (!summary.total) return ["Coverage summary is missing its total."];
  const files = Object.entries(summary)
    .filter(([path]) => path !== "total")
    .map(([path, file]) => ({ file, path: normalizedPath(path, root) }));
  const failures = thresholdFailures("total", summary.total, policy.global);
  for (const group of policy.groups) {
    const matches = files.filter(({ path }) => group.matches(path));
    if (matches.length === 0) {
      failures.push(`${group.glob}: no coverage files matched.`);
      continue;
    }
    failures.push(
      ...thresholdFailures(
        group.glob,
        aggregate(matches.map(({ file }) => file)),
        group.thresholds,
      ),
    );
  }
  return failures;
}

async function main(): Promise<void> {
  const [summaryPath] = process.argv.slice(2);
  if (!summaryPath) throw new TypeError("Expected a coverage summary path.");
  const summary = JSON.parse(
    await readFile(summaryPath, "utf8"),
  ) as CoverageSummary;
  const failures = coveragePolicyFailures(summary);
  if (failures.length > 0) {
    throw new Error(`Coverage policy failed:\n${failures.join("\n")}`);
  }
  console.log("Coverage policy passed with all global and scoped thresholds.");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
