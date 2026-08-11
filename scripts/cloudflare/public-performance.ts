import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { getActiveVersionId, parseDeploymentList } from "./release.js";

type DeploymentEnvironment = "preview" | "production";
type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface CliOptions {
  confirmProduction: boolean;
  environment: DeploymentEnvironment;
  eventSlug: string;
  seed: string;
}

interface CaptureOptions {
  build: string;
  environment: DeploymentEnvironment;
  eventSlug: string;
  fetchImplementation?: FetchImplementation;
  readActiveBuild: () => Promise<string> | string;
  seed: string;
  url: string;
}

interface DeploymentInventory {
  environment: DeploymentEnvironment;
  worker: {
    activeVersionId: string | null;
    name: string;
    url: string | null;
  };
}

interface InternalMeasurement {
  ageSeconds: number | null;
  bodyBytes: number;
  bodyText: string;
  cacheControl: string | null;
  cacheStatus: string;
  colo: string | null;
  contentType: string | null;
  etag: string | null;
  status: number;
  totalMs: number;
  ttfbMs: number;
}

type Measurement = Omit<InternalMeasurement, "bodyText">;

export interface PublicPerformanceCapture {
  build: string;
  capturedAt: string;
  cold: Measurement;
  conditional: Measurement;
  environment: DeploymentEnvironment;
  p95ThresholdMs: number;
  projection: {
    generatedAt: string;
    sessions: number;
    version: number;
  };
  route: string;
  schemaVersion: 1;
  seed: string;
  url: string;
  warm: {
    cacheStatuses: Record<string, number>;
    p95TtfbMs: number;
    requests: number;
  };
}

const defaultOptions: CliOptions = {
  confirmProduction: false,
  environment: "preview",
  eventSlug: "",
  seed: "",
};
const p95ThresholdMs = 200;
const requestTimeoutMs = 5_000;
const warmRequestCount = 30;
const rootDirectory = fileURLToPath(new URL("../../", import.meta.url));
const wranglerPath = join(rootDirectory, "node_modules/.bin/wrangler");
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const eventSlugPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const strongEntityTagPattern = /^"[a-f\d]{64}"$/;

