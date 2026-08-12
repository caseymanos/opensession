import { spawnSync } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDirectory = fileURLToPath(new URL("../../", import.meta.url));
const provisionerPath = join(rootDirectory, ".cloudflare/bin/provision.js");
const privateDeployLauncherMarker = "opensession-private-deploy-v1";
const privateDeployHandshakeFd = "3";
export function createPrivateDeployBuildEnvironment(source) {
  const environment = { ...source };
  delete environment.EMAIL_PREVIEW_RECIPIENT;
  delete environment.EMAIL_PRODUCTION_RECIPIENTS;
  delete environment.OPENSESSION_PRIVATE_DEPLOY_LAUNCHER;
  delete environment.OPENSESSION_PRIVATE_DEPLOY_LAUNCHER_PID;
  delete environment.OPENSESSION_PRIVATE_DEPLOY_HANDSHAKE_FD;
  return environment;
}

const commands = new Set([
  "apply",
  "deploy",
  "plan",
  "rollback",
  "smoke",
  "status",
  "verify-lkg",
  "verify-queues",
]);
const locations = new Set(["weur", "eeur", "apac", "oc", "wnam", "enam"]);

function validateProvisionArguments(argv) {
  const [command, ...arguments_] = argv;
  if (!commands.has(command)) {
    throw new Error("Private deploy requires a supported provision command.");
  }

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--environment") {
      const environment = arguments_[index + 1];
      if (environment !== "preview" && environment !== "production") {
        throw new Error("Private deploy requires one remote environment.");
      }
      index += 1;
    } else if (argument === "--location") {
      if (!locations.has(arguments_[index + 1])) {
        throw new Error(
          "Private deploy requires a supported resource location.",
        );
      }
      index += 1;
    } else if (argument === "--lkg-receipt" || argument === "--dlq-baseline") {
      if (
        !/^\.cloudflare\/[A-Za-z0-9._-]+\.json$/.test(
          arguments_[index + 1] ?? "",
        )
      ) {
        throw new Error(
          "Private deploy requires an ignored Cloudflare receipt path.",
        );
      }
      index += 1;
    } else if (argument === "--queue-observation-seconds") {
      const seconds = Number(arguments_[index + 1]);
      if (!Number.isInteger(seconds) || seconds < 10 || seconds > 60) {
        throw new Error(
          "Private deploy Queue observation must be 10 to 60 seconds.",
        );
      }
      index += 1;
    } else if (argument === "--confirm-production") {
      continue;
    } else {
      throw new Error("Private deploy received an unsupported argument.");
    }
  }
}

export function runPrivateDeploy(
  argv,
  { environment = process.env, spawn = spawnSync } = {},
) {
  const buildWeb = argv[0] === "--build-web";
  const provisionArguments = buildWeb ? argv.slice(1) : argv;
  validateProvisionArguments(provisionArguments);
  const buildEnvironment = createPrivateDeployBuildEnvironment(environment);
  const steps = [
    ...(buildWeb
      ? [
          {
            arguments: ["build:web"],
            command: "pnpm",
            environment: buildEnvironment,
            label: "web build",
          },
        ]
      : []),
    {
      arguments: ["cloudflare:build"],
      command: "pnpm",
      environment: buildEnvironment,
      label: "Cloudflare operator build",
    },
    {
      arguments: [provisionerPath, ...provisionArguments],
      command: process.execPath,
      environment: {
        ...environment,
        OPENSESSION_PRIVATE_DEPLOY_LAUNCHER: privateDeployLauncherMarker,
        OPENSESSION_PRIVATE_DEPLOY_LAUNCHER_PID: String(process.pid),
        OPENSESSION_PRIVATE_DEPLOY_HANDSHAKE_FD: privateDeployHandshakeFd,
      },
      label: "private deployment",
    },
  ];

  for (const [index, step] of steps.entries()) {
    let handshakeDirectory;
    let handshakeFd;
    let stdio = "inherit";
    if (index === steps.length - 1) {
      handshakeDirectory = mkdtempSync(join(tmpdir(), "opensession-private-"));
      const handshakePath = join(handshakeDirectory, "handshake");
      writeFileSync(handshakePath, privateDeployLauncherMarker, {
        mode: 0o600,
      });
      handshakeFd = openSync(handshakePath, "r");
      stdio = ["inherit", "inherit", "inherit", handshakeFd];
    }

    let result;
    try {
      result = spawn(step.command, step.arguments, {
        cwd: rootDirectory,
        env: step.environment,
        shell: false,
        stdio,
      });
    } finally {
      if (handshakeFd !== undefined) closeSync(handshakeFd);
      if (handshakeDirectory !== undefined)
        rmSync(handshakeDirectory, { recursive: true, force: true });
    }

    if (result.error) {
      throw new Error(`Unable to start ${step.label}.`);
    }
    if (result.signal) {
      return { signal: result.signal, status: null };
    }
    if (result.status !== 0) {
      return { signal: null, status: result.status ?? 1 };
    }
  }

  return { signal: null, status: 0 };
}

const entryPath = process.argv[1];
const isCliEntry =
  typeof entryPath === "string" &&
  pathToFileURL(resolve(entryPath)).href === import.meta.url;

if (isCliEntry) {
  try {
    const result = runPrivateDeploy(process.argv.slice(2));
    if (result.signal) {
      process.kill(process.pid, result.signal);
    } else {
      process.exitCode = result.status;
    }
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Private deploy failed.",
    );
    process.exitCode = 1;
  }
}
