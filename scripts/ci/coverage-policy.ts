export const coverageMetrics = [
  "statements",
  "branches",
  "functions",
  "lines",
] as const;

export type CoverageMetric = (typeof coverageMetrics)[number];
export type CoverageThresholds = Record<CoverageMetric, number>;

export const globalCoverageThresholds: CoverageThresholds = {
  statements: 60,
  branches: 54,
  functions: 67,
  lines: 60,
};

export const groupedCoverageThresholds = [
  {
    glob: "packages/data/src/airtable/**.ts",
    matches: (path: string) => path.startsWith("packages/data/src/airtable/"),
    thresholds: { statements: 80, branches: 70, functions: 85, lines: 80 },
  },
  {
    glob: "packages/email/src/**.ts",
    matches: (path: string) => path.startsWith("packages/email/src/"),
    thresholds: { statements: 82, branches: 78, functions: 95, lines: 82 },
  },
  {
    glob: "packages/calendar/src/**.ts",
    matches: (path: string) => path.startsWith("packages/calendar/src/"),
    thresholds: { statements: 85, branches: 77, functions: 95, lines: 85 },
  },
  {
    glob: "workers/app/src/auth/crypto.ts",
    matches: (path: string) => path === "workers/app/src/auth/crypto.ts",
    thresholds: { statements: 100, branches: 80, functions: 100, lines: 100 },
  },
  {
    glob: "workers/app/src/email/{delivery,messages,webhook}.ts",
    matches: (path: string) =>
      [
        "workers/app/src/email/delivery.ts",
        "workers/app/src/email/messages.ts",
        "workers/app/src/email/webhook.ts",
      ].includes(path),
    thresholds: { statements: 75, branches: 70, functions: 65, lines: 75 },
  },
  {
    glob: "workers/app/src/calendar/outbox.ts",
    matches: (path: string) => path === "workers/app/src/calendar/outbox.ts",
    thresholds: { statements: 85, branches: 75, functions: 90, lines: 85 },
  },
  {
    glob: "workers/app/src/observability.ts",
    matches: (path: string) => path === "workers/app/src/observability.ts",
    thresholds: { statements: 85, branches: 80, functions: 95, lines: 85 },
  },
  {
    glob: "workers/app/src/public-schedule/cache.ts",
    matches: (path: string) =>
      path === "workers/app/src/public-schedule/cache.ts",
    thresholds: { statements: 90, branches: 80, functions: 95, lines: 90 },
  },
  {
    glob: "workers/app/src/uploads/policy.ts",
    matches: (path: string) => path === "workers/app/src/uploads/policy.ts",
    thresholds: { statements: 85, branches: 80, functions: 70, lines: 85 },
  },
  {
    glob: "scripts/cloudflare/release.ts",
    matches: (path: string) => path === "scripts/cloudflare/release.ts",
    thresholds: { statements: 75, branches: 70, functions: 95, lines: 75 },
  },
] as const;

export const vitestCoverageThresholds = Object.fromEntries([
  ...Object.entries(globalCoverageThresholds),
  ...groupedCoverageThresholds.map(({ glob, thresholds }) => [
    glob,
    thresholds,
  ]),
]);
