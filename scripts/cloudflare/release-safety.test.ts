import { describe, expect, it } from "vitest";

import {
  assertLockedLkgCandidate,
  assertQueueReleaseGate,
  parseLockedLkgReceipt,
  parseQueueBaselineReceipt,
  parseWorkerVersionSafety,
  type QueueMeasurement,
} from "./release-safety";

const activeVersionId = "c10976e7-8565-4801-834c-5489210b0d5c";
const lkgVersionId = "4ca57e5c-0ea6-4725-9de6-35090fde71a5";
const unsafeVersionId = "feb1a779-ec70-4e5e-b686-54f8b0b930b9";
const lkgDeploymentId = "f6252118-718d-4996-964a-90cf99696912";

function version(id: string, writes = false) {
  return parseWorkerVersionSafety({
    id,
    metadata: { source: "wrangler" },
    resources: {
      script: { etag: "a".repeat(64) },
      bindings: [
        { name: "APP_ENV", text: "production", type: "plain_text" },
        {
          name: "FEATURE_FLAGS",
          type: "json",
          json: {
            ai: false,
            embeds: false,
            email: false,
            integrations: false,
            webhooks: false,
            writes,
          },
        },
        {
          name: "EMAIL_DELIVERY_CONFIG",
          type: "json",
          json: { allowlist: [], mode: "allowlist" },
        },
        { database_id: "database-id", name: "DB", type: "d1" },
        {
          bucket_name: "uploads-prod",
          name: "UPLOADS",
          type: "r2_bucket",
        },
        {
          name: "PROJECTION_REPAIR_QUEUE",
          queue_name: "projection-repair-prod",
          type: "queue",
        },
      ],
    },
  });
}

function receipt() {
  const target = version(lkgVersionId);
  return parseLockedLkgReceipt({
    approvedBy: "release-owner",
    deploymentId: lkgDeploymentId,
    environment: "production",
    resourceFingerprint: target.resourceFingerprint,
    schemaVersion: 1,
    scriptEtag: "a".repeat(64),
    sourceCommit: "b".repeat(40),
    sourceTree: "c".repeat(40),
    verifiedAt: "2026-08-12T04:19:24.627Z",
    versionId: lkgVersionId,
    workerName: "sessionbox-killer-prod",
  });
}

