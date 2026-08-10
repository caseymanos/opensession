# Product specification

Working name: **SessionBox Killer** (internal; final naming is a bounded launch task)  
Target: open-source, multi-event conference program operations  
Deadline: 2026-08-12 22:00 America/Los_Angeles

## Product promise

Run the speaker program from proposal to published agenda without spreadsheets, inbox archaeology, or a $40k annual SaaS contract.

## Users and jobs

### Program organizer

- Launch a CFP without engineering help.
- See where submissions belong and who should review them.
- Make consistent acceptance decisions.
- Know which speakers and sessions are not ready.
- Build a schedule without double-booking people or rooms.
- Communicate at scale without losing confidence in recipients/content.
- Export the final program to the registration platform and website.

### Speaker / submitter

- Understand the event, deadlines, and expectations before creating an account.
- Save and resume a proposal.
- Know its status.
- Maintain one profile and upload requested files.
- See exactly what is due and when.
- Receive reliable reminders and calendar invitations.

### Reviewer

- See only assigned proposals and relevant context.
- Score quickly against a consistent rubric.
- Save progress, disclose conflicts, and know what remains.

### Attendee / public visitor

- Find sessions by time, track, room, topic, or speaker on mobile.
- Open speaker/session detail without a login.
- Add the program or a session to a calendar.

## Core state model

### Submission lifecycle

`draft → submitted → under_review → accepted | waitlisted | declined | withdrawn`

Acceptance creates or links a program session and grants the participant portal's onboarding task set. A submission can be reopened by an organizer with an audit note.

### Speaker readiness

`not_invited → invited → active → ready`

Ready means every required assignment for the speaker and their accepted sessions is complete and approved where approval is configured. Overdue is a derived flag, not a separate terminal state.

### Session lifecycle

`proposed → accepted_unscheduled → scheduled → published → canceled`

Only scheduled/published sessions can appear in the public agenda. Publication is event-level and validates zero blocking schedule conflicts.

### Review lifecycle

`unassigned → assigned → in_progress → submitted`

Submitted reviews are immutable to reviewers; organizers can reopen with an audit entry.

## Scope by release gate

### P0 — competition vertical slice

- Organization/event bootstrap and deterministic demo seed/reset.
- Organizer passwordless authentication and roles.
- CFP form builder with conditional logic/routing and public form.
- Draft/resume/submit with spam protection.
- Submission table/detail/status transitions.
- Reviewer assignments and weighted rubric.
- Acceptance action and speaker onboarding generation.
- Speaker passwordless portal, profile, tasks, forms, files.
- Template CRUD, merge preview, acceptance/task/due emails, ICS invite.
- Agenda unscheduled rail, day/room drag/drop, conflict validation, list/week/track/room views.
- Fixed readiness dashboard and work queues.
- Airtable authoritative domain persistence, D1 read projection, R2 uploads.
- Public API docs, public schedule/gallery pages, observability, production deploy.

### P1 — bonus-complete

- Accelevents dry-run/manual/queued one-way export.
- Resource/wiki pages with safe rich text.
- Script embed, JSON feed, and event iCal.
- Outgoing signed webhooks.
- Lightweight AI review suggestion behind an explicit setting, if core gates remain green.

### P2 — post-competition

- Multi-round evaluations, reviewer caps, blind review.
- Generalized dashboard/report builder.
- Google/Outlook calendar OAuth sync.
- Multi-language content.
- SSO/SCIM, custom domains, SMS, sponsor/exhibitor workflows.
- Bidirectional event-platform sync.

## Detailed functional requirements

### Event setup

- Create event with name, slug, timezone, start/end, venue, logo, brand colors, reply-to, CFP dates, and default session duration.
- Configure tracks, rooms/capacity, formats, and reviewer rubric.
- Setup checklist deep-links to incomplete requirements.
- Clone demo/config to a new event without submissions or secrets.

### CFP form builder

- Draft/published/closed states and version number.
- Immutable submission snapshot preserves the form version seen by the submitter.
- Blocks: section text, short text, long text, URL, single select, multi-select, file.
- Field settings: stable key, label, help text, required, min/max length, options, visibility.
- Rule builder: `show` or `require` a field when a prior choice equals/includes a value.
- Routing: selected category/track maps to reviewer group and submission track.
- Preview desktop/mobile; publish generates public URL.
- Close date stops new submissions and optionally edits; draft reminders derive from event timezone.

Acceptance:

- Judge creates a “Session format” choice and a “Workshop prerequisites” conditional field.
- Public user selecting Workshop sees and must complete the field; selecting Keynote does not.
- Track choice places submission in the expected admin filter/reviewer queue.
- Published forms remain valid after organizer creates a new draft version.

### Public submission

