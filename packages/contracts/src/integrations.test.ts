import { describe, expect, it } from "vitest";

import {
  airtableIntegrationHealthSchema,
  airtableReconcileRequestSchema,
  airtableReconcileResponseSchema,
} from "./integrations.js";

describe("Airtable integration contracts", () => {
  it("accepts only redacted health metadata", () => {
    const value = {
      authority: {
        base_suffix: "…5T3JpR",
        last_read_at: "2026-08-11T20:00:00.000Z",
        last_write_at: null,
        schema_version: 10,
      },
      generated_at: "2026-08-11T20:01:00.000Z",
      judge_trace: [
        {
          kind: "proposal",
          label: "Submitted proposals",
          projected_count: 4,
          tables: ["Submissions", "Submission Participants", "Contacts"],
        },
        {
          kind: "session",
          label: "Accepted sessions",
          projected_count: 2,
          tables: ["Sessions", "Session Participants", "Contacts"],
        },
        {
          kind: "task_assignment",
          label: "Task assignments",
          projected_count: 3,
          tables: ["Task Assignments", "Task Definitions", "Contacts"],
        },
      ],
      projection: {
        lag_seconds: 60,
        last_reconcile: {
          completed_at: "2026-08-11T20:00:00.000Z",
          status: "succeeded",
          table_count: 31,
        },
        repair_backlog: { dead: 0, failed: 0, pending: 1 },
        watermark_at: "2026-08-11T20:00:00.000Z",
      },
    };

    expect(airtableIntegrationHealthSchema.parse(value)).toEqual(value);
    expect(() =>
      airtableIntegrationHealthSchema.parse({
        ...value,
        authority: {
          ...value.authority,
          base_id: "appFullBaseIdentifier",
        },
      }),
    ).toThrow();
  });

  it("requires an immutable plan and exact confirmation for apply", () => {
    expect(airtableReconcileRequestSchema.parse({ mode: "dry_run" })).toEqual({
      mode: "dry_run",
    });
    expect(() =>
      airtableReconcileRequestSchema.parse({
        confirmation: "RECONCILE",
        mode: "apply",
      }),
    ).toThrow();
  });

  it("keeps reconciliation responses aggregate-only", () => {
    expect(
      airtableReconcileResponseSchema.parse({
        audit_id: "aud_1234567890abcdef",
        completed_at: "2026-08-11T20:00:00.000Z",
        mode: "apply",
        result: { deleted: 1, projected: 12, table_count: 31 },
      }),
    ).toMatchObject({ mode: "apply" });
    expect(() =>
      airtableReconcileResponseSchema.parse({
        audit_id: "aud_1234567890abcdef",
        completed_at: "2026-08-11T20:00:00.000Z",
        mode: "apply",
        records: [{ fields: { Email: "private@example.com" } }],
        result: { deleted: 1, projected: 12, table_count: 31 },
      }),
    ).toThrow();
  });
});
