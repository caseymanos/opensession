import { describe, expect, it } from "vitest";

import {
  assertLockedLkgCandidate,
  assertProductionWriteWindow,
  assertProductionWriteWindowReceipt,
  cronFireTimesBetween,
  assertQueueReleaseGate,
  parseLockedLkgReceipt,
  parseProductionWriteWindowReceipt,
  parseQueueBaselineReceipt,
  parseWorkerVersionSafety,
  productionReleaseTransition,
  waitForProductionRelock,
  type AuthorityScanEvent,
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
  it("accepts a short UTC writes window outside the configured Cron minute", () => {
    expect(() =>
      assertProductionWriteWindow({
        cron: "17 * * * *",
        now: new Date("2026-08-12T09:20:01.000Z"),
        plannedEndAt: "2026-08-12T09:27:00.000Z",
        plannedStartAt: "2026-08-12T09:20:01.000Z",
      }),
    ).not.toThrow();
    expect(() =>
      assertProductionWriteWindow({
        cron: "17 * * * *",
        now: new Date("2026-08-12T09:05:00.000Z"),
        plannedEndAt: "2026-08-12T09:14:59.000Z",
        plannedStartAt: "2026-08-12T09:05:00.000Z",
      }),
    ).not.toThrow();
  });

  it("rejects windows before, across, and on the guarded Cron boundaries", () => {
    for (const [start, end] of [
      ["2026-08-12T09:14:00.000Z", "2026-08-12T09:18:00.000Z"],
      ["2026-08-12T09:10:00.000Z", "2026-08-12T09:15:00.000Z"],
      ["2026-08-12T09:20:00.000Z", "2026-08-12T09:25:00.000Z"],
    ] as const) {
      expect(() =>
        assertProductionWriteWindow({
          cron: "17 * * * *",
          now: new Date(start),
          plannedEndAt: end,
          plannedStartAt: start,
        }),
      ).toThrow("safety margins");
    }
  });

  it("handles UTC clock boundaries and rejects multi-hour windows", () => {
    expect(() =>
      assertProductionWriteWindow({
        cron: "17 * * * *",
        now: new Date("2026-08-12T09:58:00.000Z"),
        plannedEndAt: "2026-08-12T10:05:00.000Z",
        plannedStartAt: "2026-08-12T09:58:00.000Z",
      }),
    ).not.toThrow();
    expect(() =>
      assertProductionWriteWindow({
        cron: "17 * * * *",
        now: new Date("2026-08-12T09:58:00.000Z"),
        plannedEndAt: "2026-08-12T11:05:00.000Z",
        plannedStartAt: "2026-08-12T09:58:00.000Z",
      }),
    ).toThrow("at most 10 minutes");
    expect(
      cronFireTimesBetween({
        cron: "17 * * * *",
        endAt: "2026-08-12T11:18:00.000Z",
        startAt: "2026-08-12T09:16:00.000Z",
      }),
    ).toEqual([
      "2026-08-12T09:17:00.000Z",
      "2026-08-12T10:17:00.000Z",
      "2026-08-12T11:17:00.000Z",
    ]);
  });

  it("uses the injected clock and leaves fully locked deploys unchanged", () => {
    expect(() =>
      assertProductionWriteWindow({
        cron: "17 * * * *",
        now: new Date("2026-08-12T10:00:00.000Z"),
        plannedEndAt: "2026-08-12T09:27:00.000Z",
        plannedStartAt: "2026-08-12T09:20:01.000Z",
      }),
    ).toThrow("current UTC clock");
    expect(() =>
      assertProductionWriteWindow({
        cron: "17 * * * *",
        now: new Date("2026-08-12T16:20:01.000Z"),
        plannedEndAt: "2026-08-12T09:27:00.000-07:00",
        plannedStartAt: "2026-08-12T09:20:01.000-07:00",
      }),
    ).toThrow("UTC timestamp");
    expect(productionReleaseTransition(false, false)).toBe("locked");
    expect(productionReleaseTransition(false, true)).toBe("writable");
    expect(productionReleaseTransition(true, false)).toBe("relock");
  });

  it("validates the exact active writable version receipt", () => {
    const window = {
      activatedAt: "2026-08-12T09:20:30.000Z",
      environment: "production",
      plannedEndAt: "2026-08-12T09:27:00.000Z",
      plannedStartAt: "2026-08-12T09:20:01.000Z",
      scanCron: "17 * * * *",
      schemaVersion: 1,
      sourceCommit: "b".repeat(40),
      sourceTree: "c".repeat(40),
      versionId: activeVersionId,
      workerName: "sessionbox-killer-prod",
    } as const;
    const parsed = parseProductionWriteWindowReceipt(window);
    expect(parsed).toMatchObject({ versionId: activeVersionId });
    expect(() =>
      assertProductionWriteWindowReceipt({
        activeVersionId: lkgVersionId,
        cron: "17 * * * *",
        receipt: parsed,
        workerName: "sessionbox-killer-prod",
      }),
    ).toThrow("does not match");
    expect(() =>
      parseProductionWriteWindowReceipt({
        ...window,
        plannedEndAt: "2026-08-12T10:18:00.000Z",
        plannedStartAt: "2026-08-12T10:14:00.000Z",
      }),
    ).toThrow("safety margins");
  });

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

  it("waits for an in-flight scan and then two converged Queue reads", async () => {
    const baseline = freshBaseline();
    let clock = Date.parse("2026-08-12T09:18:00.000Z");
    let scanRead = 0;
    let queueRead = 0;
    const started = scanEvent("authority.full_scan.started");
    const completed = scanEvent("authority.full_scan.completed");
    const result = await waitForProductionRelock({
      baseline,
      expectedEnvironment: "production",
      expectedQueueNames: [
        "projection-repair-prod",
        "projection-repair-prod-dlq",
      ],
      expectedScanTimes: ["2026-08-12T09:17:00.000Z"],
      maxBaselineAgeMs: 6 * 60 * 60 * 1_000,
      now: () => new Date(clock),
      pollIntervalMs: 10_000,
      readQueues: async () => {
        queueRead += 1;
        const current = measurements(
          224,
          29_764,
          new Date(clock).toISOString(),
        );
        if (queueRead === 1 && current[0]) {
          current[0] = { ...current[0], backlogCount: 1 };
        }
        return current;
      },
      readScanEvents: async () => {
        scanRead += 1;
        return scanRead === 1 ? [started] : [started, completed];
      },
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      timeoutMs: 60_000,
    });
    expect(result.scans).toEqual([started, completed]);
    expect(scanRead).toBe(3);
    expect(queueRead).toBe(3);
  });

  it("fails closed when scan completion never arrives before timeout", async () => {
    const baseline = freshBaseline();
    let clock = Date.parse("2026-08-12T09:18:00.000Z");
    await expect(
      waitForProductionRelock({
        baseline,
        expectedEnvironment: "production",
        expectedQueueNames: [
          "projection-repair-prod",
          "projection-repair-prod-dlq",
        ],
        expectedScanTimes: ["2026-08-12T09:17:00.000Z"],
        maxBaselineAgeMs: 6 * 60 * 60 * 1_000,
        now: () => new Date(clock),
        pollIntervalMs: 10_000,
        readQueues: async () =>
          measurements(224, 29_764, new Date(clock).toISOString()),
        readScanEvents: async () => [scanEvent("authority.full_scan.started")],
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
        timeoutMs: 20_000,
      }),
    ).rejects.toThrow("timed out");
  });
});

function freshBaseline() {
  return parseQueueBaselineReceipt({
    acceptedBy: "release-owner",
    backlogBytes: 29_764,
    backlogCount: 224,
    environment: "production",
    observedAt: "2026-08-12T09:00:00.000Z",
    oldestMessageTimestampMs: 0,
    queueId: "b22b5dde94bd45d6a4f962c30dd2b819",
    queueName: "projection-repair-prod-dlq",
    schemaVersion: 1,
  });
}

function scanEvent(
  eventType: AuthorityScanEvent["eventType"],
): AuthorityScanEvent {
  return {
    eventType,
    jobId: "authority_scan_202608120917",
    occurredAt:
      eventType === "authority.full_scan.started"
        ? "2026-08-12T09:17:00.000Z"
        : "2026-08-12T09:18:12.000Z",
  };
}

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
