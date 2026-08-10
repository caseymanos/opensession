# sbek evaluation runbook

This runbook prepares the external SessionBoard evaluation harness without performing a paid evaluation. The first scored baseline belongs to RAL-102 after the deployed product and deterministic reset path are ready.

## Supply-chain pin and runtime

| Input | Pinned value |
| --- | --- |
| Eval-kit repository | `https://forge.smol.ai/swyx/killmysaas-evals.git` |
| Reviewed commit | `d99935c3e3c6c50c6b9292220260ccfe2df6d6d4` |
| `package-lock.json` SHA-256 | `21f54a9e41ee35d9bd3773ea28b5d6c5d3b28ddf4c8f349ce057f76410e714e6` |
| Project Node | `26.7.0` from `.nvmrc` and `.node-version` |
| Upstream minimum | Node 20+ |
| Install | `npm ci` inside the pinned kit; automated by `pnpm sbek prepare` |
| Browser | Upstream Playwright Chromium, stored under ignored `.sbek/browsers/` |

SmallForge is only the public Git host for this source. The evaluator runs locally and does not require a SmallForge account, API, deployment, or runtime. Moving the kit elsewhere would not change its evaluation behavior. A full run needs an Anthropic API key, not SmallForge credentials.

The wrapper verifies the remote, exact commit, clean tracked state, and lockfile digest before every operation. It uses a normal Git clone because the host's partial-clone object filtering is currently noisy.

## Clean-checkout preparation

Use the project-pinned Node and pnpm versions:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm sbek:verify
pnpm sbek init
```

`pnpm sbek:verify` clones and installs the pinned kit, validates the 84-item ownership map, runs upstream typechecking and spec loading, runs the offline Chromium smoke, and prints a complete dry-run plan. It makes no Anthropic calls.

`pnpm sbek init` copies `config/sbek/evalconfig.example.json` to ignored `.sbek/evalconfig.json` without overwriting an existing file. Replace every `.invalid` placeholder and document the deployed immutable SHA, reset identity, demo-login routes, and fixture deviations in `submissionNotes`.

The config inputs are:

- target HTTPS URL;
- required area/scenario subset, with Speaker CRM excluded by default;
- organizer, primary speaker, secondary speaker, and reviewer inbox aliases;
- optional password credentials for fixtures that do not use magic links;
- agent model, judge model, maximum turns, browser headless mode, and submission notes.

The recommended economical configuration is `claude-sonnet-5` for the browser agent and `claude-opus-5` for judging, with 70 turns per scenario. The upstream estimate for all required areas is about one hour and US$2–10. Actual cost depends on retries, model pricing, and turn count.

Never put provider keys, real passwords, auth profiles, or live inboxes in tracked configuration. Supply `ANTHROPIC_API_KEY` only in the operator environment. Paid commands also require the explicit `SBEK_ALLOW_PAID_RUN=1` acknowledgement, so a copied dry-run command cannot accidentally spend money.

## Persona contract

| Persona | Starting state and required proof |
| --- | --- |
| Organizer | Event-scoped organizer with permission to configure CFP, reviewers, speakers, content, agenda, messages, and public widgets. The account must be able to reset or enter the seeded event without manual database changes. |
| Reviewer | Reviewer-only account or captured session. It sees only assigned proposals and never organizer navigation or unassigned proposal data. |
| Speaker | Primary and secondary speaker inboxes controlled by the operator. The primary can submit and later use the accepted-speaker portal; identity must remain stable across the CFP and speaker-management areas. |
| Anonymous | A fresh logged-out browser context with no saved auth state. Public CFP and all five public widget surfaces must be readable without an account or third-party cookies. |

For passwordless or OAuth personas, capture browser state after reset and before the paid run:

```sh
pnpm sbek auth --persona organizer
pnpm sbek auth --persona reviewer
pnpm sbek auth --persona speaker
```

Saved sessions live only under `.sbek/kit/.auth/`. Re-capture them after a reset if the application invalidates sessions. Do not authenticate the anonymous path.

## Deterministic baseline gate

RAL-102 must not start until all of these are recorded in `.sbek/evalconfig.json` or the private run log:

1. An immutable deployed application SHA and stable target URL.
2. A tested reset operation that restores one isolated eval event, removes prior evaluator mutations, and can be repeated without duplicate records.
3. Seeded organizer access plus inbox-controlled reviewer and speaker identities, with magic-link or password flows proven in the evaluator browser.
4. The exact event timezone, days, rooms, tracks, formats, CFP state, and public publication state expected immediately after reset.
5. Local email capture or allowlisted delivery that proves receipt, decision, bulk-reminder, and invitation side effects without contacting unintended recipients.
6. A clean anonymous browser proof and enough deterministic data for multi-day schedule, conflicts, speaker gallery, filters, deliverables, and the two submitted proposals created by the scenarios.

RAL-78 owns the product-side deterministic seed/reset and critical E2E proof. RAL-102 owns the first paid baseline. If any prerequisite drifts, reset and restart instead of interpreting a contaminated score.

## Operator commands

All paths and upstream arguments may be inspected with `pnpm sbek help` and `pnpm sbek status`.

```sh
# Safe and offline
pnpm sbek preflight
pnpm sbek list
pnpm sbek smoke
pnpm sbek dry-run
pnpm sbek dry-run --areas call-for-papers,public-widgets

