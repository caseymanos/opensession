# OpenSession

OpenSession is an open-source conference program operating system for the complete path from call for speakers to a published, conflict-free agenda. It is the SessionBox replacement being built for the 2026 Kill My SaaS competition.

The application ships as one Cloudflare Worker with React static assets. Airtable is the authoritative event-program store; D1 provides auth, operations, audit, and read projections; R2 stores private files; Queues, Workflows, and a per-event Durable Object own reliable background work and schedule serialization.

## Prerequisites

- Node.js `26.7.0` from [`.nvmrc`](./.nvmrc)
- pnpm `10.34.5` from the root `packageManager` field
- Wrangler authentication only when using remote Cloudflare resources or deploying

Node 26 is an explicit project/tooling choice while it is the Current release. The deployed application runs in Cloudflare's Workers runtime rather than a Node.js server process; re-evaluate the pin when Node 26 enters LTS.

```bash
nvm use
corepack enable
pnpm install --frozen-lockfile
```

If the Corepack bundled with Node cannot verify the current package-manager signature, update Corepack from npm once, then repeat the commands above:

```bash
npm install --global corepack@latest
corepack enable
```

## Local development

Copy [`.env.example`](./.env.example) to `.dev.vars` only when a feature needs local configuration. The initial shell and health routes require no secrets.

```bash
pnpm dev
```

Wrangler builds the React client, serves it with the Worker at `http://localhost:8787`, and uses local bindings. Useful routes:

- `/` — responsive organizer shell
- `/health/live` — Worker liveness
- `/health/ready` — binding-readiness contract
- `/api/v1` — API discovery response

Use `pnpm dev:web` for UI-only Vite work on port `5173`.

## Quality commands

| Command | Purpose |
|---|---|
| `pnpm deps:audit` | Fail on known high- or critical-severity vulnerabilities |
| `pnpm check:public-repo` | Reject private operational data and non-redistributable source artifacts |
| `pnpm format:check` | Verify Prettier formatting |
| `pnpm lint` | Run strict ESLint rules |
| `pnpm typecheck` | Typecheck every workspace boundary |
| `pnpm test:unit` | Run domain tests and a real Wrangler Worker harness |
| `pnpm test:e2e` | Run desktop and mobile Chromium smoke tests |
| `pnpm wrangler:types:check` | Detect generated binding drift |
| `pnpm build` | Build the React assets and dry-run the Worker artifact |
| `pnpm --filter @sessionbox-killer/data airtable -- schema:check --environment preview` | Read-only Airtable schema drift check |

Run the complete local gate before opening a pull request:

```bash
pnpm format:check
pnpm check:public-repo
pnpm deps:audit
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm wrangler:types:check
pnpm build
pnpm test:e2e
```

CI repeats these checks from the immutable lockfile and runs Gitleaks against Git history. Browser CI installs Chromium explicitly before the responsive smoke suite.

## Workspace boundaries

```text
apps/web/                 React application and route modules
workers/app/              Worker entry, API, Workflows, and queue consumers
packages/domain/          Entities, value objects, policies, conflict logic
packages/contracts/       Zod/OpenAPI schemas and generated client boundary
packages/data/            Airtable command store, D1 projection, repositories
packages/email/           Templates, merge engine, ICS generation
packages/integrations/    Accelevents and webhook adapters
packages/ui/              Accessible components and design tokens
migrations/               D1 migrations
seed/                     Deterministic demo fixture and reset guard
tests/e2e/                Playwright judge and release paths
```

The scaffolded packages are intentionally narrow ports. Product tickets fill them in without importing provider clients into domain or UI code.

## Environments

| Environment | Worker name | Data posture | Email posture |
|---|---|---|---|
| `local` | `sessionbox-killer` | local fixture/D1/R2 | sink |
| `preview` | `sessionbox-killer-preview` | isolated preview resources | allowlist |
| `production` | `sessionbox-killer-prod` | isolated production resources | feature off + empty allowlist until release gate |

No environment may share secrets, Airtable bases, D1 databases, R2 buckets, queues, or workflow names. Generated Cloudflare IDs stay out of source control. Safe binding names and variables belong in `wrangler.jsonc`; local secrets belong in `.dev.vars`; remote secrets use `wrangler secret put`.

After changing `wrangler.jsonc`, regenerate and commit Worker bindings:

```bash
pnpm wrangler:types
```

### Cloudflare preview

Wrangler is the account authority; the committed config is the safe, ID-free resource contract. Preview setup is deliberately separate from production:

```bash
pnpm cloudflare:plan
pnpm cloudflare:provision:preview
pnpm cloudflare:status
pnpm cloudflare:deploy:preview
pnpm cloudflare:rollback:preview -- --version-id <VERSION_ID>
```

`plan` and `status` are read-only. The orchestration CLI is compiled from strict TypeScript before every command. Provisioning creates only missing preview resources and is safe to rerun. Deployment revalidates the remote resources, builds the web client, deploys an ID-complete generated config, records active and last-known-good Worker versions, and smokes the shell plus live and ready health routes. Rollback requires an explicit recent version, rejects split deployments, and smokes the restored Worker; it never rolls back D1, R2, Queue, or other storage state. Generated inventory and CLI output under `.cloudflare/` are ignored, owner-readable only, and never a source-controlled input.

Production has no package shortcut. The lower-level provisioner requires both `--confirm-production` and `CLOUDFLARE_PRODUCTION_CONFIRM=production` before any production provisioning, deployment, or rollback.

## Architecture and delivery references

1. [`docs/00-competition-brief.md`](./docs/00-competition-brief.md) — requirements, comments, bonuses, and deadline
2. [`docs/03-product-spec.md`](./docs/03-product-spec.md) — product scope and acceptance criteria
3. [`docs/04-architecture.md`](./docs/04-architecture.md) — Cloudflare/Airtable architecture
4. [`docs/05-data-model.md`](./docs/05-data-model.md) — domain and persistence boundaries
5. [`docs/06-ux-spec.md`](./docs/06-ux-spec.md) — organizer, reviewer, speaker, and public UX
6. [`docs/08-delivery-runbook.md`](./docs/08-delivery-runbook.md) — environments, release, and handoff
7. [`docs/09-judge-demo-and-qa.md`](./docs/09-judge-demo-and-qa.md) — judge walkthrough and ship gates
8. [`docs/11-linear-plan.md`](./docs/11-linear-plan.md) — audited execution plan
9. [`docs/12-airtable-operations.md`](./docs/12-airtable-operations.md) — Airtable credentials, schema bootstrap, probe, and recovery

Implementation is tracked in the [SessionBox killer Linear project](https://linear.app/ralc/project/sessionbox-killer-b3345a119b61/overview).

## Security

Never commit secrets, provider credentials, generated resource IDs, private upload URLs, or real recipient data. See [`SECURITY.md`](./SECURITY.md) for private vulnerability reporting, [`.env.example`](./.env.example) for the configuration contract, and [`docs/08-delivery-runbook.md`](./docs/08-delivery-runbook.md) for provisioning rules.

Contributions are welcome through the workflow in [`CONTRIBUTING.md`](./CONTRIBUTING.md). CI artifacts and the private release system hold environment-specific verification evidence; the repository keeps only reproducible tests and secret-free operating guidance.

## License

[MIT](./LICENSE)
