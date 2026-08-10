export type AirtableEnvironment = "preview" | "production";

export interface AirtableConfiguration {
  baseId: string;
  environment: AirtableEnvironment;
  runtimeToken: string;
  schemaToken: string;
}

export interface AirtableEnvironmentValues {
  AIRTABLE_ENVIRONMENT?: string | undefined;
  AIRTABLE_PAT?: string | undefined;
  AIRTABLE_PREVIEW_BASE_ID?: string | undefined;
  AIRTABLE_PRODUCTION_BASE_ID?: string | undefined;
  AIRTABLE_PRODUCTION_CONFIRM?: string | undefined;
  AIRTABLE_SCHEMA_PAT?: string | undefined;
}

function requireValue(value: string | undefined, name: string): string {
  const result = value?.trim();
  if (!result) {
    throw new Error(`${name} is required.`);
  }
  return result;
}

export function assertDistinctAirtableBases(
  previewBaseId: string | undefined,
  productionBaseId: string | undefined,
) {
  if (
    previewBaseId?.trim() &&
    productionBaseId?.trim() &&
    previewBaseId.trim() === productionBaseId.trim()
  ) {
    throw new Error(
      "Preview and production must use different Airtable bases.",
    );
  }
}

export function loadAirtableConfiguration(
  environment: AirtableEnvironment,
  values: AirtableEnvironmentValues,
): AirtableConfiguration {
  assertDistinctAirtableBases(
    values.AIRTABLE_PREVIEW_BASE_ID,
    values.AIRTABLE_PRODUCTION_BASE_ID,
  );

  if (
    values.AIRTABLE_ENVIRONMENT &&
    values.AIRTABLE_ENVIRONMENT !== environment
  ) {
    throw new Error(
      `AIRTABLE_ENVIRONMENT=${values.AIRTABLE_ENVIRONMENT} does not match ${environment}.`,
    );
  }

  const baseId = requireValue(
    environment === "preview"
      ? values.AIRTABLE_PREVIEW_BASE_ID
      : values.AIRTABLE_PRODUCTION_BASE_ID,
    environment === "preview"
      ? "AIRTABLE_PREVIEW_BASE_ID"
      : "AIRTABLE_PRODUCTION_BASE_ID",
  );
  const runtimeToken = requireValue(values.AIRTABLE_PAT, "AIRTABLE_PAT");

  return {
    baseId,
    environment,
    runtimeToken,
    schemaToken: values.AIRTABLE_SCHEMA_PAT?.trim() || runtimeToken,
  };
}

export function assertAirtableMutationAllowed(options: {
  apply: boolean;
  environment: AirtableEnvironment;
  productionConfirmation?: string | undefined;
  productionFlag: boolean;
}) {
  if (!options.apply) {
    throw new Error("Airtable mutations require --apply.");
  }

  if (
    options.environment === "production" &&
    !(options.productionFlag && options.productionConfirmation === "production")
  ) {
    throw new Error(
      "Production requires --confirm-production and AIRTABLE_PRODUCTION_CONFIRM=production.",
    );
  }
}