# Paid only after RAL-102's gate
export ANTHROPIC_API_KEY='<from the operator secret store>'
export SBEK_ALLOW_PAID_RUN=1
pnpm sbek area call-for-papers
pnpm sbek run
pnpm sbek resume .sbek/kit/runs/<timestamp>

# Offline recovery/scoring
pnpm sbek rescore .sbek/kit/runs/<timestamp>
pnpm sbek finalize .sbek/kit/runs/<timestamp>
```

Area slugs are `call-for-papers`, `abstract-management`, `speaker-management`, `content-management`, `ai-agenda`, and `public-widgets`. Run them in that order for the first baseline because later scenarios reuse earlier product state. Add `--include-optional` only for the separately gated Speaker CRM work in RAL-100.

Resume reuses completed scenario evidence and already-scored areas. Rescore rebuilds reports from stored evidence and judgements without an API call. Finalize merges operator-completed `manual-results.json` and must be rerun after rescore.

## Artifacts, privacy, and retention

Everything generated by the harness is ignored under `.sbek/`:

| Artifact | Location | Retention |
| --- | --- | --- |
| Local config | `.sbek/evalconfig.json` | Keep locally only; rotate/remove credentials after the final run. |
| Browser binaries | `.sbek/browsers/` | Cache until the pin changes; safe to re-download. |
| Persona auth state | `.sbek/kit/.auth/` | Delete after the evaluation window or immediately after credential/session rotation. |
| Report and live log | `.sbek/kit/runs/<timestamp>/report.html`, `report.json`, `run.log` | Keep every run used for a Linear verdict through RAL-101; delete abandoned dry runs after 14 days. |
| Scenario evidence | `.sbek/kit/runs/<timestamp>/<scenario>/evidence.json` and screenshots | Same lifetime as its report; treat as private because it may contain names, emails, proposal text, and portal state. |
| Manual verification | `.sbek/kit/runs/<timestamp>/manual-checklist.md`, `manual-results.json` | Keep with the selected baseline/final report through competition close plus 30 days. |

For RAL-102 and RAL-101, copy the selected run directory to an access-controlled artifact store before local cleanup and record its checksum, deployed SHA, eval-kit SHA, models, start/end time, reset identifier, and report score in Linear. Do not commit raw reports or screenshots: their contents are evaluator-generated, mutable, and potentially sensitive.

## Change control

An eval-kit update requires a new review of the upstream diff and lockfile, a new commit and lock hash in `scripts/sbek.mjs`, the ownership document's `evalKitCommit`, and a complete `pnpm sbek:verify`. Never silently fetch moving `main` for a scored run. A changed rubric invalidates comparisons unless the previous run is rescored and its coverage implications are documented.
