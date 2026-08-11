# Judge E2E evidence

RAL-78 keeps the judge suite explicit without duplicating the product tests. Tests tagged `@judge` are the required local desktop/mobile path, and each critical path has a stable `@judge-e2e-0N` tag.

| Path | Automated proof |
|---|---|
| E2E-01 CFP to submission | verified applicant completes participant, review, consent, and final submission |
| E2E-02 Review to acceptance | authoritative decision command retries one exact envelope |
| E2E-03 Portal to readiness | organizer approval updates readiness and audit state without reload |
| E2E-04 Agenda to public | publication commits the exact preview and public version |
| E2E-05 Communication reliability | redacted delivery evidence retries one failure without duplicate exposure |
| E2E-06 API/security | scoped key plaintext is shown once and remains revocable |
| E2E-07 Recovery/reset | guarded demo reset reports durable completion |

The same run includes `@judge-a11y` checks for keyboard agenda placement, conditional-field announcements, dialog focus/Axe at 360 px, and 200% text scaling.

## Commands

```sh
pnpm test:e2e:judge

E2E_BASE_URL=https://preview.opensessionboard.com \
  pnpm test:e2e:production-smoke
E2E_BASE_URL=https://preview.opensessionboard.com \
  pnpm test:e2e:production-smoke

E2E_BASE_URL=https://opensessionboard.com \
  pnpm test:e2e:production-smoke
```

The deployed smoke is credential-free and read-only. It validates live/ready health, public CFP/schedule/speaker/OpenAPI contracts, page rendering, viewport containment, and WCAG A/AA Axe rules. `E2E_EVENT_SLUG` may select another seeded public event. `E2E_BASE_URL` accepts only a credential-free HTTPS origin.

For the optional cross-browser pass, install Firefox and WebKit and set `E2E_CROSS_BROWSER=1`; required CI remains desktop and mobile Chromium.

```sh
pnpm exec playwright install firefox webkit
E2E_CROSS_BROWSER=1 pnpm test:e2e:judge
```

## Manual accessibility checklist

- Complete agenda placement with keyboard only; verify focus returns to the triggering session and conflicts are announced.
- Toggle the Workshop condition; verify the new required field is announced, receives a useful label, and clears when hidden.
- Open and close each critical dialog with keyboard only; verify focus is trapped, Escape works where safe, and focus returns to the trigger.
- Check CFP, portal task, agenda, public schedule, and API access at 360 px and 200% text without document-level horizontal scrolling.
- Run one VoiceOver smoke through CFP errors, portal outstanding work, and agenda conflict repair.

## Artifact privacy

Local failures retain screenshot, video, and first-retry trace. Local fixtures use synthetic addresses and private-upload URLs. Deployed smoke never signs in or exercises uploads, and remote tracing is disabled so signed URLs, session material, or private object locations cannot enter retained artifacts.

Record the two preview run URLs and the production smoke run URL on RAL-78. Do not copy credentials, recipient addresses, signed URLs, or private upload identifiers into Linear or repository artifacts.
