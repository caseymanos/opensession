import { spawnSync } from "node:child_process";
import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse, type ParseError } from "jsonc-parser";

import {
  extractDeploymentVersionId,
  getActiveVersionId,
  getRollbackVersionId,
  parseDeploymentList,
  type WorkerDeployment,
} from "./release.js";

type EnvironmentName = "preview" | "production";
type ResourceKind = "D1" | "Queue" | "R2";
type ResourceLocation = "apac" | "eeur" | "enam" | "oc" | "weur" | "wnam";

interface NamedResource {
  binding: string;
  name: string;
}

interface ResourcePlan {
  d1: NamedResource;
  environment: EnvironmentName;
  queues: NamedResource[];
  r2: NamedResource;
  smokeUrls: string[];
  workerName: string;
  workersDev: boolean;
}

interface ResourceDetails {
  id?: string;
}

interface RemoteState {
  d1: Map<string, ResourceDetails>;
  queues: Map<string, ResourceDetails>;
  r2: Map<string, ResourceDetails>;
}

interface ResourceAssessment extends NamedResource {
  id?: string;
  kind: ResourceKind;
  status: "create" | "ready";
}

interface D1Config {
  binding?: string;
  database_id?: string;
  database_name?: string;
  migrations_dir?: string;
}

interface R2Config {
  binding?: string;
  bucket_name?: string;
}

interface QueueConfig {
  binding?: string;
  queue?: string;
}

interface QueueConsumerConfig {
  dead_letter_queue?: string;
  queue?: string;
}

interface RouteConfig {
  custom_domain?: boolean;
  pattern?: string;
}

interface AnalyticsDatasetConfig {
  binding?: string;
  dataset?: string;
}

interface WranglerEnvironment extends Record<string, unknown> {
  analytics_engine_datasets?: AnalyticsDatasetConfig[];
  d1_databases?: D1Config[];
  name?: string;
  queues?: {
    consumers?: QueueConsumerConfig[];
    producers?: QueueConfig[];
  };
  r2_buckets?: R2Config[];
  routes?: RouteConfig[];
  vars?: Record<string, unknown>;
  workers_dev?: boolean;
}

interface WranglerConfig extends Record<string, unknown> {
  assets?: Record<string, unknown>;
  env?: Record<string, WranglerEnvironment | undefined>;
}

interface RenderedWranglerConfig extends WranglerConfig {
  assets: Record<string, unknown> & { directory: string };
  d1_databases: D1Config[];
}

interface Inventory {
  d1: NamedResource & { id: string };
  environment: EnvironmentName;
  generatedAt: string;
  queues: NamedResource[];
  r2: NamedResource;
  schemaVersion: 1;
  worker: {
    activeVersionId: string | null;
    name: string;
    rollbackVersionId: string | null;
    url: string | null;
    urls: string[];
  };
}

interface CliOptions {
  command: "apply" | "deploy" | "plan" | "rollback" | "smoke" | "status";
  confirmProduction: boolean;
  environment: EnvironmentName;
  location: ResourceLocation;
  versionId: string | null;
}

interface WranglerResult {
  stderr: string;
  stdout: string;
}

interface SmokeResult {
  requestIds: string[];
  url: string;
}

const rootDirectory = fileURLToPath(new URL("../../", import.meta.url));
const sourceConfigPath = join(rootDirectory, "workers/app/wrangler.jsonc");
const generatedDirectory = join(rootDirectory, ".cloudflare");
const wranglerPath = join(rootDirectory, "node_modules/.bin/wrangler");
const remoteEnvironments = new Set(["preview", "production"]);
const turnstileTestSiteKeys = new Set([
  "1x00000000000000000000AA",
  "2x00000000000000000000AB",
  "1x00000000000000000000BB",
  "2x00000000000000000000BB",
  "3x00000000000000000000FF",
]);
const ansiEscapePattern = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  "g",
);

export function stripAnsi(value: string): string {
  return value.replaceAll(ansiEscapePattern, "");
}

export function parseD1List(value: string): Map<string, ResourceDetails> {
  const parsed: unknown = JSON.parse(stripAnsi(value));

  if (!Array.isArray(parsed)) {
    throw new Error("Wrangler returned an unexpected D1 list response.");
  }

  return new Map(parsed.map((database) => parseD1Database(database)));
}

function parseD1Database(value: unknown): [string, ResourceDetails] {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.uuid !== "string"
  ) {
    throw new Error("Wrangler returned an invalid D1 database entry.");
  }

  return [value.name, { id: value.uuid }];
}

export function parseR2List(value: string): Map<string, ResourceDetails> {
  const buckets = new Map<string, ResourceDetails>();

  for (const match of stripAnsi(value).matchAll(/^name:\s*(.+)$/gm)) {
    const name = match[1];

    if (name) {
      buckets.set(name.trim(), {});
    }
  }

  return buckets;
}

