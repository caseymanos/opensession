import type { WorkerDeployment } from "./release.js";

export interface LockedLkgReceipt {
  approvedBy: string;
  deploymentId: string;
  environment: "preview" | "production";
  resourceFingerprint: WorkerResourceFingerprint[];
  schemaVersion: 1;
  scriptEtag: string;
  sourceCommit: string;
  sourceTree: string;
  verifiedAt: string;
  versionId: string;
  workerName: string;
}

export interface QueueBaselineReceipt {
  acceptedBy: string;
  backlogBytes: number;
  backlogCount: number;
  environment: "preview" | "production";
  observedAt: string;
  oldestMessageTimestampMs: number;
  queueId: string;
  queueName: string;
  schemaVersion: 1;
}

export interface QueueMeasurement {
  backlogBytes: number;
  backlogCount: number;
  observedAt: string;
  oldestMessageTimestampMs: number;
  queueId: string;
  queueName: string;
}

export interface AuthorityScanEvent {
  eventType:
    | "authority.full_scan.completed"
    | "authority.full_scan.failed"
    | "authority.full_scan.started";
  jobId: string;
  occurredAt: string;
}

export interface ProductionWriteWindowReceipt {
  activatedAt: string;
  environment: "production";
  plannedEndAt: string;
  plannedStartAt: string;
  scanCron: string;
  schemaVersion: 1;
  sourceCommit: string;
  sourceTree: string;
  versionId: string;
  workerName: string;
}

export interface WorkerResourceFingerprint {
  name: string;
  resource: string;
  type: string;
}

export interface WorkerVersionSafety {
  appEnvironment: string;
  bindingShape: { name: string; type: string }[];
  deliveryAllowlist: unknown[];
  deliveryMode: string;
  flags: Record<string, unknown>;
  id: string;
  resourceFingerprint: WorkerResourceFingerprint[];
  scriptEtag: string;
  source: string;
}

const versionIdPattern = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const queueIdPattern = /^[a-f\d]{32}$/i;
const gitObjectPattern = /^[a-f\d]{40}$/i;
const scriptEtagPattern = /^[a-f\d]{64}$/i;
const authorityScanJobPattern = /^authority_scan_[0-9]{12}$/;
const authorityScanEvents = new Set<AuthorityScanEvent["eventType"]>([
  "authority.full_scan.completed",
  "authority.full_scan.failed",
  "authority.full_scan.started",
]);
export const productionWriteWindowMaximumDurationMs = 10 * 60 * 1_000;
export const productionWriteWindowSafetyMarginMs = 2 * 60 * 1_000;
const dangerousFlags = [
  "ai",
  "embeds",
  "email",
  "integrations",
  "webhooks",
  "writes",
] as const;
const resourceTypes = new Set([
  "analytics_engine",
  "d1",
  "durable_object_namespace",
  "queue",
  "r2_bucket",
  "workflow",
]);

export function productionReleaseTransition(
  activeWrites: unknown,
  targetWrites: unknown,
): "locked" | "relock" | "writable" {
  if (typeof activeWrites !== "boolean" || typeof targetWrites !== "boolean") {
    throw new Error("Production release requires an explicit writes flag.");
  }
  if (targetWrites) return "writable";
  return activeWrites ? "relock" : "locked";
}

export function getHourlyCronMinute(cron: string): number {
  const match = /^(\d{1,2}) \* \* \* \*$/.exec(cron);
  const minute = Number(match?.[1]);
  if (!match || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error(
      "Authority scan must use one machine-readable hourly cron.",
    );
  }
  return minute;
}

