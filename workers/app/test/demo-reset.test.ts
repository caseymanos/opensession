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
}

class RecordingAuthority implements DemoSeedAuthorityGateway {
  calls: Parameters<DemoSeedAuthorityGateway["replaceDemoEvent"]>[0][] = [];
  capabilityValue: DemoSeedAuthorityCapabilities = fullCapabilities;
  readonly #applied = new Set<string>();

  capabilities(): Promise<DemoSeedAuthorityCapabilities> {
    return Promise.resolve(this.capabilityValue);
  }

  replaceDemoEvent(
    input: Parameters<DemoSeedAuthorityGateway["replaceDemoEvent"]>[0],
  ): Promise<DemoSeedAuthorityReceipt> {
    this.calls.push(input);
    const replayed = this.#applied.has(input.resetRunId);
    this.#applied.add(input.resetRunId);
    return Promise.resolve({
      auditEventId: `audit_${input.resetRunId}`,
      digest: input.plan.digest,
      operationCount: input.plan.operations.length,
      outcome: replayed ? "replayed" : "applied",
      resetRunId: input.resetRunId,
      snapshotId: input.plan.snapshotId,
    });
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