function requireOptionValue(arguments_: string[], index: number): string {
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${arguments_[index] ?? "option"}.`);
  }
  return value;
}

export function parsePublicPerformanceOptions(
  arguments_: string[],
): CliOptions {
  const options = { ...defaultOptions };

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    switch (argument) {
      case "--":
        break;
      case "--confirm-production":
        options.confirmProduction = true;
        break;
      case "--environment": {
        const value = requireOptionValue(arguments_, index);
        if (value !== "preview" && value !== "production") {
          throw new Error("Environment must be preview or production.");
        }
        options.environment = value;
        index += 1;
        break;
      }
      case "--event-slug":
        options.eventSlug = requireOptionValue(arguments_, index);
        index += 1;
        break;
      case "--seed":
        options.seed = requireOptionValue(arguments_, index);
        index += 1;
        break;
      default:
        throw new Error(`Unknown public performance option: ${argument ?? ""}`);
    }
  }

  if (!eventSlugPattern.test(options.eventSlug)) {
    throw new Error("A safe --event-slug is required.");
  }
  if (!identifierPattern.test(options.seed)) {
    throw new Error("A safe --seed identifier is required.");
  }
  if (options.environment === "production" && !options.confirmProduction) {
    throw new Error(
      "Production capture requires the explicit --confirm-production flag.",
    );
  }

  return options;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readDeploymentInventory(
  environment: DeploymentEnvironment,
): Promise<DeploymentInventory> {
  const path = join(
    rootDirectory,
    ".cloudflare",
    `inventory.${environment}.json`,
  );
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (
    !isRecord(parsed) ||
    parsed.environment !== environment ||
    !isRecord(parsed.worker) ||
    typeof parsed.worker.name !== "string" ||
    (parsed.worker.url !== null && typeof parsed.worker.url !== "string") ||
    (parsed.worker.activeVersionId !== null &&
      typeof parsed.worker.activeVersionId !== "string")
  ) {
    throw new Error(`${environment} deployment inventory is invalid.`);
  }
  return {
    environment,
    worker: {
      activeVersionId: parsed.worker.activeVersionId,
      name: parsed.worker.name,
      url: parsed.worker.url,
    },
  };
}

function readActiveWorkerBuild(workerName: string): string {
  const result = spawnSync(
    wranglerPath,
    ["deployments", "list", "--name", workerName, "--json"],
    {
      cwd: rootDirectory,
      encoding: "utf8",
      env: {
        ...process.env,
        FORCE_COLOR: undefined,
        NO_COLOR: "1",
      },
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error("Wrangler could not read the active Worker version.");
  }

  const activeVersionId = getActiveVersionId(
    parseDeploymentList(result.stdout ?? ""),
  );
  if (!activeVersionId) {
    throw new Error("Cloudflare did not report an active Worker version.");
  }
  return activeVersionId;
}

async function assertActiveBuild(
  expectedBuild: string,
  readActiveBuild: CaptureOptions["readActiveBuild"],
  phase: "before" | "after",
): Promise<void> {
  const activeBuild = await readActiveBuild();
  if (activeBuild !== expectedBuild) {
    const action =
      phase === "before"
        ? "Refresh the deployment inventory before capturing."
        : "Discard this capture and retry after the deployment is stable.";
    throw new Error(
      `Active Worker version ${activeBuild} does not match expected build ${expectedBuild} ${phase} capture. ${action}`,
    );
  }
}

function cacheColo(ray: string | null): string | null {
  const candidate = ray?.split("-").at(-1)?.toUpperCase();
  return candidate && /^[A-Z]{3}$/.test(candidate) ? candidate : null;
}

function numericHeader(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) {
    return null;
  }
  return Number(value);
}

function roundedMilliseconds(value: number): number {
  return Math.round(value * 100) / 100;
}

async function measureRequest(
  url: string,
  fetchImplementation: FetchImplementation,
  timeoutMs: number,
  headers?: HeadersInit,
): Promise<InternalMeasurement> {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("Accept", "application/json");
  requestHeaders.set("Accept-Encoding", "identity");
  const startedAt = performance.now();
  const response = await fetchImplementation(url, {
    headers: requestHeaders,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const headersAt = performance.now();
  const body = await response.arrayBuffer();
  const completedAt = performance.now();

  return {
    ageSeconds: numericHeader(response.headers.get("age")),
    bodyBytes: body.byteLength,
    bodyText: new TextDecoder().decode(body),
    cacheControl: response.headers.get("cache-control"),
    cacheStatus:
      response.headers.get("cf-cache-status")?.toUpperCase() ?? "ABSENT",
    colo: cacheColo(response.headers.get("cf-ray")),
    contentType: response.headers.get("content-type"),
    etag: response.headers.get("etag"),
    status: response.status,
    totalMs: roundedMilliseconds(completedAt - startedAt),
    ttfbMs: roundedMilliseconds(headersAt - startedAt),
  };
}

function publicMeasurement(measurement: InternalMeasurement): Measurement {
  return {
    ageSeconds: measurement.ageSeconds,
    bodyBytes: measurement.bodyBytes,
    cacheControl: measurement.cacheControl,
    cacheStatus: measurement.cacheStatus,
    colo: measurement.colo,
    contentType: measurement.contentType,
    etag: measurement.etag,
    status: measurement.status,
    totalMs: measurement.totalMs,
    ttfbMs: measurement.ttfbMs,
  };
}

function assertPublicProjection(
  measurement: InternalMeasurement,
  eventSlug: string,
): PublicPerformanceCapture["projection"] {
  if (measurement.status !== 200) {
    throw new Error(
      `Public projection returned HTTP ${measurement.status}; a published preview seed is required.`,
    );
  }
  if (!strongEntityTagPattern.test(measurement.etag ?? "")) {
    throw new Error(
      "Public projection did not return its strong SHA-256 ETag.",
    );
  }
  if (measurement.cacheControl !== "public, max-age=0, must-revalidate") {
    throw new Error("Public projection browser cache policy changed.");
  }
  if (!measurement.contentType?.startsWith("application/json")) {
    throw new Error("Public projection did not return JSON content.");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(measurement.bodyText);
  } catch {
    throw new Error("Public projection response was not valid JSON.");
  }
  if (
    !isRecord(payload) ||
    !isRecord(payload.event) ||
    payload.event.slug !== eventSlug ||
    typeof payload.generatedAt !== "string" ||
    !Number.isInteger(payload.version) ||
    !Array.isArray(payload.sessions)
  ) {
    throw new Error(
      "Public projection response did not match the requested seed.",
    );
  }
  return {
    generatedAt: payload.generatedAt,
    sessions: payload.sessions.length,
    version: Number(payload.version),
  };
}

function percentile95(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return (
    sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY
  );
}

function countCacheStatuses(measurements: InternalMeasurement[]) {
  const statuses: Record<string, number> = {};
  for (const measurement of measurements) {
    statuses[measurement.cacheStatus] =
      (statuses[measurement.cacheStatus] ?? 0) + 1;
  }
  return statuses;
}

export async function capturePublicPerformance(
  options: CaptureOptions,
): Promise<PublicPerformanceCapture> {
  await assertActiveBuild(options.build, options.readActiveBuild, "before");
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const cold = await measureRequest(
    options.url,
    fetchImplementation,
    requestTimeoutMs,
  );
  const projection = assertPublicProjection(cold, options.eventSlug);
  if (cold.cacheStatus !== "MISS") {
    throw new Error(
      `Expected a cold MISS after deployment; received ${cold.cacheStatus}.`,
    );
  }

  const warm: InternalMeasurement[] = [];
  for (let request = 0; request < warmRequestCount; request += 1) {
    const measurement = await measureRequest(
      options.url,
      fetchImplementation,
      requestTimeoutMs,
    );
    assertPublicProjection(measurement, options.eventSlug);
    if (measurement.etag !== cold.etag) {
      throw new Error(
        "Public projection ETag changed during the warm capture.",
      );
    }
    if (measurement.cacheStatus !== "HIT") {
      throw new Error(
        `Expected warm HIT ${request + 1}; received ${measurement.cacheStatus}.`,
      );
    }
    warm.push(measurement);
  }

  const p95TtfbMs = roundedMilliseconds(
    percentile95(warm.map((measurement) => measurement.ttfbMs)),
  );
  if (p95TtfbMs > p95ThresholdMs) {
    throw new Error(
      `Warm public projection p95 TTFB ${p95TtfbMs} ms exceeds ${p95ThresholdMs} ms.`,
    );
  }

  const conditional = await measureRequest(
    options.url,
    fetchImplementation,
    requestTimeoutMs,
    { "If-None-Match": cold.etag ?? "" },
  );
  if (
    conditional.status !== 304 ||
    conditional.bodyBytes !== 0 ||
    conditional.etag !== cold.etag ||
    conditional.cacheStatus !== "HIT"
  ) {
    throw new Error(
      "Warm conditional request did not return a bodyless cached 304.",
    );
  }

  await assertActiveBuild(options.build, options.readActiveBuild, "after");

  return {
    build: options.build,
    capturedAt: new Date().toISOString(),
    cold: publicMeasurement(cold),
    conditional: publicMeasurement(conditional),
    environment: options.environment,
    p95ThresholdMs,
    projection,
    route: "/api/v1/public/events/:slug/schedule",
    schemaVersion: 1,
    seed: options.seed,
    url: options.url,
    warm: {
      cacheStatuses: countCacheStatuses(warm),
      p95TtfbMs,
      requests: warm.length,
    },
  };
}

async function runCli(): Promise<void> {
  const options = parsePublicPerformanceOptions(process.argv.slice(2));
  const inventory = await readDeploymentInventory(options.environment);
  if (!inventory.worker.url || !inventory.worker.activeVersionId) {
    throw new Error(
      `${options.environment} must have an active deployed Worker inventory.`,
    );
  }
  const url = new URL(
    `/api/v1/public/events/${encodeURIComponent(options.eventSlug)}/schedule`,
    inventory.worker.url,
  ).toString();
  const result = await capturePublicPerformance({
    build: inventory.worker.activeVersionId,
    environment: options.environment,
    eventSlug: options.eventSlug,
    readActiveBuild: () => readActiveWorkerBuild(inventory.worker.name),
    seed: options.seed,
    url,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && resolve(entry) === fileURLToPath(import.meta.url));
}

if (isDirectExecution()) {
  try {
    await runCli();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    process.stderr.write(`${JSON.stringify({ error: message })}\n`);
    process.exitCode = 1;
  }
}
