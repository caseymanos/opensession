import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { vitestCoverageThresholds } from "./scripts/ci/coverage-policy.ts";
import DurationBalancedSequencer from "./scripts/ci/duration-balanced-sequencer.ts";

const coverageReporters = process.env.CI_COVERAGE_SHARD
  ? (["json"] as const)
  : (["text", "json-summary", "json", "html"] as const);

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL(
          "./workers/app/test/fixtures/cloudflare-workers.ts",
          import.meta.url,
        ),
      ),
    },
  },
  test: {
    fileParallelism: false,
    hookTimeout: 30_000,
    sequence: { sequencer: DurationBalancedSequencer },
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: [
        "apps/web/src/demo/demoClient.ts",
        "apps/web/src/campaigns/{campaignClient,campaignRoute}.ts",
        "apps/web/src/email-templates/{emailTemplateClient,emailTemplateRoute}.ts",
        "packages/calendar/src/{canonical,invitation,render,time}.ts",
        "packages/contracts/src/{calendar,demo,index,portal,schedule,tasks}.ts",
        "packages/data/src/airtable/{client,command-store,config,demo-root,errors,rate-limiter,schema-definition,schema-manager}.ts",
        "packages/domain/src/{conflicts,demo,schedule,tasks}.ts",
        "packages/email/src/{campaign,campaign-contracts,contracts,identity,merge,preview,render,seeds,versioning}.ts",
        "scripts/cloudflare/{demo-bootstrap,provision,public-performance,release}.ts",
        "workers/app/src/auth/{authorization,crypto,http,routes,service}.ts",
        "workers/app/src/cfp/{policy,routes,submission-authority,submission-compiler}.ts",
        "workers/app/src/calendar/outbox.ts",
        "workers/app/src/campaigns/{repository,routes,service}.ts",
        "workers/app/src/demo/{bootstrap,compiler,reset,routes}.ts",
        "workers/app/src/email/{config,delivery,messages,provider,routes,webhook}.ts",
        "workers/app/src/email-templates/{repository,routes,service}.ts",
        "workers/app/src/public-schedule/{cache,projection}.ts",
        "workers/app/src/portal/{brand,routes,service}.ts",
        "workers/app/src/schedule/d1-repository.ts",
        "workers/app/src/tasks/{model,routes,service}.ts",
        "workers/app/src/uploads/{policy,pptx,routes,service}.ts",
        "workers/app/src/{features,observability}.ts",
      ],
      reporter: coverageReporters,
      reportOnFailure: true,
      ...(process.env.CI_COVERAGE_SHARD
        ? {}
        : { thresholds: vitestCoverageThresholds }),
    },
    include: [
      "apps/web/src/**/*.test.ts",
      "packages/**/*.test.ts",
      "scripts/**/*.test.ts",
      "workers/app/test/**/*.test.ts",
    ],
  },
});