export function parseQueueList(value: string): Map<string, ResourceDetails> {
  const queues = new Map<string, ResourceDetails>();

  for (const line of stripAnsi(value).split("\n")) {
    const cells = line
      .split("│")
      .map((cell) => cell.trim())
      .filter(Boolean);

    const [id, name] = cells;

    if (id && name && /^[a-f\d-]{32,36}$/i.test(id)) {
      queues.set(name, { id });
    }
  }

  return queues;
}

function parseConfiguredResource(
  resource: { binding: string | undefined; name: string | undefined },
  label: string,
): NamedResource {
  if (!resource.binding || !resource.name) {
    throw new Error(`${label} must declare a binding and resource name.`);
  }

  return { binding: resource.binding, name: resource.name };
}

export function getCustomDomainUrls(
  routes: RouteConfig[] | undefined,
): string[] {
  return (routes ?? [])
    .filter((route) => route.custom_domain === true)
    .map((route) => {
      const pattern = route.pattern;

      if (!pattern) {
        throw new Error("Custom Domain must declare an exact hostname.");
      }

      if (
        pattern.includes("*") ||
        pattern.includes("/") ||
        pattern.includes(":")
      ) {
        throw new Error(`Custom Domain must be an exact hostname: ${pattern}.`);
      }

      const url = new URL(`https://${pattern}`);

      if (url.hostname !== pattern.toLowerCase()) {
        throw new Error(`Custom Domain must be a valid hostname: ${pattern}.`);
      }

      return url.origin;
    });
}

export function getResourcePlan(
  config: WranglerConfig,
  environment: EnvironmentName,
): ResourcePlan {
  if (!remoteEnvironments.has(environment)) {
    throw new Error("Environment must be preview or production.");
  }

  assertEnvironmentIsolation(config);

  const target = config.env?.[environment];

  if (!target?.name) {
    throw new Error(`Missing Wrangler environment: ${environment}.`);
  }

  if (typeof target.workers_dev !== "boolean") {
    throw new Error(
      `${environment} must declare an explicit workers_dev policy.`,
    );
  }

  if (
    typeof target.vars?.AIRTABLE_BASE_ID !== "string" ||
    !/^app[A-Za-z0-9]{14}$/.test(target.vars.AIRTABLE_BASE_ID)
  ) {
    throw new Error(
      `${environment} must declare a configured Airtable base ID.`,
    );
  }

  if (
    typeof target.vars.TURNSTILE_SITE_KEY !== "string" ||
    !/^[A-Za-z0-9_-]{3,32}$/.test(target.vars.TURNSTILE_SITE_KEY) ||
    /^(?:CONFIGURE|REPLACE)_/.test(target.vars.TURNSTILE_SITE_KEY) ||
    turnstileTestSiteKeys.has(target.vars.TURNSTILE_SITE_KEY)
  ) {
    throw new Error(
      `${environment} must declare a configured non-test Turnstile site key.`,
    );
  }

  if (target.d1_databases?.length !== 1) {
    throw new Error(`${environment} must declare exactly one D1 database.`);
  }

  if (target.r2_buckets?.length !== 1) {
    throw new Error(`${environment} must declare exactly one R2 bucket.`);
  }

  const d1Config = target.d1_databases[0];
  const r2Config = target.r2_buckets[0];

  if (!d1Config || !r2Config) {
    throw new Error(`${environment} resource configuration is incomplete.`);
  }

  const queueConfigs = target.queues?.producers ?? [];
  const queueConsumers = target.queues?.consumers ?? [];
  const d1 = parseConfiguredResource(
    { binding: d1Config.binding, name: d1Config.database_name },
    "D1 database",
  );
  const r2 = parseConfiguredResource(
    { binding: r2Config.binding, name: r2Config.bucket_name },
    "R2 bucket",
  );
  const queues = queueConfigs.map((queue) =>
    parseConfiguredResource(
      { binding: queue.binding, name: queue.queue },
      "Queue",
    ),
  );
  const queueNames = new Set(queues.map(({ name }) => name));
  queueConsumers.forEach((consumer, index) => {
    if (typeof consumer.queue !== "string" || consumer.queue.length === 0) {
      throw new Error(`${environment} contains an invalid Queue consumer.`);
    }
    if (!queueNames.has(consumer.queue)) {
      queues.push({
        binding: `CONSUMER_QUEUE_${index + 1}`,
        name: consumer.queue,
      });
      queueNames.add(consumer.queue);
    }
    if (
      consumer.dead_letter_queue &&
      !queueNames.has(consumer.dead_letter_queue)
    ) {
      queues.push({
        binding: `DEAD_LETTER_QUEUE_${index + 1}`,
        name: consumer.dead_letter_queue,
      });
      queueNames.add(consumer.dead_letter_queue);
    }
  });

  if (queues.length === 0) {
    throw new Error(`${environment} must declare at least one queue.`);
  }

  const names = [d1.name, r2.name, ...queues.map((queue) => queue.name)];

  if (new Set(names).size !== names.length) {
    throw new Error(`${environment} resource names must be unique.`);
  }

  return {
    environment,
    workerName: target.name,
    workersDev: target.workers_dev,
    smokeUrls: getCustomDomainUrls(target.routes),
    d1,
    r2,
    queues,
  };
}

