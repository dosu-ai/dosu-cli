/** Every tRPC call must be typed through the generated contract, never hand-written shapes:
 * hand shapes turned an unregistered procedure into a production 404 (dosu review, v0.29.0). */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = join(__dirname, "..");

const FORBIDDEN: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /TypedClient\s*&/,
    reason:
      "extending TypedClient with hand-written procedures — add the procedure to cliRouter in dosu and re-vendor the contract instead",
  },
  {
    pattern: /\b(?:query|mutate)\(input\??:/,
    reason:
      "hand-declared procedure signature — type the client from the generated contract (CliApiClient / TypedClient) instead",
  },
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      return name === "generated" ? [] : walk(full);
    }
    if (!full.endsWith(".ts") || full.endsWith(".test.ts")) {
      return [];
    }
    return [full];
  });
}

describe("contract discipline", () => {
  it("has no hand-written tRPC client shapes outside the generated contract", () => {
    const violations: string[] = [];

    for (const file of walk(SRC_ROOT)) {
      const source = readFileSync(file, "utf8");
      for (const { pattern, reason } of FORBIDDEN) {
        const match = source.match(pattern);
        if (match) {
          const line = source.slice(0, match.index).split("\n").length;
          violations.push(`${file}:${line} — ${reason}`);
        }
      }
    }

    expect(violations, violations.join("\n")).toEqual([]);
  });
});
