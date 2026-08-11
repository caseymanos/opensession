# RAL-58 calendar invitation evidence

These redacted, importable fixtures demonstrate the same invitation series without contacting a calendar or email provider:

1. `01-initial-request.ics` — `METHOD:REQUEST`, `SEQUENCE:0`
2. `02-rescheduled-request.ics` — the same `UID`, `METHOD:REQUEST`, `SEQUENCE:1`
3. `03-cancellation.ics` — the same `UID`, `METHOD:CANCEL`, `STATUS:CANCELLED`, `SEQUENCE:2`

All identities use reserved `.test` addresses and URLs. Automated tests compare every byte with the provider-neutral renderer, validate CRLF and UTF-8 folding, and parse the files with `ical.js`. They are prepared for manual import but have not been sent or imported into Gmail, Outlook, Apple Calendar, or another live client.