export function assertProductionWriteWindow(options: {
  cron: string;
  now: Date;
  plannedEndAt: string;
  plannedStartAt: string;
}): void {
  const start = parseTimestamp(options.plannedStartAt, "start");
  const end = parseTimestamp(options.plannedEndAt, "end");
  const now = options.now.getTime();
  if (!Number.isFinite(now)) {
    throw new Error("Production writes window clock is invalid.");
  }
  if (start > now + 60_000 || start < now - 60_000) {
    throw new Error(
      "Production writes window must start within one minute of the current UTC clock.",
    );
  }
  const duration = end - start;
  if (duration <= 0 || duration > productionWriteWindowMaximumDurationMs) {
    throw new Error(
      "Production writes window must be positive and at most 10 minutes.",
    );
  }

  const minute = getHourlyCronMinute(options.cron);
  const guardedStart = start - productionWriteWindowSafetyMarginMs;
  const guardedEnd = end + productionWriteWindowSafetyMarginMs;
  const firstHour = Math.floor(guardedStart / 3_600_000) * 3_600_000;
  for (let hour = firstHour; hour <= guardedEnd; hour += 3_600_000) {
    const cronMinuteStart = hour + minute * 60_000;
    const cronMinuteEnd = cronMinuteStart + 60_000;
    if (guardedStart <= cronMinuteEnd && guardedEnd >= cronMinuteStart) {
      throw new Error(
        `Production writes window plus two-minute safety margins overlaps ${String(minute).padStart(2, "0")} * * * * UTC.`,
      );
    }
  }
}

export function cronFireTimesBetween(options: {
  cron: string;
  endAt: string;
  startAt: string;
}): string[] {
  const start = parseTimestamp(options.startAt, "start");
  const end = parseTimestamp(options.endAt, "end");
  if (end < start || end - start > 24 * 60 * 60 * 1_000) {
    throw new Error(
      "Production relock interval is invalid or exceeds 24 hours.",
    );
  }
  const minute = getHourlyCronMinute(options.cron);
  const result: string[] = [];
  const firstHour = Math.floor(start / 3_600_000) * 3_600_000;
  for (let hour = firstHour; hour <= end; hour += 3_600_000) {
    const scheduledAt = hour + minute * 60_000;
    if (scheduledAt >= start && scheduledAt <= end) {
      result.push(new Date(scheduledAt).toISOString());
    }
  }
  return result;
}

export function parseProductionWriteWindowReceipt(
  value: unknown,
): ProductionWriteWindowReceipt {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.environment !== "production" ||
    typeof value.workerName !== "string" ||
    !versionIdPattern.test(String(value.versionId)) ||
    !gitObjectPattern.test(String(value.sourceCommit)) ||
    !gitObjectPattern.test(String(value.sourceTree)) ||
    !isTimestamp(value.plannedStartAt) ||
    !isTimestamp(value.plannedEndAt) ||
    !isTimestamp(value.activatedAt) ||
    typeof value.scanCron !== "string"
  ) {
    throw new Error("Production writes window receipt is invalid.");
  }
  assertProductionWriteWindow({
    cron: value.scanCron,
    now: new Date(value.plannedStartAt),
    plannedEndAt: value.plannedEndAt,
    plannedStartAt: value.plannedStartAt,
  });
  return value as unknown as ProductionWriteWindowReceipt;
}

export function assertProductionWriteWindowReceipt(options: {
  activeVersionId: string;
  cron: string;
  receipt: ProductionWriteWindowReceipt;
  workerName: string;
}): void {
  if (
    options.receipt.versionId !== options.activeVersionId ||
    options.receipt.workerName !== options.workerName ||
    options.receipt.scanCron !== options.cron
  ) {
    throw new Error(
      "Production writes window receipt does not match the active Worker and scan schedule.",
    );
  }
}

export function parseAuthorityScanEvents(value: unknown): AuthorityScanEvent[] {
  if (!Array.isArray(value)) {
    throw new Error("Authority scan telemetry is invalid.");
  }
  return value.map((event) => {
    if (
      !isRecord(event) ||
      !authorityScanEvents.has(
        event.eventType as AuthorityScanEvent["eventType"],
      ) ||
      typeof event.jobId !== "string" ||
      !authorityScanJobPattern.test(event.jobId) ||
      !isTimestamp(event.occurredAt)
    ) {
      throw new Error("Authority scan telemetry is invalid.");
    }
    return event as unknown as AuthorityScanEvent;
  });
}

