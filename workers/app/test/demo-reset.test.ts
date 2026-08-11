import { beforeAll, describe, expect, it } from "vitest";

import { compileDemoSeed } from "../src/demo/compiler";
import {
  demoEventId,
  demoOrganizationId,
  demoResetPhrase,
  demoSeedSource,
} from "../src/demo/fixture";
import {
  currentRal34DemoCapabilities,
  DemoResetService,
  demoAuthorityBlockers,
} from "../src/demo/reset";
import type {
  CompiledDemoSeed,
  DemoEventGuard,
  DemoEventGuardReader,
  DemoResetRequest,
  DemoSeedAuthorityCapabilities,
  DemoSeedAuthorityGateway,
  DemoSeedAuthorityReceipt,
} from "../src/demo/types";

const fullCapabilities: DemoSeedAuthorityCapabilities = {
  activeOwnerRevalidation: true,
  authoritativeDemoGuard: true,
  durableAudit: true,
  idempotentSnapshotReplace: true,
  privateAssets: true,
  supportedTables: [
    "organizations",
    "events",
    "forms",
    "form_fields",
    "form_rules",
    "contacts",
    "event_contacts",
    "submissions",
    "submission_answers",
    "submission_participants",
    "reviewer_groups",
    "rubrics",
    "criteria",
    "reviews",
    "review_scores",
    "sessions",
    "session_participants",
    "rooms",
    "tracks",
    "formats",
    "schedule_slots",
    "task_definitions",
    "task_assignments",
    "resources",
    "email_templates",
    "campaigns",
    "messages",
    "integrations",
    "external_mappings",
    "sync_runs",
  ],
};

class RecordingEventReader implements DemoEventGuardReader {
  activeOrganizations: readonly string[] = [demoOrganizationId];
  calls = 0;
  event: DemoEventGuard | null = {
    eventId: demoEventId,
    isDemo: true,
    organizationId: demoOrganizationId,
    sourceVersion: 7,
  };

  read(): Promise<DemoEventGuard | null> {
    this.calls += 1;
    return Promise.resolve(this.event);
  }

  activeOrganizationIds(): Promise<readonly string[]> {
    return Promise.resolve(this.activeOrganizations);
  }
}

class RecordingAuthority implements DemoSeedAuthorityGateway {
  calls: Parameters<DemoSeedAuthorityGateway["replaceDemoEvent"]>[0][] = [];
  capabilityValue: DemoSeedAuthorityCapabilities = fullCapabilities;
  onSynchronize: (() => Promise<void> | void) | null = null;
  providerMutationCount = 0;
  synchronizeCalls: readonly string[][] = [];
  readonly #applied = new Set<string>();
  readonly #runs = new Map<
    string,
    Parameters<DemoSeedAuthorityGateway["replaceDemoEvent"]>[0]
  >();

  capabilities(): Promise<DemoSeedAuthorityCapabilities> {
    return Promise.resolve(this.capabilityValue);
  }

  recordApplying(
    input: Parameters<DemoSeedAuthorityGateway["replaceDemoEvent"]>[0],
  ): void {
    this.#runs.set(input.resetRunId, input);
  }

  inspectDemoEventReplacement(organizationId: string, resetRunId: string) {
    const input = this.#runs.get(resetRunId);
    return Promise.resolve(
      input && input.plan.organizationId === organizationId
        ? {
            actorId: input.actorId,
            digest: input.plan.digest,
            eventId: input.plan.eventId,
            expectedSourceVersion: input.expectedSourceVersion,
            operationCount: input.plan.operations.length,
            organizationId: input.plan.organizationId,
            receiptAvailable: this.#applied.has(resetRunId),
            resetRunId,
            snapshotId: input.plan.snapshotId,
            state: this.#applied.has(resetRunId) ? "complete" : "applying",
          }
        : null,
    );
  }

