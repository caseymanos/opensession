import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse } from "jsonc-parser";

type EnvironmentName = "preview" | "production";

interface CliOptions {
  confirmProduction: boolean;
  environment: EnvironmentName;
  restartFailed: boolean;
}

interface DemoManifest {
  assetCount: number;
  digest: string;
  eventId: string;
  operationCount: number;
  organizationId: string;
  schemaVersion: 1;
  seedVersion: number;
  snapshotId: string;
}

interface BootstrapState {
  authorizationExpiresAt: string | null;
  baseId: string;
  environment: EnvironmentName;
  eventRecordId: string;
  manifestDigest: string;
  operationId: string;
  organizationRecordId: string;
  token: string;
}

interface RenderedConfig {
  name?: string;
  routes?: {
    custom_domain?: boolean;
    pattern?: string;
  }[];
  vars?: Record<string, unknown>;
}

interface DemoRootResult {
  eventRecordId: string;
  organizationRecordId: string;
  outcome: "applied" | "replayed";
}

interface D1Execution<Row extends Record<string, unknown>> {
  meta?: { changes?: unknown };
  results?: Row[];
  success?: boolean;
}

interface DataRuntime {
  AirtableClient: new (options: { baseId: string; token: string }) => unknown;
  runAirtableDemoRootBootstrap(client: unknown): Promise<DemoRootResult>;
}

const rootDirectory = fileURLToPath(new URL("../../", import.meta.url));
const wranglerPath = join(rootDirectory, "node_modules/.bin/wrangler");
const recordIdPattern = /^rec[A-Za-z0-9]{14}$/;
const baseIdPattern = /^app[A-Za-z0-9]{14}$/;
const emailPattern =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

function assertManifest(manifest: DemoManifest): void {
  if (
    !/^[a-f0-9]{64}$/.test(manifest.digest) ||
    manifest.schemaVersion !== 1 ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(manifest.organizationId) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(manifest.eventId) ||
    !/^snapshot_[a-f0-9]{24}$/.test(manifest.snapshotId) ||
    !Number.isSafeInteger(manifest.assetCount) ||
    manifest.assetCount < 1 ||
    !Number.isSafeInteger(manifest.seedVersion) ||
    manifest.seedVersion < 1 ||
    !Number.isSafeInteger(manifest.operationCount) ||
    manifest.operationCount < 1
  ) {
    throw new Error("The committed demo seed manifest is invalid.");
  }
}

function customDomainOrigin(config: RenderedConfig): URL {
  const domains = (config.routes ?? []).filter(
    (route) =>
      route.custom_domain === true && typeof route.pattern === "string",
  );
  if (domains.length < 1 || !domains[0]?.pattern) {
    throw new Error("The rendered Worker config has no custom domain.");
  }
  const origin = new URL(`https://${domains[0].pattern}`);
  if (
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    origin.hostname !== domains[0].pattern
  ) {
    throw new Error("The rendered Worker custom domain is invalid.");
  }
  return origin;
}

function parseArguments(arguments_: readonly string[]): CliOptions {
  let environment: EnvironmentName | undefined;
  let confirmProduction = false;
  let restartFailed = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--environment") {
      const value = arguments_[index + 1];
      if (value !== "preview" && value !== "production") {
        throw new Error("--environment must be preview or production.");
      }
      environment = value;
      index += 1;
    } else if (argument === "--confirm-production") {
      confirmProduction = true;
    } else if (argument === "--restart-failed") {
      restartFailed = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!environment) {
    throw new Error("Pass --environment preview or production.");
  }
  return { confirmProduction, environment, restartFailed };
}

function sql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function childEnvironment(): NodeJS.ProcessEnv {
  const privateNames = new Set([
    "AIRTABLE_PAT",
    "AIRTABLE_SCHEMA_PAT",
    "DEMO_OWNER_EMAIL",
    "EMAIL_PREVIEW_RECIPIENT",
  ]);
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !privateNames.has(name)),
  );
}