export async function waitForProductionRelock(options: {
  baseline: QueueBaselineReceipt;
  expectedEnvironment: "production";
  expectedQueueNames: string[];
  expectedScanTimes: string[];
  maxBaselineAgeMs: number;
  now: () => Date;
  pollIntervalMs: number;
  readQueues: () => Promise<QueueMeasurement[]>;
  readScanEvents: () => Promise<AuthorityScanEvent[]>;
  sleep: (milliseconds: number) => Promise<void>;
  timeoutMs: number;
}): Promise<{ scans: AuthorityScanEvent[]; queues: QueueMeasurement[] }> {
  if (
    !Number.isInteger(options.pollIntervalMs) ||
    options.pollIntervalMs < 1 ||
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < options.pollIntervalMs
  ) {
    throw new Error("Production relock polling bounds are invalid.");
  }
  const startedAt = options.now().getTime();
  if (!Number.isFinite(startedAt)) {
    throw new Error("Production relock clock is invalid.");
  }
  const deadline = startedAt + options.timeoutMs;
  let previousQueues: QueueMeasurement[] | null = null;

  while (true) {
    const scans = await options.readScanEvents();
    const scansComplete = assertAuthorityScansComplete(
      scans,
      options.expectedScanTimes,
    );
    const queues = await options.readQueues();
    if (scansComplete) {
      if (previousQueues) {
        try {
          assertQueueReleaseGate({
            baseline: options.baseline,
            expectedEnvironment: options.expectedEnvironment,
            expectedQueueNames: options.expectedQueueNames,
            first: previousQueues,
            maxBaselineAgeMs: options.maxBaselineAgeMs,
            now: options.now(),
            second: queues,
          });
          return { queues, scans };
        } catch (error) {
          if (
            !(error instanceof Error) ||
            (!error.message.includes("must have zero backlog") &&
              !error.message.includes("active ingress"))
          ) {
            throw error;
          }
          previousQueues = queues;
        }
      } else {
        previousQueues = queues;
      }
    } else {
      previousQueues = null;
    }

    const remaining = deadline - options.now().getTime();
    if (remaining <= 0) {
      throw new Error(
        "Production relock timed out waiting for authority scan completion and Queue convergence.",
      );
    }
    await options.sleep(Math.min(options.pollIntervalMs, remaining));
  }
}

function assertAuthorityScansComplete(
  events: AuthorityScanEvent[],
  expectedScanTimes: string[],
): boolean {
  const byJob = new Map<string, Set<AuthorityScanEvent["eventType"]>>();
  const startedByTime = new Map<string, string>();
  for (const event of events) {
    const types = byJob.get(event.jobId) ?? new Set();
    if (types.has(event.eventType)) {
      throw new Error("Authority scan telemetry contains duplicate events.");
    }
    types.add(event.eventType);
    byJob.set(event.jobId, types);
    if (event.eventType === "authority.full_scan.started") {
      if (startedByTime.has(event.occurredAt)) {
        throw new Error("Authority scan telemetry contains duplicate starts.");
      }
      startedByTime.set(event.occurredAt, event.jobId);
    }
  }

  for (const [jobId, types] of byJob) {
    if (types.has("authority.full_scan.failed")) {
      throw new Error(
        `Authority scan ${jobId} failed before production relock.`,
      );
    }
  }

  const requiredJobs = expectedScanTimes.map((scheduledAt) =>
    startedByTime.get(scheduledAt),
  );
  if (requiredJobs.some((jobId) => !jobId)) return false;
  for (const [jobId, types] of byJob) {
    if (
      types.has("authority.full_scan.started") &&
      !types.has("authority.full_scan.completed")
    ) {
      return false;
    }
    if (!types.has("authority.full_scan.started")) {
      throw new Error(`Authority scan ${jobId} has no start evidence.`);
    }
  }
  return requiredJobs.every((jobId) =>
    byJob.get(jobId ?? "")?.has("authority.full_scan.completed"),
  );
}

function parseTimestamp(value: string, label: string): number {
  const timestamp = Date.parse(value);
  if (!value.endsWith("Z") || !Number.isFinite(timestamp)) {
    throw new Error(
      `Production writes window ${label} must be a UTC timestamp.`,
    );
  }
  return timestamp;
}

