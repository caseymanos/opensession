import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

type EnvironmentName = "preview" | "production";
type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface CliOptions {
  baseUrl: string;
  confirmProduction: boolean;
  environment: EnvironmentName;
  eventId: string;
  eventSlug: string;
  fileId: string;
  resetRunId: string;
}

export interface DemoSmokeManifest {
  assetCount: number;
  digest: string;
  eventId: string;
  operationCount: number;
  organizationId: string;
  schemaVersion: number;
  seedVersion: number;
  snapshotId: string;
}

interface SmokeCredentials {
  apiKey: string;
  ownerCookie: string;
}

interface SmokeCheck {
  name: string;
  requestId: string;
  status: number;
}

export interface DemoSmokeTranscript {
  airtable: {
    judgeTrace: Record<string, number>;
    repairBacklog: { dead: number; failed: number; pending: number };
    schemaVersion: number;
  };
  api: { eventId: string };
  baseUrl: string;
  checks: SmokeCheck[];
  cfp: { conditionalFields: string[] };
  environment: EnvironmentName;
  eventId: string;
  eventSlug: string;
  generatedAt: string;
  reset: {
    assetCount: number;
    digest: string;
    operationCount: number;
    runId: string;
    snapshotId: string;
  };
  schedule: { sessions: number; version: number };
  schemaVersion: 1;
  upload: { contentType: string; fileId: string };
}

interface SmokeOptions extends CliOptions {
  credentials: SmokeCredentials;
  fetchImplementation?: FetchImplementation;
  manifest: DemoSmokeManifest;
  now?: () => Date;
}

const manifestPath = fileURLToPath(
  new URL("../../workers/app/src/demo/seed-manifest.json", import.meta.url),
);
const stableIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const apiKeyPattern = /^osk_key_[A-Za-z0-9_-]{20,80}\.[A-Za-z0-9_-]{32,100}$/;
const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const requestTimeoutMs = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function requireValue(arguments_: readonly string[], index: number): string {
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${arguments_[index] ?? "option"}.`);
  }
  return value;
}

export function parseDemoSmokeOptions(
  arguments_: readonly string[],
  environmentVariables: NodeJS.ProcessEnv = process.env,
): CliOptions {
  let baseUrl = "";
  let environment: EnvironmentName | undefined;
  let eventId = "";
  let eventSlug = "";
  let fileId = "";
  let resetRunId = "";
  let confirmProduction = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--base-url") {
      baseUrl = requireValue(arguments_, index);
      index += 1;
    } else if (argument === "--environment") {
      const value = requireValue(arguments_, index);
      if (value !== "preview" && value !== "production") {
        throw new Error("--environment must be preview or production.");
      }
      environment = value;
      index += 1;
    } else if (argument === "--event-id") {
      eventId = requireValue(arguments_, index);
      index += 1;
    } else if (argument === "--event-slug") {
      eventSlug = requireValue(arguments_, index);
      index += 1;
    } else if (argument === "--file-id") {
      fileId = requireValue(arguments_, index);
      index += 1;
    } else if (argument === "--reset-run-id") {
      resetRunId = requireValue(arguments_, index);
      index += 1;
    } else if (argument === "--confirm-production") {
      confirmProduction = true;
    } else {
      throw new Error(`Unknown demo smoke option: ${argument ?? ""}`);
    }
  }

  if (!environment) {
    throw new Error("Pass --environment preview or production.");
  }
  const parsedUrl = new URL(baseUrl);
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.pathname !== "/" ||
    parsedUrl.search ||
    parsedUrl.hash
  ) {
    throw new Error("--base-url must be a credential-free HTTPS origin.");
  }
  for (const [name, value] of [
    ["--event-id", eventId],
    ["--event-slug", eventSlug],
    ["--file-id", fileId],
    ["--reset-run-id", resetRunId],
  ] as const) {
    if (!stableIdentifierPattern.test(value)) {
      throw new Error(`${name} must be a stable identifier.`);
    }
  }
  if (
    environment === "production" &&
    (!confirmProduction ||
      environmentVariables.DEMO_PRODUCTION_CONFIRM !== "production")
  ) {
    throw new Error(
      "Production smoke requires --confirm-production and DEMO_PRODUCTION_CONFIRM=production.",
    );
  }
  return {
    baseUrl: parsedUrl.origin,
    confirmProduction,
    environment,
    eventId,
    eventSlug,
    fileId,
    resetRunId,
  };
}

export function readSmokeCredentials(
  environmentVariables: NodeJS.ProcessEnv = process.env,
): SmokeCredentials {
  const ownerCookie =
    environmentVariables.DEMO_SMOKE_OWNER_COOKIE?.trim() ?? "";
  const apiKey = environmentVariables.DEMO_SMOKE_API_KEY?.trim() ?? "";
  if (
    !ownerCookie.includes("__Host-opensession-session=") ||
    /[\r\n]/.test(ownerCookie)
  ) {
    throw new Error(
      "DEMO_SMOKE_OWNER_COOKIE must contain a production-safe owner session cookie.",
    );
  }
  if (!apiKeyPattern.test(apiKey)) {
    throw new Error("DEMO_SMOKE_API_KEY must contain a scoped API key.");
  }
  return { apiKey, ownerCookie };
}

function validateManifest(value: unknown): DemoSmokeManifest {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !integer(value.seedVersion) ||
    !stableIdentifierPattern.test(String(value.organizationId ?? "")) ||
    !stableIdentifierPattern.test(String(value.eventId ?? "")) ||
    !stableIdentifierPattern.test(String(value.snapshotId ?? "")) ||
    !digestPattern.test(String(value.digest ?? "")) ||
    !integer(value.operationCount) ||
    !integer(value.assetCount)
  ) {
    throw new Error("The committed demo seed manifest is invalid.");
  }
  return value as unknown as DemoSmokeManifest;
}

async function json(response: Response, name: string): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error(`${name} did not return JSON.`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${name} returned invalid JSON.`);
  }
}

