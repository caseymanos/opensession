# Security and privacy release-readiness evidence

## Scope and release decision

This checklist audits RAL-79 from canonical public `main` commit
`00eb93f1401ca41e3d2ecd571fd29d689133e01a`. It is release evidence, not a
claim that preview or production was mutated. All privacy fixtures use reserved
`.test` addresses and local D1/R2-compatible bindings.

Release rule: ship only with zero known P0/P1 security or privacy defects. A
failed protected check, an unreviewed high/critical dependency finding, an
unexplained secret/PII scan result, or a missing row in the matrices below is a
no-go.

## Export and deletion product policy

`GET /api/v1/privacy/policy` publishes the bounded policy in a machine-readable
form.

An active organization owner can call
`POST /api/organizations/:organizationId/privacy/exports` with same-origin JSON,
their current session and CSRF token, and one email address. The response is a
no-store JSON attachment scoped to that organization. Revoked owners,
organizers/viewers, foreign tenants, missing sessions, invalid origins, and
missing CSRF tokens fail closed.

The online package is deliberately minimized:

| Family | Included | Excluded |
|---|---|---|
| Account and membership | account display data and organization/event roles only when the account belongs to this organization | session, CSRF and magic-link secrets; browser fingerprints; memberships in other organizations |
| Contact and portal | the matching contact profile, public-profile state, event roles and portal state | source record IDs, projection hashes/cursors, other contacts' profiles |
| CFP | submissions submitted by or naming the subject; answers only when the subject is the submitter | answers owned by a different submitter; other participants' profiles |
| Reviews | reviews and score/comments authored by the subject | proposal content and other reviewers' work |
| Sessions and tasks | the subject's roles, confirmations, assignment responses and safe file IDs | other participants' data and internal command receipts |
| Files | filename, type, size, purpose, state and lifecycle timestamps | R2 key/version/ETag, checksum, private URL and file bytes |
| Messages | campaign/event relationship, state and lifecycle timestamps | body, recipient routing, provider ID, idempotency key and delivery payload |
| Safety evidence | none in the user-content package | pseudonymous audit, abuse, suppression, delivery-attempt, repair and operational rows |

Each resource family is limited to 1,000 rows and the serialized response is
limited to 4 MiB. An oversized request fails with a generic instruction to use
the operator runbook. A valid owner request for an absent subject returns a
complete empty package, not a distinct lookup error.

### No partial delete invariant

`POST /api/organizations/:organizationId/privacy/deletions` performs the same
owner, origin, session, CSRF, scope and input checks, then returns
`coordinated_deletion_required` without changing data. This is intentional.
Airtable is authoritative; D1 projection repair can recreate rows, while file
content lives in private R2 and delivery/integration copies may exist with
providers. A D1-only "delete" would be misleading and unsafe.

Complete a verified request within 30 days:

1. Open a private request receipt. Record request time, organization scope,
   verification method, owner/operator, due date and disposition. Never paste
   the subject email, export body, magic link, session token or private URL into
   Linear, logs or source control.
2. Verify the requester through the existing passwordless account. If that is
   impossible, use a documented event-organizer identity check and record only
   its method and outcome.
3. Run the organization-scoped online export and store it only in the approved
   private request system. For a complete portability response, attach the
   subject-owned R2 file bytes and any provider-held message body separately;
   the bounded JSON package intentionally contains metadata only.
4. For deletion, freeze projection repair for the exact organization/request
   under the release operator's normal change control. Delete or anonymize the
   authoritative Airtable contact and subject-owned content first. Reconcile
   downstream email/integration copies using their provider procedures.
5. Delete the subject's exact R2 object keys from the private request inventory.
   Do not use a bucket, directory or unresolved prefix as a target. Record only
   counts and opaque object IDs in the receipt.
6. Revoke the subject's sessions, magic links, portal grants, organization/event
   memberships and API credentials. Purge or anonymize matching D1 contact,
   free-form answer/review/task/file metadata according to the data-family map.
   Preserve only pseudonymous safety/audit facts and any event business record
   with a recorded retention reason and review date.
7. Resume/rebuild the projection after the authoritative deletion. Repeat the
   export for the same organization/email and verify `subject_found: false`, no
   subject-owned R2 object remains, and no provider lookup resolves. A D1-only
   success is not completion.
8. Record completion time, family-by-family counts, retention exceptions and
   verification outcomes. Delete temporary export packages within 30 days after
   request closure.

This runbook requires production authority and destructive-action approval. It
was not executed by the RAL-79 implementation lane.

## Resource-family, role, projection and cache matrix

The matrix links every application family to its fail-closed authority and the
executable evidence that exercises its projection or cache path.