describe("release safety", () => {
  it("accepts only the explicit fully locked LKG deployment", () => {
    const target = version(lkgVersionId);
    expect(() =>
      assertLockedLkgCandidate({
        active: version(activeVersionId),
        deployments: [
          {
            createdOn: "2026-08-12T02:52:35Z",
            id: "897a8701-2add-466c-9243-2658584ac5c4",
            versions: [{ percentage: 100, versionId: activeVersionId }],
          },
          {
            createdOn: "2026-08-12T02:45:57Z",
            id: "6a657439-581e-4e80-86e7-361662c12f1e",
            versions: [{ percentage: 100, versionId: unsafeVersionId }],
          },
          {
            createdOn: "2026-08-12T02:45:19Z",
            id: lkgDeploymentId,
            versions: [{ percentage: 100, versionId: lkgVersionId }],
          },
        ],
        expectedEnvironment: "production",
        expectedResourceNames: [
          "database-id",
          "uploads-prod",
          "projection-repair-prod",
        ],
        expectedWorkerName: "sessionbox-killer-prod",
        receipt: receipt(),
        target,
      }),
    ).not.toThrow();
  });

  it("rejects the unsafe immediate-prior version even with matching source and resources", () => {
    expect(() =>
      assertLockedLkgCandidate({
        active: version(activeVersionId),
        deployments: [
          {
            createdOn: "2026-08-12T02:45:19Z",
            id: lkgDeploymentId,
            versions: [{ percentage: 100, versionId: lkgVersionId }],
          },
        ],
        expectedEnvironment: "production",
        expectedResourceNames: ["database-id"],
        expectedWorkerName: "sessionbox-killer-prod",
        receipt: receipt(),
        target: version(lkgVersionId, true),
      }),
    ).toThrow("writes");
  });

  it("accepts an exact stable retained DLQ and zero active queues", () => {
    const baseline = parseQueueBaselineReceipt({
      acceptedBy: "release-owner",
      backlogBytes: 191714,
      backlogCount: 1459,
      environment: "production",
      observedAt: "2026-08-12T04:19:43.378Z",
      oldestMessageTimestampMs: 0,
      queueId: "b22b5dde94bd45d6a4f962c30dd2b819",
      queueName: "projection-repair-prod-dlq",
      schemaVersion: 1,
    });
    const first = measurements(1459, 191714, "2026-08-12T04:29:00.000Z");
    const second = measurements(1459, 191714, "2026-08-12T04:29:30.000Z");
    expect(() =>
      assertQueueReleaseGate({
        baseline,
        expectedEnvironment: "production",
        expectedQueueNames: [
          "projection-repair-prod",
          "projection-repair-prod-dlq",
        ],
        first,
        maxBaselineAgeMs: 6 * 60 * 60 * 1_000,
        now: new Date("2026-08-12T04:30:00.000Z"),
        second,
      }),
    ).not.toThrow();
  });

  it("rejects positive DLQ delta and nonzero active queues", () => {
    const baseline = parseQueueBaselineReceipt({
      acceptedBy: "release-owner",
      backlogBytes: 191714,
      backlogCount: 1459,
      environment: "production",
      observedAt: "2026-08-12T04:19:43.378Z",
      oldestMessageTimestampMs: 0,
      queueId: "b22b5dde94bd45d6a4f962c30dd2b819",
      queueName: "projection-repair-prod-dlq",
      schemaVersion: 1,
    });
    expect(() =>
      assertQueueReleaseGate({
        baseline,
        expectedEnvironment: "production",
        expectedQueueNames: [
          "projection-repair-prod",
          "projection-repair-prod-dlq",
        ],
        first: measurements(1459, 191714, "2026-08-12T04:29:00.000Z"),
        maxBaselineAgeMs: 6 * 60 * 60 * 1_000,
        now: new Date("2026-08-12T04:30:00.000Z"),
        second: measurements(1460, 191800, "2026-08-12T04:29:30.000Z"),
      }),
    ).toThrow("active ingress");

    const nonzeroActive = measurements(
      1459,
      191714,
      "2026-08-12T04:29:00.000Z",
    );
    const activeMeasurement = nonzeroActive[0];
    if (!activeMeasurement) {
      throw new Error("Expected an active Queue measurement.");
    }
    nonzeroActive[0] = { ...activeMeasurement, backlogCount: 1 };
    expect(() =>
      assertQueueReleaseGate({
        baseline,
        expectedEnvironment: "production",
        expectedQueueNames: [
          "projection-repair-prod",
          "projection-repair-prod-dlq",
        ],
        first: nonzeroActive,
        maxBaselineAgeMs: 6 * 60 * 60 * 1_000,
        now: new Date("2026-08-12T04:30:00.000Z"),
        second: nonzeroActive,
      }),
    ).toThrow("must have zero backlog");
  });
});

function measurements(
  dlqCount: number,
  dlqBytes: number,
  observedAt: string,
): QueueMeasurement[] {
  return [
    {
      backlogBytes: 0,
      backlogCount: 0,
      observedAt,
      oldestMessageTimestampMs: 0,
      queueId: "4727a92ba5264d26b56bd0f99fab36af",
      queueName: "projection-repair-prod",
    },
    {
      backlogBytes: dlqBytes,
      backlogCount: dlqCount,
      observedAt,
      oldestMessageTimestampMs: 0,
      queueId: "b22b5dde94bd45d6a4f962c30dd2b819",
      queueName: "projection-repair-prod-dlq",
    },
  ];
}
