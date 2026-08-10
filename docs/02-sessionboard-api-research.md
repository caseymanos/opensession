# Sessionboard and Accelevents API research

Last verified: 2026-08-08 against the official documentation linked below. Third-party documentation snapshots are intentionally not redistributed in this repository.

## Sessionboard public API inventory

Captured OpenAPI metadata:

- OpenAPI 3.1.0; API version 1.0.
- US: `https://public-api.sessionboard.com`.
- EU: `https://public-api-eu.sessionboard.com`.
- 131 paths, 177 operations, 68 component schemas.
- Methods: 58 GET, 70 POST, 25 PUT, 24 DELETE.
- Largest surfaces: Insights (28 operations), Agenda Planning (22), Metadata Writes (22), Event Settings (16), and Transcriptions (13).

### Authentication and scopes

- Server integrations use `x-access-token` with organization-scoped tokens.
- OAuth 2.1 PKCE uses `Authorization: Bearer`; access tokens last one hour and refresh tokens seven days.
- Useful domain scopes include `read:events`, `read:sessions`, `read:contacts`, `read:insights`, `write:sessions`, `write:contacts`, `write:fields`, `write:metadata`, and `write:events`.
- Legacy tokens with empty scopes receive read access but not write access.

### Limits and reliability behavior

- Most limited categories allow 100 requests per 15 minutes per token/category.
- Response headers expose `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset`; 429 includes `Retry-After`.
- Create session/contact/sponsor/exhibitor operations have a 10,000/day/token write quota.
- Bulk operations accept up to 100 changes and count as one request.
- Search endpoints paginate with default 25 and max 100.
- Session get/search may be cached for three minutes.
- Session/contact update can use `updated_at` for optimistic concurrency.
- Deletes are soft and have restore operations.

### Domain modeling implications

- Abstracts and finalized program sessions share a resource; `is_abstract` distinguishes them.
- `composition_status` links an abstract/source into a final session/target.
- Sessions expose flat participants plus legacy speakers/chairpersons/moderators.
- Agenda drafts are explicit workspaces with preview and commit, a useful model for safe schedule publishing.
- Event metadata (rooms, tracks, tags, formats, levels, languages, statuses) is first-class.
- Webhooks include full resource plus action/event/org/version/timestamp metadata and retry with exponential backoff.

### Useful endpoint subset

| Purpose | Sessionboard reference |
|---|---|
| List events | `GET /v1/events` |
| Search abstracts/sessions | `POST /v1/event/{eventId}/sessions` with `filters.isAbstract` |
| Create abstract/session | `POST /v1/event/{eventId}/sessions/create` |
| Update session | `PUT /v1/event/{eventId}/sessions/{sessionId}` |
| Speaker search | `POST /v1/event/{eventId}/speakers` |
| Contact CRUD | `/v1/event/{eventId}/contacts...` |
| Settings | `/v1/event/{eventId}/{rooms,tracks,tags,formats,levels,languages,statuses}` |
| Draft agenda | `/v1/event/{eventId}/agenda-drafts...` |
| Session files | `/v1/event/{eventId}/sessions/{sessionId}/files...` |

## API design lessons for this entry

Our deadline API is deliberately smaller. Required resources:

- `/api/v1/events`
- `/api/v1/events/{eventId}/forms`
- `/api/v1/events/{eventId}/submissions`
- `/api/v1/events/{eventId}/speakers`
- `/api/v1/events/{eventId}/reviews`
- `/api/v1/events/{eventId}/sessions`
- `/api/v1/events/{eventId}/schedule`
- `/api/v1/events/{eventId}/tasks`
- `/api/v1/events/{eventId}/resources`
- `/api/v1/events/{eventId}/exports/accelevents`
- `/api/v1/public/events/{slug}/{schedule,speakers}`
- `/openapi.json` and `/docs`

Contract rules:

- bearer API keys stored as hashes and scoped to organization/event/actions;
- ISO 8601 timestamps with explicit event timezone in event metadata;
- cursor pagination and `data`/`page` envelope;
- RFC 9457 `application/problem+json` errors;
- `Idempotency-Key` on all POST actions with external side effects;
- ETag/`If-Match` or `updatedAt` concurrency on schedule/template mutations;
- soft-delete only where user recovery matters;
- webhooks signed with HMAC, delivery IDs, retries, and replay UI;
- generated OpenAPI is contract-tested against handlers and examples.

## Accelevents connector research

The public API documentation describes an Enterprise/White Label feature using `https://api.accelevents.com`.

Confirmed endpoints:

- `GET /rest/host/event/{eventUrl}/speaker?eventId=...` — list speakers.
- `POST /rest/host/event/{eventUrl}/speaker` — create speaker.
- `GET /rest/host/event/{eventUrl}/session?eventId=...` — list sessions.
- `PUT /rest/host/event/{eventUrl}/session/{id}` — update session.
- `POST /rest/host/event/{eventUrl}/key-value` — create tag/track.

Observed speaker fields include name, email, title, company, bio, image URL, pronouns, and social profiles. Duplicate email returns code `4068906`. Session writes recommend at least title, start/end (`yyyy/MM/dd HH:mm`), format, and eligible ticket types; formats include main stage, breakout, meetup, workshop, expo, break, and other.

### Documentation gaps that require a credentialed spike

1. The OpenAPI security scheme names header `Key`, while operation parameters document `Authorization`.
2. The public index exposes session update but not a session-create endpoint.
3. Speaker-to-session assignment and track assignment are not clearly documented on the captured update schema.
4. Timezone semantics for the date strings are not explicit.
5. The product's Accelevents API entitlement and a test event are not yet available.

The connector cannot be called production-complete until sandbox contract tests resolve those points. The UI may still ship behind a “Configure Accelevents” gate with fixture-driven adapter tests.

## One-way export contract

Source of truth remains this app. The export state machine is:

1. Validate connector/event settings and accepted/scheduled source records.
2. Reconcile existing Accelevents speakers by normalized email; create missing speakers.
3. Reconcile tags/tracks by normalized name; create missing values.
4. Reconcile sessions by stored external ID, then deterministic source key; never title alone.
5. Create/update session fields and participant associations.
6. Persist source→destination IDs and content hash.
7. Record per-record success/skipped/error and a resumable cursor.
8. Retry retryable failures with bounded exponential backoff; do not replay successful operations.

Every run supports dry-run, explicit manual trigger, and automatically queued export after an accepted session changes. Deletion is not propagated before the deadline; records can be hidden with an explicit operator action instead.
