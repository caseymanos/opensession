# Judge walkthrough, QA, and ship gates

## Winning narrative

“A conference team can launch a CFP, evaluate proposals, onboard accepted speakers, communicate, prevent schedule collisions, publish a fast agenda, and inspect every record in Airtable—all from one seeded event on Cloudflare.”

The demo should show a coherent operating system, not a checklist of disconnected pages. Every state change survives reload and appears in the relevant downstream workflow.

## Twelve-minute primary walkthrough

### 0:00–0:45 — orient

- Open the production home for the seeded event.
- State the deadline use case, open-source posture, Cloudflare deployment, Airtable authority, and six firm workflows.
- Point out readiness cards and the single deliberate agenda conflict.

### 0:45–2:15 — CFP builder and public submission

- Open published CFP, clone to draft, add “Workshop prerequisites.”
- Configure it to show/require only when Session format = 90-minute workshop; route the Product alias Track D.
- Preview desktop/mobile, publish version, open public URL.
- In incognito, select Workshop, show conditional validation, autosave/resume, add participant, review, submit.
- Return to admin and show the new routed submission plus the corresponding Airtable records.

### 2:15–3:35 — human review and decision

- Assign seeded reviewer, open reviewer queue, enter weighted rubric scores, save and submit.
- Show aggregate without fabricated missing reviews.
- Accept the submission; preview consequence/template.
- Prove one session, portal invitation, default tasks, message, and calendar UID were created exactly once.

### 3:35–5:15 — speaker portal

- Follow judge-safe magic link.
- Update bio/headshot, complete acknowledgement, upload slides, inspect processing/approval.
- Show profile public preview and readiness move from outstanding to ready after the last required task.
- Return to organizer dashboard and show live drill-through change.

### 5:15–6:15 — communications and calendar

- Preview acceptance/reminder merge fields against the speaker.
- Filter incomplete recipients, show exact count/exclusions, queue a safe test send.
- Open delivery log and received message; import ICS.
- Reschedule later and explain stable UID/incremented sequence.

### 6:15–8:15 — agenda and conflict safety

- Drag an unscheduled accepted session to a room/time.
- Trigger room or shared-speaker overlap; read the named conflict and prove server rejects it.
- Correct placement and save; repeat via keyboard “Schedule…” to establish accessibility.
- Switch list/day/week/track/room views and publish.

### 8:15–9:30 — public output and speed

- Open mobile schedule/gallery, filter/search, session and speaker pages, add-to-calendar.
- Show embed in isolated test page, JSON/iCal feed, ETag/cache behavior.
- Show performance artifact and current production smoke result.

### 9:30–10:30 — API and Airtable

- Open `/docs/api`, create/show-once scoped key, run a seeded read curl example.
- Show webhook delivery log/replay if green.
- Open Airtable and point to the just-created submission/session/task records.
- Show projection health and reconciliation rather than obscuring the dual-store design.

### 10:30–11:15 — Accelevents/bonuses

- If live contract gate passed: run export dry-run, inspect diff, confirm, show external records and idempotent second run.
- If not: present honest manual CSV/JSON artifact and the explicit contract-test blocker.
- Mention Cloudflare Workflows, R2, Durable Objects/Queues, speed budget, API, Airtable, and optional Forge evidence only when each has proof.

### 11:15–12:00 — close

- Reset the demo event (guard visible), show success, then open source/setup docs.
- Reload, perform one independent second reset, and show the same snapshot receipt/counts with no manual Airtable or D1 repair.
- Close on product judgment: fewer handoffs, fewer hidden failures, faster public program, no $40k-class lock-in.

## Five-minute fallback walkthrough

1. Submit through conditional CFP.
2. Accept a pre-reviewed proposal and show generated onboarding.
3. Complete final speaker task and show readiness update.
4. prevent agenda conflict, publish, open mobile schedule.
5. Show Airtable record + API docs + performance evidence.

## Critical E2E paths

### E2E-01 CFP to submission

Publish version → anonymous welcome → verified account → conditional validation → autosave/reload → participant → submit → confirmation → admin/Airtable visibility.

### E2E-02 Review to acceptance

Route → assign → reviewer draft/submit → aggregate → accept → session/task/portal/message/ICS idempotency.

### E2E-03 Portal to readiness

Invite exchange → profile/headshot → form/ack/file task → approval → computed readiness/dashboard drill-through.

### E2E-04 Agenda to public

Unscheduled session → hard room conflict → hard participant conflict → keyboard-valid placement → stale-version rejection → publish → public filters/detail/cache invalidation.

### E2E-05 Communication reliability

Template validation → audience preview → queue → provider sink/live webhook → delivered/bounced state → retry excludes delivered → no duplicate.

### E2E-06 API/security

Create/revoke key → authorized pagination → cross-event denial → idempotent mutation → ETag mismatch → signed webhook verify/replay.

### E2E-07 Recovery

Simulate Airtable 429, post-authority projection failure, email failure, queue retry, workflow resume, reconciliation, and demo reset after interrupted run.