  replaceDemoEvent(
    input: Parameters<DemoSeedAuthorityGateway["replaceDemoEvent"]>[0],
  ): Promise<DemoSeedAuthorityReceipt> {
    this.calls.push(input);
    const replayed = this.#applied.has(input.resetRunId);
    const existing = this.#runs.get(input.resetRunId);
    if (
      existing &&
      (existing.actorId !== input.actorId ||
        existing.expectedSourceVersion !== input.expectedSourceVersion ||
        existing.plan.digest !== input.plan.digest)
    ) {
      throw new Error("Conflicting replacement input");
    }
    this.#runs.set(input.resetRunId, input);
    this.#applied.add(input.resetRunId);
    if (!replayed) this.providerMutationCount += 1;
    return Promise.resolve({
      auditEventId: `audit_${input.resetRunId}`,
      digest: input.plan.digest,
      operationCount: input.plan.operations.length,
      outcome: replayed ? "replayed" : "applied",
      resetRunId: input.resetRunId,
      snapshotId: input.plan.snapshotId,
    });
  }

  async synchronizeFull(organizationIds: readonly string[]): Promise<void> {
    this.synchronizeCalls = [...this.synchronizeCalls, [...organizationIds]];
    await this.onSynchronize?.();
  }
}

let plan: CompiledDemoSeed;

function request(overrides: Partial<DemoResetRequest> = {}): DemoResetRequest {
  return {
    actor: {
      id: "usr_demo_owner",
      organizationId: demoOrganizationId,
      permissions: ["organization:manage"],
    },
    confirmation: demoResetPhrase,
    eventId: demoEventId,
    organizationId: demoOrganizationId,
    requestId: "req_demo_reset",
    ...overrides,
  };
}

beforeAll(async () => {
  plan = await compileDemoSeed(demoSeedSource);
});

