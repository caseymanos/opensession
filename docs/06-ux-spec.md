# UX specification

## Experience principles

1. **Show the next consequential action.** Each role lands on a prioritized work queue, not a generic dashboard.
2. **Make irreversible actions legible.** Decisions, bulk sends, publishing, exports, and resets expose audience/scope, validation, and a confirmation step.
3. **Preserve context.** Filters live in the URL, drawers retain the table position, autosave is visible, and every failure explains what was preserved.
4. **Design for the judge's first five minutes.** Seeded credentials, sample data, and setup progress make every firm workflow discoverable.
5. **Keyboard is first-class.** Drag/drop always has a form/keyboard equivalent; focus and announcements are intentional.

## Information architecture

```text
/app/:eventSlug
  /home                    readiness and action queue
  /cfp                     form versions, builder, preview, publication
  /submissions             table, detail, routing, decisions
  /reviews                 assignment, rubric, reviewer progress
  /people                  speakers/reviewers and individual readiness
  /tasks                   definitions, assignments, responses/files
  /communications          templates, campaigns, delivery log
  /agenda                   builder, conflicts, publication
  /resources               speaker pages (stretch)
  /integrations            Airtable, Accelevents, webhooks, API keys
  /settings                event, tracks, rooms, formats, roles

/submit/:eventSlug         public welcome, identity, form, participants, review
/review/:eventSlug         reviewer queue and score form
/portal/:eventSlug         speaker home, profile, sessions, tasks, resources
/e/:eventSlug              public schedule and speaker gallery
/embed/:eventSlug/*        isolated schedule/gallery embeds
/api/v1/*                  documented public API
/docs/api                  OpenAPI reference
```

## Shared application shell

- Event switcher/name, environment badge outside production, and global command/search entry.
- Left navigation grouped as Collect, Decide, Prepare, Publish, Configure.
- Header shows setup completion before launch and unresolved blocking count after launch.
- Narrow screens use a labeled bottom sheet menu; key tables become list cards without hiding actions.
- Toasts acknowledge completed actions, but persistent state/failure remains in-page.
- A demo banner identifies synthetic data and provides guarded reset; production never renders reset.

## Organizer flows

### First-run setup

1. Create or choose the deterministic demo event.
2. Complete event dates/timezone, tracks, rooms, formats, rubric, tasks, sender, and Airtable connection.
3. Checklist validates prerequisites and deep-links to the failing setting.
4. “Preview judge event” opens the public CFP in a new tab.

The checklist distinguishes blocking, recommended, and stretch items. Secrets show configured/unconfigured plus last check, never values.

### Build and publish CFP

- Left rail: ordered field/block palette.
- Center canvas: sections and fields with clear drop targets; clicking selects.
- Right inspector: stable key, copy, help, validation, options, rule, route.
- Rules are expressed in plain language and previewable against sample answers.
- Unsaved indicator, undo for current session, validation summary, version history.
- Publish dialog lists public URL, opening/closing time in event timezone, changed fields, and impact on existing drafts.

### Submission triage

- Dense but readable table with title, submitter, track, status, reviewers, score, last activity.
- Saved filters are optional; default chips cover new, incomplete reviews, accepted, waitlisted.
- Detail drawer/page keeps answers, participants, review summary, history, and actions together.
- Decision dialog shows consequence checklist: status, session creation, task assignment, portal invitation, selected email, ICS behavior.
- Decision can be recorded without sending; sending has explicit template preview.

### Review operations

- Assignment matrix supports individual reviewer selection and routed group default.
- Reviewer progress shows assigned/in progress/submitted and missing criteria.
- Aggregate charts never imply scores for absent reviews and expose raw reviews.
- AI suggestion, if enabled, is a labeled non-authoritative note that cannot submit or decide.

### Speaker readiness

- Summary cards always drill into a filtered table.
- Main table columns: speaker, sessions, ready ratio, next due, overdue, portal state, quick contact.
- Cell details explain numerator/denominator and approval requirements.
- Bulk reminder starts from current filters, computes recipients server-side, then previews exclusions and recipients.
- Speaker page unifies profile, sessions, assignments, files, messages, and audit history.

