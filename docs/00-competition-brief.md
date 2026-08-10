# Competition brief and requirement traceability

Last verified: 2026-08-08  
Authority: the organizer-supplied competition brief, including tracked deletions, screenshots, and reviewer comments. The proprietary source document is intentionally not redistributed in this repository.

## Executive read

The product must replace the operational center of a conference program, not Sessionboard's entire modern feature catalog. The winning strategy is a complete, fast, humane path across four people:

1. An organizer configures a CFP and publishes it.
2. A speaker submits, then completes onboarding in a self-service portal.
3. A reviewer scores the proposal and an organizer accepts it.
4. An organizer schedules the accepted session without conflicts and publishes a public agenda.

Every firm requirement appears in that path. The generalized CRM, sponsors/exhibitors, AI agents, media/transcription platform, custom report builder, payments, SMS, SSO, and enterprise governance are outside the competition's required replacement boundary.

## Traceability matrix

| ID | Requirement | Source status | Planned proof |
|---|---|---|---|
| F1 | Conditional, category-routed CFP form builder | Firm #1 | Organizer creates/publishes a form; judge submits through two conditional branches; routed category is visible in admin. |
| F2 | Self-service speaker portal for profile and files | Firm #2 | Accepted speaker opens passwordless portal, edits bio/headshot, uploads slides, and sees completion state. |
| F3 | Templated communications, reminders, calendar invites | Firm #3 | Organizer previews/sends a merge-tag template; queued delivery is logged; stable-UID ICS invite validates in Gmail/Outlook/iCal. |
| F4 | Submission evaluation and scoring | Firm #4 | Reviewer completes a rubric; aggregate score and comments appear; organizer accepts/declines with audit record. |
| F5 | Drag/drop agenda, conflict detection, multiple views | Firm #5 | Accepted session is dragged into a room/time; room/speaker collisions block or warn; list/day/week/track/room filters work. |
| F6 | Outstanding-onboarding dashboard | Firm #6 | Organizer sees per-speaker required/complete/overdue counts, filters outstanding owners, and deep-links to the missing task. |
| S1 | One-way Accelevents integration | Struck/best effort | Accepted scheduled sessions, speakers, tags/tracks are idempotently exported; sync log shows mappings/errors/retry. |
| S2 | Portal resources/wiki and HTML embed | Struck/best effort | Organizer publishes rich resource; assigned speakers view safe sanitized content and an allowlisted embed. |
| S3 | Public gallery and schedule embeds | Struck/best effort | Mobile public schedule/gallery plus copyable script/JSON/iCal endpoints. |
| B1 | Cloudflare infrastructure | Mild bonus | Worker/static assets, R2, Workflows, Queues, D1 projection, cache, Turnstile; deployment evidence in README/runbook. |
| B2 | Airtable persistence/database | Bonus | Airtable is authoritative for event-domain records; judge-visible base and sync health prove real use. |
| B3 | Forge hosting | Very small bonus | Time-boxed feasibility spike; never blocks public GitHub/open-source delivery. |
| B4 | Speed/performance | Bonus | Budgets in `09-judge-demo-and-qa.md` pass against deployed production. |
| B5 | Public API | Bonus | Versioned OpenAPI, scoped keys, pagination/errors, docs, and contract tests. |
| D1 | Open-source repository | Submission | License, README, architecture, local setup, seed/reset, contributor/security files. |
| D2 | Deployed site | Submission | Stable production URL with seeded demo accounts and synthetic smoke check. |
| D3 | Submission form | Submission | Owner/completion evidence recorded when form is published by organizers. |

## Product judgment principles

1. **Optimize for “what do I need to chase today?”** The organizer home is readiness, deadlines, conflicts, and recent submissions—not vanity analytics.
2. **Make speakers feel taken care of.** A speaker should never wonder what is due, where to upload, or whether a change saved.
3. **Make dangerous communication deliberate.** Preview recipient count and merge-field output; acceptance/decline sends require confirmation; retries are idempotent.
4. **Let the agenda be forgiving.** Dragging is fast, keyboard editing remains first-class, and conflicts are explained with exact people/rooms/times.
5. **Keep the data portable.** Airtable, CSV/JSON export, public API, and R2 file inventory make lock-in structurally difficult.
6. **Show the whole story in five minutes.** The seeded event demonstrates all six firm workflows without manual back-office setup.

## Non-goals before the deadline

- General-purpose sponsor/exhibitor CRM.
- Ticketing, attendee registration, payments, invoicing, or session streaming.
- SMS campaigns.
- Fully arbitrary no-code automation builder.
- Multi-organization enterprise SSO/SCIM.
- Native Google/Outlook calendar OAuth. Standards-compliant email calendar invitations satisfy the firm requirement.
- AI-first scoring. If added, AI is an assistive suggestion with provenance; it never replaces human scores.
- Pixel cloning Sessionboard.

## Open evidence gates

- Discord judge updates are not yet supplied. They must be appended to `docs/10-discord-updates.md`, mapped to requirement IDs, and triaged in Linear before implementation freeze.
- The organizer submission form is not yet published.
- Cloudflare account/project credentials are intentionally deferred until implementation/deployment.
- Airtable base/PAT, Resend domain/key, AI provider key, and Accelevents sandbox credentials are external setup gates.

## Source interpretation notes

- The visible Word rendering is authoritative for strikethrough. Plain text extraction includes deleted text and therefore overstates requirements 7–9 unless the tracked rendering is consulted.
- Sessionboard's public pricing page currently displays `$249/month` for multiple tiers, while the organizer reports a real annual cost over `$40k`. The product story should cite the organizer's actual pain without claiming that the marketing page is the contractual price.
- The source brief's live CFP link was validated during research; the environment-specific identifier is intentionally not retained here.
