import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const runtimes = {
  arm64: {
    path: join(root, "bin", "runtime", "deja-darwin-arm64"),
    sha256: "b9ed47eebb9ea84812c44775cc1d85be7587ca141a233fad5471f2a9ab0a8bdf",
  },
  x64: {
    path: join(root, "bin", "runtime", "deja-darwin-x64"),
    sha256: "19e1eb6bdd6565faf15461f5fb48669cba929ce1ff7a71249ff938f95f082b80",
  },
} as const;

it("pins executable enhanced deja-vu runtimes for both Mac architectures", () => {
  for (const runtime of Object.values(runtimes)) {
    const bytes = readFileSync(runtime.path);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(runtime.sha256);
    expect(statSync(runtime.path).mode & 0o111).not.toBe(0);
  }
  if (process.platform === "darwin" && (process.arch === "arm64" || process.arch === "x64")) {
    expect(
      execFileSync(runtimes[process.arch].path, ["version"], { encoding: "utf8" }).trim(),
    ).toBe("deja 0.17.3-dosu.1");
  }
});