function configuredValues(values: (string | undefined)[]): string[] {
  return values.filter((value): value is string => Boolean(value));
}

function queueResourceNames(environment: WranglerEnvironment): string[] {
  return configuredValues([
    ...(environment.queues?.producers ?? []).map((queue) => queue.queue),
    ...(environment.queues?.consumers ?? []).flatMap((consumer) => [
      consumer.queue,
      consumer.dead_letter_queue,
    ]),
  ]);
}

function assertDisjoint(
  label: string,
  previewValues: string[],
  productionValues: string[],
): void {
  const production = new Set(productionValues);
  const shared = [...new Set(previewValues)].filter((value) =>
    production.has(value),
  );
  if (shared.length > 0) {
    throw new Error(
      `Preview and production must not share ${label}: ${shared.join(", ")}.`,
    );
  }
}

export function assertEnvironmentIsolation(config: WranglerConfig): void {
  const preview = config.env?.preview;
  const production = config.env?.production;
  if (!preview || !production) {
    return;
  }

  assertDisjoint(
    "Worker names",
    configuredValues([preview.name]),
    configuredValues([production.name]),
  );
  assertDisjoint(
    "Airtable bases",
    configuredValues([
      typeof preview.vars?.AIRTABLE_BASE_ID === "string"
        ? preview.vars.AIRTABLE_BASE_ID
        : undefined,
    ]),
    configuredValues([
      typeof production.vars?.AIRTABLE_BASE_ID === "string"
        ? production.vars.AIRTABLE_BASE_ID
        : undefined,
    ]),
  );
  assertDisjoint(
    "D1 databases",
    configuredValues(
      (preview.d1_databases ?? []).map((database) => database.database_name),
    ),
    configuredValues(
      (production.d1_databases ?? []).map((database) => database.database_name),
    ),
  );
  assertDisjoint(
    "R2 buckets",
    configuredValues(
      (preview.r2_buckets ?? []).map((bucket) => bucket.bucket_name),
    ),
    configuredValues(
      (production.r2_buckets ?? []).map((bucket) => bucket.bucket_name),
    ),
  );
  assertDisjoint(
    "Queues",
    queueResourceNames(preview),
    queueResourceNames(production),
  );
  assertDisjoint(
    "Custom Domains",
    configuredValues((preview.routes ?? []).map((route) => route.pattern)),
    configuredValues((production.routes ?? []).map((route) => route.pattern)),
  );
  assertDisjoint(
    "Analytics Engine datasets",
    configuredValues(
      (preview.analytics_engine_datasets ?? []).map(
        (dataset) => dataset.dataset,
      ),
    ),
    configuredValues(
      (production.analytics_engine_datasets ?? []).map(
        (dataset) => dataset.dataset,
      ),
    ),
  );
}

export function getDeploymentSmokeUrls(
  plan: Pick<ResourcePlan, "smokeUrls" | "workersDev">,
  workersDevUrl: string | null,
): string[] {
  if (plan.workersDev && !workersDevUrl) {
    throw new Error("Wrangler did not return a workers.dev deployment URL.");
  }

  return [
    ...new Set([
      ...plan.smokeUrls,
      ...(plan.workersDev && workersDevUrl ? [workersDevUrl] : []),
    ]),
  ];
}

function getConfiguredSmokeUrls(
  plan: Pick<ResourcePlan, "smokeUrls" | "workersDev">,
  inventoryUrls: string[],
): string[] {
  const workersDevUrls = inventoryUrls.filter((url) => {
    try {
      return new URL(url).hostname.endsWith(".workers.dev");
    } catch {
      return false;
    }
  });

  return [
    ...new Set([...plan.smokeUrls, ...(plan.workersDev ? workersDevUrls : [])]),
  ];
}

export function assertProductionConfirmation(
  environment: EnvironmentName,
  options: Pick<CliOptions, "confirmProduction">,
  productionConfirmation: string | null | undefined = process.env
    .CLOUDFLARE_PRODUCTION_CONFIRM,
): void {
  if (
    environment === "production" &&
    !(options.confirmProduction && productionConfirmation === "production")
  ) {
    throw new Error(
      "Production requires --confirm-production and CLOUDFLARE_PRODUCTION_CONFIRM=production.",
    );
  }
}

