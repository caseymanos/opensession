# Public API v1 local curl transcript

This is a **local, ephemeral fixture transcript**, not evidence of a preview or
production deployment. The seed and assertions live in
`workers/app/test/public-api-runtime.test.ts`; run them with:

```sh
pnpm exec vitest run workers/app/test/public-api-runtime.test.ts
```

The fixture creates two organizations, three events, canonical submission,
session, speaker, task and export-run projections, and event- and
organization-scoped keys after applying the complete migration chain through
`0025_task_reminder_workflows.sql` to a disposable database. Migration
`0021_scoped_public_api_keys.sql` introduces the per-key `verifier_salt` used by
these keys. The transcript does not apply a remote migration or make any
preview or production request.

## Verify the served contract

With `pnpm dev` running, these secret-free curls execute against the same
generated document and registered handlers:

```sh
curl --fail --silent http://127.0.0.1:8787/openapi.json \
  | jq -e '
      .openapi == "3.1.0" and
      .servers[0].url == "/api/v1" and
      (.paths | length == 13)
    '

curl --fail --silent --output /dev/null \
  http://127.0.0.1:8787/docs/api

test "$(curl --silent --output /dev/null --write-out '%{http_code}' \
  http://127.0.0.1:8787/api/v1/events)" = 401
```

The scoped success exchanges below require one-time fixture keys, so the
runtime test is their executable authority. The output is intentionally
redacted and uses placeholders rather than reusable credentials.

The commands below show the equivalent curl exchange. The shell variables stand
in for one-time local secrets and should never be printed, committed, placed in
a URL, or copied into a production environment.

```sh
export OPENSESSION_LOCAL_ORIGIN=http://127.0.0.1:8787
export OPENSESSION_EVENT_KEY='<one-time event-scoped fixture key>'
export OPENSESSION_ORG_KEY='<one-time organization-scoped fixture key>'
```

## Read an event

```console
$ curl --silent --include \
    --header "Authorization: Bearer $OPENSESSION_EVENT_KEY" \
    "$OPENSESSION_LOCAL_ORIGIN/api/v1/events/event_alpha"
HTTP/1.1 200 OK
content-type: application/json; charset=UTF-8
etag: "opensession-event-v3"
ratelimit-limit: 120
ratelimit-remaining: 119
ratelimit-reset: <unix timestamp>
x-request-id: <local request UUID>

{"id":"event_alpha","name":"Alpha Summit","slug":"alpha-summit","status":"published","timezone":"UTC","version":3,...}
```

## Cursor pagination

```console
$ curl --silent \
    --header "Authorization: Bearer $OPENSESSION_ORG_KEY" \
    "$OPENSESSION_LOCAL_ORIGIN/api/v1/events?limit=1"
{"data":[{"id":"event_alpha_other",...}],"page":{"limit":1,"next_cursor":"<opaque cursor>"}}
```

The default is 25 and the maximum is 100. A cursor is opaque and bound to its
resource and authenticated scope; sending the event-list cursor to the
submissions collection returns `400 invalid_cursor`.

## Canonical read-only tasks

```console
$ curl --silent \
    --header "Authorization: Bearer $OPENSESSION_EVENT_KEY" \
    "$OPENSESSION_LOCAL_ORIGIN/api/v1/events/event_alpha/tasks/task_bio"
{"contact_id":"contact_speaker","definition":{"id":"definition_bio","name":"Confirm biography","type":"ack"},"due_at":null,"id":"task_bio","required":true,"session_id":null,"state":"complete","updated_at":"2026-08-10T20:00:00.000Z","version":3}
```

Public API v1 intentionally has no task mutation scope or endpoint. Task writes
remain owned by the canonical organizer/speaker task workflow.

## Cross-event failure

The event-scoped key for `event_alpha` cannot access another event in the same
organization.

```console
$ curl --silent --include \
    --header "Authorization: Bearer $OPENSESSION_EVENT_KEY" \
    "$OPENSESSION_LOCAL_ORIGIN/api/v1/events/event_alpha_other"
HTTP/1.1 403 Forbidden
content-type: application/problem+json; charset=UTF-8

{"type":"https://opensessionboard.com/problems/event_scope_mismatch","title":"Event scope mismatch","status":403,"detail":"This API key cannot access the requested event.","code":"event_scope_mismatch","request_id":"<local request UUID>"}
```

## Cross-organization failure

An organization-scoped key for `organization_alpha` receives a scoped `404`
when it requests `organization_beta` data. The response does not disclose which
other tenant owns the identifier.

```console
$ curl --silent --include \
    --header "Authorization: Bearer $OPENSESSION_ORG_KEY" \
    "$OPENSESSION_LOCAL_ORIGIN/api/v1/events/event_beta"
HTTP/1.1 404 Not Found
content-type: application/problem+json; charset=UTF-8

{"type":"https://opensessionboard.com/problems/resource_not_found","title":"Resource not found","status":404,"detail":"The requested event does not exist in this API key's scope.","code":"resource_not_found","request_id":"<local request UUID>"}
```

## Revoke and verify fail-closed behavior

Revocation is an organizer-session operation. It requires a same-origin request,
CSRF token, JSON content type and a unique idempotency key. Creation returns the
full plaintext exactly once; every later list and revoke response contains only
the safe prefix, and the plaintext cannot be recovered.

```console
$ curl --silent --include --request DELETE \
    --cookie "__Host-opensession-session=$OPENSESSION_LOCAL_SESSION" \
    --header "Origin: $OPENSESSION_LOCAL_ORIGIN" \
    --header "Sec-Fetch-Site: same-origin" \
    --header "Content-Type: application/json" \
    --header "X-CSRF-Token: $OPENSESSION_LOCAL_CSRF" \
    --header "Idempotency-Key: local-revoke-example-0001" \
    --data '{}' \
    "$OPENSESSION_LOCAL_ORIGIN/api/events/event_alpha/api-keys/$OPENSESSION_KEY_ID"
HTTP/1.1 200 OK

{"data":{"id":"<key id>","prefix":"osk_key_<safe prefix>","state":"revoked",...},"audit_receipt":{"id":"<audit id>","request_id":"<local request UUID>",...}}

$ curl --silent --include \
    --header "Authorization: Bearer $OPENSESSION_REVOKED_KEY" \
    "$OPENSESSION_LOCAL_ORIGIN/api/v1/events"
HTTP/1.1 401 Unauthorized
www-authenticate: Bearer realm="OpenSession API", error="invalid_token"
content-type: application/problem+json; charset=UTF-8

{"type":"https://opensessionboard.com/problems/invalid_api_key","title":"Invalid API key","status":401,"detail":"The API key is invalid, expired, or revoked.","code":"invalid_api_key","request_id":"<local request UUID>"}
```
