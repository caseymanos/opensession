# Contributing to OpenSession

Thanks for helping improve OpenSession. Keep changes focused, tested, and safe for a multi-tenant conference operations system.

## Before you start

- Search existing issues and pull requests before opening a duplicate.
- Use a GitHub issue for product changes large enough to need design discussion.
- Report suspected vulnerabilities privately through [`SECURITY.md`](./SECURITY.md), never in a public issue.

## Local setup

Use the Node.js and pnpm versions declared by the repository:

```bash
nvm use
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

Copy `.env.example` to `.dev.vars` only when local configuration is required. Never commit real credentials, recipient data, provider identifiers, or generated deployment inventory.

## Pull requests

1. Create a focused branch from current `main`.
2. Add or update tests for behavioral changes.
3. Run `pnpm check:public-repo`, formatting, lint, typecheck, unit tests, generated-binding checks, and the build.
4. Run Playwright for user-facing workflow changes.
5. Explain the user impact, security implications, verification, and any follow-up work in the pull request.

Pull requests must pass the required GitHub checks and resolve substantive review feedback before merge. Avoid unrelated refactors and generated artifacts.

## Architecture expectations

- Keep provider clients outside domain and UI packages.
- Preserve tenant and event boundaries in every query and mutation.
- Treat Airtable as event-domain authority and D1 as the operational/read-projection store described in the architecture.
- Keep uploads private by default and background work idempotent.
- Prefer small reusable components and accessible interaction states.

By participating, you agree to follow [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).
