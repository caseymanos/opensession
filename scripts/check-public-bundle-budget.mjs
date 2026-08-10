import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { gzipSync } from "node:zlib";

const publicBudgetBytes = 170 * 1024;
const distributionDirectory = path.resolve("apps/web/dist");
const manifestPath = path.join(distributionDirectory, ".vite/manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const routeEntries = [
  "index.html",
  "src/public/PublicSchedule.tsx",
  "src/public/PublicSpeakers.tsx",
];
const visitedEntries = new Set();
const javascriptFiles = new Set();

function visitEntry(key) {
  if (visitedEntries.has(key)) {
    return;
  }
  visitedEntries.add(key);
  const entry = manifest[key];
  if (!entry) {
    throw new Error(`Public bundle manifest entry is missing: ${key}`);
  }
  if (entry.file?.endsWith(".js")) {
    javascriptFiles.add(entry.file);
  }
  for (const importedKey of entry.imports ?? []) {
    visitEntry(importedKey);
  }
}

for (const entry of routeEntries) {
  visitEntry(entry);
}

const files = [];
let totalGzipBytes = 0;
for (const file of [...javascriptFiles].sort()) {
  const contents = await readFile(path.join(distributionDirectory, file));
  const gzipBytes = gzipSync(contents, { level: 9 }).byteLength;
  totalGzipBytes += gzipBytes;
  files.push({ file, gzipBytes });
}

const result = {
  budgetGzipBytes: publicBudgetBytes,
  files,
  route: "/e/:eventSlug",
  totalGzipBytes,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

if (totalGzipBytes > publicBudgetBytes) {
  throw new Error(
    `Public JavaScript is ${totalGzipBytes} gzip bytes; budget is ${publicBudgetBytes}.`,
  );
}
