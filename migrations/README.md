# D1 migrations

Forward-only D1 migrations live here. Schema tickets add numbered SQL files and verify them against disposable local databases before any preview application.

- `0001_operational_foundation.sql`: tenant, projection, delivery, audit, and workflow foundation.
- `0002_auth_security.sql`: passwordless authentication and session hardening.
- `0003_operational_observability.sql`: append-only redacted events, correlation indexes, retention controls, and aggregate metric snapshot.
- `0006_authority_completion.sql`: canonical source registry, complete Airtable-owned projections, safe authority traces, and durable demo snapshot state.
- `0007_public_abuse_protection.sql`: hashed, strict rate-limit counters for public account, draft, submission, and upload operations.
- `0008_tenant_authority_readiness.sql`: fail-closed tenant activation readiness and versioned authority roster invalidation.
- `0009_authority_cache_invalidation.sql`: durable public-schedule invalidation intents for authority projection changes.
- `0010_cache_invalidation_delivery.sql`: generation-safe cache purge completion and automatic redrive state.
- `0011_cfp_authoritative_routing.sql`: authoritative CFP track routing metadata and durable submission draft projections.
- `0012_cfp_submission_reservations.sql`: atomic per-account CFP limits and request-bound submission identities.
- `0013_email_queue_handoff.sql`: durable Queue handoff leases, confirmations, bounded frozen campaign envelopes, and database-unique CFP receipt identities for crash-safe email delivery.
- `0014_schedule_domain.sql`: event schedule configuration and resumable, idempotent schedule-command receipts for authoritative placement writes.
- `0015_demo_bootstrap_authorization.sql`: one-time environment/base/seed-scoped operator authorization, renewable execution leases, and durable replayable bootstrap results.
- `0016_organizer_submissions.sql`: organizer submission activity, authoritative internal notes, indexed queue reads, and resumable command receipts.
- `0018_schedule_publication.sql`: immutable operator/public publication snapshots, version-linked public cache purge metadata, and durable post-public session-change facts.

The guarded Cloudflare deploy command applies pending remote migrations before the Worker version and Wrangler captures a D1 backup for each migration. A failed Worker deploy can therefore leave an additive migration in place; migrations must remain forward-compatible and rollback continues to mean Worker code/configuration only.
