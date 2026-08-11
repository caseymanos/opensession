# Airtable operations

## Authority boundary

Airtable is the authoritative store for conference-program business data. D1 contains authentication, operations, audit, and read projections; it must not become an independent writer of Airtable-owned entities.

The expected schema is versioned in `packages/data/src/airtable/schema-definition.ts`. Version 10 contains all 31 authoritative tables from the data model, stable internal IDs, source versions, command IDs, UTC lifecycle timestamps, human-readable field types, and explicit linked-record targets. Its additive upgrades include durable CFP draft/routing metadata, structured email/template snapshots, schedule-domain fields, organizer notes, review operations/scores/decisions, reusable speaker profiles, and task-reminder lifecycle fields; applying them does not rewrite earlier records.

Schema bootstrap is non-destructive:

- missing tables and fields may be added;
- existing field types, link targets, primary fields, tables, and fields are never deleted or silently changed;
- incompatible drift stops bootstrap before the first write;
- organizer-added tables and fields are reported as warnings and retained.

## Preview credentials

Create an empty Airtable base named `OpenSession Preview`. Create personal access tokens whose resource access is limited to that base.

Recommended split:

| Variable | Scopes | Purpose |
|---|---|---|
| `AIRTABLE_PAT` | `data.records:read`, `data.records:write`, `schema.bases:read` | Worker runtime, schema resolution, and live read/write probe |
| `AIRTABLE_SCHEMA_PAT` | `schema.bases:read`, `schema.bases:write` | Operator-only table/field bootstrap |

The token owner needs Creator access for schema bootstrap and Editor access for record writes. A single preview-only token with all four scopes may be used during initial setup, then replaced by the split tokens. Production must use different tokens and a different base.

Never paste a token into chat, Linear, command arguments, committed files, or captured output. For local operator commands, create a root `.dev.vars` file with mode `0600`:

```dotenv
AIRTABLE_ENVIRONMENT=preview
AIRTABLE_PREVIEW_BASE_ID=app_REPLACE_ME
AIRTABLE_PAT=pat_REPLACE_ME
AIRTABLE_SCHEMA_PAT=pat_REPLACE_ME
```

Remote Worker configuration stores `AIRTABLE_PAT` with Wrangler secrets. `AIRTABLE_BASE_ID` is a safe environment-specific variable. `AIRTABLE_SCHEMA_PAT` is not a Worker runtime secret and should not be deployed.

## Commands

All commands compile the strict TypeScript operator before execution. The schema check is read-only:

```bash
pnpm --filter @sessionbox-killer/data airtable schema:check --environment preview
```

Review the drift report before applying the additive bootstrap:

```bash
pnpm --filter @sessionbox-killer/data airtable schema:bootstrap --environment preview --apply
pnpm --filter @sessionbox-killer/data airtable schema:check --environment preview
```

The probe idempotently creates a clearly labeled synthetic organization, event, and CFP form using stable IDs:

```bash
pnpm --filter @sessionbox-killer/data airtable probe --environment preview --apply
```

Production bootstrap or probe additionally requires both `--confirm-production` and `AIRTABLE_PRODUCTION_CONFIRM=production`. Preview and production base IDs are rejected when equal.

The release demo bootstrap is intentionally narrower than the generic probe. After the complete D1 migration chain through `0025_task_reminder_workflows.sql`, Airtable schema v10, and the matching Worker deploy, `pnpm cloudflare:demo:bootstrap --environment preview` accepts only an empty base or the exact command-store-managed demo roots. The deterministic root command ID is tied to the shared seed version; Source version, last-command hash, applied-content hash, and organization link must all replay exactly. The Worker then reconciles those source record IDs before the guarded 139-operation snapshot plus four private assets may create any child record.

Operator commands require the environment-specific base variable. They never fall back to the Worker's generic `AIRTABLE_BASE_ID`, so a production mutation cannot silently target an unverified base.

## Runtime guarantees