- Welcome page renders event pitch, resources, dates, tracks, and submission limit.
- Passwordless email verification creates/resumes identity.
- Autosave with explicit last-saved state and local recovery fallback.
- Participant step captures primary/contact plus optional co-speakers.
- Review page shows all answers, editable section links, consent, and final submit.
- Confirmation screen/email includes submission ID and portal link.

### Review and decision

- Organizer assigns reviewers individually or by routed group.
- Reviewer inbox shows pending/in-progress/complete.
- Criteria have 1–5 score, weight, guidance, and optional comment.
- Aggregate shows weighted mean, review count, and score range; never fabricates missing reviews.
- Organizer acceptance/waitlist/decline records reason/note and can send a selected template.
- Acceptance generates program session, participant links, portal access, default task assignments, and ICS invitation exactly once.

### Speaker portal and onboarding

- Magic link expires; a logged-in speaker can request another.
- Home shows status, days until event, outstanding/overdue tasks, and assigned sessions.
- Profile fields: display name, pronouns, title, company, bio, headshot, socials.
- Task types: acknowledgement/link, structured form, file request.
- Each assignment shows required flag, due date, description, completion/approval, and owner session where relevant.
- File upload shows validation/progress, supports replacement/version metadata, and private download.
- Resource pages support safe rich text/images/links and target all speakers, track, or session.
- Ready badge is computed consistently with organizer dashboard.

### Communication

- Templates: internal name, audience, sender name, reply-to, subject, rich body, merge fields.
- Supported merge fields are typed and validated; preview can use a selected real recipient or seed data.
- Send screen shows exact audience filter/count and at least five preview recipients.
- Queue is idempotent by campaign/recipient/template version.
- Statuses: queued, sent, delivered, bounced, failed; provider webhooks update status.
- System triggers: submission receipt, decision, new assignment, reminder, schedule changed.
- Reminder workflow selects only currently incomplete assignments at execution time.
- Calendar invitation: stable UID, UTC timestamps plus timezone metadata, organizer, attendee, location, description, `METHOD:REQUEST`, and incrementing SEQUENCE. Cancel/reschedule uses same UID.

### Agenda and conflicts

- Event days and business hours define the grid.
- Unscheduled accepted sessions can be filtered/searched.
- Drag/drop and keyboard edit set day, start, duration, room.
- Snap interval configurable; deadline default 15 minutes.
- Hard conflicts: same room overlap; any shared participant overlap.
- Soft warnings: room capacity below expected attendance; transition time under configurable buffer; missing required speaker tasks.
- Conflict message names both sessions, conflicting entity, and overlap interval.
- Server revalidates against latest schedule before save.
- Views: list, day, week, track, room; filters share URL state.
- Publish validates hard conflicts and missing time/room, then invalidates public cache.

### Readiness dashboard

- Cards: new submissions, reviews remaining, accepted unscheduled, conflicts, speakers ready, speakers outstanding, overdue assignments.
- Primary table: speaker, sessions, required-complete ratio, next due item, overdue count, contact action.
- Filters: track, status, task, due state, search.
- Every aggregate has a drill-through and empty-state explanation.
- Updates are visible after successful mutation without manual refresh.

### Public schedule and gallery

- Mobile-first schedule with day switcher, search, track/room filters.
- Session card/detail includes time, room, format, track, speakers, abstract, calendar link.
- Speaker gallery/search and profile with assigned published sessions.
- Accessible script embed resizes via `postMessage`; no third-party cookie requirement.
- JSON feed has ETag/cache headers; iCal has stable event UIDs.

### API and webhooks

- Organizer creates/revokes scoped keys and sees prefix/last-used, never secret again.
- OpenAPI docs include working curl examples and seeded IDs.
- Rate limits and pagination are documented.
- Webhook endpoint config stores URL, event set, signing secret hash/encrypted secret, status.
- Delivery log supports inspection and replay with identical delivery ID semantics.

## Cross-cutting requirements

- Accessible at WCAG 2.2 AA for critical flows; complete keyboard schedule editing even if drag/drop is inaccessible.
- No secret or private upload URL in client bundles/logs.
- All organizer mutations create audit events with actor, action, entity, timestamp, and safe diff.
- All displayed times use event timezone; stored times are UTC plus IANA timezone context.
- Destructive/bulk/communication actions provide preview and confirmation.
- Seed/reset never operates on a non-demo event.
- Empty, loading, partial-failure, permission-denied, expired-link, offline/retry, and rate-limited states are designed, not accidental.

## Definition of done for a feature

1. Acceptance criteria work through UI and API where applicable.
2. Authorization and tenant isolation tests exist.
3. Happy path, validation, empty, retry, and failure states are handled.
4. Audit/observability events are emitted without PII leakage.
5. Keyboard and narrow-mobile flow pass.
6. Seed fixture demonstrates the feature.
7. Documentation and API schema are current.
8. Production smoke path is green.

