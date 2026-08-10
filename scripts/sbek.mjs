#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const KIT_REPOSITORY = "https://forge.smol.ai/swyx/killmysaas-evals.git";
export const KIT_COMMIT = "d99935c3e3c6c50c6b9292220260ccfe2df6d6d4";
export const KIT_LOCK_SHA256 =
  "21f54a9e41ee35d9bd3773ea28b5d6c5d3b28ddf4c8f349ce057f76410e714e6";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_ROOT = path.resolve(
  process.env.SBEK_STATE_DIR ?? path.join(ROOT, ".sbek"),
);
const KIT_DIR = path.join(STATE_ROOT, "kit");
const CONFIG_FILE = path.join(STATE_ROOT, "evalconfig.json");
const CONFIG_EXAMPLE = path.join(
  ROOT,
  "config",
  "sbek",
  "evalconfig.example.json",
);
const OWNERSHIP_FILE = path.join(
  ROOT,
  "config",
  "sbek",
  "rubric-ownership.json",
);
const BROWSERS_DIR = path.join(STATE_ROOT, "browsers");

const HELP = `OpenSession sbek harness

Usage:
  pnpm sbek prepare                  Clone, pin, verify, and install the eval kit
  pnpm sbek init                     Create ignored .sbek/evalconfig.json
  pnpm sbek preflight                Validate local kit and safe configuration
  pnpm sbek verify                   Install + offline ownership/list/smoke/dry-run checks
  pnpm sbek ownership [--json]       Validate and summarize all 84 required rubric owners
  pnpm sbek list                     List upstream areas and scenarios (offline)
  pnpm sbek smoke                    Run upstream Playwright browser smoke (offline)
  pnpm sbek dry-run [upstream flags] Validate specs and print the plan (offline)
  pnpm sbek auth --persona <name>    Capture a persona session in the pinned kit
  pnpm sbek area <slug> [flags]      Run one paid area
  pnpm sbek run [flags]              Run selected/all paid required areas
  pnpm sbek resume <run-dir> [flags] Resume a paid run
  pnpm sbek rescore <run-dir>        Rebuild stored reports without API calls
  pnpm sbek finalize <run-dir>       Apply manual results without API calls
  pnpm sbek status                   Show paths and pin state

Paid commands require SBEK_ALLOW_PAID_RUN=1 and ANTHROPIC_API_KEY.
The ignored state root defaults to .sbek and can be overridden with SBEK_STATE_DIR.`;

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: BROWSERS_DIR,
      ...options.env,
    },
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    fail(`${command} exited with status ${result.status}`);
  return options.capture ? result.stdout.trim() : "";
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function assertNode() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major !== 26 || minor < 7)
    fail(
      `OpenSession's sbek wrapper requires project Node >=26.7 <27; current version is ${process.version}. The upstream kit alone supports Node 20+.`,
    );
}

function assertPrepared({ requireInstall = true } = {}) {
  assertNode();
  if (!fs.existsSync(path.join(KIT_DIR, ".git"))) {
    fail(`Eval kit is not prepared. Run "pnpm sbek prepare" first.`);
  }
  const remote = run("git", ["remote", "get-url", "origin"], {
    cwd: KIT_DIR,
    capture: true,
  });
  if (remote !== KIT_REPOSITORY) fail(`Unexpected eval-kit remote: ${remote}`);
  const head = run("git", ["rev-parse", "HEAD"], {
    cwd: KIT_DIR,
    capture: true,
  });
  if (head !== KIT_COMMIT)
    fail(`Eval kit is at ${head}; expected ${KIT_COMMIT}`);
  const dirty = run("git", ["status", "--porcelain"], {
    cwd: KIT_DIR,
    capture: true,
  });
  if (dirty)
    fail(
      "Pinned eval-kit files have local changes; preserve or remove them before continuing.",
    );
  const lock = path.join(KIT_DIR, "package-lock.json");
  if (sha256(lock) !== KIT_LOCK_SHA256)
    fail(
      "Pinned eval-kit package-lock.json hash does not match the reviewed lockfile.",
    );
  if (
    requireInstall &&
    !fs.existsSync(path.join(KIT_DIR, "node_modules", ".bin", "tsx"))
  )
    fail(`Eval-kit dependencies are missing. Run "pnpm sbek prepare".`);
}

function resolveConfig({ allowExample = false } = {}) {
  const file = fs.existsSync(CONFIG_FILE)
    ? CONFIG_FILE
    : allowExample
      ? CONFIG_EXAMPLE
      : null;
  if (!file)
    fail(
      `Missing ${CONFIG_FILE}. Run "pnpm sbek init" and replace every placeholder.`,
    );
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  let url;
  try {
    url = new URL(config.url);
  } catch {
    fail(`Invalid target URL in ${file}`);
  }
  if (!new Set(["http:", "https:"]).has(url.protocol))
    fail("sbek target URL must use HTTP or HTTPS.");
  return { file, config, placeholder: url.hostname.endsWith(".invalid") };
}

