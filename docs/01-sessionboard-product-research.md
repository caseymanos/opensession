# Sessionboard product research

Research findings verified: 2026-08-08. Source availability and response digests recaptured: 2026-08-11T19:56:27Z. Official product, help-center, API, supplied screenshot, and live-CFP evidence only.

This document is a competitive reference, not an implementation source. OpenSession code, interaction design, copy, and fixtures are original. Third-party HTML, screenshots, specifications, and proprietary assets are not redistributed in this repository.

## Product shape

Sessionboard is an event content and speaker-operations platform. Its current public catalog spans:

- submission forms and draft CFPs;
- abstracts, review plans, AI evaluation, and acceptance;
- speaker/contact CRM and event reuse;
- speaker portals, tasks, forms, file requests, and resources;
- templated email/SMS and campaigns;
- agenda planning and public embeds;
- sponsors/exhibitors, payments, content/media, transcription, reporting, and integrations.

The competition asks for the central program workflow, not the full catalog.

## Information architecture observed in supplied screenshots

Organizer navigation is event-scoped, with prominent modules for Dashboard, Program, CRM, Marketing, CMS, Reports, Studio, History, Event Team, Preview, and Settings. Within Program, the observed working areas are Overview, View All, Abstracts, Sessions, Files, Forms, Evaluation, Agenda, Invoices, and Site. Portal operations include Portals, Tasks, Forms, and File Requests.

What is worth retaining:

- persistent event switcher and event dates;
- module labels that match organizer language;
- data tables for bulk work;
- multi-step builders with a visible completion rail;
- status chips with strong semantic color;
- public CFP stepper: Welcome → Account → Submission → Participant → Review;
- speaker home that leads with “My Submissions” and status;
- dashboard cards that lead directly to actionable lists.

What to improve:

- reduce three-level side navigation for a weekend-sized product;
- keep all setup progress in one event setup checklist;
- make missing requirements and blocking conflicts visible without custom dashboards;
- avoid duplicating “forms” concepts by clearly labeling CFP forms vs onboarding forms;
- preserve keyboard/table workflows next to drag-and-drop.

## Firm workflow findings

### F1 — CFP builder

Sessionboard exposes a wizard with submission setup, welcome screen, abstract/session questions, participant information, payment/fees, and form settings. Official guidance confirms:

- abstract vs finalized session submission types;
- speaker/chairperson/moderator participant roles and min/max counts;
- draft saving;
- form open/close windows;
- title, description, learning objectives, standard/custom fields;
- layouts using headers/text blocks;
- question rules/conditional logic;
- submission limits and administrator notifications;
- reminders five days and one day before close.

The live AI Engineer sandbox CFP shows a five-step public flow and a three-submission limit. Its welcome screen combines event pitch, tracks, resources, deadlines, and the explicit promise that accepted speakers receive portal tasks.

Decision: implement a smaller builder with six stable block types (short text, long text, single select, multi-select, URL, file) plus section text. Conditional rules are `show`/`require` predicates over prior single/multi-select answers. Category routing writes the selected track and reviewer pool; no general workflow language is needed.

### F2 — Speaker portal

Sessionboard's portal is the speaker home base for submissions, profile fields, files, task assignments, forms, and resources. Official docs distinguish:

- generic tasks with due date, required flag, optional link, completion lock;
- forms that collect structured fields and files;
- file requests with review/approval state;
- resources/wiki pages assigned to one or more portals;
- portal visibility and filtering by contact/session criteria;
- admin preview-as-user mode.

Decision: one portal per event with role/track targeting on assignments. Provide profile, submissions, tasks, resources, and schedule tabs. Use passwordless signed invitations; speakers do not need to understand organizations or accounts before completing work.

### F3 — Communications and calendar

Sessionboard supports reusable templates, merge fields by module, reply-to, CC/BCC, previews, scheduled/recurring campaigns, delivery history, and system emails. Its default automations include submission confirmation, draft reminders, new task notice, and reviewer progress reminders.

Decision: deadline scope includes template CRUD, merge-field validation, preview, audience filters, immediate/scheduled send, delivery log, and four system triggers: submission receipt, acceptance/decline, task assigned, and task due reminder. Generate RFC 5545 invitations with stable UID/SEQUENCE; email attachment support is the cross-calendar path.

### F4 — Evaluation

Sessionboard review plans use filtered submission pools, evaluator assignments, rubrics, rating scales, progress tracking, comments, exports, and cumulative scoring. It supports rounds, caps, and AI, but those extensions are explicitly optional here.

Decision: one review round is the shippable path. Each event has one or more rubrics; each criterion has label, help text, 1–5 scale, and weight. Reviewer conflicts can be flagged manually. Aggregate uses weighted mean and shows review count/disagreement; final accept/decline remains an organizer decision.

### F5 — Agenda

Sessionboard officially supports list, day, week, month, and rooms views; accepted sessions are draggable; tracks control colors; rooms/time can be customized. Conflict detection reports:

- overlapping sessions in the same room;
- double-booked speaker, chairperson, or moderator.

The public product also markets unscheduled-session staging, status indicators, quick editing, version history, and publishable embeds.