export function assessResources(
  plan: ResourcePlan,
  state: RemoteState,
): ResourceAssessment[] {
  const d1Id = state.d1.get(plan.d1.name)?.id;

  return [
    {
      binding: plan.d1.binding,
      ...(d1Id ? { id: d1Id } : {}),
      kind: "D1",
      name: plan.d1.name,
      status: state.d1.has(plan.d1.name) ? "ready" : "create",
    },
    {
      binding: plan.r2.binding,
      kind: "R2",
      name: plan.r2.name,
      status: state.r2.has(plan.r2.name) ? "ready" : "create",
    },
    ...plan.queues.map((queue): ResourceAssessment => {
      const id = state.queues.get(queue.name)?.id;

      return {
        binding: queue.binding,
        ...(id ? { id } : {}),
        kind: "Queue",
        name: queue.name,
        status: state.queues.has(queue.name) ? "ready" : "create",
      };
    }),
  ];
}

export function renderDeploymentConfig(
  config: WranglerConfig,
  environment: EnvironmentName,
  inventory: { d1: { id: string } },
): RenderedWranglerConfig {
  const target = config.env?.[environment];

  if (!target) {
    throw new Error(`Missing Wrangler environment: ${environment}.`);
  }

  if (!target.d1_databases) {
    throw new Error(`${environment} must declare a D1 database.`);
  }

  const baseConfig = { ...config };
  delete baseConfig.env;
  const rendered = {
    ...baseConfig,
    ...target,
    $schema: "../node_modules/wrangler/config-schema.json",
    main: "../workers/app/src/index.ts",
    assets: {
      ...baseConfig.assets,
      directory: "../apps/web/dist",
    },
    d1_databases: target.d1_databases.map((database) => ({
      ...database,
      database_id: inventory.d1.id,
      migrations_dir: "../migrations",
    })),
  };

  return rendered;
}

function runWrangler(
  arguments_: string[],
  { print = false }: { print?: boolean } = {},
): WranglerResult {
  const result = spawnSync(wranglerPath, arguments_, {
    cwd: rootDirectory,
    encoding: "utf8",
    env: {
      ...process.env,
      FORCE_COLOR: undefined,
      NO_COLOR: "1",
    },
    maxBuffer: 10 * 1024 * 1024,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";

  if (print) {
    process.stdout.write(stripAnsi(stdout));
    process.stderr.write(stripAnsi(stderr));
  }

  if (result.status !== 0) {
    const detail = stripAnsi(stderr || stdout).trim();
    throw new Error(
      `Wrangler ${arguments_.slice(0, 3).join(" ")} failed${detail ? `: ${detail}` : "."}`,
    );
  }

  return { stderr, stdout };
}

export function applyAirtableBaseOverride(
  config: WranglerConfig,
  environment: EnvironmentName,
  baseId: string | undefined,
): WranglerConfig {
  if (!baseId) {
    return config;
  }
  if (!/^app[A-Za-z0-9]{14}$/.test(baseId)) {
    throw new Error(
      `AIRTABLE_${environment.toUpperCase()}_BASE_ID must be a valid Airtable base ID.`,
    );
  }
  const target = config.env?.[environment];
  if (!target) {
    throw new Error(`Missing Wrangler environment: ${environment}.`);
  }
  target.vars = { ...target.vars, AIRTABLE_BASE_ID: baseId };
  return config;
}

export function applyTurnstileSiteKeyOverride(
  config: WranglerConfig,
  environment: EnvironmentName,
  siteKey: string | undefined,
): WranglerConfig {
  if (!siteKey) {
    return config;
  }
  if (
    !/^[A-Za-z0-9_-]{3,32}$/.test(siteKey) ||
    /^(?:CONFIGURE|REPLACE)_/.test(siteKey) ||
    turnstileTestSiteKeys.has(siteKey)
  ) {
    throw new Error(
      `TURNSTILE_${environment.toUpperCase()}_SITE_KEY must be a valid non-test Turnstile site key.`,
    );
  }
  const target = config.env?.[environment];
  if (!target) {
    throw new Error(`Missing Wrangler environment: ${environment}.`);
  }
  target.vars = { ...target.vars, TURNSTILE_SITE_KEY: siteKey };
  return config;
}

async function readSourceConfig(): Promise<WranglerConfig> {
  const errors: ParseError[] = [];
  const config: unknown = parse(
    await readFile(sourceConfigPath, "utf8"),
    errors,
    {
      allowTrailingComma: true,
    },
  );

  if (errors.length > 0) {
    throw new Error("workers/app/wrangler.jsonc contains invalid JSONC.");
  }

  if (!isRecord(config)) {
    throw new Error("workers/app/wrangler.jsonc must contain an object.");
  }

  const withPreviewBase = applyAirtableBaseOverride(
    config as WranglerConfig,
    "preview",
    process.env.AIRTABLE_PREVIEW_BASE_ID,
  );
  const withProductionBase = applyAirtableBaseOverride(
    withPreviewBase,
    "production",
    process.env.AIRTABLE_PRODUCTION_BASE_ID,
  );
  const withPreviewTurnstile = applyTurnstileSiteKeyOverride(
    withProductionBase,
    "preview",
    process.env.TURNSTILE_PREVIEW_SITE_KEY,
  );
  return applyTurnstileSiteKeyOverride(
    withPreviewTurnstile,
    "production",
    process.env.TURNSTILE_PRODUCTION_SITE_KEY,
  );
}

async function readRemoteState(): Promise<RemoteState> {
  return {
    d1: parseD1List(runWrangler(["d1", "list", "--json"]).stdout),
    r2: parseR2List(runWrangler(["r2", "bucket", "list"]).stdout),
    queues: readAllQueues(),
  };
}

export function isMissingWorkerError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("This Worker does not exist on your account.") &&
    error.message.includes("[code: 10007]")
  );
}