export function parseLockedLkgReceipt(value: unknown): LockedLkgReceipt {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isEnvironment(value.environment) ||
    typeof value.workerName !== "string" ||
    !versionIdPattern.test(String(value.versionId)) ||
    !versionIdPattern.test(String(value.deploymentId)) ||
    !gitObjectPattern.test(String(value.sourceCommit)) ||
    !gitObjectPattern.test(String(value.sourceTree)) ||
    !scriptEtagPattern.test(String(value.scriptEtag)) ||
    !isTimestamp(value.verifiedAt) ||
    typeof value.approvedBy !== "string" ||
    value.approvedBy.trim().length === 0 ||
    !Array.isArray(value.resourceFingerprint)
  ) {
    throw new Error("Locked LKG receipt is invalid.");
  }

  return {
    approvedBy: value.approvedBy,
    deploymentId: String(value.deploymentId),
    environment: value.environment,
    resourceFingerprint: parseResourceFingerprint(value.resourceFingerprint),
    schemaVersion: 1,
    scriptEtag: String(value.scriptEtag),
    sourceCommit: String(value.sourceCommit),
    sourceTree: String(value.sourceTree),
    verifiedAt: value.verifiedAt,
    versionId: String(value.versionId),
    workerName: value.workerName,
  };
}

export function parseWorkerVersionSafety(value: unknown): WorkerVersionSafety {
  if (
    !isRecord(value) ||
    !versionIdPattern.test(String(value.id)) ||
    !isRecord(value.metadata) ||
    typeof value.metadata.source !== "string" ||
    !isRecord(value.resources) ||
    !isRecord(value.resources.script) ||
    !scriptEtagPattern.test(String(value.resources.script.etag)) ||
    !Array.isArray(value.resources.bindings)
  ) {
    throw new Error("Wrangler returned invalid Worker version details.");
  }

  const bindings = value.resources.bindings;
  const appEnvironment = findBinding(bindings, "APP_ENV").text;
  const flags = findBinding(bindings, "FEATURE_FLAGS").json;
  const delivery = findBinding(bindings, "EMAIL_DELIVERY_CONFIG").json;
  if (
    typeof appEnvironment !== "string" ||
    !isRecord(flags) ||
    !isRecord(delivery) ||
    typeof delivery.mode !== "string" ||
    !Array.isArray(delivery.allowlist)
  ) {
    throw new Error("Worker version safety bindings are invalid.");
  }

  return {
    appEnvironment,
    bindingShape: bindings
      .map((binding) => {
        if (
          !isRecord(binding) ||
          typeof binding.name !== "string" ||
          typeof binding.type !== "string"
        ) {
          throw new Error("Worker version contains an invalid binding.");
        }
        return { name: binding.name, type: binding.type };
      })
      .sort((left, right) => left.name.localeCompare(right.name)),
    deliveryAllowlist: delivery.allowlist,
    deliveryMode: delivery.mode,
    flags,
    id: String(value.id),
    resourceFingerprint: workerResourceFingerprint(bindings),
    scriptEtag: String(value.resources.script.etag),
    source: value.metadata.source,
  };
}

