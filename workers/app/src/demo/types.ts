import type { EventPermission } from "../auth/authorization";
import type { BaseAuthorityCommand } from "../authority/types";

export type DemoAirtableTableKey = BaseAuthorityCommand["table"];
export type DemoAirtableCellValue = BaseAuthorityCommand["fields"][string];

export interface DemoEntityReference {
  readonly entityId: string;
  readonly kind: "entity_reference";
}

export type DemoSeedFieldValue =
  DemoAirtableCellValue | DemoEntityReference | readonly DemoEntityReference[];

export interface DemoSeedEntity {
  readonly entityId: string;
  readonly fields: Readonly<Record<string, DemoSeedFieldValue>>;
  readonly table: DemoAirtableTableKey;
}

export interface DemoAssetFixture {
  readonly assetId: string;
  readonly contentBase64: string;
  readonly contentType: "application/pdf" | "image/png";
  readonly kind: "headshot" | "slides";
  readonly license: "CC0-1.0";
  readonly objectKey: string;
  readonly ownerContactId: string;
  readonly synthetic: true;
}

export interface CompiledDemoAsset extends DemoAssetFixture {
  readonly contentDigest: string;
  readonly sizeBytes: number;
}

export interface DemoSeedSource {
  readonly assets: readonly DemoAssetFixture[];
  readonly delivery: {
    readonly allowlist: readonly string[];
    readonly mode: "allowlist" | "sink";
  };
  readonly entities: readonly DemoSeedEntity[];
  readonly eventId: string;
  readonly organizationId: string;
  readonly resetPhrase: string;
  readonly schemaVersion: 1;
  readonly seedVersion: number;
}

export interface DemoSeedOperation extends DemoSeedEntity {
  readonly dependencies: readonly string[];
  readonly operation: "demo.seed.upsert";
  readonly templateOperationId: string;
}

export interface CompiledDemoSeed {
  readonly assets: readonly CompiledDemoAsset[];
  readonly delivery: DemoSeedSource["delivery"];
  readonly digest: string;
  readonly eventId: string;
  readonly operations: readonly DemoSeedOperation[];
  readonly organizationId: string;
  readonly resetPhrase: string;
  readonly seedVersion: number;
  readonly snapshotId: string;
}

export interface TrustedDemoResetActor {
  readonly id: string;
  readonly organizationId: string;
  readonly permissions: readonly EventPermission[];
}

export interface DemoResetRequest {
  readonly actor: TrustedDemoResetActor;
  readonly confirmation: string;
  readonly eventId: string;
  readonly organizationId: string;
  readonly requestId: string;
}

export interface DemoEventGuard {
  readonly eventId: string;
  readonly isDemo: boolean;
  readonly organizationId: string;
  readonly sourceVersion: number;
}

export interface DemoEventGuardReader {
  read(organizationId: string, eventId: string): Promise<DemoEventGuard | null>;
}

export interface DemoSeedAuthorityCapabilities {
  readonly activeOwnerRevalidation: boolean;
  readonly authoritativeDemoGuard: boolean;
  readonly durableAudit: boolean;
  readonly idempotentSnapshotReplace: boolean;
  readonly privateAssets: boolean;
  readonly supportedTables: readonly DemoAirtableTableKey[];
}

export interface DemoSeedAuthorityReceipt {
  readonly auditEventId: string;
  readonly digest: string;
  readonly operationCount: number;
  readonly outcome: "applied" | "replayed";
  readonly resetRunId: string;
  readonly snapshotId: string;
}

export interface DemoSnapshotRunInspection {
  readonly actorId: string;
  readonly digest: string;
  readonly eventId: string;
  readonly expectedSourceVersion: number;
  readonly operationCount: number;
  readonly organizationId: string;
  readonly receiptAvailable: boolean;
  readonly resetRunId: string;
  readonly snapshotId: string;
  readonly state: string;
}

export interface DemoSeedAuthorityGateway {
  capabilities(): Promise<DemoSeedAuthorityCapabilities>;
  inspectDemoEventReplacement?(
    organizationId: string,
    resetRunId: string,
  ): Promise<DemoSnapshotRunInspection | null>;
  replaceDemoEvent(input: {
    readonly actorId: string;
    readonly expectedSourceVersion: number;
    readonly operation: "demo.snapshot.replace";
    readonly plan: CompiledDemoSeed;
    readonly requireActiveOwner: true;
    readonly requireAuthoritativeDemo: true;
    readonly resetRunId: string;
  }): Promise<DemoSeedAuthorityReceipt>;
}

export interface DemoBootstrapRootInspection {
  readonly eventRecordId: string;
  readonly eventSourceVersion: number;
  readonly organizationRecordId: string;
  readonly organizationSourceVersion: number;
}

export interface DemoBootstrapAuthorityGateway extends DemoSeedAuthorityGateway {
  inspectDemoBootstrapRoots(
    organizationId: string,
    eventId: string,
  ): Promise<DemoBootstrapRootInspection>;
  synchronize(organizationIds: readonly string[]): Promise<unknown>;
}