function readDeployments(
  plan: ResourcePlan,
  { allowMissingWorker = false }: { allowMissingWorker?: boolean } = {},
): WorkerDeployment[] {
  try {
    return parseDeploymentList(
      runWrangler(["deployments", "list", "--name", plan.workerName, "--json"])
        .stdout,
    );
  } catch (error) {
    if (allowMissingWorker && isMissingWorkerError(error)) return [];
    throw error;
  }
}

async function waitForActiveVersion(
  plan: ResourcePlan,
  expectedVersionId: string,
): Promise<string> {
  let lastVersionId: string | null = null;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    lastVersionId = getActiveVersionId(readDeployments(plan));

    if (lastVersionId && lastVersionId === expectedVersionId) {
      return lastVersionId;
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }

  throw new Error(
    `Cloudflare did not activate expected version ${expectedVersionId}; current version is ${lastVersionId ?? "unavailable"}.`,
  );
}

function readAllQueues(): Map<string, ResourceDetails> {
  const queues = new Map<string, ResourceDetails>();

  for (let page = 1; page <= 100; page += 1) {
    const pageQueues = parseQueueList(
      runWrangler(["queues", "list", "--page", String(page)]).stdout,
    );

    if (pageQueues.size === 0) {
      return queues;
    }

    for (const [name, details] of pageQueues) {
      queues.set(name, details);
    }
  }

  throw new Error("Queue inventory exceeded the 100-page safety limit.");
}

function inventoryPath(environment: EnvironmentName): string {
  return join(generatedDirectory, `inventory.${environment}.json`);
}

async function readInventory(
  environment: EnvironmentName,
): Promise<Inventory | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(inventoryPath(environment), "utf8"),
    );
    return parseInventory(parsed, environment);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

async function writeInventory(
  plan: ResourcePlan,
  resources: ResourceAssessment[],
  previousInventory: Inventory | null = null,
): Promise<Inventory> {
  const d1 = resources.find((resource) => resource.kind === "D1");

  if (!d1?.id) {
    throw new Error("Provisioned D1 database did not return an ID.");
  }

  const urls = getConfiguredSmokeUrls(
    plan,
    previousInventory?.worker.urls ?? [],
  );
  const inventory: Inventory = {
    schemaVersion: 1,
    environment: plan.environment,
    generatedAt: new Date().toISOString(),
    worker: {
      activeVersionId: previousInventory?.worker.activeVersionId ?? null,
      name: plan.workerName,
      rollbackVersionId: previousInventory?.worker.rollbackVersionId ?? null,
      url: urls[0] ?? null,
      urls,
    },
    d1: {
      binding: plan.d1.binding,
      id: d1.id,
      name: plan.d1.name,
    },
    r2: {
      binding: plan.r2.binding,
      name: plan.r2.name,
    },
    queues: plan.queues,
  };

  await writeJsonAtomic(inventoryPath(plan.environment), inventory);
  return inventory;
}

function printResources(resources: ResourceAssessment[]): void {
  for (const resource of resources) {
    console.log(
      `${resource.status.padEnd(6)} ${resource.kind.padEnd(5)} ${resource.binding.padEnd(28)} ${resource.name}`,
    );
  }
}

async function applyPlan(
  plan: ResourcePlan,
  options: CliOptions,
): Promise<Inventory> {
  assertProductionConfirmation(plan.environment, options);
  let state = await readRemoteState();
  let resources = assessResources(plan, state);

  printResources(resources);

  for (const resource of resources.filter(
    (candidate) => candidate.status === "create",
  )) {
    console.log(`create ${resource.kind} ${resource.name}`);

    if (resource.kind === "D1") {
      runWrangler([
        "d1",
        "create",
        resource.name,
        "--location",
        options.location,
      ]);
    } else if (resource.kind === "R2") {
      runWrangler([
        "r2",
        "bucket",
        "create",
        resource.name,
        "--location",
        options.location,
      ]);
    } else {
      runWrangler(["queues", "create", resource.name]);
    }
  }

  state = await readRemoteState();
  resources = assessResources(plan, state);
  const missing = resources.filter((resource) => resource.status !== "ready");

  if (missing.length > 0) {
    throw new Error(
      `Provisioning incomplete: ${missing.map((resource) => resource.name).join(", ")}`,
    );
  }

  const inventory = await writeInventory(
    plan,
    resources,
    await readInventory(plan.environment),
  );
  console.log(`inventory ${inventoryPath(plan.environment)}`);
  return inventory;
}

