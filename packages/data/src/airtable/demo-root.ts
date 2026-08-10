import {
  demoEventId,
  demoEventRootFields,
  demoOrganizationId,
  demoOrganizationRootFields,
  demoSeedVersion,
} from "@sessionbox-killer/domain";

import type { AirtableClient } from "./client.js";
import { AirtableCommandStore } from "./command-store.js";
import { AirtableSchemaDriftError } from "./errors.js";
import { createAirtableSchemaIndex } from "./schema-manager.js";
import type { AirtableFields, AirtableRecord } from "./types.js";

export interface DemoRootBootstrapResult {
  readonly eventRecordId: string;
  readonly organizationRecordId: string;
  readonly outcome: "applied" | "replayed";
}

function equalValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertFields(
  record: AirtableRecord,
  expected: AirtableFields,
  label: string,
): void {
  for (const [field, value] of Object.entries(expected)) {
    if (!equalValue(record.fields[field], value)) {
      throw new AirtableSchemaDriftError(
        `The existing demo ${label} root conflicts at ${field}.`,
      );
    }
  }
}

function exactRoot(
  records: readonly AirtableRecord[],
  entityId: string,
  label: string,
): AirtableRecord | null {
  const matching = records.filter(({ fields }) => fields.ID === entityId);
  if (
    matching.length > 1 ||
    records.some(({ fields }) => fields.ID !== entityId)
  ) {
    throw new AirtableSchemaDriftError(
      `The Airtable base contains a conflicting ${label} root.`,
    );
  }
  return matching[0] ?? null;
}

export async function runAirtableDemoRootBootstrap(
  client: AirtableClient,
): Promise<DemoRootBootstrapResult> {
  const schema = createAirtableSchemaIndex(await client.getBaseSchema());
  const organizationsTable = schema.tables.get("organizations");
  const eventsTable = schema.tables.get("events");
  if (!organizationsTable || !eventsTable) {
    throw new AirtableSchemaDriftError(
      "The Airtable schema does not contain the demo root tables.",
    );
  }

  const [organizations, events] = await Promise.all([
    client.listRecords(organizationsTable.id, { pageSize: 100 }),
    client.listRecords(eventsTable.id, { pageSize: 100 }),
  ]);
  const existingOrganization = exactRoot(
    organizations,
    demoOrganizationId,
    "organization",
  );
  const existingEvent = exactRoot(events, demoEventId, "event");
  if (existingEvent && !existingOrganization) {
    throw new AirtableSchemaDriftError(
      "The demo event root exists without its organization root.",
    );
  }
  if (existingOrganization) {
    assertFields(
      existingOrganization,
      demoOrganizationRootFields,
      "organization",
    );
  }
  if (existingEvent) {
    assertFields(existingEvent, demoEventRootFields, "event");
    if (
      !Array.isArray(existingEvent.fields.Organization) ||
      existingEvent.fields.Organization.length !== 1 ||
      existingEvent.fields.Organization[0] !== existingOrganization?.id
    ) {
      throw new AirtableSchemaDriftError(
        "The demo event root is linked to a different organization.",
      );
    }
  }
  const store = new AirtableCommandStore({ client, schema });
  const organization = await store.execute({
    commandId: `demo_root_v${demoSeedVersion}_organization`,
    entityId: demoOrganizationId,
    expectedVersion: existingOrganization ? demoSeedVersion - 1 : 0,
    fields: demoOrganizationRootFields,
    table: "organizations",
  });
  const event = await store.execute({
    commandId: `demo_root_v${demoSeedVersion}_event`,
    entityId: demoEventId,
    expectedVersion: existingEvent ? demoSeedVersion - 1 : 0,
    fields: {
      ...demoEventRootFields,
      Organization: [organization.recordId],
    },
    table: "events",
  });

  return {
    eventRecordId: event.recordId,
    organizationRecordId: organization.recordId,
    outcome: organization.replayed && event.replayed ? "replayed" : "applied",
  };
}
