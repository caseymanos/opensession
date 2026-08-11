# Task and readiness policy

This document defines the provider-neutral task and speaker-readiness contract. Airtable remains the business-data authority. D1 is a bounded event-scoped read and operations projection; D1 state alone never authorizes a business write.

## Definitions and targeting

An organizer task definition is one of:

- `ack`: an acknowledgement with organizer-authored label;
- `link`: an HTTPS URL plus an acknowledgement;
- `form`: a bounded structured form with stable field IDs;
- `file`: a private-file policy containing allowed extensions, byte and file limits. The task contract does not implement upload transport.

Every definition records its description, required flag, approval requirement, optional event-local due policy, and target. Contact targets can include or exclude stable contact IDs and match event roles. Session targets can additionally match stable session, track, format, and participant-role IDs. A contact-scoped definition produces at most one assignment per contact; a session-scoped definition produces at most one per contact and session. Stable assignment IDs are derived from event, definition, contact, and optional session.

Acceptance materialization is a narrow boundary for acceptance orchestration. The caller supplies an acceptance ID, command ID, and accepted session IDs. The service snapshots applicable definitions and participants, fails closed above 5,000 applicable assignments, stores an immutable operational plan receipt, and submits one idempotent authority command per missing assignment. Retrying the same command resumes the stored plan; changing its payload is a conflict. This boundary creates assignments only and does not send email, write calendars, or own the broader acceptance workflow.

## Target changes and backfill

Target changes require a current preview ID. The preview records:

- assignments that will be created;
- assignments that still match and will be preserved;
- assignments that no longer match but will also be preserved.

The policy is `additive_preserve_existing`. A targeting edit never silently removes or waives existing work. The preview hash covers the definition version and target, event, timezone, applicable identities, existing identities, and policy. A stale preview fails closed. Definition and child-assignment authority commands use safe audit diffs; responses, reason text, provider record IDs, and private file IDs are excluded from audit metadata.

## Assignment state machine

The provider-neutral states are `incomplete`, `submitted`, `complete`, `approved`, and `rejected`.

- A speaker may submit an `incomplete` or `rejected` assignment.
- An organizer may submit one on a speaker's behalf.
- A submitted assignment may be rejected, completed when approval is not required, or approved when approval is required.
- An organizer may directly complete a non-approval assignment with a reason.
- Any non-incomplete assignment can be reset to incomplete with a reason.

Every transition requires the current version and a unique command ID. Successful transitions append an immutable history entry containing actor type and ID, exact time, from/to states, normalized reason, command ID, and new version. Reusing a command ID with another payload or actor is a conflict. Stale versions and illegal transitions fail before authority mutation.

## Readiness invariant

For a speaker, let `R` be the assigned tasks whose assignment-level `required` flag is true. A task satisfies readiness when:

- it does not require approval and its state is `complete` or `approved`; or
- it requires approval and its state is exactly `approved`.

Readiness is `ready` if and only if `R` is non-empty and every task in `R` satisfies that rule. Submission alone never satisfies an approval-required task.

The ratio is `satisfied required / all required`, with a whole-number percent. Outstanding is the unsatisfied required count. Overdue is the outstanding required count whose UTC due instant is strictly earlier than `now`; equality at the due instant is not overdue. Next due is the earliest outstanding due instant and is returned with its event-local date, time, and IANA timezone.

Zero assignments produce `configuration: no_assignments`, `status: not_configured`, a `0 / 0` ratio with null percent, and an explanation. Optional-only assignments produce `configuration: optional_only` with the same non-ready ratio semantics and a distinct explanation. Neither state is treated as ready.

Definition due values are entered as an event-local date and time. They are resolved once at materialization using the event's IANA timezone. Nonexistent DST wall times are rejected. Repeated wall times require explicit `earlier` or `later` disambiguation, or are rejected when the policy is `reject`.

## Authority and repair outcomes

The business write succeeds only through the event tenant's Base Authority. A durable response means Airtable committed and D1 projected. `repair_pending` means Airtable committed but the D1 projection needs repair; callers must show the response as pending rather than retrying with a new command ID. An outcome-unknown response leaves the plan receipt resumable. Replaying the same command reconciles through the child authority receipts and cannot create a second assignment.