async function renderConfig(
  config: WranglerConfig,
  environment: EnvironmentName,
  inventory: Inventory,
): Promise<string> {
  const path = join(generatedDirectory, `wrangler.${environment}.json`);
  await writeJsonAtomic(
    path,
    renderDeploymentConfig(config, environment, inventory),
  );
  return path;
}

function extractDeploymentUrl(value: string): string | null {
  const matches = stripAnsi(value).match(/https:\/\/[^\s]+\.workers\.dev/g);
  return matches?.at(-1) ?? null;
}

export async function smokeDeployment(
  url: string,
  environment: EnvironmentName,
): Promise<SmokeResult> {
  let lastError: unknown = new Error(`${environment} smoke test did not run.`);

  for (let attempt = 0; attempt < 15; attempt += 1) {
    try {
      const smokeToken = `${Date.now()}-${attempt}`;
      const requestUrl = (pathname: string): URL => {
        const target = new URL(pathname, url);
        target.searchParams.set("__opensession_smoke", smokeToken);
        return target;
      };
      const requestOptions = {
        headers: { "Cache-Control": "no-cache" },
      };
      const health = await fetch(requestUrl("/health/live"), {
        ...requestOptions,
        signal: AbortSignal.timeout(5_000),
      });
      const healthContentType = health.headers.get("content-type") ?? "";
      const healthBody: unknown = healthContentType.includes("application/json")
        ? await health.json()
        : null;
      const readiness = await fetch(requestUrl("/health/ready"), {
        ...requestOptions,
        signal: AbortSignal.timeout(5_000),
      });
      const readinessContentType = readiness.headers.get("content-type") ?? "";
      const readinessBody: unknown = readinessContentType.includes(
        "application/json",
      )
        ? await readiness.json()
        : null;
      const shell = await fetch(requestUrl("/"), {
        ...requestOptions,
        signal: AbortSignal.timeout(5_000),
      });
      const shellBody = await shell.text();
      const healthRequestId = health.headers.get("x-request-id");
      const readinessRequestId = readiness.headers.get("x-request-id");

      if (
        !health.ok ||
        !isRecord(healthBody) ||
        healthBody.environment !== environment ||
        healthBody.status !== "ok" ||
        !readiness.ok ||
        !isRecord(readinessBody) ||
        readinessBody.environment !== environment ||
        readinessBody.status !== "ready" ||
        !isVersionId(healthRequestId) ||
        !isVersionId(readinessRequestId) ||
        !shell.ok ||
        !shellBody.includes("OpenSession")
      ) {
        throw new Error(
          `${environment} responses did not match the release contract (health ${health.status} ${healthContentType || "unknown content type"}; readiness ${readiness.status} ${readinessContentType || "unknown content type"}; shell ${shell.status}).`,
        );
      }

      return {
        requestIds: [healthRequestId, readinessRequestId],
        url,
      };
    } catch (error) {
      lastError = error;

      if (attempt < 14) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
      }
    }
  }

  throw lastError;
}

export async function smokeDeployments(
  urls: string[],
  environment: EnvironmentName,
): Promise<SmokeResult[]> {
  return Promise.all(urls.map((url) => smokeDeployment(url, environment)));
}

function printSmokeResult(result: SmokeResult): void {
  console.log(`smoke   ${result.url}`);

  if (result.requestIds.length > 0) {
    console.log(`requests ${result.requestIds.join(" ")}`);
  }
}

function printSmokeResults(results: SmokeResult[]): void {
  for (const result of results) {
    printSmokeResult(result);
  }
}