Decision: provide an unscheduled rail plus day/room grid as the editing surface. List/week/track/room are projections over the same schedule. Conflict checks run both optimistically while dragging and authoritatively on save. A judge can override soft warnings with a reason, but room and person overlaps are hard errors by default.

### F6 — Readiness dashboard

The generalized Sessionboard dashboard is broad and configurable. The competition needs a narrower operational view.

Decision: fixed cards for total/accepted submissions, unscheduled accepted sessions, conflicted sessions, speakers complete, speakers outstanding, and overdue tasks. The main table groups by speaker and shows required tasks as explicit status cells. Every metric links to a filtered work queue.

## Best-effort findings

### Accelevents

Sessionboard markets Accelevents alongside other event-platform integrations. The challenge asks only for one-way export, so do not build webhook-based bidirectional ownership. The local product owns accepted speakers/sessions and pushes a projection to Accelevents.

### Resources and embeds

Sessionboard resource pages contain title, subtitle, rich text, images, and links. Public embeds can output styled HTML, plain HTML, JSON, XML, or iCal; types include schedule itinerary, speaker gallery, agenda, session list, and speaker list. Its styled embeds update on a cache cadence.

Decision: ship native public pages first, then a single script embed and JSON/iCal feeds. Resource HTML is sanitized; arbitrary scripts are not stored or executed. Allowlisted iframe embeds are a stretch flag.

## Competitive API findings

The public Sessionboard API is unusually broad for this category (177 operations across 131 paths in the captured OpenAPI). It has region-specific base URLs, scoped API tokens/OAuth 2.1, bulk writes, soft deletion, optimistic concurrency, public webhooks, agenda drafts, reporting queries, file/media flows, and session/contact CRUD.

Our bonus API should compete on clarity rather than breadth: stable v1 resources for events, submissions, speakers, sessions, tasks, schedule, and public feeds; predictable cursor pagination; idempotency keys; OpenAPI examples; scoped tokens; and outgoing webhooks for the state transitions the demo actually performs.

## Product risks learned from the research

- “Forms” is overloaded across CFP, portal onboarding, and generic field definitions.
- Speaker/contact identity can duplicate by email across submissions.
- Draft submission reminders require accurate event timezone and form close time.
- Acceptance, participant confirmation, and final scheduled-session status are distinct states.
- A speaker can participate in multiple sessions; conflicts must use participant links, not a single speaker field.
- A session can be accepted but unscheduled; public publication rules must exclude it until complete.
- Upload workflows need content-type/size enforcement and private-by-default delivery.
- Bulk emails and exports must tolerate partial failure without duplicating side effects.

## Primary sources

The manifest records the exact requested URL, redirect-resolved URL, UTC capture time, HTTP status, and SHA-256 of the decompressed raw response bytes. Dynamic vendor pages may produce a different digest later; the digest identifies the private research snapshot used for this reference and is not a vendored-content integrity pin.

| Requested URL | Resolved URL | Captured (UTC) | Status | SHA-256 |
|---|---|---|---:|---|
| `https://www.sessionboard.com/pricing` | same | 2026-08-11T19:56:27Z | 200 | `da5cf412006744051bb35bc053a48653137748272798491649e491d10765a2c1` |
| `https://www.sessionboard.com/explore-the-platform` | same | 2026-08-11T19:56:27Z | 200 | `01179bbffc313f3d426e01dfc0daa392fe261fcf02322c7085ca53fde583aa82` |
| `https://learn.sessionboard.com/en/knowledge-base/6284018-create-a-session-submission-form` | `https://learn.sessionboard.com/sessions/submission-forms` | 2026-08-11T19:56:27Z | 200 | `44e0ac0684f008d0400f353e85de1bddf47d5a16ea348eeffd2d05b487877c75` |
| `https://learn.sessionboard.com/en/knowledge-base/7102247-create-manage-evaluation-plans` | `https://learn.sessionboard.com/evaluations/evaluation-plans` | 2026-08-11T19:56:27Z | 200 | `8906a4e6e5408eb4375c96e3107c4f8ec98a44ed91385ff21cf7184d81d4ab52` |
| `https://learn.sessionboard.com/en/knowledge-base/6284026-build-and-manage-your-agenda` | `https://learn.sessionboard.com/sessions/agenda` | 2026-08-11T19:56:27Z | 200 | `b2af3b445e0d60cc8fe8ca4a1ec12853cb1e95c3a421fd46f31082ef8893b2cf` |
| `https://learn.sessionboard.com/en/knowledge-base/6284020-configure-customize-portals` | `https://learn.sessionboard.com/portals/portals-101` | 2026-08-11T19:56:27Z | 200 | `4a3840208a958542e972b8cb536025fc8a5e705f8f33e32447624344551e7983` |
| `https://learn.sessionboard.com/en/knowledge-base/6284057-assign-tasks` | `https://learn.sessionboard.com/portals/assign-tasks` | 2026-08-11T19:56:27Z | 200 | `3c810f286edc516e09b3349fdbd1d894fd0ebed015f6b2c83fd292cb2ec15df0` |
| `https://learn.sessionboard.com/en/knowledge-base/6949616-agenda-speaker-embeds` | `https://learn.sessionboard.com/sessions/embeds` | 2026-08-11T19:56:27Z | 200 | `b384d47578b306f86840c7e9c090a41068f83c5f2f8009cf08db58d8579c195a` |
