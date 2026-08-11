import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

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
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: [
        "apps/web/src/demo/demoClient.ts",
        "apps/web/src/email-templates/{emailTemplateClient,emailTemplateRoute}.ts",
        "packages/calendar/src/{canonical,invitation,render,time}.ts",
        "packages/contracts/src/{calendar,demo,index,portal,schedule,tasks}.ts",
        "packages/data/src/airtable/{client,command-store,config,demo-root,errors,rate-limiter,schema-definition,schema-manager}.ts",
        "packages/domain/src/{conflicts,demo,schedule,tasks}.ts",
        "packages/email/src/{campaign,contracts,identity,merge,preview,render,seeds,versioning}.ts",
        "scripts/cloudflare/{demo-bootstrap,provision,public-performance,release}.ts",
        "workers/app/src/auth/{authorization,crypto,http,routes,service}.ts",
        "workers/app/src/cfp/{policy,routes,submission-authority,submission-compiler}.ts",
        "workers/app/src/calendar/outbox.ts",
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
      reporter: ["text", "json-summary", "json", "html"],
      reportOnFailure: true,
      thresholds: {
        statements: 60,
        branches: 54,
        functions: 67,
        lines: 60,
        "packages/data/src/airtable/**.ts": {
          statements: 80,
          branches: 70,
          functions: 85,
          lines: 80,
        },
        "packages/email/src/**.ts": {
          statements: 82,
          branches: 78,
          functions: 95,
          lines: 82,
        },
        "packages/calendar/src/**.ts": {
          statements: 85,
          branches: 77,
          functions: 95,
          lines: 85,
        },
        "workers/app/src/auth/crypto.ts": {
          statements: 100,
          branches: 80,
          functions: 100,
          lines: 100,
        },
        "workers/app/src/email/{delivery,messages,webhook}.ts": {
          statements: 75,
          branches: 70,
          functions: 65,
          lines: 75,
        },
        "workers/app/src/calendar/outbox.ts": {
          statements: 85,
          branches: 75,
          functions: 90,
          lines: 85,
        },
        "workers/app/src/observability.ts": {
          statements: 85,
          branches: 80,
          functions: 95,
          lines: 85,
        },
        "workers/app/src/public-schedule/cache.ts": {
          statements: 90,
          branches: 80,
          functions: 95,
          lines: 90,
        },
        "workers/app/src/uploads/policy.ts": {
          statements: 85,
          branches: 80,
          functions: 70,
          lines: 85,
        },
        "scripts/cloudflare/release.ts": {
          statements: 75,
          branches: 70,
          functions: 95,
          lines: 75,
        },
      },
    },
    include: [
      "apps/web/src/**/*.test.ts",
      "packages/**/*.test.ts",
      "scripts/**/*.test.ts",
      "workers/app/test/**/*.test.ts",
    ],
  },
});
