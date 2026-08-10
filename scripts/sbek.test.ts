import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "sbek.mjs");

describe("sbek harness", () => {
  it("documents the paid-run guard and offline workflow", () => {
    const output = execFileSync(process.execPath, [script, "help"], {
      encoding: "utf8",
    });

    expect(output).toContain("pnpm sbek verify");
    expect(output).toContain("SBEK_ALLOW_PAID_RUN=1");
  });

  it("validates an explicit 84-item required-rubric map", () => {
    const output = execFileSync(
      process.execPath,
      [script, "ownership", "--json"],
      {
        encoding: "utf8",
      },
    );
    const document = JSON.parse(output) as {
      items: { id: string; owners: string[] }[];
    };

    expect(document.items).toHaveLength(84);
    expect(new Set(document.items.map((item) => item.id)).size).toBe(84);
    expect(document.items.every((item) => item.owners.length > 0)).toBe(true);
  });

  it("rejects unknown commands", () => {
    const result = spawnSync(process.execPath, [script, "not-a-command"], {
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown sbek command");
  });
});
