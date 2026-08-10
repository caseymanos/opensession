import type { AirtableClient } from "./client.js";
import { AirtableCommandStore } from "./command-store.js";
import { createAirtableSchemaIndex } from "./schema-manager.js";

export interface AirtableProbeResult {
  baseSuffix: string;
  entityIds: readonly string[];
  schemaVersion: number;
}

export async function runAirtableProbe(
  client: AirtableClient,
): Promise<AirtableProbeResult> {
  const schema = createAirtableSchemaIndex(await client.getBaseSchema());
  const store = new AirtableCommandStore({ client, schema });
  const organization = await store.execute({
    commandId: "probe_schema_v1_organization",
    entityId: "org_preview_probe",
    expectedVersion: 0,
    fields: {
      "Default timezone": "America/Los_Angeles",
      Name: "OpenSession Preview",
      Slug: "opensession-preview",
    },
    table: "organizations",
  });
  const event = await store.execute({
    commandId: "probe_schema_v1_event",
    entityId: "evt_preview_probe",
    expectedVersion: 0,
    fields: {
      "CFP closes": "2026-08-12T19:00:00.000Z",
      "CFP opens": "2026-08-08T19:00:00.000Z",
      End: "2026-10-17T01:00:00.000Z",
      "Is demo": true,
      Name: "AI Engineer Summit 2026",
      Organization: [organization.recordId],
      Slug: "ai-engineer-summit-2026",
      Start: "2026-10-15T16:00:00.000Z",
      Status: "draft",
      Timezone: "America/Los_Angeles",
      Venue: "San Francisco",
    },
    table: "events",
  });
  const form = await store.execute({
    commandId: "probe_schema_v1_form",
    entityId: "form_preview_probe",
    expectedVersion: 0,
    fields: {
      "Edit after close": true,
      Event: [event.recordId],
      Name: "Call for Proposals",
      Status: "draft",
      "Submission limit": 3,
      Version: 1,
      "Welcome content":
        "Submit a practical session for AI Engineer Summit 2026.",
    },
    table: "forms",
  });

  return {
    baseSuffix: client.baseId.slice(-6),
    entityIds: [organization.entityId, event.entityId, form.entityId],
    schemaVersion: schema.version,
  };
}
