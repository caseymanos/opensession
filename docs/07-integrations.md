# Integrations and API contracts

## Integration policy

Adapters own all provider-specific behavior. Domain commands emit provider-neutral intents; external calls happen after authoritative state commits. Every outbound side effect has a deterministic idempotency key, durable attempt log, bounded retry policy, redacted error, and manual replay.

## Airtable

### Purpose and authority

Airtable is the authoritative store for event-program business records and must be inspectable during the judge walkthrough. D1 is an operational/read projection, not a second writer of business truth.

### Setup

- Dedicated production base and separate preview/test base.
- Personal access token with least privilege to only required bases.
- Server-only runtime inputs: secret `AIRTABLE_PAT` and non-secret environment-specific `AIRTABLE_BASE_ID`; generated/owner-specific values stay out of public source.
- `pnpm --filter @sessionbox-killer/data airtable schema:check --environment <preview|production>` compares schema v10 to the selected base without mutation.
- `pnpm --filter @sessionbox-killer/data airtable schema:bootstrap --environment <preview|production> --apply` may add missing managed tables/fields only after explicit environment confirmation.

### Runtime contract

- Serialize conflicting commands and route every Airtable request through the single Durable Object for that environment/base so the documented 5 requests/second limit and 429 cooldown are globally coordinated.
- Batch record operations where supported; honor `Retry-After` with jitter.
- Stable internal ID is stored in an Airtable field and is the app's public identity; record IDs are implementation metadata.
- Write `Source version` and `Updated at`; projection consumes only newer versions.
- `BaseAuthority` exposes webhook-cursor and bounded full-scan reconciliation that reports created/updated/missing/divergent rows. The current public config does not claim a provider webhook or reconciliation Cron; release operations invoke and evidence the full scan explicitly.

### Operator health proof

Release evidence records only a safe base suffix, schema version, last successful synthetic probe, projection lag, queued-repair count, and reconciliation result—never the token or generated base ID. The authenticated integration surface may render those safe fields when the corresponding runtime ticket is enabled; provider fixtures are not live proof.

## Resend/email provider

- Required: API key, verified domain, default from, reply-to, webhook signing secret.
- Delivery modes: `sink` local, `allowlist` preview and release-gated production, `live` only after an explicit production readiness decision.
- Preview/seed addresses cannot reach arbitrary recipients.
- Domain verification and inbox placement checks are external setup gates.
- Every campaign queue intent is bound to its organization/event/campaign/contact/template version, recipient hash, and rendered payload hash before enqueue. Magic-link intents bind the recipient and complete link payload before enqueue without storing the raw token.
- Queue consumers use durable leases, stable provider idempotency keys, at most five provider attempts, environment allowlists, and a dead-letter queue. A successful magic-link send is durably terminal so at-least-once queue redelivery cannot resend it.
- `POST /api/webhooks/resend` verifies the Svix signature against the unmodified request body, caps the body at 256 KiB, deduplicates event IDs, retains only the raw payload hash, and normalizes sent, delivered, bounced, complained, failed, and suppressed events. A signed event that arrives before its local provider message receives a bounded retry window. If it remains foreign after that window, immutable event-ID and payload digests quarantine it with a successful acknowledgement; no address, provider payload, or provider identifier is retained, and the existing 30-day operational-event retention applies.
- Provider events are monotonic by provider timestamp and severity. Complaint/manual suppressions cannot be weakened by a later or out-of-order bounce.
- Suppressed/bounced addresses are explained and excluded from automated retries.

