import { AirtableClient } from "./client.js";
import {
  assertAirtableMutationAllowed,
  loadAirtableConfiguration,
  type AirtableEnvironment,
  type AirtableEnvironmentValues,
} from "./config.js";
import { runAirtableProbe } from "./probe.js";
import { AirtableSchemaManager } from "./schema-manager.js";

type Command = "probe" | "schema:bootstrap" | "schema:check";

interface CliOptions {
  apply: boolean;
  command: Command;
  environment: AirtableEnvironment;
  productionFlag: boolean;
}

function parseArguments(arguments_: readonly string[]): CliOptions {
  const command = arguments_[0];
  if (
    command !== "probe" &&
    command !== "schema:bootstrap" &&
    command !== "schema:check"
  ) {
    throw new Error(
      "Command must be schema:check, schema:bootstrap, or probe.",
    );
  }

  let environment: AirtableEnvironment | undefined;
  let apply = false;
  let productionFlag = false;

  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--environment") {
      const value = arguments_[index + 1];
      if (value !== "preview" && value !== "production") {
        throw new Error("--environment must be preview or production.");
      }
      environment = value;
      index += 1;
    } else if (argument === "--apply") {
      apply = true;
    } else if (argument === "--confirm-production") {
      productionFlag = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!environment) {
    throw new Error("Pass --environment preview or production.");
  }

  return { apply, command, environment, productionFlag };
}

function environmentValues(): AirtableEnvironmentValues {
  return {
    AIRTABLE_ENVIRONMENT: process.env.AIRTABLE_ENVIRONMENT,
    AIRTABLE_PAT: process.env.AIRTABLE_PAT,
    AIRTABLE_PREVIEW_BASE_ID: process.env.AIRTABLE_PREVIEW_BASE_ID,
    AIRTABLE_PRODUCTION_BASE_ID: process.env.AIRTABLE_PRODUCTION_BASE_ID,
    AIRTABLE_PRODUCTION_CONFIRM: process.env.AIRTABLE_PRODUCTION_CONFIRM,
    AIRTABLE_SCHEMA_PAT: process.env.AIRTABLE_SCHEMA_PAT,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const values = environmentValues();
  const configuration = loadAirtableConfiguration(options.environment, values);
  const mutating = options.command !== "schema:check";

  if (mutating) {
    assertAirtableMutationAllowed({
      apply: options.apply,
      environment: options.environment,
      productionConfirmation: values.AIRTABLE_PRODUCTION_CONFIRM,
      productionFlag: options.productionFlag,
    });
  }

  const client = new AirtableClient({
    baseId: configuration.baseId,
    token:
      options.command === "schema:bootstrap"
        ? configuration.schemaToken
        : configuration.runtimeToken,
  });

  if (options.command === "schema:check") {
    const report = await new AirtableSchemaManager(client).check();
    console.log(JSON.stringify(report, null, 2));
    if (!report.ready) {
      process.exitCode = 2;
    }
    return;
  }

  if (options.command === "schema:bootstrap") {
    const report = await new AirtableSchemaManager(client).bootstrap();
    console.log(JSON.stringify(report, null, 2));
    if (!report.ready) {
      process.exitCode = 2;
    }
    return;
  }

  console.log(JSON.stringify(await runAirtableProbe(client), null, 2));
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Airtable command failed.",
  );
  process.exitCode = 1;
});