function runWrangler<Row extends Record<string, unknown>>(
  configPath: string,
  command: string,
): D1Execution<Row>[] {
  const result = spawnSync(
    wranglerPath,
    [
      "d1",
      "execute",
      "DB",
      "--remote",
      "--config",
      configPath,
      "--command",
      command,
      "--json",
    ],
    {
      cwd: rootDirectory,
      encoding: "utf8",
      env: childEnvironment(),
    },
  );
  if (result.status !== 0) {
    throw new Error(
      "The scoped D1 bootstrap authorization could not be stored.",
    );
  }
  try {
    return JSON.parse(result.stdout) as D1Execution<Row>[];
  } catch {
    throw new Error("The scoped D1 authorization readback was invalid.");
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writePrivateState(
  path: string,
  state: BootstrapState,
): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}

function assertState(
  state: BootstrapState,
  environment: EnvironmentName,
  baseId: string,
  manifest: DemoManifest,
): void {
  if (
    state.environment !== environment ||
    state.baseId !== baseId ||
    state.manifestDigest !== manifest.digest ||
    !recordIdPattern.test(state.organizationRecordId) ||
    !recordIdPattern.test(state.eventRecordId) ||
    !/^[A-Za-z0-9_-]{40,160}$/.test(state.token) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(state.operationId) ||
    (state.authorizationExpiresAt !== null &&
      !Number.isFinite(Date.parse(state.authorizationExpiresAt)))
  ) {
    throw new Error("The private bootstrap resume state is invalid.");
  }
}

async function createState(
  environment: EnvironmentName,
  baseId: string,
  airtableToken: string,
  manifest: DemoManifest,
): Promise<BootstrapState> {
  const runtimePath = pathToFileURL(
    join(rootDirectory, "packages/data/dist/airtable/internal.js"),
  ).href;
  const runtime = (await import(runtimePath)) as DataRuntime;
  const client = new runtime.AirtableClient({
    baseId,
    token: airtableToken,
  });
  const root = await runtime.runAirtableDemoRootBootstrap(client);
  if (
    !recordIdPattern.test(root.organizationRecordId) ||
    !recordIdPattern.test(root.eventRecordId)
  ) {
    throw new Error("Airtable returned invalid demo root identifiers.");
  }
  return {
    authorizationExpiresAt: null,
    baseId,
    environment,
    eventRecordId: root.eventRecordId,
    manifestDigest: manifest.digest,
    operationId: `demo_bootstrap_${randomBytes(16).toString("hex")}`,
    organizationRecordId: root.organizationRecordId,
    token: randomBytes(32).toString("base64url"),
  };
}

function authorizationCommand(options: {
  environment: EnvironmentName;
  baseId: string;
  expiresAt: string;
  manifest: DemoManifest;
  now: string;
  restartFailed: boolean;
  state: BootstrapState;
  tokenHash: string;
}): string {
  const {
    environment,
    baseId,
    expiresAt,
    manifest,
    now,
    restartFailed,
    state,
    tokenHash,
  } = options;
  const baseKey = `${environment}:${baseId}`;
  return `INSERT INTO demo_bootstrap_authorizations (
      operation_id, token_hash, environment, base_key, organization_id,
      event_id, organization_source_record_id, event_source_record_id,
      seed_version, snapshot_id, seed_digest, status, created_at, updated_at,
      expires_at
    ) VALUES (
      ${sql(state.operationId)}, ${sql(tokenHash)}, ${sql(environment)},
      ${sql(baseKey)}, ${sql(manifest.organizationId)},
      ${sql(manifest.eventId)}, ${sql(state.organizationRecordId)},
      ${sql(state.eventRecordId)}, ${manifest.seedVersion},
      ${sql(manifest.snapshotId)}, ${sql(manifest.digest)}, 'pending',
      ${sql(now)}, ${sql(now)}, ${sql(expiresAt)}
    ) ON CONFLICT(operation_id) DO UPDATE SET
      status = 'pending', lease_expires_at = NULL, last_error_code = NULL,
      updated_at = excluded.updated_at, expires_at = excluded.expires_at
    WHERE demo_bootstrap_authorizations.token_hash = excluded.token_hash
      AND demo_bootstrap_authorizations.environment = excluded.environment
      AND demo_bootstrap_authorizations.base_key = excluded.base_key
      AND demo_bootstrap_authorizations.organization_id = excluded.organization_id
      AND demo_bootstrap_authorizations.event_id = excluded.event_id
      AND demo_bootstrap_authorizations.organization_source_record_id =
          excluded.organization_source_record_id
      AND demo_bootstrap_authorizations.event_source_record_id =
          excluded.event_source_record_id
      AND demo_bootstrap_authorizations.seed_version = excluded.seed_version
      AND demo_bootstrap_authorizations.snapshot_id = excluded.snapshot_id
      AND demo_bootstrap_authorizations.seed_digest = excluded.seed_digest
      AND (
        demo_bootstrap_authorizations.status = 'pending'
        OR (
          demo_bootstrap_authorizations.status = 'leased'
          AND demo_bootstrap_authorizations.lease_expires_at <= excluded.updated_at
        )
        OR (
          demo_bootstrap_authorizations.status = 'failed'
          AND ${restartFailed ? "1" : "0"} = 1
        )
      )
    ;
    SELECT operation_id, status, expires_at,
           changes() AS authorization_changes
    FROM demo_bootstrap_authorizations
    WHERE operation_id = ${sql(state.operationId)}
      AND token_hash = ${sql(tokenHash)}
      AND environment = ${sql(environment)}
      AND base_key = ${sql(baseKey)}
      AND organization_id = ${sql(manifest.organizationId)}
      AND event_id = ${sql(manifest.eventId)}
      AND organization_source_record_id = ${sql(state.organizationRecordId)}
      AND event_source_record_id = ${sql(state.eventRecordId)}
      AND seed_version = ${manifest.seedVersion}
      AND snapshot_id = ${sql(manifest.snapshotId)}
      AND seed_digest = ${sql(manifest.digest)};`;
}

function assertAuthorizationWrite(
  executions: D1Execution<{
    authorization_changes?: unknown;
    expires_at?: unknown;
    operation_id?: unknown;
    status?: unknown;
  }>[],
  state: BootstrapState,
  expiresAt: string,
): void {
  const execution = executions.at(-1);
  const row = execution?.results?.[0];
  const authorizationChanges = row?.authorization_changes;
  const pendingWrite =
    authorizationChanges === 1 &&
    row?.status === "pending" &&
    row.expires_at === expiresAt;
  const completedReplay =
    authorizationChanges === 0 && row?.status === "complete";
  if (
    executions.length !== 2 ||
    execution?.success !== true ||
    execution.results?.length !== 1 ||
    row?.operation_id !== state.operationId ||
    (!pendingWrite && !completedReplay)
  ) {
    throw new Error(
      "The scoped D1 authorization was not written exactly once; private resume state was retained.",
    );
  }
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (
    options.environment === "production" &&
    (!options.confirmProduction ||
      process.env.DEMO_PRODUCTION_CONFIRM !== "production")
  ) {
    throw new Error(
      "Production bootstrap requires --confirm-production and DEMO_PRODUCTION_CONFIRM=production.",
    );
  }
  const baseVariable =
    options.environment === "preview"
      ? "AIRTABLE_PREVIEW_BASE_ID"
      : "AIRTABLE_PRODUCTION_BASE_ID";
  const baseId = process.env[baseVariable]?.trim() ?? "";
  const airtableToken = process.env.AIRTABLE_PAT?.trim() ?? "";
  const ownerEmail = process.env.DEMO_OWNER_EMAIL?.trim().toLowerCase() ?? "";
  if (!baseIdPattern.test(baseId)) {
    throw new Error(`${baseVariable} must be a valid Airtable base ID.`);
  }
  if (!airtableToken.startsWith("pat") || airtableToken.length < 20) {
    throw new Error("AIRTABLE_PAT is required for the selected base.");
  }
  if (
    ownerEmail.length === 0 ||
    ownerEmail.length > 320 ||
    !emailPattern.test(ownerEmail)
  ) {
    throw new Error("DEMO_OWNER_EMAIL must be a valid private owner address.");
  }

  const configPath = join(
    rootDirectory,
    ".cloudflare",
    `wrangler.${options.environment}.json`,
  );
  const statePath = join(
    rootDirectory,
    ".cloudflare",
    `demo-bootstrap.${options.environment}.json`,
  );
  const manifestPath = join(
    rootDirectory,
    "workers/app/src/demo/seed-manifest.json",
  );
  const [manifest, configSource] = await Promise.all([
    readJson<DemoManifest>(manifestPath),
    readFile(configPath, "utf8"),
  ]);
  assertManifest(manifest);
  const config = parse(configSource) as RenderedConfig;
  const origin = customDomainOrigin(config);
  if (
    config.vars?.APP_ENV !== options.environment ||
    config.vars?.AIRTABLE_BASE_ID !== baseId
  ) {
    throw new Error(
      "The ignored rendered Worker config does not match the selected environment and base.",
    );
  }

  let state: BootstrapState;
  try {
    state = await readJson<BootstrapState>(statePath);
    assertState(state, options.environment, baseId, manifest);
  } catch (error) {
    if (
      error instanceof Error &&
      !error.message.includes("ENOENT") &&
      !error.message.includes("no such file")
    ) {
      throw error;
    }
    state = await createState(
      options.environment,
      baseId,
      airtableToken,
      manifest,
    );
    await writePrivateState(statePath, state);
  }

  const now = new Date();
  const tokenHash = createHash("sha256").update(state.token).digest("hex");
  const expiresAt = new Date(now.getTime() + 15 * 60 * 1_000).toISOString();
  const authorizationWrite = runWrangler<{
    authorization_changes?: unknown;
    expires_at?: unknown;
    operation_id?: unknown;
    status?: unknown;
  }>(
    configPath,
    authorizationCommand({
      baseId,
      environment: options.environment,
      expiresAt,
      manifest,
      now: now.toISOString(),
      restartFailed: options.restartFailed,
      state,
      tokenHash,
    }),
  );
  assertAuthorizationWrite(authorizationWrite, state, expiresAt);
  state = { ...state, authorizationExpiresAt: expiresAt };
  await writePrivateState(statePath, state);

  const response = await fetch(
    new URL("/api/internal/demo/bootstrap", origin),
    {
      body: JSON.stringify({ owner_email: ownerEmail }),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${state.token}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10 * 60 * 1_000),
    },
  );
  const payload = (await response.json().catch(() => null)) as {
    asset_count?: unknown;
    authority_ready?: unknown;
    receipt?: {
      digest?: unknown;
      operation_count?: unknown;
      snapshot_id?: unknown;
    };
    root_lineage_verified?: unknown;
  } | null;
  if (
    !response.ok ||
    payload?.authority_ready !== true ||
    payload.root_lineage_verified !== true ||
    payload.asset_count !== manifest.assetCount ||
    payload.receipt?.digest !== manifest.digest ||
    payload.receipt.snapshot_id !== manifest.snapshotId ||
    payload.receipt.operation_count !== manifest.operationCount
  ) {
    throw new Error(
      "The guarded demo bootstrap did not return a verified snapshot receipt; private resume state was retained.",
    );
  }
  await unlink(statePath);
  console.log(
    JSON.stringify(
      {
        assetCount: payload.asset_count,
        authorityReady: true,
        environment: options.environment,
        operationCount: payload.receipt.operation_count,
        outcome: "verified",
        rootLineageVerified: true,
        snapshotId: payload.receipt.snapshot_id,
      },
      null,
      2,
    ),
  );
}

function reportFailure(error: unknown): void {
  const message =
    error instanceof Error ? error.message : "Demo bootstrap failed.";
  const secrets = [
    process.env.AIRTABLE_PAT,
    process.env.DEMO_OWNER_EMAIL,
    process.env.AIRTABLE_PREVIEW_BASE_ID,
    process.env.AIRTABLE_PRODUCTION_BASE_ID,
  ].filter((value): value is string => Boolean(value));
  const redacted = secrets.reduce(
    (value, secret) => value.replaceAll(secret, "[redacted]"),
    message,
  );
  console.error(redacted);
  process.exitCode = 1;
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main().catch(reportFailure);
}

export {
  assertAuthorizationWrite,
  assertManifest,
  authorizationCommand,
  customDomainOrigin,
  parseArguments,
};
