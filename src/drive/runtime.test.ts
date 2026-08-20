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
    sha256: "3b5beb9fd7d184bd57904f315d1475e74d88f3b2fac0429947e1a3f52ecd4c01",
  },
  x64: {
    path: join(root, "bin", "runtime", "deja-darwin-x64"),
    sha256: "cf8b212c64a687a366bfd0833ced31db4ba89444fe6b2ef9e3746773df87d97e",
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
