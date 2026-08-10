# Airtable operations

## Authority boundary

Airtable is the authoritative store for conference-program business data. D1 contains authentication, operations, audit, and read projections; it must not become an independent writer of Airtable-owned entities.

The expected schema is versioned in `packages/data/src/airtable/schema-definition.ts`. Version 4 contains all 29 authoritative tables from the data model, stable internal IDs, source versions, command IDs, UTC lifecycle timestamps, human-readable field types, and explicit linked-record targets. Its additive upgrades include durable CFP draft/routing metadata, structured email/template snapshots, and schedule-domain fields; applying them does not rewrite earlier records.

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

The release demo bootstrap is intentionally narrower than the generic probe. After D1 migration `0015` and the matching Worker deploy, `pnpm cloudflare:demo:bootstrap -- --environment preview` accepts only an empty base or the exact command-store-managed demo roots. The deterministic root command ID is tied to the shared seed version; Source version, last-command hash, applied-content hash, and organization link must all replay exactly. The Worker then reconciles those source record IDs before the guarded snapshot may create any child record.

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
- CFP draft/final multi-record writes use the authority's schema-v4 parent plan ledger. The full ordered plan is committed before its first child command; only contacts, submissions, answers, and participant links are accepted. Dependent Airtable record links come from completed earlier children, and the receipt is withheld until all child projections are durable. An identical replay resumes after eviction; a changed replay conflicts without another provider mutation.
- Direct organizer edits are authoritative. The reconciler accepts changed content only when the protected hash, Source version, and command markers still match its last projection; adoption advances Source version before updating the projection, so a stale app command cannot overwrite the edit. Lifecycle-field tampering fails closed. A base-wide webhook cursor advances only after every active tenant converges, and a scheduled complete scan protects against missed or expired notifications.
- Airtable has no compare-and-swap primitive. Correctness therefore depends on the single base authority Durable Object and its long-lived command-store instance. Direct Worker/workflow use of `AirtableClient` for authoritative mutations is prohibited by the package export and lint boundary.

The workerd authority suites apply the production D1 migrations, inject projection failures after successful Airtable writes, and verify alarm-safe repair with one provider mutation, an unchanged replay response, canonical projections, and durable idempotency/audit/outbox/repair state. Crash cases abort the object while the provider response is in flight and prove persisted-lease readback recovery without a second mutation. The shared projector and reconciliation path cover all 29 schema-v4 tables, multi-tenant webhook cursor ingestion, scheduled full scans, tombstones, organizer edit adoption with version advancement, stale-writer rejection, and protected-lifecycle tamper rejection.

Provider behavior is covered by deterministic fetch fixtures. Credentialed preview checks and the operator-only demo root/bootstrap path are the release steps that require owner-provided Airtable access.