Resend documents webhook delivery as at-least-once and unordered, with retries from the immediate attempt through later 5-minute, 30-minute, and multi-hour windows: [Retries and Replays](https://resend.com/docs/webhooks/retries-and-replays). The 15-minute local-persistence grace therefore preserves the immediate, 5-second, and 5-minute race-recovery opportunities before the next scheduled retry is quarantined.

Provider operations never contain portal tokens in logs. Email HTML and plain text are snapshot-tested; tracked links are optional and off by default.

## Calendar invitations

Baseline delivery is standards-compliant iCalendar attachment in email, not calendar-provider OAuth. This fulfills Gmail/Outlook/iCal compatibility while containing deadline risk.

- Create/accept: `METHOD:REQUEST` with stable UID.
- Schedule/title/location material change: same UID, incremented `SEQUENCE`.
- Cancel: same UID, `METHOD:CANCEL`, `STATUS:CANCELLED`.
- Event timezone is represented with correct UTC values and human-readable event-zone copy.
- Test fixtures are imported manually into Google Calendar, Outlook web/desktop when available, and Apple Calendar.

Direct Google/Microsoft Calendar OAuth is post-competition unless core gates are already green.

## Accelevents one-way export

Status: stretch, externally gated. The source links below remain the authority; third-party documentation is not copied into the repository.

### What public docs prove

- API host: `https://api.accelevents.com`.
- Speaker list/create: `GET|POST /rest/host/event/{eventUrl}/speaker`.
- Sessions list: `GET /rest/host/event/{eventUrl}/session?eventId=...`.
- Session update: `PUT /rest/host/event/{eventUrl}/session/{id}`.
- Track/tag creation: `POST /rest/host/event/{eventUrl}/key-value`.
- Duplicate speaker email may return code `4068906` and should reconcile rather than duplicate.
- API access may require Enterprise or White Label entitlement.

### Unknowns that block a production claim

- Documentation alternates between `Key` and `Authorization` header conventions.
- No unambiguous public session-create endpoint was found.
- Speaker-to-session and track-to-session assignment contracts are incomplete.
- Source/event timezone semantics need a sandbox proof.

### Credentialed contract-test gate

Before native export is called complete, obtain a disposable Accelevents event and API credential, then save redacted request/response fixtures proving:

1. authentication header;
2. event identity and timezone;
3. list/create/reconcile speaker;
4. create or resolve a session;
5. link speaker and track;
6. update time/location/content;
7. repeated export is idempotent;
8. documented rate/error handling.

If the API cannot create/link required entities, ship a clearly labeled CSV/JSON export compatible with manual import and retain the native adapter behind an experimental flag. Never demo a fixture adapter as live integration.

### Sync order

Dry-run diff → validate accepted/published session shape → upsert tags/tracks → upsert speakers by normalized email/external mapping → upsert sessions → link speakers/tracks → re-read and compare → persist mapping/hash/run report.

Deletion is out of scope. Removed source records become warnings/manual review so one-way export cannot destroy external content.

## Public API

### Shape

- Base: `/api/v1`; JSON, RFC 3339 timestamps, stable internal IDs.
- Auth: opaque API key in `Authorization: Bearer`. The v1 catalog is authenticated; anonymous CFP/schedule/speaker routes are separate public product contracts.
- Pagination: cursor with default 25/max 100.
- Errors: problem-details-like `{type,title,status,code,detail,request_id,errors?}`.
- The submission lifecycle `PATCH` requires `Idempotency-Key` and `If-Match`; a changed replay or stale version fails closed.
- Optimistic concurrency via ETag/`If-Match` for mutable singular resources.

### Current generated resource surface

| Method | Route | Scope |
|---|---|---|
| GET | `/events`, `/events/:eventId` | `events:read` |
| GET | `/events/:eventId/submissions`, `/events/:eventId/submissions/:submissionId` | `submissions:read` |
| PATCH | `/events/:eventId/submissions/:submissionId` | `submissions:write` |
| GET | `/events/:eventId/sessions`, `/events/:eventId/sessions/:sessionId` | `sessions:read` |
| GET | `/events/:eventId/speakers`, `/events/:eventId/speakers/:speakerId` | `speakers:read` |
| GET | `/events/:eventId/tasks`, `/events/:eventId/tasks/:taskId` | `tasks:read` |
| GET | `/events/:eventId/schedule` | `schedule:read` |
| GET | `/events/:eventId/export-runs`, `/events/:eventId/export-runs/:runId` | `integrations:read` |

The OpenAPI file is generated from the same runtime catalog that registers handlers, validated in CI, served at `/openapi.json`, and rendered at `/docs/api`. The catalog currently produces 13 paths. The executable local curl exchange is in [`examples/public-api-v1/local-curl-transcript.md`](../examples/public-api-v1/local-curl-transcript.md); production smoke checks the public document/docs but never exposes a plaintext key.

The public CFP configuration returns presentation-safe event, form, field, conditional-rule, track-label, and format data. Canonical route keys and default reviewer-group IDs remain server-only. The final submission handler must resolve them again from authoritative policy and must never let a caller select an internal queue by editing the request.

## Outgoing webhooks (gated contract)

- Initial events: submission submitted/status changed, session changed/scheduled/published, task completed/overdue, speaker readiness changed.
- Signature: `t=<unix>,v1=<hex HMAC-SHA256>` over `timestamp + '.' + rawBody`.
- Headers include event type, delivery ID, API version.
- At-least-once delivery; receivers dedupe by delivery ID.
- Exponential retry with jitter and terminal dead-letter; replay keeps logical delivery/event IDs and records new attempt.
- Disable after sustained failures only with visible alert; secret rotation supports overlap.

## Sessionboard reference API

The captured Sessionboard OpenAPI is competitive reference only; we do not depend on or copy proprietary implementation. Product-relevant lessons incorporated into our contract:

- OAuth/token scopes and regional base URLs show mature integrations matter.
- Search/pagination, bulk operations, soft-delete/restore, and optimistic timestamps reveal operational expectations.
- Agenda drafts and `is_abstract` reveal the distinction between proposals and published program records.
- Webhook resource metadata/retry surfaces inform our delivery log.

The first release deliberately exposes fewer, coherent resources with better seeded documentation.

## Discord/judge updates

New judge statements are recorded verbatim with timestamp and source in `docs/10-discord-updates.md`, then mapped to one of: clarification, new requirement, changed priority, deadline/process, or non-binding suggestion. A change affecting scope must update the product spec and Linear issue/milestone in the same pass.
