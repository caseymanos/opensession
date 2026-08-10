# Linear execution plan audit

Project: [SessionBox killer](https://linear.app/ralc/project/sessionbox-killer-b3345a119b61/overview)  
Audit performed: 2026-08-08  
Project ID: `4f2219f1-2580-4e74-888a-bfb74264a322`

## Project configuration

- State: In Progress
- Priority: High
- Lead/assignee baseline: Casey Manos
- Start: 2026-08-08
- Target/hard competition day: 2026-08-12
- Summary and detailed definition of done: present
- Linked project documents: 5

## Readback counts

| Check | Result |
|---|---:|
| Total issues | 71 |
| Parent outcome/epic issues | 10 |
| Estimated child issues | 61 |
| Done research issues | 5 |
| Remaining Todo issues | 66 |
| Explicit dependency updates | 50 |
| Missing milestone | 0 |
| Missing assignee | 0 |
| Missing substantive description | 0 |
| Missing child estimate | 0 |
| Missing labels | 0 |

## Milestones and issue allocation

| Milestone | Target | Issues | Status |
|---|---|---:|---|
| M0 — Research & product lock | Aug 8 | 5 | 100% complete |
| M1 — Foundation + walking skeleton | Aug 9 | 10 | planned |
| M2 — Firm six integrated | Aug 10 | 33 | planned |
| M3 — Bonuses, integration & polish | Aug 11 | 15 | planned |
| M4 — Release, demo & submit | Aug 12 | 8 | planned |

## Parent outcomes

| ID | Outcome |
|---|---|
| RAL-21 | Research, requirements & product lock |
| RAL-23 | Platform foundation & walking skeleton |
| RAL-22 | CFP builder & public submissions |
| RAL-24 | Human evaluation & decisions |
| RAL-25 | Speaker portal & onboarding |
| RAL-26 | Communications, reminders & calendar |
| RAL-28 | Agenda builder & conflict safety |
| RAL-29 | Readiness dashboard & public program |
| RAL-27 | Public API, integrations & stretch bonuses |
| RAL-30 | Quality, production release & winning submission |

## Scope and bonus traceability

- `Firm`: 33 issues, covering all six firm requirements and their cross-cutting proof.
- `Stretch`: 6 issues with explicit cut/go-no-go conditions.
- `Ship blocker`: 44 issues on the actual submission path.
- `External credential`: 5 issues for Cloudflare/Airtable/email/Accelevents owner/provider access.
- Bonus evidence labels: Cloudflare 7, Airtable 3, Performance 2, Public API 2; Forge is one intentionally tiny decision issue.

Area and requirement/bonus/gate labels are mutually exclusive within their Linear label group, preventing contradictory classifications.

## Key dependency readback

- RAL-43 public submission is blocked by auth, private uploads, form builder and rule/routing; it blocks admin visibility, E2E and security review.
- RAL-49 acceptance orchestration is blocked by review decision, task policy, template and ICS work.
- RAL-64 agenda publication is blocked by grid/keyboard UX, conflict engine and event serialization; it blocks public schedule, E2E and performance work.
- RAL-87 final submission is blocked by RAL-86 production rehearsal/evidence.

The remaining relation graph also sequences Airtable authority before D1 repair, campaign queues before reminders, production sender proof before deployment, and test/security/performance gates before freeze and demo.

## Project documents

1. Competition brief & locked scope
2. Product & UX specification
3. Cloudflare, Airtable, data & integration architecture
4. Delivery runbook & external setup
5. Judge walkthrough, QA & ship gates

## First execution slice

Start with RAL-31 (typed Cloudflare monorepo/CI), then run RAL-32/RAL-33/RAL-37 in parallel as credentials permit. RAL-34 follows the Airtable adapter; RAL-35 follows identity schema; RAL-38 proves the walking slice. Do not begin Accelevents, Forge, AI, or other stretch work while any firm ship-blocker remains red.