export function assertLockedLkgCandidate(options: {
  active: WorkerVersionSafety;
  deployments: WorkerDeployment[];
  expectedEnvironment: "preview" | "production";
  expectedResourceNames: string[];
  expectedWorkerName: string;
  receipt: LockedLkgReceipt;
  target: WorkerVersionSafety;
}): void {
  const {
    active,
    deployments,
    expectedEnvironment,
    expectedResourceNames,
    expectedWorkerName,
    receipt,
    target,
  } = options;
  if (
    receipt.environment !== expectedEnvironment ||
    receipt.workerName !== expectedWorkerName ||
    target.id !== receipt.versionId ||
    target.id === active.id
  ) {
    throw new Error("Locked LKG receipt targets the wrong Worker or version.");
  }

  const matchingDeployment = deployments.filter(
    (deployment) => deployment.id === receipt.deploymentId,
  );
  if (matchingDeployment.length !== 1) {
    throw new Error("Locked LKG deployment is unavailable or ambiguous.");
  }
  const deployment = matchingDeployment[0];
  if (
    deployment?.versions.length !== 1 ||
    deployment.versions[0]?.percentage !== 100 ||
    deployment.versions[0].versionId !== receipt.versionId
  ) {
    throw new Error(
      "Locked LKG deployment does not exclusively target the receipt version.",
    );
  }

  assertLockedVersion(target, expectedEnvironment);
  if (
    target.source !== "wrangler" ||
    target.scriptEtag !== receipt.scriptEtag
  ) {
    throw new Error("Locked LKG source does not match its operator receipt.");
  }

  const receiptResources = canonicalFingerprint(receipt.resourceFingerprint);
  const targetResources = canonicalFingerprint(target.resourceFingerprint);
  const activeResources = canonicalFingerprint(active.resourceFingerprint);
  if (
    JSON.stringify(targetResources) !== JSON.stringify(receiptResources) ||
    JSON.stringify(targetResources) !== JSON.stringify(activeResources)
  ) {
    throw new Error(
      "Locked LKG resources do not match active production and the receipt.",
    );
  }
  if (
    JSON.stringify(target.bindingShape) !== JSON.stringify(active.bindingShape)
  ) {
    throw new Error(
      "Locked LKG binding shape does not match active production.",
    );
  }

  const actualNames = new Set(
    targetResources.map((resource) => resource.resource),
  );
  const missing = expectedResourceNames.filter(
    (name) => !actualNames.has(name),
  );
  if (missing.length > 0) {
    throw new Error(
      `Locked LKG is missing expected resources: ${missing.join(", ")}.`,
    );
  }
}

export function parseQueueBaselineReceipt(
  value: unknown,
): QueueBaselineReceipt {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isEnvironment(value.environment) ||
    typeof value.queueName !== "string" ||
    !queueIdPattern.test(String(value.queueId)) ||
    !isNonNegativeInteger(value.backlogCount) ||
    !isNonNegativeInteger(value.backlogBytes) ||
    !isNonNegativeInteger(value.oldestMessageTimestampMs) ||
    !isTimestamp(value.observedAt) ||
    typeof value.acceptedBy !== "string" ||
    value.acceptedBy.trim().length === 0
  ) {
    throw new Error("Queue baseline receipt is invalid.");
  }
  return value as unknown as QueueBaselineReceipt;
}

export function assertQueueReleaseGate(options: {
  baseline: QueueBaselineReceipt;
  first: QueueMeasurement[];
  second: QueueMeasurement[];
  expectedEnvironment: "preview" | "production";
  expectedQueueNames: string[];
  maxBaselineAgeMs: number;
  now?: Date;
}): void {
  const now = options.now ?? new Date();
  const expectedDlq = `projection-repair-${options.expectedEnvironment === "production" ? "prod" : options.expectedEnvironment}-dlq`;
  if (
    options.baseline.environment !== options.expectedEnvironment ||
    options.baseline.queueName !== expectedDlq
  ) {
    throw new Error("Queue baseline targets the wrong environment or DLQ.");
  }
  const baselineAge = now.getTime() - Date.parse(options.baseline.observedAt);
  if (baselineAge < 0 || baselineAge > options.maxBaselineAgeMs) {
    throw new Error("Queue baseline is future-dated or stale.");
  }

  const first = measurementsByName(options.first, options.expectedQueueNames);
  const second = measurementsByName(options.second, options.expectedQueueNames);
  for (const name of options.expectedQueueNames) {
    const left = first.get(name);
    const right = second.get(name);
    if (!left || !right) {
      throw new Error(`Queue measurement is missing: ${name}.`);
    }
    if (left.queueId !== right.queueId) {
      throw new Error(`Queue identity changed during the gate: ${name}.`);
    }
    if (
      name !== expectedDlq &&
      (left.backlogCount !== 0 ||
        left.backlogBytes !== 0 ||
        right.backlogCount !== 0 ||
        right.backlogBytes !== 0)
    ) {
      throw new Error(`Queue ${name} must have zero backlog.`);
    }
  }

  const firstDlq = first.get(expectedDlq);
  const secondDlq = second.get(expectedDlq);
  if (!firstDlq || !secondDlq) {
    throw new Error("Projection DLQ measurement is missing.");
  }
  if (
    firstDlq.queueId !== options.baseline.queueId ||
    firstDlq.backlogCount > options.baseline.backlogCount ||
    firstDlq.backlogBytes > options.baseline.backlogBytes ||
    (options.baseline.oldestMessageTimestampMs > 0 &&
      firstDlq.oldestMessageTimestampMs !==
        options.baseline.oldestMessageTimestampMs)
  ) {
    throw new Error(
      "Projection DLQ exceeds or does not match the accepted baseline.",
    );
  }
  if (
    secondDlq.backlogCount > firstDlq.backlogCount ||
    secondDlq.backlogBytes > firstDlq.backlogBytes ||
    (firstDlq.oldestMessageTimestampMs > 0 &&
      secondDlq.oldestMessageTimestampMs !== firstDlq.oldestMessageTimestampMs)
  ) {
    throw new Error(
      "Projection DLQ received active ingress during the release gate.",
    );
  }
}

