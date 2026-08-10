# sbek rubric ownership forecast

This is a planning forecast against eval-kit commit `d99935c3e3c6c50c6b9292220260ccfe2df6d6d4`, not a measured verdict. RAL-102 must replace forecasts with evidence from the scored baseline. The machine-validated source is `config/sbek/rubric-ownership.json`; `pnpm sbek ownership` rejects missing, duplicate, extra, or ownerless required IDs.

## Required rubric: 84 of 84 mapped

The links below are Linear issue identifiers. Multiple identifiers mean the evaluator crosses a product handoff rather than having two competing implementations.

### Call for Papers (16)

| ID | Forecast owner(s) | Capability |
| --- | --- | --- |
| CFP-01 | RAL-41 | Custom public form and validation |
| CFP-02 | RAL-42 | Conditional form logic |
| CFP-03 | RAL-43 | Anonymous branded portal |
| CFP-04 | RAL-43 | Submission-window enforcement |
| CFP-05 | RAL-43 | Account, submit, confirmation, dashboard |
| CFP-06 | RAL-43, RAL-44 | Organizer round-trip |
| CFP-07 | RAL-43 | Draft save and resume |
| CFP-08 | RAL-55, RAL-56, RAL-57 | Receipt email |
| CFP-09 | RAL-43, RAL-44 | Speaker edit round-trip |
| CFP-10 | RAL-46, RAL-47 | Reviewer role isolation |
| CFP-11 | RAL-47, RAL-48 | Review round-trip |
| CFP-12 | RAL-48 | Accept/reject decisions |
| CFP-13 | RAL-48, RAL-50 | Speaker-visible status |
| CFP-14 | RAL-55, RAL-56, RAL-57 | Decision email dispatch |
| CFP-15 | RAL-49 | Accepted-session handoff |
| CFP-16 | RAL-43 | Close-date edit lock |

### Abstract Management (14)

| ID | Forecast owner(s) | Capability |
| --- | --- | --- |
| ABS-01 | RAL-96 | Multiple review rounds |
| ABS-02 | RAL-96 | Round-specific reviewer pools |
| ABS-03 | RAL-96 | Multi-type scorecards |
| ABS-04 | RAL-46, RAL-48 | Weighted aggregate |
| ABS-05 | RAL-46, RAL-47 | Exact assignment scoping |
| ABS-06 | RAL-96 | Bulk/automatic assignment |
| ABS-07 | RAL-96 | Blind review |
| ABS-08 | RAL-96, RAL-65 | Reviewer progress |
| ABS-09 | RAL-96, RAL-57 | Bulk review reminders |
| ABS-10 | RAL-48 | Sortable aggregate results |
| ABS-11 | RAL-43, RAL-44 | Co-author persistence |
| ABS-12 | RAL-46, RAL-47 | Conflict/recusal |
| ABS-13 | RAL-96 | Review export |
| ABS-14 | RAL-76 | AI triage only if claimed |

### Speaker Management (16)

| ID | Forecast owner(s) | Capability |
| --- | --- | --- |
| SPK-01 | RAL-65 | Searchable speaker roster |
| SPK-02 | RAL-51 | Organizer profile editing |
| SPK-03 | RAL-98 | CSV import |
| SPK-04 | RAL-50, RAL-65 | Filterable workflow status |
| SPK-05 | RAL-52 | Dated multi-speaker tasks |
| SPK-06 | RAL-50, RAL-57 | Portal invitation |
| SPK-07 | RAL-50 | Speaker-scoped portal |
| SPK-08 | RAL-51 | Profile/headshot round-trip |
| SPK-09 | RAL-52, RAL-53 | General task completion |
| SPK-10 | RAL-53 | Deliverable download |
| SPK-11 | RAL-50, RAL-60 | Session assignment visibility |
| SPK-12 | RAL-65 | Completion progress |
| SPK-13 | RAL-55, RAL-56 | Logged bulk email |
| SPK-14 | RAL-55 | Personalized merge fields |
| SPK-15 | RAL-104 | Travel/logistics fields |
| SPK-16 | RAL-57 | Due-date reminders |