function validateOwnership() {
  const document = JSON.parse(fs.readFileSync(OWNERSHIP_FILE, "utf8"));
  if (document.evalKitCommit !== KIT_COMMIT)
    fail("Rubric ownership pin does not match the harness pin.");
  const expected = [
    ["CFP", 16],
    ["ABS", 14],
    ["SPK", 16],
    ["CNT", 14],
    ["AIA", 8],
    ["EMB", 16],
  ].flatMap(([prefix, count]) =>
    Array.from(
      { length: count },
      (_, index) => `${prefix}-${String(index + 1).padStart(2, "0")}`,
    ),
  );
  const actual = document.items.map((item) => item.id);
  const duplicates = actual.filter((id, index) => actual.indexOf(id) !== index);
  const missing = expected.filter((id) => !actual.includes(id));
  const extra = actual.filter((id) => !expected.includes(id));
  const ownerless = document.items.filter(
    (item) => !Array.isArray(item.owners) || item.owners.length === 0,
  );
  const invalidOwners = document.items.filter((item) =>
    item.owners.some((owner) => !/^RAL-\d+$/.test(owner)),
  );
  if (
    document.requiredItemCount !== expected.length ||
    duplicates.length ||
    missing.length ||
    extra.length ||
    ownerless.length ||
    invalidOwners.length
  ) {
    fail(
      `Invalid rubric ownership: declared=${document.requiredItemCount}; duplicates=${duplicates.join(",") || "none"}; missing=${missing.join(",") || "none"}; extra=${extra.join(",") || "none"}; ownerless=${ownerless.map((item) => item.id).join(",") || "none"}; invalidOwners=${invalidOwners.map((item) => item.id).join(",") || "none"}`,
    );
  }
  return document;
}

function prepare() {
  assertNode();
  fs.mkdirSync(STATE_ROOT, { recursive: true });
  if (!fs.existsSync(path.join(KIT_DIR, ".git"))) {
    if (fs.existsSync(KIT_DIR))
      fail(`${KIT_DIR} exists but is not a Git checkout.`);
    run("git", ["clone", KIT_REPOSITORY, KIT_DIR]);
  }
  const remote = run("git", ["remote", "get-url", "origin"], {
    cwd: KIT_DIR,
    capture: true,
  });
  if (remote !== KIT_REPOSITORY)
    fail(`Refusing unexpected eval-kit remote: ${remote}`);
  const dirty = run("git", ["status", "--porcelain"], {
    cwd: KIT_DIR,
    capture: true,
  });
  if (dirty)
    fail(
      "Refusing to replace modified or untracked files in the local eval-kit checkout.",
    );
  const commitExists =
    spawnSync("git", ["cat-file", "-e", `${KIT_COMMIT}^{commit}`], {
      cwd: KIT_DIR,
      stdio: "ignore",
    }).status === 0;
  if (!commitExists)
    run("git", ["fetch", "origin", KIT_COMMIT], { cwd: KIT_DIR });
  run("git", ["checkout", "--detach", KIT_COMMIT], { cwd: KIT_DIR });
  assertPrepared({ requireInstall: false });
  fs.mkdirSync(BROWSERS_DIR, { recursive: true });
  run("npm", ["ci"], { cwd: KIT_DIR });
  console.log(`Prepared sbek ${KIT_COMMIT} in ${KIT_DIR}`);
}

function init() {
  fs.mkdirSync(STATE_ROOT, { recursive: true });
  if (fs.existsSync(CONFIG_FILE))
    fail(`${CONFIG_FILE} already exists; it was not overwritten.`);
  fs.copyFileSync(CONFIG_EXAMPLE, CONFIG_FILE, fs.constants.COPYFILE_EXCL);
  console.log(
    `Created ${CONFIG_FILE}. Replace placeholders before a scored run.`,
  );
}

