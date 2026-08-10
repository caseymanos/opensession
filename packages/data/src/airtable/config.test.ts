import { describe, expect, it } from "vitest";

import {
  assertAirtableMutationAllowed,
  assertDistinctAirtableBases,
  loadAirtableConfiguration,
} from "./config.js";

describe("Airtable configuration", () => {
  it("loads an environment-specific base without exposing token distinctions", () => {
    expect(
      loadAirtableConfiguration("preview", {
        AIRTABLE_PAT: "runtime-token",
        AIRTABLE_PREVIEW_BASE_ID: "app-preview",
        AIRTABLE_PRODUCTION_BASE_ID: "app-production",
        AIRTABLE_SCHEMA_PAT: "schema-token",
      }),
    ).toEqual({
      baseId: "app-preview",
      environment: "preview",
      runtimeToken: "runtime-token",
      schemaToken: "schema-token",
    });
  });

  it("rejects shared preview and production bases", () => {
    expect(() => assertDistinctAirtableBases("app-one", "app-one")).toThrow(
      "different Airtable bases",
    );
  });

  it("requires explicit mutation and two production confirmations", () => {
    expect(() =>
      assertAirtableMutationAllowed({
        apply: false,
        environment: "preview",
        productionFlag: false,
      }),
    ).toThrow("--apply");
    expect(() =>
      assertAirtableMutationAllowed({
        apply: true,
        environment: "production",
        productionConfirmation: "production",
        productionFlag: false,
      }),
    ).toThrow("Production requires");
    expect(() =>
      assertAirtableMutationAllowed({
        apply: true,
        environment: "production",
        productionConfirmation: "production",
        productionFlag: true,
      }),
    ).not.toThrow();
  });

  it("rejects environment marker mismatches", () => {
    expect(() =>
      loadAirtableConfiguration("production", {
        AIRTABLE_ENVIRONMENT: "preview",
        AIRTABLE_PAT: "runtime-token",
        AIRTABLE_PRODUCTION_BASE_ID: "app-production",
      }),
    ).toThrow("does not match production");
  });

  it("requires the explicitly selected environment base", () => {
    expect(() =>
      loadAirtableConfiguration("production", {
        AIRTABLE_PAT: "runtime-token",
        AIRTABLE_PREVIEW_BASE_ID: "app-preview",
      }),
    ).toThrow("AIRTABLE_PRODUCTION_BASE_ID is required");
  });
});