describe("guarded demo reset service", () => {
  it("replays one reset request while a new reset request reapplies the snapshot", async () => {
    const authority = new RecordingAuthority();
    const eventReader = new RecordingEventReader();
    const service = new DemoResetService({ authority, eventReader, plan });

    await expect(service.reset(request())).resolves.toMatchObject({
      outcome: "applied",
      resetRunId: "req_demo_reset",
      snapshotId: plan.snapshotId,
    });
    eventReader.event = {
      eventId: demoEventId,
      isDemo: true,
      organizationId: demoOrganizationId,
      sourceVersion: 8,
    };
    await expect(service.reset(request())).resolves.toMatchObject({
      outcome: "replayed",
      resetRunId: "req_demo_reset",
      snapshotId: plan.snapshotId,
    });
    await expect(
      service.reset(request({ requestId: "req_demo_reset_second" })),
    ).resolves.toMatchObject({
      outcome: "applied",
      resetRunId: "req_demo_reset_second",
      snapshotId: plan.snapshotId,
    });
    expect(authority.calls).toHaveLength(3);
    expect(
      authority.calls
        .slice(0, 2)
        .map(({ expectedSourceVersion }) => expectedSourceVersion),
    ).toEqual([7, 7]);
    expect(authority.calls[0]).toMatchObject({
      actorId: "usr_demo_owner",
      expectedSourceVersion: 7,
      operation: "demo.snapshot.replace",
      requireActiveOwner: true,
      requireAuthoritativeDemo: true,
      resetRunId: "req_demo_reset",
    });
    expect("commandId" in (authority.calls[0] ?? {})).toBe(false);
    expect(authority.calls[0]?.plan.digest).toBe(plan.digest);
  });

  it("rejects a changed actor under an existing reset key without another write", async () => {
    const authority = new RecordingAuthority();
    const eventReader = new RecordingEventReader();
    const service = new DemoResetService({ authority, eventReader, plan });
    await service.reset(request());
    eventReader.event = {
      eventId: demoEventId,
      isDemo: true,
      organizationId: demoOrganizationId,
      sourceVersion: 8,
    };

    await expect(
      service.reset(
        request({
          actor: {
            id: "usr_different_owner",
            organizationId: demoOrganizationId,
            permissions: ["organization:manage"],
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(authority.calls).toHaveLength(1);
  });

  it("recovers a completed snapshot after readiness loss without another provider mutation", async () => {
    const authority = new RecordingAuthority();
    const eventReader = new RecordingEventReader();
    let loseFirstResponse = true;
    authority.onSynchronize = () => {
      if (!loseFirstResponse) {
        eventReader.event = {
          eventId: demoEventId,
          isDemo: true,
          organizationId: demoOrganizationId,
          sourceVersion: 8,
        };
        return;
      }
      loseFirstResponse = false;
      eventReader.event = null;
      throw new Error("response lost before convergence");
    };
    const service = new DemoResetService({ authority, eventReader, plan });

    await expect(service.reset(request())).rejects.toMatchObject({
      code: "authority_unavailable",
    });
    expect(authority.providerMutationCount).toBe(1);
    expect(authority.calls).toHaveLength(1);

    await expect(
      service.reset(request({ requestId: "req_demo_reset_different" })),
    ).rejects.toMatchObject({ code: "not_demo" });
    expect(authority.providerMutationCount).toBe(1);

    const changedPlan: CompiledDemoSeed = {
      ...plan,
      digest: "f".repeat(64),
    };
    await expect(
      new DemoResetService({
        authority,
        eventReader,
        plan: changedPlan,
      }).reset(request()),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(authority.providerMutationCount).toBe(1);

    await expect(service.reset(request())).resolves.toMatchObject({
      digest: plan.digest,
      outcome: "replayed",
      resetRunId: "req_demo_reset",
    });
    expect(authority.providerMutationCount).toBe(1);
    expect(authority.calls).toHaveLength(2);
    expect(authority.synchronizeCalls).toEqual([
      [demoOrganizationId],
      [demoOrganizationId],
    ]);
  });

  it("recovers an applying snapshot when readiness is unavailable", async () => {
    const authority = new RecordingAuthority();
    const eventReader = new RecordingEventReader();
    eventReader.event = null;
    authority.recordApplying({
      actorId: "usr_demo_owner",
      expectedSourceVersion: 7,
      operation: "demo.snapshot.replace",
      plan,
      requireActiveOwner: true,
      requireAuthoritativeDemo: true,
      resetRunId: "req_demo_reset",
    });
    authority.onSynchronize = () => {
      eventReader.event = {
        eventId: demoEventId,
        isDemo: true,
        organizationId: demoOrganizationId,
        sourceVersion: 8,
      };
    };

    await expect(
      new DemoResetService({ authority, eventReader, plan }).reset(request()),
    ).resolves.toMatchObject({
      outcome: "applied",
      resetRunId: "req_demo_reset",
    });
    expect(authority.providerMutationCount).toBe(1);
    expect(authority.calls).toHaveLength(1);
    expect(authority.synchronizeCalls).toEqual([
      [demoOrganizationId],
      [demoOrganizationId],
    ]);
  });

  it("synchronizes the complete active roster and rejects a missing demo tenant", async () => {
    const authority = new RecordingAuthority();
    const eventReader = new RecordingEventReader();
    eventReader.activeOrganizations = ["org_fixture", demoOrganizationId];

    await expect(
      new DemoResetService({ authority, eventReader, plan }).reset(request()),
    ).rejects.toMatchObject({ code: "authority_unavailable" });
    expect(authority.providerMutationCount).toBe(0);

    eventReader.activeOrganizations = [demoOrganizationId, "org_fixture"];

    await expect(
      new DemoResetService({ authority, eventReader, plan }).reset(request()),
    ).resolves.toMatchObject({ outcome: "applied" });
    expect(authority.synchronizeCalls).toEqual([
      [demoOrganizationId, "org_fixture"],
    ]);

    const missingAuthority = new RecordingAuthority();
    const missingReader = new RecordingEventReader();
    missingReader.activeOrganizations = ["org_other"];
    await expect(
      new DemoResetService({
        authority: missingAuthority,
        eventReader: missingReader,
        plan,
      }).reset(request()),
    ).rejects.toMatchObject({ code: "authority_unavailable" });
    expect(missingAuthority.providerMutationCount).toBe(0);
    expect(missingAuthority.calls).toHaveLength(0);
  });

  it("repairs the complete roster before replaying a completed receipt", async () => {
    const authority = new RecordingAuthority();
    const eventReader = new RecordingEventReader();
    eventReader.activeOrganizations = [demoOrganizationId, "org_sibling"];
    let synchronizeAttempts = 0;
    authority.onSynchronize = () => {
      synchronizeAttempts += 1;
      if (synchronizeAttempts === 1) {
        throw new Error("sibling tenant projection failed");
      }
    };
    const service = new DemoResetService({ authority, eventReader, plan });

    await expect(service.reset(request())).rejects.toMatchObject({
      code: "authority_unavailable",
    });
    expect(authority.providerMutationCount).toBe(1);

    await expect(service.reset(request())).resolves.toMatchObject({
      outcome: "replayed",
      resetRunId: "req_demo_reset",
    });
    expect(authority.providerMutationCount).toBe(1);
    expect(authority.synchronizeCalls).toEqual([
      [demoOrganizationId, "org_sibling"],
      [demoOrganizationId, "org_sibling"],
    ]);
  });

  it.each([
    ["invalid_audit_context", request({ requestId: "" })],
    [
      "invalid_audit_context",
      request({
        actor: {
          id: "not a stable actor",
          organizationId: demoOrganizationId,
          permissions: ["organization:manage"],
        },
      }),
    ],
    [
      "not_privileged",
      request({
        actor: {
          id: "usr_viewer",
          organizationId: demoOrganizationId,
          permissions: ["event:read"],
        },
      }),
    ],
    [
      "not_privileged",
      request({
        actor: {
          id: "usr_other_owner",
          organizationId: "org_other_tenant",
          permissions: ["organization:manage"],
        },
      }),
    ],
    ["invalid_confirmation", request({ confirmation: "RESET" })],
    ["invalid_target", request({ eventId: "evt_other" })],
  ] as const)("rejects %s before reading or mutating", async (code, input) => {
    const authority = new RecordingAuthority();
    const eventReader = new RecordingEventReader();
    const service = new DemoResetService({ authority, eventReader, plan });

    await expect(service.reset(input)).rejects.toMatchObject({
      code,
    });
    expect(eventReader.calls).toBe(0);
    expect(authority.calls).toHaveLength(0);
  });

  it("rejects a missing or non-demo projection without mutation", async () => {
    const authority = new RecordingAuthority();
    const eventReader = new RecordingEventReader();
    eventReader.event = {
      eventId: demoEventId,
      isDemo: false,
      organizationId: demoOrganizationId,
      sourceVersion: 1,
    };
    const service = new DemoResetService({ authority, eventReader, plan });

    await expect(service.reset(request())).rejects.toMatchObject({
      code: "not_demo",
    });
    expect(authority.calls).toHaveLength(0);
  });

  it("rejects a mismatched guard result even when it claims demo state", async () => {
    const authority = new RecordingAuthority();
    const eventReader = new RecordingEventReader();
    eventReader.event = {
      eventId: "evt_other_demo",
      isDemo: true,
      organizationId: demoOrganizationId,
      sourceVersion: 1,
    };
    const service = new DemoResetService({ authority, eventReader, plan });

    await expect(service.reset(request())).rejects.toMatchObject({
      code: "invalid_target",
    });
    expect(authority.calls).toHaveLength(0);
  });

  it("advertises the complete RAL-34 snapshot contract", async () => {
    const authority = new RecordingAuthority();
    authority.capabilityValue = currentRal34DemoCapabilities;
    const service = new DemoResetService({
      authority,
      eventReader: new RecordingEventReader(),
      plan,
    });
    const blockers = demoAuthorityBlockers(plan, currentRal34DemoCapabilities);

    expect(blockers).toEqual([]);
    await expect(service.reset(request())).resolves.toMatchObject({
      outcome: "applied",
    });
    expect(authority.calls).toHaveLength(1);
  });

  it("rejects an authority receipt that cannot prove the requested snapshot", async () => {
    const authority = new RecordingAuthority();
    authority.replaceDemoEvent = async (input) => ({
      auditEventId: "audit_wrong",
      digest: "0".repeat(64),
      operationCount: input.plan.operations.length,
      outcome: "applied",
      resetRunId: input.resetRunId,
      snapshotId: input.plan.snapshotId,
    });
    const service = new DemoResetService({
      authority,
      eventReader: new RecordingEventReader(),
      plan,
    });

    await expect(service.reset(request())).rejects.toMatchObject({
      code: "receipt_mismatch",
    });
  });

  it("rejects an invalid projected source version before mutation", async () => {
    const authority = new RecordingAuthority();
    const eventReader = new RecordingEventReader();
    eventReader.event = {
      eventId: demoEventId,
      isDemo: true,
      organizationId: demoOrganizationId,
      sourceVersion: -1,
    };
    const service = new DemoResetService({ authority, eventReader, plan });

    await expect(service.reset(request())).rejects.toMatchObject({
      code: "invalid_target",
    });
    expect(authority.calls).toHaveLength(0);
  });
});
