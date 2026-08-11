# Scale and resilience acceptance

RAL-80 is enforced by deterministic local Workerd/D1 and Chromium gates. The
live production cache/deployment receipt remains in Linear because it contains
release-state identifiers; no production mutation is required to run these
checks.

## Scale and budget receipt

`workers/app/test/scale-resilience.test.ts` applies the full D1 migration
chain and seeds one event with exactly:

- 500 submissions;
- 1,000 contacts and event speaker memberships;
- 250 scheduled sessions across 10 rooms and 10 tracks (100 combinations);
- 5,000 task assignments.

After one warmup it takes 20 samples of the actual organizer submission,
readiness, and public API repositories. Common reads must remain at or below
500 ms p95. The full readiness aggregation has a separate 750 ms local runaway
guard because the runbook's organizer user-facing gate is LCP, not server
duration. The same receipt verifies the 170 KiB gzip public and 300 KiB gzip
organizer JavaScript graphs and records the build, local URL, seed, sample
conditions, p95 values, and D1 query plans.

`tests/e2e/performance-budgets.spec.ts` takes five LCP samples in the existing
production bundle/browser harness. Mobile public schedule p75 must be at or
below 2.0 seconds and desktop organizer p75 at or below 2.5 seconds. Each test
attaches a JSON receipt to the protected browser report.

Run the focused gates with:

```bash
pnpm build:web
pnpm exec vitest run --config vitest.config.ts \
  workers/app/test/scale-resilience.test.ts
pnpm exec playwright test --config tests/e2e/playwright.config.ts \
  tests/e2e/performance-budgets.spec.ts
```

## Resilience assertion map

| RAL-80 criterion | Executable assertion |
|---|---|
| Airtable five requests/second | `AirtableRateLimiter` starts concurrent calls at 0, 200, and 400 ms. |
| Airtable pressure/backoff | `AirtableClient` honors a 429 and applies the documented minimum 30-second cooldown before retry. |
| Projection failure/repair | The AgendaCoordinator Workerd suite injects a D1 projection abort after the authority mutation, retains the prior visible version, emits no premature broadcast, repairs after object eviction, and makes replay side-effect free. |
| Queue backlog/poison | The campaign queue suite corrupts the first persisted envelope, proves it is failed and scrubbed, and drains the valid later envelope. |
| Workflow resume | The RAL-80 harness proves a durable wait re-enters the next named step with the bounded exponential retry policy; the task reminder suite separately proves current-state re-query, one send, restart idempotency, and a persisted retry checkpoint. |
| Concurrent agenda writes | The AgendaCoordinator suite proves one version winner under conflicting writes and a side-effect-free stale loser. |
| Publish during mutation | The AgendaCoordinator suite races publication with a move and proves one winner plus exactly one complete command receipt. |
| Cache hit/invalidation | The release capture proves cold MISS, repeated HIT, stable ETag, and bodyless 304. The cache contract purges only a valid committed generation; agenda repair and replay do not invalidate or broadcast early. |
| D1 plans | The scale receipt records indexed submission plans and the bounded 5,000-row task plan together with achieved p95. |

These tests run inside the existing protected unit and browser matrices, so a
budget, cardinality, plan, resume, poison, repair, cache, or concurrency
regression fails the release candidate without a separate mutable environment.
