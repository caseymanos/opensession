import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";

const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);

const violations = [];
const binaryExtensions = new Set([
  ".docx",
  ".gif",
  ".jpeg",
  ".jpg",
  ".pdf",
  ".png",
  ".webp",
  ".zip",
]);
const forbiddenPaths = [
  { pattern: /^docs\/evidence\//u, reason: "private release evidence" },
  { pattern: /^research\//u, reason: "third-party source archive" },
  { pattern: /\.docx$/iu, reason: "Word source artifact" },
];
const contentRules = [
  { pattern: /\/(?:Users|home)\/[^\s/]+\//u, reason: "absolute home path" },
  {
    pattern: /[A-Z0-9._%+-]+@gmail\.com/iu,
    reason: "personal Gmail address",
  },
  { pattern: /caseymanos\.com/iu, reason: "personal operational domain" },
];

for (const file of trackedFiles) {
  for (const rule of forbiddenPaths) {
    if (rule.pattern.test(file)) {
      violations.push(`${file}: ${rule.reason}`);
    }
  }
  if (!existsSync(file) || binaryExtensions.has(extname(file).toLowerCase())) {
    continue;
  }
  const content = readFileSync(file, "utf8");
  for (const rule of contentRules) {
    if (rule.pattern.test(content)) {
      violations.push(`${file}: ${rule.reason}`);
    }
  }
  if (
    !file.includes(".test.") &&
    !file.includes("/test/") &&
    /(?:^|[^A-Za-z0-9])app(?=[A-Za-z0-9]{14}(?:[^A-Za-z0-9]|$))(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{14}(?:[^A-Za-z0-9]|$)/u.test(
      content,
    )
  ) {
    violations.push(`${file}: live-shaped Airtable base identifier`);
  }
}

if (violations.length > 0) {
  console.error("Public repository check failed:\n" + violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Public repository check passed for ${trackedFiles.length} files.`,
  );
}