async function deploy(
  config: WranglerConfig,
  plan: ResourcePlan,
  options: CliOptions,
): Promise<void> {
  assertProductionConfirmation(plan.environment, options);
  const previousInventory = await readInventory(plan.environment);

  if (!previousInventory) {
    throw new Error(
      `Run apply for ${plan.environment} before attempting deployment.`,
    );
  }

  const previousActiveVersionId = previousInventory.worker.url
    ? getActiveVersionId(readDeployments(plan))
    : null;

  const resources = assessResources(plan, await readRemoteState());
  const missing = resources.filter((resource) => resource.status !== "ready");

  if (missing.length > 0) {
    throw new Error(
      `Remote resources are missing; rerun apply: ${missing.map((resource) => resource.name).join(", ")}`,
    );
  }

  const inventory = await writeInventory(plan, resources, previousInventory);

  const configPath = await renderConfig(config, plan.environment, inventory);
  console.log(`migrate ${plan.d1.name}`);
  runWrangler(
    [
      "d1",
      "migrations",
      "apply",
      plan.d1.binding,
      "--remote",
      "--config",
      configPath,
    ],
    { print: true },
  );
  const result = runWrangler(["deploy", "--config", configPath], {
    print: true,
  });
  const deploymentOutput = `${result.stdout}\n${result.stderr}`;
  const workersDevUrl = extractDeploymentUrl(deploymentOutput);
  const urls = getDeploymentSmokeUrls(plan, workersDevUrl);
  const deployedVersionId = extractDeploymentVersionId(deploymentOutput);

  if (urls.length === 0) {
    throw new Error("Wrangler did not return a workers.dev deployment URL.");
  }

  if (!deployedVersionId) {
    throw new Error("Wrangler did not return a deployed Worker version ID.");
  }

  const smokeResults = await smokeDeployments(urls, plan.environment);
  const activeVersionId = await waitForActiveVersion(plan, deployedVersionId);
  const updatedInventory: Inventory = {
    ...inventory,
    generatedAt: new Date().toISOString(),
    worker: {
      ...inventory.worker,
      activeVersionId,
      rollbackVersionId:
        previousActiveVersionId === activeVersionId
          ? inventory.worker.rollbackVersionId
          : previousActiveVersionId,
      url: urls[0] ?? null,
      urls,
    },
  };
  await writeJsonAtomic(inventoryPath(plan.environment), updatedInventory);
  console.log(`version ${activeVersionId}`);
  printSmokeResults(smokeResults);
}

async function rollback(
  plan: ResourcePlan,
  options: CliOptions,
): Promise<void> {
  assertProductionConfirmation(plan.environment, options);

  if (!options.versionId) {
    throw new Error("Rollback requires an explicit --version-id.");
  }

  const inventory = await readInventory(plan.environment);

  if (!inventory || inventory.worker.urls.length === 0) {
    throw new Error(
      `No deployed ${plan.environment} inventory is available for rollback.`,
    );
  }

  const resources = assessResources(plan, await readRemoteState());
  const missing = resources.filter((resource) => resource.status !== "ready");

  if (missing.length > 0) {
    throw new Error(
      `Remote resources are missing; rollback is unsafe: ${missing.map((resource) => resource.name).join(", ")}`,
    );
  }

  const deployments = readDeployments(plan);
  const activeVersionId = getActiveVersionId(deployments);

  if (!activeVersionId) {
    throw new Error(`No active ${plan.environment} Worker version exists.`);
  }

  if (activeVersionId === options.versionId) {
    throw new Error(`Version ${options.versionId} is already active.`);
  }

  if (
    !deployments.some((deployment) =>
      deployment.versions.some(
        (version) => version.versionId === options.versionId,
      ),
    )
  ) {
    throw new Error(
      `Version ${options.versionId} is not present in recent deployment history.`,
    );
  }

  console.log(
    "rollback affects Worker code and configuration only; storage data and migrations are unchanged",
  );
  runWrangler(
    [
      "rollback",
      options.versionId,
      "--name",
      plan.workerName,
      "--message",
      `OpenSession ${plan.environment} rollback`,
    ],
    { print: true },
  );

  await waitForActiveVersion(plan, options.versionId);
  const smokeResults = await smokeDeployments(
    getConfiguredSmokeUrls(plan, inventory.worker.urls),
    plan.environment,
  );

  const updatedInventory: Inventory = {
    ...inventory,
    generatedAt: new Date().toISOString(),
    worker: {
      ...inventory.worker,
      activeVersionId: options.versionId,
      rollbackVersionId: activeVersionId,
    },
  };
  await writeJsonAtomic(inventoryPath(plan.environment), updatedInventory);
  console.log(`version ${options.versionId}`);
  printSmokeResults(smokeResults);
}

export function parseArguments(argv: string[]): CliOptions {
  const [command, ...arguments_] = argv;
  const options: {
    command: string | undefined;
    confirmProduction: boolean;
    environment: string | null;
    location: string;
    versionId: string | null;
  } = {
    command,
    confirmProduction: false,
    environment: null,
    location: "wnam",
    versionId: null,
  };

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];

    if (argument === "--environment") {
      options.environment = arguments_[index + 1] ?? null;
      index += 1;
    } else if (argument === "--location") {
      options.location = arguments_[index + 1] ?? "";
      index += 1;
    } else if (argument === "--version-id") {
      options.versionId = arguments_[index + 1] ?? null;
      index += 1;
    } else if (argument === "--confirm-production") {
      options.confirmProduction = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!isCommand(command)) {
    throw new Error(
      "Command must be plan, status, apply, deploy, rollback, or smoke.",
    );
  }

  if (!isEnvironmentName(options.environment)) {
    throw new Error("Pass --environment preview or production.");
  }

  if (!isResourceLocation(options.location)) {
    throw new Error(`Unsupported location: ${options.location}`);
  }

  if (command === "rollback" && !isVersionId(options.versionId)) {
    throw new Error("Rollback requires a valid --version-id UUID.");
  }

  if (command !== "rollback" && options.versionId) {
    throw new Error("--version-id is only valid with rollback.");
  }

  return {
    command,
    confirmProduction: options.confirmProduction,
    environment: options.environment,
    location: options.location,
    versionId: options.versionId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isEnvironmentName(value: unknown): value is EnvironmentName {
  return value === "preview" || value === "production";
}

function isResourceLocation(value: unknown): value is ResourceLocation {
  return new Set(["weur", "eeur", "apac", "oc", "wnam", "enam"]).has(
    String(value),
  );
}

function isCommand(value: unknown): value is CliOptions["command"] {
  return new Set([
    "apply",
    "deploy",
    "plan",
    "rollback",
    "smoke",
    "status",
  ]).has(String(value));
}

function isVersionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value)
  );
}

