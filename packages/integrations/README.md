# Provider contract boundary

This package owns provider-specific request/response behavior. Domain and Worker
code should pass provider-neutral intents through a durable queue or workflow and
persist stable source-to-provider mappings outside these clients.

## Accelevents

`AcceleventsClient` implements the currently documented API-key contracts for:

- paginated session and speaker reads;
- tag/track, speaker, and session creation;
- session updates;
- duplicate-speaker reconciliation by normalized email;
- bounded reads, pagination, retries, batch size, and response bodies; and
- redacted per-operation receipts that preserve partial-failure evidence.

The deterministic JSON fixtures use reserved `.invalid` addresses and invented
IDs. They contain no provider credentials, event identifiers, or attendee data.
Unsafe `POST` requests are never retried after an ambiguous network failure.

The upstream docs still disagree between `Key` and `Authorization`, their prose
and OpenAPI disagree on the tag/track enum spelling, and they do not fully specify
timezone or speaker/track association payloads. Callers must select the verified
header explicitly. This adapter follows the OpenAPI `TAG`/`TRACK` values. Native
compatibility remains externally gated until an approved disposable event proves
those contracts; fixture tests are not live-provider evidence.

## Live readiness gate

`.github/workflows/provider-live-readiness.yml` is a manual, environment-approved,
read-only job. It validates one selected provider without sending email or changing
external data:

- Airtable: reads the configured base schema;
- Resend: lists at most one domain; and
- Accelevents: lists sessions and speakers for the configured disposable event.

The workflow emits only test pass/fail output. Provider payloads, resource names,
IDs, addresses, and credentials are not logged or uploaded. Accelevents mutation,
timezone, idempotency, and association proof still requires a separately approved
credentialed run with an explicit external-mutation lease.