function assertLockedVersion(
  version: WorkerVersionSafety,
  expectedEnvironment: "preview" | "production",
): void {
  if (version.appEnvironment !== expectedEnvironment) {
    throw new Error("Locked LKG has the wrong application environment.");
  }
  for (const flag of dangerousFlags) {
    if (version.flags[flag] !== false) {
      throw new Error(
        `Locked LKG has dangerous feature flag ${flag} enabled or missing.`,
      );
    }
  }
  if (
    version.deliveryMode !== "allowlist" ||
    version.deliveryAllowlist.length !== 0
  ) {
    throw new Error("Locked LKG email delivery is not an empty allowlist.");
  }
}

function workerResourceFingerprint(
  values: unknown[],
): WorkerResourceFingerprint[] {
  const resources: WorkerResourceFingerprint[] = [];
  for (const value of values) {
    if (
      !isRecord(value) ||
      typeof value.name !== "string" ||
      typeof value.type !== "string" ||
      !resourceTypes.has(value.type)
    )
      continue;
    const resource =
      value.database_id ??
      value.bucket_name ??
      value.queue_name ??
      value.namespace_id ??
      value.workflow_name ??
      value.dataset;
    if (typeof resource !== "string" || resource.length === 0) {
      throw new Error(
        `Worker resource ${value.name} has no stable identifier.`,
      );
    }
    resources.push({ name: value.name, resource, type: value.type });
  }
  return canonicalFingerprint(resources);
}

function parseResourceFingerprint(
  value: unknown[],
): WorkerResourceFingerprint[] {
  return canonicalFingerprint(
    value.map((resource) => {
      if (
        !isRecord(resource) ||
        typeof resource.name !== "string" ||
        typeof resource.resource !== "string" ||
        typeof resource.type !== "string"
      ) {
        throw new Error("Locked LKG resource fingerprint is invalid.");
      }
      return {
        name: resource.name,
        resource: resource.resource,
        type: resource.type,
      };
    }),
  );
}

function canonicalFingerprint(
  value: WorkerResourceFingerprint[],
): WorkerResourceFingerprint[] {
  return [...value].sort((left, right) => left.name.localeCompare(right.name));
}

function findBinding(values: unknown[], name: string): Record<string, unknown> {
  const matches = values.filter(
    (value) => isRecord(value) && value.name === name,
  );
  if (matches.length !== 1)
    throw new Error(`Worker version must contain exactly one ${name} binding.`);
  return matches[0] as Record<string, unknown>;
}

function measurementsByName(
  values: QueueMeasurement[],
  expected: string[],
): Map<string, QueueMeasurement> {
  const result = new Map<string, QueueMeasurement>();
  for (const value of values) {
    if (result.has(value.queueName))
      throw new Error(`Duplicate Queue measurement: ${value.queueName}.`);
    result.set(value.queueName, value);
  }
  const missing = expected.filter((name) => !result.has(name));
  const extra = [...result.keys()].filter((name) => !expected.includes(name));
  if (missing.length > 0 || extra.length > 0)
    throw new Error(
      "Queue gate measurements do not match the expected inventory.",
    );
  return result;
}

function isEnvironment(value: unknown): value is "preview" | "production" {
  return value === "preview" || value === "production";
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.endsWith("Z") &&
    Number.isFinite(Date.parse(value))
  );
}
