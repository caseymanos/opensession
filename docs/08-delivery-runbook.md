# Delivery and infrastructure runbook

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

Environment-specific account state, resource identifiers, sender inventory, and verification evidence belong in the private release system or short-lived CI artifacts. They must not be copied into the public repository. The committed Wrangler file contains safe names, the client-visible Turnstile site key, and placeholders for private account-specific resource identifiers. Supply remote Airtable base IDs through `AIRTABLE_PREVIEW_BASE_ID` or `AIRTABLE_PRODUCTION_BASE_ID` when running the provisioner. `TURNSTILE_PREVIEW_SITE_KEY` and `TURNSTILE_PRODUCTION_SITE_KEY` remain optional public-value overrides for a coordinated widget rotation.

## Resource inventory target

Expected production resource names:

- D1: `sessionbox-killer-prod`
- R2 private bucket: `sessionbox-killer-uploads-prod`
- Queues: `email-send-prod`, `email-send-prod-dlq`, `projection-repair-prod`, `webhook-delivery-prod`, and `integration-export-prod`
- Worker/static assets: `sessionbox-killer-prod`
- Analytics Engine: `sessionbox_killer_observability_production`
- Workflows: reminders, decisions, calendar, Accelevents export, reconciliation, demo reset
- Durable Object namespaces/migrations: per-event conflict coordinator and per-base Airtable authority gate
- Queue producers/consumers and Cron triggers
- KV only if a specific cache/config need survives design review; do not add redundant storage.

Expected preview resource names:

- Worker/static assets: `sessionbox-killer-preview`
- Analytics Engine: `sessionbox_killer_observability_preview` (created on first data point)
- D1: `sessionbox-killer-preview`
- R2 private bucket: `sessionbox-killer-uploads-preview`
- Queues: `email-send-preview`, `email-send-preview-dlq`, `projection-repair-preview`, `webhook-delivery-preview`, `integration-export-preview`
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

`EMAIL_DELIVERY_CONFIG` is validated at startup. Local is restricted to `sink`; preview is restricted to `allowlist`; the committed production default is also an empty allowlist with the email feature disabled. The email Queue consumer uses batches of 10, a five-second batch timeout, five Queue retries, 30-second retry delay, maximum concurrency 5, and an environment-specific dead-letter queue. Application provider attempts are separately bounded at five and use the same Resend idempotency key on every attempt.

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
pnpm exec wrangler d1 migrations list DB --remote --env preview --config workers/app/wrangler.jsonc
pnpm cloudflare:smoke:preview        # read-only live/ready/shell release contract
pnpm cloudflare:deploy:preview       # build, drift check, migrate, deploy, smoke
pnpm cloudflare:public-performance:preview -- --event-slug <SLUG> --seed <SEED_ID>
pnpm cloudflare:rollback:preview -- --version-id <VERSION_ID>
```

Preview deployment validates the shell, liveness, environment identity, and binding readiness. After resource drift checks and before publishing the Worker version, it applies pending forward-only D1 migrations through the rendered ID-complete Wrangler config; Wrangler captures a backup per migration and rolls back a migration that fails. An additive migration can remain after a later Worker deployment or smoke failure, so every migration must be backward-compatible with the previous Worker. The same synthetic smoke is available independently to an operator and returns safe request IDs for log correlation after the observability-enabled Worker is deployed. A successful deploy records the active and previous Worker version in the ignored environment inventory. The public performance capture independently reads Cloudflare deployment state before and after its requests, rejects stale inventory, split deployments, and concurrent version changes, and only then emits build-attributed evidence. Rollback requires an explicit version from recent deployment history, rejects gradual/split deployments, verifies Cloudflare activated the requested version, and repeats the release smoke; it never reverses D1. Production apply, deploy, and rollback calls are denied unless both a CLI flag and an explicit environment confirmation are present. The base authority class uses Wrangler's declarative SQLite Durable Object lifecycle and is created when that Worker configuration deploys. A daily `03:17 UTC` Cron Trigger runs bounded operational-event retention cleanup. Workflows and the event conflict object remain gated on their executable tickets.

The public performance capture must run immediately after a deployment with `cross_version_cache` disabled and before another request warms the selected public projection. It requires a named, representative published seed; proves the first request is `MISS`, every warm sample is `HIT`, the ETag stays stable, a conditional request is a bodyless cached `304`, and warm p95 TTFB remains within 200 ms. The JSON output records the public URL, active Worker version, seed identifier, colo, cache-status counts, and timings without retaining full `CF-Ray` request identifiers.

Before enabling live email, configure the Resend webhook target as `https://<production-origin>/api/webhooks/resend`, store its `whsec_…` value as `RESEND_WEBHOOK_SECRET`, and prove one allowlisted magic link plus one allowlisted campaign through send, provider callback, and inbox receipt. Confirm that the callback event is deduplicated, a test complaint/bounce suppresses the recipient, the DLQ exists, and no telemetry row contains an address, rendered body, or portal token. Only then change production delivery mode to `live` and enable the email feature in an immutable reviewed deployment.

The committed production sender is `OpenSession <auth@updates.opensessionboard.com>` on the verified, sending-only Resend subdomain. This source configuration is not delivery approval: the email feature remains off and the production allowlist remains empty. Before deploying it, prove `hello@opensessionboard.com` reaches the monitored human mailbox, retain that reply-to, and confirm the generated Wrangler binding types match. Deploy only in feature-off, empty-allowlist mode, then run the signed callback and allowlisted inbox gates against that exact deployment before proposing live mode.

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