| Resource family | Tenant/event/role boundary | Projection/cache path | Executable evidence |
|---|---|---|---|
| Identity, membership, portal grants | server-owned organization/event memberships; revoked/suspended relationships produce no permissions | `users`, membership tables, sessions, grants and scoped contact lookup | `auth-runtime.test.ts`, `auth-authorization.test.ts`, `speaker-portal-service.test.ts` |
| Event and form configuration | organizer/owner writes, public reads only from published event/form versions | Airtable authority to `p_events`, `p_forms`, fields/rules and CFP policy | `airtable-runtime.test.ts`, `public-cfp-policy.test.ts`, `cfp-form-service.test.ts` |
| Contacts and speaker profiles | owner/organizer or relationship-owned speaker access; foreign event/tenant denied | `p_contacts`, `p_event_contacts`, private R2 headshot and public profile projection | `speaker-profile-runtime.test.ts`, `speaker-profile-image.test.ts`, `portal` tests |
| Submissions and participants | submitter ownership for CFP; event-manage for organizer reads/commands | `p_submissions`, answers, participants, idempotent authority and organizer queue | `cfp-route-security.test.ts`, `cfp-submission-authority.test.ts`, `organizer-submissions-runtime.test.ts` |
| Rubrics, reviews and decisions | reviewer assignment for scoring; organizer authority for assignment/decision | rubric/review/score/decision projections and immutable snapshots | `review-operations-runtime.test.ts`, reviewer and decision browser suites |
| Sessions, participants and agenda | relationship-owned session reads; organizer writes; foreign event/tenant denied | session/room/track/slot projection, Durable Object coordinator and publication snapshots | `agenda-coordinator-workerd.test.ts`, `schedule` tests, `agenda-publication.spec.ts` |
| Public schedule | published-only projection with no private contact fields | versioned schedule snapshot and generation-safe Cache API invalidation | `public-schedule-cache.test.ts`, `public-schedule.spec.ts` |
| Tasks and readiness | speaker can read/write own assignments; organizer manages exact event | task definition/assignment/readiness projections plus reminder Workflow replay | `task-readiness-service.test.ts`, `task-reminder-workflow.test.ts`, `task-completion.spec.ts` |
| Private files | owner/relationship/event authorization on every intent, finalize and download | D1 file lineage plus exact private R2 key/version; no public bucket/list path | `upload-policy.test.ts`, `uploads-runtime.test.ts`, `uploads-writes-disabled.test.ts` |
| Templates, campaigns and delivery | organizer-only authoring; audience frozen server-side; provider callbacks signed | template/campaign/message projections, Queue handoff, redacted delivery ledger | email/template/campaign unit and Workerd tests plus `campaigns.spec.ts` |
| API keys and public API | owner-only create/revoke; declared organization/event scope checked per operation | salted/peppered key metadata, audit receipt and schema-generated OpenAPI | `public-api-contract.test.ts`, `public-api-runtime.test.ts`, `api-access.spec.ts` |
| Integrations, webhooks and reconciliation | organization/event scope; feature gates and signed inbound callbacks | outbox, webhook delivery, external mapping, repair/reconciliation and provider readiness | `provider-acceptance.test.ts`, Airtable/reconciliation, webhook/email tests |
| Audit and observability | actor/scope supplied by trusted service; client cannot write ledger fields | append-only redacted audit/delivery facts and 30-day operational event retention | `schema.test.ts`, `observability.test.ts`, authority/service tests |
| Privacy export/delete | active owner only; same-origin session + CSRF; exact organization; no partial delete | direct bounded reads of minimized D1 subject projections; coordinated Airtable/R2/provider runbook | `privacy.test.ts`, `privacy-runtime.test.ts` |

## RAL-79 requirement-by-requirement sign-off

| Acceptance requirement | Evidence and release assertion | Status |
|---|---|---|
| Cross-organization/event/role matrix across every resource family and projection/cache path | Matrix above; full unit/Workerd/browser suites are protected required checks | PASS when protected CI is green |
| CSRF/origin, XSS/sanitization/CSP, webhook SSRF/signing, magic-link replay, rate/enumeration and API-key scope/revoke | Auth/security/abuse/upload/email/public-API tests; attachment routes use `sandbox`, `nosniff` and safe disposition; static assets set CSP | PASS when protected CI and CodeQL are green |
| R2 type spoof/executable/path/cross-tenant/expiry | upload policy and Workerd lifecycle tests cover signature sniffing, HTML/SVG, MIME/extension mismatch, size, traversal, one-time capability, replacement and authorization | PASS when protected CI is green |
| Logs/errors/client bundle/source archive scanned for keys, tokens, email body and private URLs | structured telemetry allowlist, redacted runtime tests, public-repository scanner, bundle build and protected Gitleaks history scan | PASS when static/build and Secret scan are green |
| Dependency/license audit has no unaccepted critical/high; P0/P1 fixed and retested | lockfile audit is a protected static check; production dependency licenses remain permissive; current review found no known P0/P1 | PASS when dependency audit, CI and CodeQL are green |
| Basic export/delete-by-email operation or bounded documented policy | owner-scoped minimized export is implemented; partial deletion is rejected; coordinated 30-day policy and operator runbook are above | PASS |
| Signed checklist with residual risk and zero known P0/P1 | this document plus Linear receipts records the exact base/head/main and all residual external requirements | PENDING protected checks and exact-main receipt |

## Residual risk and external release requirements

- No partial automated deletion exists. This is a safety invariant, not a hidden
  gap: deletion must coordinate authoritative Airtable, private R2, downstream
  providers and D1, and requires a separately authorized operator.
- The bounded JSON export does not inline private file bytes or provider-held
  message bodies. The operator must attach those through the private request
  system when they are part of the verified subject response.
- Protected CI, Secret scan, CodeQL and the exact-main post-merge checks are the
  release authority. Local results cannot replace them.
- Greptile is explicitly waived for this change because of the recorded outage.
- Production verification of an actual subject request remains external and is
  not claimed. No deployment, live export, live deletion, provider mutation,
  migration, R2 operation or production write occurred in this lane.

## Receipts

The implementation PR, protected check runs, dependency audit, merge SHA and
exact-main verification are recorded in Linear RAL-79. Do not add recipient
addresses, secrets, private URLs, raw export data or local absolute paths here.