### Content Management (14)

| ID | Forecast owner(s) | Capability |
| --- | --- | --- |
| CNT-01 | RAL-52 | File-request creation |
| CNT-02 | RAL-53 | Speaker upload |
| CNT-03 | RAL-50, RAL-53 | Portal scoping |
| CNT-04 | RAL-53 | File versions |
| CNT-05 | RAL-97 | Cross-role comments |
| CNT-06 | RAL-53 | Upload constraints |
| CNT-07 | RAL-65 | Deliverables dashboard |
| CNT-08 | RAL-57 | Outstanding-task reminders |
| CNT-09 | RAL-60 | Central session editing |
| CNT-10 | RAL-51 | Admin profile editing |
| CNT-11 | RAL-97 | Restorable content history |
| CNT-12 | RAL-51, RAL-64 | Publication approval gate |
| CNT-13 | RAL-97 | Central files library |
| CNT-14 | RAL-97 | Bulk ZIP export |

### AI Agenda (8)

| ID | Forecast owner(s) | Capability |
| --- | --- | --- |
| AIA-01 | RAL-61 | Multi-day builder |
| AIA-02 | RAL-60, RAL-61 | Rooms/tracks configuration |
| AIA-03 | RAL-61, RAL-63 | Persistent placement |
| AIA-04 | RAL-62 | Speaker overlap warning |
| AIA-05 | RAL-62, RAL-63 | Room conflict enforcement |
| AIA-06 | RAL-61, RAL-62 | Move and clear conflict |
| AIA-07 | RAL-64 | Publication handoff |
| AIA-08 | RAL-98 | One-action schedule assist |

### Public and Embeddable Widgets (16)

| ID | Forecast owner(s) | Capability |
| --- | --- | --- |
| EMB-01 | RAL-99 | Complete session cards |
| EMB-02 | RAL-99 | Session/speaker search |
| EMB-03 | RAL-99 | Faceted filters |
| EMB-04 | RAL-67, RAL-99 | Alphabetized speakers list |
| EMB-05 | RAL-67, RAL-99 | Speaker drill-down |
| EMB-06 | RAL-64, RAL-66 | Correct public agenda |
| EMB-07 | RAL-66 | Day navigation |
| EMB-08 | RAL-66 | Agenda detail |
| EMB-09 | RAL-103 | Public itinerary |
| EMB-10 | RAL-103 | Personal selection |
| EMB-11 | RAL-103 | Persistence/calendar export |
| EMB-12 | RAL-67 | Photo gallery |
| EMB-13 | RAL-67 | Gallery detail |
| EMB-14 | RAL-99 | Five anonymous surfaces |
| EMB-15 | RAL-68, RAL-99 | Embed/share builder |
| EMB-16 | RAL-64, RAL-66, RAL-67, RAL-99 | Cross-surface consistency |

## Forecast hotspots

RAL-96 owns the clear review-depth delta; RAL-97 owns the clear deliverables-operations delta; RAL-98 owns the two bounded missing capabilities; RAL-99 owns the remaining five-widget and embed-builder delta; and RAL-104 owns the residual speaker-logistics gap. RAL-103 is already complete for EMB-09–11. These are hypotheses until RAL-102 measures them.

RAL-104 must extend the RAL-51 canonical speaker profile rather than create an eval-only record. ABS-14 is conditional: RAL-76 explicitly decides whether to claim AI-assisted triage, and the rubric should not punish an honest product that makes no such claim.

## Optional extra credit

Speaker CRM is a separate optional area with 12 IDs (`CRM-01`–`CRM-12`) and a 10% extra-credit weight. RAL-100 owns its go/no-go and any bounded implementation only after RAL-101 proves at least 90% on required areas. It is intentionally excluded from the required 84-item map and default harness configuration.