### Agenda builder

- Unscheduled sessions rail supports search, track/format filters, and session-duration display.
- Grid uses days as tabs and rooms as columns; track color is supplementary to labels.
- Dragging provides a live time/room target and conflict feedback; Escape cancels.
- Keyboard action “Schedule…” opens day/start/room/duration fields with equivalent validation.
- Conflict drawer groups hard blocks and soft warnings with direct links to both affected sessions.
- Save is optimistic visually but becomes durable only after server response; stale-version response reloads impacted slots and preserves attempted values.
- Publish preview lists unscheduled accepted sessions, hard conflicts, missing rooms/times, and public URL/cache state.

### Communications

- Template editor separates subject/body and displays allowed merge fields with types.
- Preview renders seed or selected recipient data and flags missing values before save.
- Campaign composer shows audience query, count, exclusions, sample recipients, template version, sender/reply-to, schedule.
- Delivery log supports status filters and safe error codes; retry is idempotent and excludes delivered recipients.

## Submitter flow

The public CFP mirrors the competition reference sequence: **Welcome → Account → Submission → Participants → Review**.

- Welcome requires no account and carries event dates, deadline, submission limit, tracks, resources, and contact.
- Account verifies email through a one-time link/code and returns to the same step.
- Submission autosaves on blur and debounce; top status says Saving/Saved/Offline/Failed with retry.
- Conditional content inserts without moving focus unexpectedly and announces newly required fields.
- Participants starts with the verified contact; co-speakers can be invited later without blocking a draft.
- Review is a structured summary with Edit links, consent, and clear finality.
- Confirmation gives friendly ID, email destination, edit policy, and portal/status link.

## Reviewer flow

- Magic link lands on assigned queue with due date, progress, track, and conflict control.
- Review page keeps proposal content and sticky score panel side by side on desktop, sequential on mobile.
- Scores require guidance-visible controls, validation, and Save draft; Submit is a distinct confirmation.
- Submitted review becomes read-only with submitted time and organizer-reopen explanation.

## Speaker portal

- Home leads with outstanding required action and readiness explanation.
- Profile preview shows how content will look publicly.
- Assignment cards state what, why, owner session, due date, required/approval, and current state.
- File upload includes allowed types/size, progress, scan/processing state, replace, and downloadable version.
- Session page shows title/abstract, schedule, participants, calendar action, related tasks.
- Expired links retain event branding and email, with throttled resend rather than a dead end.

## Public surfaces

- Mobile-first day switcher and sticky search/filter button.
- Cards always include local day/time, title, track label, room, and speaker names.
- Session detail is linkable and retains originating filters/back behavior.
- Speaker gallery includes search, profile, and published sessions.
- No login, tracking requirement, or third-party cookie dependency.
- Embed has intrinsic loading state, responsive height messaging, and a direct “Open full schedule” link.

## State inventory

Every high-value page receives explicit designs/tests for:

- initial loading and stale cached data;
- true empty versus empty filter result;
- partial response and retryable upstream failure;
- validation anchored to field plus summary;
- permission denied and wrong-event access;
- expired/redeemed magic link;
- offline/autosave failure and safe resume;
- stale write/conflict;
- rate limit with retry time;
- success with a useful next action.

## Accessibility acceptance

- WCAG 2.2 AA contrast and visible focus.
- One logical H1; landmark and heading hierarchy.
- Labels, descriptions, errors, and required state are programmatic.
- Dialog focus is trapped/restored; no action requires pointer or color perception.
- Live regions announce autosave, conditional fields, scheduling conflict, upload progress, and queued send.
- Table semantics remain on desktop; responsive cards preserve accessible names.
- Critical flows pass axe plus manual keyboard and VoiceOver smoke tests.

## Responsive checkpoints

- 360×800: public CFP, portal tasks, schedule/gallery, reviewer scoring.
- 768×1024: all flows usable; agenda may use horizontal room scrolling with frozen time axis.
- 1440×900: organizer primary demo viewport.
- 200% zoom at 1280 CSS px remains functional without clipped controls.