async function request(
  options: SmokeOptions,
  checks: SmokeCheck[],
  name: string,
  path: string,
  init: RequestInit,
  expectedStatus: number,
): Promise<Response> {
  const response = await (options.fetchImplementation ?? fetch)(
    new URL(path, options.baseUrl),
    {
      ...init,
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(requestTimeoutMs),
    },
  );
  if (response.status !== expectedStatus) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${name} returned HTTP ${response.status}.`);
  }
  const requestId = response.headers.get("x-request-id") ?? "";
  if (!requestIdPattern.test(requestId)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${name} did not return a safe request ID.`);
  }
  checks.push({ name, requestId, status: response.status });
  return response;
}

export async function runDemoSmoke(
  options: SmokeOptions,
): Promise<DemoSmokeTranscript> {
  if (options.manifest.eventId !== options.eventId) {
    throw new Error("The requested event does not match the seed manifest.");
  }
  const checks: SmokeCheck[] = [];
  const publicHeaders = { Accept: "application/json" };

  for (const [name, path, expected] of [
    ["live", "/health/live", "ok"],
    ["ready", "/health/ready", "ready"],
  ] as const) {
    const response = await request(
      options,
      checks,
      name,
      path,
      { headers: publicHeaders },
      200,
    );
    const body = await json(response, name);
    if (
      !isRecord(body) ||
      body.environment !== options.environment ||
      body.status !== expected
    ) {
      throw new Error(`${name} did not match the environment contract.`);
    }
  }

  const cfpResponse = await request(
    options,
    checks,
    "conditional_cfp",
    `/api/v1/public/events/${encodeURIComponent(options.eventSlug)}/cfp`,
    { headers: publicHeaders },
    200,
  );
  const cfp = await json(cfpResponse, "conditional_cfp");
  const fields = isRecord(cfp) && isRecord(cfp.form) ? cfp.form.fields : null;
  const conditionalFields = Array.isArray(fields)
    ? fields.flatMap((field) => {
        if (!isRecord(field) || typeof field.key !== "string") return [];
        const rules = Array.isArray(field.rules) ? field.rules : [];
        const effects = new Set(
          rules.flatMap((rule) =>
            isRecord(rule) && typeof rule.effect === "string"
              ? [rule.effect]
              : [],
          ),
        );
        return effects.has("show") && effects.has("require") ? [field.key] : [];
      })
    : [];
  if (
    !isRecord(cfp) ||
    !isRecord(cfp.event) ||
    cfp.event.slug !== options.eventSlug ||
    conditionalFields.length === 0
  ) {
    throw new Error("The public CFP did not expose a conditional field.");
  }

  const healthResponse = await request(
    options,
    checks,
    "admin_airtable_health",
    `/api/events/${encodeURIComponent(options.eventSlug)}/integrations/airtable/health`,
    {
      headers: {
        ...publicHeaders,
        Cookie: options.credentials.ownerCookie,
      },
    },
    200,
  );
  if (healthResponse.headers.get("cache-control") !== "no-store") {
    throw new Error("Admin Airtable health was not marked no-store.");
  }
  const health = await json(healthResponse, "admin_airtable_health");
  const authority = isRecord(health) ? health.authority : null;
  const projection = isRecord(health) ? health.projection : null;
  const backlog = isRecord(projection) ? projection.repair_backlog : null;
  const lastReconcile = isRecord(projection) ? projection.last_reconcile : null;
  const traces = isRecord(health) ? health.judge_trace : null;
  if (
    !isRecord(authority) ||
    !integer(authority.schema_version) ||
    authority.schema_version < 1 ||
    !isRecord(backlog) ||
    !integer(backlog.pending) ||
    !integer(backlog.failed) ||
    !integer(backlog.dead) ||
    backlog.pending !== 0 ||
    backlog.failed !== 0 ||
    backlog.dead !== 0 ||
    !isRecord(lastReconcile) ||
    lastReconcile.status !== "succeeded" ||
    !Array.isArray(traces) ||
    traces.length !== 3
  ) {
    throw new Error(
      "Admin Airtable health did not report a converged projection.",
    );
  }
  const judgeTrace: Record<string, number> = {};
  for (const trace of traces) {
    if (
      !isRecord(trace) ||
      typeof trace.kind !== "string" ||
      !integer(trace.projected_count) ||
      trace.projected_count < 1
    ) {
      throw new Error(
        "Admin Airtable health did not expose seeded judge traces.",
      );
    }
    judgeTrace[trace.kind] = trace.projected_count;
  }
  if (
    !["proposal", "session", "task_assignment"].every(
      (kind) => judgeTrace[kind] !== undefined,
    )
  ) {
    throw new Error("Admin Airtable health returned incomplete judge traces.");
  }

  const scheduleResponse = await request(
    options,
    checks,
    "public_schedule",
    `/api/v1/public/events/${encodeURIComponent(options.eventSlug)}/schedule`,
    { headers: publicHeaders },
    200,
  );
  const schedule = await json(scheduleResponse, "public_schedule");
  if (
    !isRecord(schedule) ||
    !isRecord(schedule.event) ||
    schedule.event.slug !== options.eventSlug ||
    !Array.isArray(schedule.sessions) ||
    schedule.sessions.length < 1 ||
    !integer(schedule.version)
  ) {
    throw new Error("The public schedule did not match the seeded event.");
  }

  const apiResponse = await request(
    options,
    checks,
    "api_example",
    "/api/v1/events?limit=25",
    {
      headers: {
        ...publicHeaders,
        Authorization: `Bearer ${options.credentials.apiKey}`,
      },
    },
    200,
  );
  const api = await json(apiResponse, "api_example");
  const apiEvents = isRecord(api) && Array.isArray(api.data) ? api.data : [];
  if (
    !apiEvents.some((event) => isRecord(event) && event.id === options.eventId)
  ) {
    throw new Error(
      "The documented API example did not return the demo event.",
    );
  }

  const uploadResponse = await request(
    options,
    checks,
    "upload_authorized",
    `/api/uploads/${encodeURIComponent(options.fileId)}`,
    { headers: { Cookie: options.credentials.ownerCookie } },
    200,
  );
  const uploadContentType = uploadResponse.headers.get("content-type") ?? "";
  if (
    uploadResponse.headers.get("cache-control") !== "private, no-store" ||
    (uploadContentType !== "image/png" &&
      uploadContentType !== "application/pdf")
  ) {
    await uploadResponse.body?.cancel().catch(() => undefined);
    throw new Error(
      "The seeded private asset did not match the download contract.",
    );
  }
  await uploadResponse.body?.cancel().catch(() => undefined);

  const deniedUpload = await request(
    options,
    checks,
    "upload_anonymous_denied",
    `/api/uploads/${encodeURIComponent(options.fileId)}`,
    { headers: publicHeaders },
    401,
  );
  await deniedUpload.body?.cancel().catch(() => undefined);

  return {
    airtable: {
      judgeTrace,
      repairBacklog: {
        dead: Number(backlog.dead),
        failed: Number(backlog.failed),
        pending: Number(backlog.pending),
      },
      schemaVersion: Number(authority.schema_version),
    },
    api: { eventId: options.eventId },
    baseUrl: options.baseUrl,
    checks,
    cfp: { conditionalFields },
    environment: options.environment,
    eventId: options.eventId,
    eventSlug: options.eventSlug,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    reset: {
      assetCount: options.manifest.assetCount,
      digest: options.manifest.digest,
      operationCount: options.manifest.operationCount,
      runId: options.resetRunId,
      snapshotId: options.manifest.snapshotId,
    },
    schedule: {
      sessions: schedule.sessions.length,
      version: Number(schedule.version),
    },
    schemaVersion: 1,
    upload: { contentType: uploadContentType, fileId: options.fileId },
  };
}

async function main(): Promise<void> {
  const options = parseDemoSmokeOptions(process.argv.slice(2));
  const manifest = validateManifest(
    JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
  );
  const transcript = await runDemoSmoke({
    ...options,
    credentials: readSmokeCredentials(),
    manifest,
  });
  process.stdout.write(`${JSON.stringify(transcript, null, 2)}\n`);
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  await main();
}
