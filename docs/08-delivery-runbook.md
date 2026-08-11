# Delivery and infrastructure runbook

Status at 2026-08-11: the public source and production shell/API documentation are online; release acceptance remains in progress until the deadline gates complete. This runbook is the guarded release authority. Fresh-clone and self-hosting steps are consolidated in [`docs/19-open-source-operator-guide.md`](./19-open-source-operator-guide.md).

## Deadline and operating cadence

- Hard submission cutoff: **2026-08-12 22:00 America/Los_Angeles** (`2026-08-13T05:00:00Z`).
- Internal feature freeze: 2026-08-12 12:00 PT.
- Release candidate: 2026-08-12 17:00 PT.
- Submission evidence/archive complete: 2026-08-12 20:00 PT.
- Remaining two hours are rollback/repair buffer, never planned feature time.

## Environments

| Environment | Purpose | Email | Data | Reset |
|---|---|---|---|---|
| local | development/unit/E2E | sink | local fixture adapter + local D1/R2 | yes |
| preview | integration/PR/demo rehearsal | allowlist | isolated Airtable base + CF resources | demo event only |
| production | judge/public | allowlist + feature off until release gate | production Airtable base + CF resources | guarded demo event only |

No environment shares secrets, Airtable base, D1 database, R2 bucket, queue, or workflow instance names.

## Credentials/configuration required from the owner

Cloudflare provisioning can begin after the owner supplies or authorizes:

- Cloudflare account ID;
- API token scoped to Workers Scripts, D1, R2, Queues, Workflows, and zone/DNS only if custom-domain automation is desired;
- chosen `workers.dev`/custom domain and production Worker name;
- Airtable production and preview base IDs plus least-privilege PATs;
- Resend API key, verified sending domain/default sender, and webhook secret;
- optional Accelevents disposable event ID/URL and API key;
- optional AI provider key only after firm requirements are green.

Prefer `wrangler login` for a user-supervised local session; otherwise pass a scoped token through the environment and immediately store application secrets with `wrangler secret put`. Never paste secrets into Linear, docs, command output, or committed files.

Environment-specific account state, resource identifiers, sender inventory, approved recipient addresses, and verification evidence belong in the private release system or short-lived CI artifacts. They must not be copied into the public repository. The committed Wrangler file contains safe names, the client-visible Turnstile site key, and placeholders for private account-specific resource identifiers. Supply remote Airtable base IDs through `AIRTABLE_PREVIEW_BASE_ID` or `AIRTABLE_PRODUCTION_BASE_ID` when running the provisioner. `TURNSTILE_PREVIEW_SITE_KEY` and `TURNSTILE_PRODUCTION_SITE_KEY` remain optional public-value overrides for a coordinated widget rotation.

## Resource inventory target

Expected production resource names:

- D1: `sessionbox-killer-prod`
- R2 private bucket: `sessionbox-killer-uploads-prod`
- Queues: `email-send-prod`, `email-send-prod-dlq`, `projection-repair-prod`, `projection-repair-prod-dlq`, `webhook-delivery-prod`, and `integration-export-prod`
- Worker/static assets: `sessionbox-killer-prod`
- Analytics Engine: `sessionbox_killer_observability_production`
- Workflows: `task-reminder-production`; other orchestration uses implemented D1/Durable Object/Queue boundaries, and Accelevents remains gated
- Durable Object namespaces/migrations: per-event conflict coordinator and per-base Airtable authority gate
- Queue producers/consumers and Cron triggers
- KV only if a specific cache/config need survives design review; do not add redundant storage.

Expected preview resource names:

- Worker/static assets: `sessionbox-killer-preview`
- Analytics Engine: `sessionbox_killer_observability_preview` (created on first data point)
- D1: `sessionbox-killer-preview`
- R2 private bucket: `sessionbox-killer-uploads-preview`
- Queues: `email-send-preview`, `email-send-preview-dlq`, `projection-repair-preview`, `projection-repair-preview-dlq`, `webhook-delivery-preview`, `integration-export-preview`
- Custom domain: `preview.opensessionboard.com`

Reserved production custom domains (attached only by a production-gated deploy):

- `opensessionboard.com`
- `www.opensessionboard.com`