function preflight({ paid = false, allowExample = false } = {}) {
  assertPrepared();
  validateOwnership();
  const { file, config, placeholder } = resolveConfig({ allowExample });
  const personas = ["organizer", "speaker", "speaker2", "reviewer"];
  const missingPersonas = personas.filter(
    (persona) => !config.personaEmails?.[persona],
  );
  if (missingPersonas.length)
    fail(`Missing persona emails: ${missingPersonas.join(", ")}`);
  if (paid) {
    if (process.env.SBEK_ALLOW_PAID_RUN !== "1") {
      fail(
        "Paid run blocked. Review the target/reset/config, then set SBEK_ALLOW_PAID_RUN=1.",
      );
    }
    if (!process.env.ANTHROPIC_API_KEY)
      fail("Paid run blocked: ANTHROPIC_API_KEY is not set.");
    if (placeholder)
      fail(`Paid run blocked: ${file} still contains a .invalid target URL.`);
  }
  console.log(
    `Preflight passed (${paid ? "paid execution enabled" : "offline"}): ${file}`,
  );
  return file;
}

function upstream(script, args = []) {
  assertPrepared();
  run("npm", ["run", script, "--", ...args], { cwd: KIT_DIR });
}

function paidConfig() {
  return preflight({ paid: true });
}

function resolveRunDir(value) {
  const runDir = path.isAbsolute(value) ? value : path.resolve(ROOT, value);
  if (!fs.existsSync(runDir)) fail(`Run directory does not exist: ${runDir}`);
  return runDir;
}

function printOwnership(json) {
  const document = validateOwnership();
  if (json) {
    console.log(JSON.stringify(document, null, 2));
    return;
  }
  const areas = Object.groupBy(document.items, (item) => item.id.slice(0, 3));
  for (const [area, items] of Object.entries(areas)) {
    const issueCount = new Set(items.flatMap((item) => item.owners)).size;
    console.log(
      `${area}: ${items.length} rubric items mapped across ${issueCount} Linear issues`,
    );
  }
  console.log(
    `Required total: ${document.items.length}/84 mapped (forecast, not measured verdicts)`,
  );
  console.log("Optional Speaker CRM is tracked separately in RAL-100.");
}

function status() {
  const prepared = fs.existsSync(path.join(KIT_DIR, ".git"));
  const config = fs.existsSync(CONFIG_FILE);
  console.log(`Repository: ${KIT_REPOSITORY}`);
  console.log(`Commit:     ${KIT_COMMIT}`);
  console.log(`State:      ${STATE_ROOT}`);
  console.log(
    `Kit:        ${KIT_DIR} (${prepared ? "present" : "not prepared"})`,
  );
  console.log(
    `Config:     ${CONFIG_FILE} (${config ? "present" : "not initialized"})`,
  );
  console.log(`Runs:       ${path.join(KIT_DIR, "runs")}`);
}

async function main() {
  const [command = "help", ...args] = process.argv.slice(2);
  if (["help", "--help", "-h"].includes(command)) return console.log(HELP);
  if (command === "prepare") return prepare();
  if (command === "init") return init();
  if (command === "status") return status();
  if (command === "ownership") return printOwnership(args.includes("--json"));
  if (command === "preflight") return preflight();
  if (command === "list") return upstream("list");
  if (command === "smoke") return upstream("smoke");
  if (command === "dry-run") {
    const config = preflight({ allowExample: true });
    return upstream("sbek", ["run", "--config", config, "--dry-run", ...args]);
  }
  if (command === "auth") {
    const config = preflight();
    return upstream("sbek", ["auth", "--config", config, ...args]);
  }
  if (command === "area") {
    const [area, ...rest] = args;
    if (!area || area.startsWith("--"))
      fail(
        "area requires an area slug, for example: pnpm sbek area call-for-papers",
      );
    const config = paidConfig();
    return upstream("sbek", [
      "run",
      "--config",
      config,
      "--areas",
      area,
      ...rest,
    ]);
  }
  if (command === "run") {
    const config = paidConfig();
    return upstream("sbek", ["run", "--config", config, ...args]);
  }
  if (command === "resume") {
    const [runDir, ...rest] = args;
    if (!runDir) fail("resume requires a run directory.");
    const config = paidConfig();
    return upstream("sbek", [
      "run",
      "--config",
      config,
      "--resume",
      resolveRunDir(runDir),
      ...rest,
    ]);
  }
  if (["rescore", "finalize"].includes(command)) {
    const [runDir, ...rest] = args;
    if (!runDir) fail(`${command} requires a run directory.`);
    assertPrepared();
    return upstream("sbek", [command, "--run", resolveRunDir(runDir), ...rest]);
  }
  if (command === "verify") {
    prepare();
    preflight({ allowExample: true });
    printOwnership(false);
    upstream("typecheck");
    upstream("list");
    upstream("smoke");
    const config = resolveConfig({ allowExample: true }).file;
    upstream("sbek", ["run", "--config", config, "--dry-run"]);
    return;
  }
  fail(`Unknown sbek command: ${command}`);
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`sbek: ${error.message}`);
    process.exitCode = 1;
  });
}