- The local operator client begins requests no faster than five per second. Runtime uses one SQLite-backed `BaseAuthority` Durable Object keyed by trusted environment/base configuration. It owns the long-lived client/store plus persistent 200 ms request slots and 429 cooldown, so coordination survives object eviction.
- List reads follow Airtable offsets with a maximum page size of 100 and reject repeated offsets.
- Writes batch at most 10 records.
- HTTP 429 honors `Retry-After`, enforces Airtable's minimum 30-second cooldown, and adds bounded jitter.
- Reads retry transient network/5xx failures with bounded exponential backoff. Writes retry only an explicit 429; ambiguous network/5xx write failures return immediately. Replaying the same command first reads its stable command ID/hash, so it reconciles an accepted-but-unacknowledged write instead of blindly resending it. Unresolved authority outcomes retain a persisted exponential recovery schedule capped at 15 minutes.
- Schema creates never retry after ambiguous failures. Rerun bootstrap to refetch markers and reconcile before attempting another additive write.
- Partial multi-batch writes report confirmed count, failed batch, total count, and a provider code without record contents or credentials. Treat the failed batch as outcome-unknown when the provider response was ambiguous.
- Commands store stable `ID`, `Source version`, latest command ID/hash, and the canonical hash of app-managed content. One command-store instance serializes its read/check/write critical section; an immediate replay of the latest command is recognized and stale versions fail closed.
- The record-local latest-command marker is not the system-wide idempotency ledger. `BaseAuthority` persists its intent, provider attempts, result, and original response in object SQLite; the atomic D1 commit stores the tenant + operation + command ID ledger. Delayed and cross-entity key reuse is deterministic.
- CFP draft/final multi-record writes use the authority's schema-v5 parent plan ledger. The full ordered plan is committed before its first child command; only contacts, submissions, answers, and participant links are accepted. Dependent Airtable record links come from completed earlier children, and the receipt is withheld until all child projections are durable. An identical replay resumes after eviction; a changed replay conflicts without another provider mutation.
- Organizer submission commands use the same authority with a D1 receipt that freezes stable child operations. Lifecycle writes carry the projected source-version precondition. Adding a note version-touches the submission before creating the linked `Submission Notes` record, so concurrent commands serialize and fail stale rather than bypassing authority through D1. The organizer workspace remains unavailable for writes until the current Airtable schema and D1 migration `0016_organizer_submissions.sql` are both ready.
- Direct organizer edits are authoritative. The reconciler accepts changed content only when the protected hash, Source version, and command markers still match its last projection; adoption advances Source version before updating the projection, so a stale app command cannot overwrite the edit. Removed lifecycle markers and a Source version older than the projected baseline fail closed. A base-wide webhook cursor advances only after every active tenant converges, and the same authority exposes a bounded complete scan for missed or expired notifications. The hourly Worker trigger runs this synchronization only while writes are enabled; a configured live webhook narrows the work, otherwise the trigger performs the bounded full scan.
- Airtable has no compare-and-swap primitive. Correctness therefore depends on the single base authority Durable Object and its long-lived command-store instance. Direct Worker/workflow use of `AirtableClient` for authoritative mutations is prohibited by the package export and lint boundary.

The workerd authority suites apply the production D1 migrations, inject projection failures after successful Airtable writes, and verify alarm-safe repair with one provider mutation, an unchanged replay response, canonical projections, and durable idempotency/audit/outbox/repair state. Crash cases abort the object while the provider response is in flight and prove persisted-lease readback recovery without a second mutation. The shared projector and reconciliation path cover all 31 schema-v10 tables, multi-tenant webhook cursor ingestion, scheduled full scans, tombstones, organizer edit adoption with version advancement, stale-writer rejection, and protected-lifecycle tamper rejection.

## Authenticated integration health and manual reconcile

The event workspace's **Integrations & API** page exposes an owner-only Airtable panel. It returns aggregate operational facts: the last six alphanumeric base-ID characters, expected schema version, last completed provider read, last authoritative provider commit, oldest table watermark and derived lag, repair counts, latest reconciliation status, and event-scoped counts for submitted proposals, accepted sessions, and task assignments. The record trace names the corresponding Airtable tables and links. It never returns the full base ID, token, Airtable record ID, stable business ID, field payload, email address, source hash, command ID, or provider error.

“Review reconcile” runs an organization-wide, non-mutating divergence plan through the same per-base Durable Object and persistent rate discipline. It reads Airtable and D1, validates lifecycle/source monotonicity, and reports aggregate create/update/missing/unchanged counts by human-readable table. It does not patch Airtable lifecycle markers, change readiness, write scan rows, or tombstone D1 projections. Durable Object request-slot bookkeeping may advance because even a dry-run read must honor provider rate limits.

Apply requires all of the following: an active organization owner, same-origin JSON and CSRF, enabled integration and write flags, a stable idempotency key, an unchanged fingerprinted dry-run plan, and the exact organization-wide confirmation shown by the server. A successful apply uses the existing serialized reconciler and appends `airtable.reconciliation.completed` to `audit_events` with aggregate counts only. Direct Airtable edits may advance lifecycle markers during apply; missing authority records are tombstoned in D1, never recreated in Airtable from projection data.

The activity timestamps describe runtime reads and authoritative writes, not the separate CLI synthetic probe. A green fixture or local panel proves the contract, not a live provider environment. Live demo evidence still requires a timestamped owner session against the frozen deployed SHA and a separately verified Airtable view; do not substitute fixture counts or this documentation for that evidence.

## Repair operations

An Airtable success followed by a D1 projection failure is returned as `committed_with_repair`; it is not a failed Airtable command. `BaseAuthority` retains the provider result and original response in Durable Object SQLite, records a `projection_repairs` row, and wakes the projection-repair queue. Its alarm and queue consumer call the same `recoverPending()` path, so an identical retry converges D1 and replays the stored response without a second Airtable mutation.

Operators diagnose with aggregate status only and an ID-complete ignored Wrangler config. Never dump request bodies, recipient fields, provider payloads, or private object metadata:

```bash
pnpm exec wrangler d1 execute DB --remote \
  --config .cloudflare/wrangler.preview.json \
  --command "SELECT status, COUNT(*) AS count FROM projection_repairs GROUP BY status ORDER BY status"
```

If a repair becomes dead/failed, disable the affected write feature, preserve Airtable as authority, and fix the projection contract before using the existing authority recovery path. Never insert a replacement business record directly into D1 and never blindly resend an `unknown` Airtable write. Full diagnosis and recovery decisions are in [`docs/19-open-source-operator-guide.md`](./19-open-source-operator-guide.md#dual-store-repair).

Provider behavior is covered by deterministic fetch fixtures. Credentialed preview checks and the operator-only demo root/bootstrap path are the release steps that require owner-provided Airtable access.