For the final live reset gate, start from the immutable release SHA and capture exact operational identifiers privately in Linear. Pass one must mutate representative Airtable, projection, and private-asset state, reset through the owner UI, and verify the compiled digest/counts after reload. Pass two must repeat from a fresh browser session with a new idempotency key and converge to the same digest/counts. Public documentation records only the sanitized scenario and generic pass/fail outcome.

## Test matrix

### Unit/property

- Conditional rule evaluator and form-version snapshot.
- Submission/session/review state transitions and illegal moves.
- Weighted score with missing/inapplicable criteria.
- Task applicability/readiness/overdue in event timezone.
- Half-open interval conflict symmetry, adjacency, containment, DST.
- Merge fields, HTML sanitation, ICS escaping/UID/sequence.
- Idempotency fingerprints, webhook signing, token hashing/expiry.

### Contract/integration

- Runtime schemas ↔ OpenAPI drift.
- Airtable batch, pagination, 429, partial failure, reconciliation.
- D1 migrations/index query plans.
- R2 signed intent/finalize/download authorization.
- Resend payload/webhook signatures.
- Accelevents public fixtures plus live gated suite.
- Queues/workflow retry, duplicate, poison, and resumed wait.

### Security/privacy

- Cross-organization/event/role matrix on every resource family.
- CSRF/origin, XSS/sanitization/CSP, SSRF webhook URL rules.
- Magic-link replay/expiry/throttling/session fixation.
- Public form spam/rate/file abuse and enumeration.
- Upload type spoof, SVG/HTML execution, path/key isolation, oversized file.
- Logs, error responses, analytics, client bundle, and source archive secret/PII scan.
- API key one-time display, scope, revoke, constant-time comparison.

### Accessibility/usability

- Axe critical routes, manual keyboard, VoiceOver smoke.
- Conditional focus/announcement, error summary, drag alternative, modal focus.
- 360px and 200% zoom, reduced motion, forced colors where practical.
- Five-minute fresh-user test: find CFP, submit; find outstanding task; schedule session.

### Performance/resilience

- Public Lighthouse/WebPageTest against `docs/08-delivery-runbook.md` budgets.
- Seed scale: 500 submissions, 1,000 contacts, 250 sessions, 100 rooms/track combinations, 5,000 tasks; common query latency.
- Airtable 5 req/s pressure and backoff; queue backlog drain; cache cold/warm.
- Concurrent agenda writes and publish during mutation.

## Ship gates

### Gate A — firm scope complete

- All six firm requirements pass their E2E path in preview and production.
- Deterministic reset reproduces the demonstrated states.
- No issue labeled Firm remains Todo/In Progress unless explicitly documented as non-blocking polish.

### Gate B — integrity and safety

- Zero known P0/P1 correctness/security/accessibility defects.
- Tenant isolation, private files, message idempotency, schedule concurrency pass.
- Airtable authority/projection repair and backup/rollback rehearsal are proven.

### Gate C — bonus evidence

- Cloudflare resource inventory/deployment, Airtable live visibility, API docs/curl, and performance report are captured.
- Accelevents, embed/resources, AI, or Forge are claimed only with production evidence.

### Gate D — judge-ready

- 12-minute and five-minute scripts completed twice from incognito without manual data surgery.
- Seed mailbox/magic-link experience is available to judges without private developer access.
- Public URLs, source repo, setup docs, credentials/instructions, video, screenshots, and submission copy are checked.

### Gate E — deadline-safe

- Production release frozen, tagged, backed up, and smoke-tested by 20:00 PT.
- Submission confirmation is captured before 22:00 PT.
- A static video/screenshots and last-known-good deployment remain available if live systems fail.

## Defect triage during freeze

| Severity | Meaning | Response |
|---|---|---|
| P0 | data loss/security/production down/core path impossible | stop, rollback or fix immediately |
| P1 | firm requirement or judge path materially broken | fix before submission; cut stretch work |
| P2 | workaround exists, polish/accessibility outside critical path | fix if safe; document |
| P3 | cosmetic or post-competition | backlog |

## Evidence bundle

Save under a dated release evidence directory (artifact storage, not necessarily Git): deployment URL/version, commit SHA, test summary, performance reports, OpenAPI hash, Airtable schema check, resource inventory, backup IDs, screenshots, walkthrough recording, submission text, and confirmation receipt. Redact secrets and real participant data.

## Linear completion audit

Before planning is considered complete:

- project has lead, start/target, high priority, In Progress state, summary, description;
- five dated milestones cover research through submission;
- every firm/bonus requirement maps to an issue with acceptance criteria and milestone;
- infrastructure, data, security, UX, QA, performance, docs, deployment, demo, and external setup are represented;
- parent epics and critical blockers/dependencies are linked;
- stretch issues are distinguishable from firm work and have cut conditions;
- project documents preserve brief, product/UX, architecture/runbook, and judge gates;
- issue counts, labels, milestone assignment, and unassigned/unestimated work are reviewed via readback.