Exact generated IDs are recorded in an ignored, owner-readable deployment inventory and the Cloudflare dashboard, never guessed in source.

## Configuration contract

Commit binding names and safe variables in `wrangler.jsonc`; use `.dev.vars` locally and Wrangler secrets remotely.

`workers/app/wrangler.jsonc` is the source of truth for Worker settings and bindings. This follows Cloudflare's recommendation for new projects; YAML is not a Wrangler configuration format. The Cloudflare orchestration CLI remains code because it must query remote inventory, create only missing resources, resolve generated D1 IDs, enforce two-part production confirmation, deploy, and smoke-test. It is compiled from strict TypeScript before execution and its emitted JavaScript is ignored under `.cloudflare/`.

Remote plans fail before account access when `AIRTABLE_BASE_ID` is missing, malformed, or still a `CONFIGURE` placeholder. They also reject missing or placeholder Turnstile site keys and every [Cloudflare-documented test site key](https://developers.cloudflare.com/turnstile/troubleshooting/testing/); Cloudflare explicitly warns that test credentials must never reach production. Preview and production base IDs are injected only into the ignored rendered deployment config. The client-visible Turnstile site key is committed per environment and may be overridden during a coordinated widget rotation. PATs and the Turnstile secret remain outside source control, and these public configuration values do not authorize deployment, migration, secret installation, or route attachment.

For example, supply the preview identifier only for the process that needs it:

```bash
AIRTABLE_PREVIEW_BASE_ID=app_REPLACE_ME \
pnpm cloudflare:plan

AIRTABLE_PRODUCTION_BASE_ID=app_REPLACE_ME \
pnpm cloudflare:run plan --environment production
```

This CLI is release orchestration, not a general-purpose replacement for infrastructure as code. If the account surface grows beyond the application-owned Worker, D1, R2, Queues, Workflows, and Durable Object bindings, move durable resource lifecycle to the official Cloudflare Terraform provider (or Pulumi when TypeScript ownership is materially more valuable), retain `wrangler.jsonc` for Worker configuration, and keep build/deploy/smoke behavior in the TypeScript release CLI. Do not introduce a second YAML resource manifest that can drift from Wrangler.

Required secret names:

```text
AIRTABLE_PAT
RESEND_API_KEY
RESEND_WEBHOOK_SECRET
AUTH_HASH_PEPPER
WEBHOOK_SECRET_ENCRYPTION_KEY
TURNSTILE_SECRET
ACCELEVENTS_API_KEY          # optional/gated
AI_PROVIDER_API_KEY          # optional/gated
```

Required non-secret vars/bindings include environment, canonical origin, Airtable base ID, from/reply-to, event/demo ID, Turnstile site key and comma-separated hostname allowlist, feature flags, and every Cloudflare resource binding.

Turnstile is fail-closed outside local development. Create the production widget with an account-scoped API token that has `Account.Turnstile:Edit`; never commit or paste that token into an issue or terminal transcript. Allow `preview.opensessionboard.com`, `opensessionboard.com`, and `www.opensessionboard.com`, set the resulting public site key in each environment, and install the widget secret as `TURNSTILE_SECRET`. Local development uses Cloudflare's documented always-pass test site key; the corresponding test secret can be placed in `.dev.vars` when exercising live Siteverify. The server independently verifies the expected action (`sign_in`, `cfp_account`, or `cfp_submit`) and hostname for every token.

`EMAIL_DELIVERY_CONFIG` is validated at startup. Local is restricted to `sink`; preview is restricted to `allowlist`; the committed production default is also an empty allowlist with the email feature disabled. The public source for both remote environments remains feature-off with an empty allowlist. For an approved preview release only, pass exactly one recipient through the process-scoped `EMAIL_PREVIEW_RECIPIENT`. For an approved production acceptance release only, pass one to six unique recipients through the comma-separated `EMAIL_PRODUCTION_RECIPIENTS`; this input is accepted only by a production deploy carrying both production confirmations. The bound covers two approved inboxes plus the provider-owned targets needed for the [documented Resend delivery and suppression tests](https://resend.com/docs/knowledge-base/what-email-addresses-to-use-for-testing) without authorizing a general mailing list. The provisioner normalizes and validates every address, requires the exact verified sender and monitored reply-to plus the safe committed baseline, keeps delivery in allowlist mode, and enables email only in the ignored mode-`0600` rendered config. Use only the direct private-deploy launcher for either recipient input: it removes both values from the web and operator build environments, then passes them only to the freshly compiled provisioner. The provisioner removes them again from every Wrangler child, disables Wrangler's global disk log for those child processes, and suppresses every address plus the delivery binding from operator output. Never prefix a `pnpm cloudflare:run` or `pnpm cloudflare:deploy:preview` invocation with a private recipient variable, and never copy a recipient into source or release evidence. The email Queue consumer uses batches of 10, a five-second batch timeout, five Queue retries, 30-second retry delay, maximum concurrency 5, and an environment-specific dead-letter queue. Application provider attempts are separately bounded at five and use the same Resend idempotency key on every attempt.

## Bootstrap sequence

1. Pin Node/pnpm versions; install from lockfile.
2. Run formatting, typecheck, lint, unit and contract tests.
3. Authenticate Wrangler and confirm the selected account without printing credentials.
4. Create preview resources, write binding IDs, run D1 migrations, configure secrets.
5. Validate/bootstrap preview Airtable schema and seed demo event.
6. Deploy preview; run synthetic and Playwright judge paths.
7. Repeat with production names/base only after preview gates pass.
8. Verify custom-domain certificates, configure the Resend webhook, and enable Cloudflare queue/workflow triggers.
9. Run production migrations with backup/rollback notes, deploy immutable build, seed guarded demo.
10. Verify observability, cache, public API/docs, email/calendar, uploaded file auth, and reset guard.

All provision commands must be captured in package scripts or `scripts/provision-*` with dry-run/status modes so setup is repeatable. Do not provision until the owner selects the Cloudflare account/project.

Current preview workflow:

```bash
pnpm cloudflare:plan                 # read-only desired/remote diff
pnpm cloudflare:provision:preview    # idempotent create-if-missing apply
pnpm cloudflare:status               # read-only account and inventory check
pnpm exec wrangler d1 migrations list DB --remote --config .cloudflare/wrangler.preview.json
pnpm cloudflare:smoke:preview        # read-only live/ready/shell release contract
pnpm cloudflare:deploy:preview       # build, drift check, migrate, deploy, smoke
pnpm cloudflare:public-performance:preview -- --event-slug <SLUG> --seed <SEED_ID>
pnpm cloudflare:rollback:preview -- --version-id <VERSION_ID>
```

The deterministic demo bootstrap is a separate operator-only release step. Run it only after the complete forward migration chain through `0025_task_reminder_workflows.sql`, Airtable schema v10, and the same immutable Worker SHA are active. It refuses a foreign or duplicate Airtable root, writes the two canonical roots through `AirtableCommandStore`, registers the exact base and source-record lineage with readiness unset, synchronizes through `BaseAuthority`, and only then applies and verifies the digest-bound 139-operation snapshot plus four private assets. It does not expose a public bootstrap screen or accept an arbitrary event.

Supply the base, runtime PAT, and owner address only to the process. The raw owner address is stored only in the intended private D1 user identity row so normal sign-in can resolve the operational owner; it never enters the fixture, Git, logs, pull requests, Linear, or Wrangler's child environment. The raw one-time authorization token exists only in ignored mode-`0600` resume state, while D1 retains only its SHA-256 hash and immutable environment/base/operation scope. All three process-private values are filtered from Wrangler's child environment and output:

```bash
AIRTABLE_PREVIEW_BASE_ID=app_REPLACE_ME \
AIRTABLE_PAT=pat_REPLACE_ME \
DEMO_OWNER_EMAIL=owner@example.test \
pnpm cloudflare:demo:bootstrap --environment preview
```

An interrupted run reuses the same durable operation and private token. The CLI renews only an exact expired pending/leased authorization, verifies that D1 changed one matching row, and accepts a completed operation only as a zero-mutation stored-result replay. A permanent fail-closed conflict requires the operator to correct the authoritative cause and explicitly pass `--restart-failed`; it never chooses a new tenant, base, root, or snapshot. Production additionally requires `--confirm-production` and `DEMO_PRODUCTION_CONFIRM=production`.

Normal demo reset is not an operator endpoint. The workspace calls the authenticated event reset route with same-origin JSON, the current CSRF token, a stable idempotency key, and the exact displayed confirmation phrase. The server independently requires an active owner with `organization:manage`, the compiled organization/event pair, ready D1 lineage, and authoritative Airtable `Is demo=true`; it rate-limits the event, identity, and IP before invoking the idempotent snapshot replacement.

The approved preview deploy is supplied only to that process and never copied into source, evidence, or logs:

```bash
AIRTABLE_PREVIEW_BASE_ID=app_REPLACE_ME \
EMAIL_PREVIEW_RECIPIENT=approved-recipient@example.test \
node scripts/cloudflare/private-deploy.mjs \
  --build-web deploy \
  --environment preview
```

The production acceptance renderer uses the same private boundary and additionally requires both production confirmations. Recipient approval, provider readiness, and the exact immutable SHA remain separate release gates:

```bash
AIRTABLE_PRODUCTION_BASE_ID=app_REPLACE_ME \
EMAIL_PRODUCTION_RECIPIENTS=owner@example.test,reviewer@example.test \
CLOUDFLARE_PRODUCTION_CONFIRM=production \
node scripts/cloudflare/private-deploy.mjs \
  --build-web deploy \
  --environment production \
  --confirm-production
```

The app-backed provider acceptance seam is intentionally narrower than normal campaign writes. It accepts only an authenticated organization owner, same-origin CSRF, the exact four provider-owned Resend test recipients, production allowlist mode, and the acceptance feature shape (`email=true` with AI, embeds, integrations, webhooks, and writes all false). `POST /api/events/:eventKey/campaigns/provider-acceptance` accepts only a stable `ral59_…` command ID and an `initial` or `subsequent` phase. The initial phase durably enqueues the four official delivery outcomes against the seeded acceptance campaign; after provider callbacks have persisted suppressions, the subsequent phase proves three later attempts stop inside the application. Responses contain message IDs and outcomes but no address or rendered body. The route is inert after the immediate empty-allowlist relock.

Preview deployment validates the shell, liveness, environment identity, and binding readiness. After resource drift checks and before publishing the Worker version, it applies pending forward-only D1 migrations through the rendered ID-complete Wrangler config; Wrangler captures a backup per migration and rolls back a migration that fails. An additive migration can remain after a later Worker deployment or smoke failure, so every migration must be backward-compatible with the previous Worker. The same synthetic smoke is available independently to an operator and returns safe request IDs for log correlation after the observability-enabled Worker is deployed. A successful deploy records the active and previous Worker version in the ignored environment inventory. The public performance capture independently reads Cloudflare deployment state before and after its requests, rejects stale inventory, split deployments, and concurrent version changes, and only then emits build-attributed evidence. Rollback requires an explicit version from recent deployment history, rejects gradual/split deployments, verifies Cloudflare activated the requested version, and repeats the release smoke; it never reverses D1. Production apply, deploy, and rollback calls are denied unless both a CLI flag and an explicit environment confirmation are present. The base authority class uses Wrangler's declarative SQLite Durable Object lifecycle and is created when that Worker configuration deploys. A daily `03:17 UTC` Cron Trigger runs bounded operational-event retention cleanup. Workflows and the event conflict object remain gated on their executable tickets.

The public performance capture must run immediately after a deployment with `cross_version_cache` disabled and before another request warms the selected public projection. It requires a named, representative published seed; proves the first request is `MISS`, every warm sample is `HIT`, the ETag stays stable, a conditional request is a bodyless cached `304`, and warm p95 TTFB remains within 200 ms. The JSON output records the public URL, active Worker version, seed identifier, colo, cache-status counts, and timings without retaining full `CF-Ray` request identifiers.

Before enabling live email, configure the Resend webhook target as `https://<production-origin>/api/webhooks/resend`, store its `whsec_…` value as `RESEND_WEBHOOK_SECRET`, and prove one allowlisted magic link plus one allowlisted campaign through send, provider callback, and inbox receipt. Confirm that the callback event is deduplicated, a test complaint/bounce suppresses the recipient, the DLQ exists, and no telemetry row contains an address, rendered body, or portal token. Also prove the account-level foreign-event case: the signed event retries during the 15-minute provider-persistence grace, then returns `200` from its immutable digest-only quarantine receipt and does not create a provider message, suppression, or delivery event. The receipt's first-seen time is stable, payload drift fails closed, and the daily retention job plus ingress-assisted cleanup removes expired receipts after their 30-day retention. Only then change production delivery mode to `live` and enable the email feature in an immutable reviewed deployment.

Preview uses `OpenSession <auth@updates.opensessionboard.com>` on the same verified, sending-only Resend subdomain. Its committed configuration remains feature-off with an empty allowlist; a reviewed release may inject exactly one privately approved recipient through the guarded preview-only renderer above. Never place a real recipient in Git or substitute an unverified preview hostname in the sender address.

The committed production sender is `OpenSession <auth@updates.opensessionboard.com>` on the verified, sending-only Resend subdomain. This source configuration is not delivery approval: the email feature remains off and the production allowlist remains empty. Before deploying it, prove `hello@opensessionboard.com` reaches the monitored human mailbox, retain that reply-to, and confirm the generated Wrangler binding types match. First deploy in feature-off, empty-allowlist mode; only a separately approved acceptance deployment may inject the bounded private allowlist above. Run the signed callback, inbox, bounce, complaint, suppression, dedupe, and DLQ gates against that exact allowlisted deployment before proposing live mode.

For provider-key or webhook-secret rotation, first keep email disabled or pause the Queue consumer, create the replacement credential/endpoint, store it through Wrangler without printing it, deploy in empty-allowlist mode, and prove readiness plus a signed negative/positive callback. Revoke the prior credential only after the replacement proof. A future zero-downtime webhook-secret rotation requires an explicitly bounded dual-secret verification window; do not silently accept two secrets indefinitely. During a Resend outage, retain durable messages for bounded retry/DLQ inspection, pause the consumer when failures are systemic, and communicate degraded email status. Never bypass recipient authorization, switch production to sink while claiming delivery, or introduce an unreviewed provider mid-incident.

## CI pipeline

Required checks for main and release candidate:

1. dependency install from immutable lockfile;
2. formatting, lint, TypeScript strict typecheck;
3. unit/property tests with coverage report;
4. API/OpenAPI schema drift and docs example checks;
5. D1 migration up/down-or-forward validation on a disposable DB;
6. Airtable/Accelevents contract tests against fixtures; live contract suite opt-in through secrets;
7. build and bundle-size budget;
8. Playwright critical paths on desktop/mobile plus axe;
9. secret scan, dependency audit, license inventory;
10. preview deploy and synthetic smoke.

The protected `Quality and build`, `Browser smoke`, and `Secret scan` names are stable fail-closed aggregate checks. Static/type/build work runs in parallel with four duration-balanced Vitest shards. The coverage aggregate merges the blob reports, regenerates JUnit/HTML/JSON evidence, and independently enforces the same global and path-scoped thresholds; a missing shard, missing scope, test failure, static failure, or threshold regression fails the aggregate. Browser coverage runs in two Playwright shards across the unchanged desktop/mobile projects, retries and Axe/overflow assertions, then merges one retained HTML report. CodeQL and secret scanning remain independent required checks.

The workflow accepts `pull_request`, `merge_group`, and `main` push events. A release merge must use the reviewed expected head on an unchanged base or a green merge-queue group. For an expected-head squash, verify the canonical merge has the expected sole parent and that its tree exactly equals the protected green head tree. That tree identity is the release gate; the duplicate `main` run is asynchronous integrity monitoring and does not hold the next repo-only branch. A parent/tree mismatch or a failed main integrity run freezes deployment and subsequent merges until diagnosed.

For local handoff, run focused affected tests plus format, lint, typecheck, public-surface, binding, dependency and production-build checks. Protected CI owns the complete coverage and browser matrices. Run the monolithic `pnpm test:coverage` and `pnpm test:e2e` commands locally only for cross-surface changes or harness diagnosis. To roll back CI sharding, restore the prior single-runner workflow and use those two monolithic commands; do not bypass the aggregate required checks or lower coverage, retry, browser-project or assertion policy.

Production deploy is a manual, named release job from a green immutable SHA.

## Release strategy and rollback

- D1 migrations are forward-compatible: expand → deploy/read both if needed → contract later.
- Airtable changes are additive during competition; never rename/delete production fields inside the launch window.
- Worker deployment rollback uses the last known-good Cloudflare version.
- Worker rollback changes code and Worker configuration only. It does not reverse D1 migrations, R2 objects, Queue contents, or other storage state; forward-compatible data changes and backups remain mandatory.
- Run `pnpm cloudflare:status` to read the active and recorded rollback version. Use `pnpm cloudflare:rollback:preview -- --version-id <VERSION_ID>` only after confirming that target against the release record. The equivalent lower-level production command additionally requires `--confirm-production` and `CLOUDFLARE_PRODUCTION_CONFIRM=production`.
- Cloudflare can reject rollback when a bound resource was removed or a Durable Object class lifecycle changed. Never delete release resources during the rollback window, and treat Durable Object migrations as forward-only.
- Feature flags independently disable outbound email, Accelevents, webhooks, AI, embeds, and writes while retaining read access.
- Queue consumers can pause; poison messages go to dead-letter with safe replay.
- Before freeze, export Airtable schema/data snapshot and D1 backup; record timestamp and restore rehearsal result.
- Public cache key includes publication version so rollback can point to the prior consistent publication.

## Performance budgets

Measured on production-like preview with seeded data and cold/warm samples:

| Surface | Budget |
|---|---|
| Public schedule/gallery | p75 LCP ≤ 2.0 s mobile; INP ≤ 200 ms; CLS ≤ 0.1 |
| Organizer initial route | p75 LCP ≤ 2.5 s desktop |
| Cached public API | p95 TTFB ≤ 200 ms near edge |
| Common read API | p95 server duration ≤ 500 ms warm |
| Domain mutation excluding external async work | p95 ≤ 1.2 s |
| Agenda drag visual response | ≤ 100 ms; durable result visibly acknowledged |
| Initial public JS | ≤ 170 KiB gzip; organizer route ≤ 300 KiB gzip |

Record Lighthouse/WebPageTest artifacts for 360px mobile and desktop. Performance tests fail on regressions beyond budget, not on a single noisy sample.

## Operational checks

### Daily during build

- preview deploy and critical path;
- error/queue/workflow dashboard;
- Airtable projection reconciliation;
- unresolved hard conflicts and seed reset;
- scope/deadline/Discord update review.

### Pre-demo

- start from incognito and seeded URLs;
- request every role's magic link using judge-safe mailbox flow;
- confirm email and ICS arrival/import;
- upload/download private file and reject unauthorized URL;
- reset then complete the scripted path without admin repair;
- run a second reset with a new idempotency key and verify the same compiled digest/counts, then reload in a fresh browser session;
- test on slow mobile profile and keyboard only;
- record a backup walkthrough video.

## Open-source/repository setup

- MIT license, contribution/setup docs, architecture and source provenance.
- `.env.example` contains names and explanations only.
- No generated Cloudflare/Airtable IDs or real emails/keys in commits.
- Automated secret scan before every push and final source archive.
- Third-party screenshots/specifications stay in the private research workspace; implementation and copy are original.

## External blockers register

| Blocker | Owner action | Safe work before unblock | Decision deadline |
|---|---|---|---|
| Cloudflare custom domain/DNS | preview delegation, Custom Domain, TLS and DNSSEC are active and resolver-validated | preview `workers.dev` remains the fallback | complete |
| Airtable PAT/base IDs | create isolated production-only runtime/schema credentials and bootstrap the selected base | schema/fixture adapter/tests; preview remains unchanged | before production resource apply |
| Resend branded domain | complete: Pro is active and `updates.opensessionboard.com` is provider-verified for sending | committed sender stays feature-off with an empty allowlist until reply-route, callback, and inbox proof | complete |
| Accelevents credential/event | supply disposable entitled event | fixture adapter/dry-run/export contract | Aug 10; otherwise manual export |
| Discord updates | paste text/screenshots with timestamps | current brief remains authority | review daily |