function isOptionalVersionId(
  value: unknown,
): value is string | null | undefined {
  return value === undefined || value === null || isVersionId(value);
}

function parseNamedResource(value: unknown, label: string): NamedResource {
  if (
    !isRecord(value) ||
    typeof value.binding !== "string" ||
    typeof value.name !== "string"
  ) {
    throw new Error(`Inventory contains an invalid ${label}.`);
  }

  return { binding: value.binding, name: value.name };
}

function parseInventory(
  value: unknown,
  expectedEnvironment: EnvironmentName,
): Inventory {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.environment !== expectedEnvironment ||
    typeof value.generatedAt !== "string" ||
    !isRecord(value.worker) ||
    typeof value.worker.name !== "string" ||
    !(typeof value.worker.url === "string" || value.worker.url === null) ||
    !(
      value.worker.urls === undefined ||
      (Array.isArray(value.worker.urls) &&
        value.worker.urls.every((url) => typeof url === "string"))
    ) ||
    !isOptionalVersionId(value.worker.activeVersionId) ||
    !isOptionalVersionId(value.worker.rollbackVersionId) ||
    !isRecord(value.d1) ||
    typeof value.d1.id !== "string" ||
    !Array.isArray(value.queues)
  ) {
    throw new Error(`Inventory for ${expectedEnvironment} is invalid.`);
  }

  const urls = Array.isArray(value.worker.urls)
    ? (value.worker.urls as string[])
    : typeof value.worker.url === "string"
      ? [value.worker.url]
      : [];

  return {
    d1: { ...parseNamedResource(value.d1, "D1 database"), id: value.d1.id },
    environment: expectedEnvironment,
    generatedAt: value.generatedAt,
    queues: value.queues.map((queue) => parseNamedResource(queue, "queue")),
    r2: parseNamedResource(value.r2, "R2 bucket"),
    schemaVersion: 1,
    worker: {
      activeVersionId: value.worker.activeVersionId ?? null,
      name: value.worker.name,
      rollbackVersionId: value.worker.rollbackVersionId ?? null,
      url: value.worker.url,
      urls,
    },
  };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const config = await readSourceConfig();
  const plan = getResourcePlan(config, options.environment);

  if (options.command === "apply") {
    await applyPlan(plan, options);
    return;
  }

  if (options.command === "deploy") {
    await deploy(config, plan, options);
    return;
  }

  if (options.command === "rollback") {
    await rollback(plan, options);
    return;
  }

  if (options.command === "smoke") {
    const inventory = await readInventory(plan.environment);
    const urls = getConfiguredSmokeUrls(plan, inventory?.worker.urls ?? []);

    if (urls.length === 0) {
      throw new Error(
        `No deployed ${plan.environment} inventory is available for smoke testing.`,
      );
    }

    printSmokeResults(await smokeDeployments(urls, plan.environment));
    return;
  }

  const resources = assessResources(plan, await readRemoteState());
  printResources(resources);

  if (options.command === "status") {
    const inventory = await readInventory(plan.environment);
    console.log(
      `inventory ${inventory ? inventoryPath(plan.environment) : "missing"}`,
    );

    if (inventory?.worker.url ?? plan.smokeUrls[0]) {
      const deployments = readDeployments(plan, { allowMissingWorker: true });
      const activeVersionId = getActiveVersionId(deployments);
      const remoteRollbackVersionId = getRollbackVersionId(deployments);
      const rollbackVersionId =
        inventory && inventory.worker.activeVersionId === activeVersionId
          ? (inventory.worker.rollbackVersionId ?? remoteRollbackVersionId)
          : remoteRollbackVersionId;
      console.log(`active   ${activeVersionId ?? "missing"}`);
      console.log(`rollback ${rollbackVersionId ?? "unavailable"}`);
    }
  }
}

const entryPath = process.argv[1];
const isCliEntry =
  typeof entryPath === "string" &&
  pathToFileURL(resolve(entryPath)).href === import.meta.url;

if (isCliEntry) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
