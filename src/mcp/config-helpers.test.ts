import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installJSONServer,
  installProjectJSONServer,
  isJSONKeyConfigured,
  isProjectJSONServerConfigured,
  loadJSONConfig,
  mcpHeaders,
  mcpURL,
  removeJSONServer,
  removeProjectFile,
  removeProjectJSONServer,
  saveJSONConfig,
  stripJSONComments,
  writeProjectFile,
  writeSecureFile,
} from "./config-helpers";

describe("mcpURL", () => {
  const savedBackendURL = process.env.DOSU_BACKEND_URL;

  beforeEach(() => {
    process.env.DOSU_BACKEND_URL = "https://api.test.dev";
  });

  afterEach(() => {
    if (savedBackendURL !== undefined) {
      process.env.DOSU_BACKEND_URL = savedBackendURL;
    } else {
      delete process.env.DOSU_BACKEND_URL;
    }
  });

  it("builds correct URL with deployment ID", () => {
    const url = mcpURL("deploy-abc");
    expect(url).toContain("/v1/mcp/deployments/deploy-abc");
    expect(url).toMatch(/^https?:\/\//);
  });
});

describe("mcpHeaders", () => {
  it("returns correct header map", () => {
    const headers = mcpHeaders("my-api-key");
    expect(headers).toEqual({ "X-Dosu-API-Key": "my-api-key" });
  });

  it("throws instead of returning an empty header map when the API key is missing", () => {
    expect(() => mcpHeaders(undefined)).toThrow("API key is required");
    expect(() => mcpHeaders("")).toThrow("API key is required");
  });
});

describe("stripJSONComments", () => {
  it("strips line comments", () => {
    const input = '{"key": "value" // comment\n}';
    const result = stripJSONComments(input);
    expect(JSON.parse(result)).toEqual({ key: "value" });
  });

  it("strips block comments", () => {
    const input = '{"key": /* block */ "value"}';
    const result = stripJSONComments(input);
    expect(JSON.parse(result)).toEqual({ key: "value" });
  });

  it("preserves strings containing comment-like sequences", () => {
    const input = '{"url": "http://example.com"}';
    const result = stripJSONComments(input);
    expect(JSON.parse(result)).toEqual({ url: "http://example.com" });
  });

  it("preserves strings with // inside", () => {
    const input = '{"url": "http://host:8080/path"}';
    const result = stripJSONComments(input);
    expect(JSON.parse(result)).toEqual({ url: "http://host:8080/path" });
  });

  it("handles escaped quotes in strings", () => {
    const input = '{"key": "val\\"ue" // comment\n}';
    const result = stripJSONComments(input);
    expect(JSON.parse(result)).toEqual({ key: 'val"ue' });
  });

  it("handles multiline block comments", () => {
    const input = '{\n/* multi\nline\ncomment */\n"key": "value"\n}';
    const result = stripJSONComments(input);
    expect(JSON.parse(result)).toEqual({ key: "value" });
  });

  it("handles empty input", () => {
    expect(stripJSONComments("")).toBe("");
  });
});

describe("JSON config file operations", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dosu-mcp-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("loadJSONConfig", () => {
    it("returns empty object for non-existent file", () => {
      const result = loadJSONConfig(join(tempDir, "nonexistent.json"));
      expect(result).toEqual({});
    });

    it("reads JSON file", () => {
      const path = join(tempDir, "test.json");
      writeFileSync(path, '{"foo": "bar"}');
      expect(loadJSONConfig(path)).toEqual({ foo: "bar" });
    });

    it("reads JSONC file with comments", () => {
      const path = join(tempDir, "test.jsonc");
      writeFileSync(path, '{\n// comment\n"foo": "bar"\n}');
      expect(loadJSONConfig(path)).toEqual({ foo: "bar" });
    });

    it("returns an empty object for empty or malformed config instead of inventing state", () => {
      const empty = join(tempDir, "empty.json");
      const malformed = join(tempDir, "malformed.json");
      writeFileSync(empty, "  \n");
      writeFileSync(malformed, '{"mcpServers":');

      expect(loadJSONConfig(empty)).toEqual({});
      expect(loadJSONConfig(malformed)).toEqual({});
    });
  });

  describe("saveJSONConfig", () => {
    it("writes JSON file with indentation", () => {
      const path = join(tempDir, "out.json");
      saveJSONConfig(path, { hello: "world" });
      const raw = readFileSync(path, "utf-8");
      expect(JSON.parse(raw)).toEqual({ hello: "world" });
      expect(raw).toContain("  "); // indented
    });

    it("creates parent directories", () => {
      const path = join(tempDir, "deep", "nested", "out.json");
      saveJSONConfig(path, { x: 1 });
      expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ x: 1 });
    });

    it("writes config files with owner-only permissions", () => {
      const path = join(tempDir, "secret.json");
      saveJSONConfig(path, { headers: { "X-Dosu-API-Key": "key" } });
      expect(statSync(path).mode & 0o777).toBe(0o600);
    });

    it("replaces existing loose-permission files with owner-only permissions", () => {
      const path = join(tempDir, "secret.json");
      writeFileSync(path, "old secret", { mode: 0o644 });

      writeSecureFile(path, "new secret");

      expect(readFileSync(path, "utf-8")).toBe("new secret");
      expect(statSync(path).mode & 0o777).toBe(0o600);
    });
  });

  describe("writeProjectFile", () => {
    it.each([
      "replace",
      "remove",
    ] as const)("leaves an existing target untouched when hard links are unavailable during %s", (operation) => {
      const path = join(tempDir, "project.json");
      writeFileSync(path, "original project config\n", { mode: 0o640 });
      const unavailable = () => {
        throw Object.assign(new Error("hard links are unsupported"), { code: "ENOTSUP" });
      };

      expect(() => {
        if (operation === "replace") {
          writeProjectFile(path, "Dosu edit\n", "original project config\n", {
            probeHardLink: unavailable,
          });
        } else {
          removeProjectFile(path, "original project config\n", {
            probeHardLink: unavailable,
          });
        }
      }).toThrow(/hard links.*unchanged/i);

      expect(readFileSync(path, "utf8")).toBe("original project config\n");
      expect(statSync(path).mode & 0o777).toBe(0o640);
      expect(readdirSync(tempDir).some((entry) => entry.includes(".dosu-capture-"))).toBe(false);
    });

    it.each([
      "regular file",
      "symlink",
      "directory",
    ] as const)("restores a concurrent %s swapped in after the capture journal", (replacement) => {
      const path = join(tempDir, "project.json");
      const displaced = join(tempDir, "displaced-original.json");
      const outside = join(tempDir, "outside-user-file.txt");
      writeFileSync(path, "original project config\n");
      writeFileSync(outside, "outside user data\n");

      expect(() =>
        writeProjectFile(path, "Dosu edit\n", "original project config\n", {
          beforeCaptureRename: () => {
            renameSync(path, displaced);
            if (replacement === "regular file") writeFileSync(path, "concurrent user file\n");
            else if (replacement === "symlink") symlinkSync(outside, path);
            else {
              mkdirSync(path);
              writeFileSync(join(path, "nested-user-file.txt"), "nested user data\n");
            }
          },
        }),
      ).toThrow(/changed during capture.*restored/i);

      expect(readFileSync(displaced, "utf8")).toBe("original project config\n");
      if (replacement === "regular file") {
        expect(readFileSync(path, "utf8")).toBe("concurrent user file\n");
      } else if (replacement === "symlink") {
        expect(lstatSync(path).isSymbolicLink()).toBe(true);
        expect(readlinkSync(path)).toBe(outside);
        expect(readFileSync(outside, "utf8")).toBe("outside user data\n");
      } else {
        expect(lstatSync(path).isDirectory()).toBe(true);
        expect(readFileSync(join(path, "nested-user-file.txt"), "utf8")).toBe("nested user data\n");
      }
      expect(readdirSync(tempDir).some((entry) => entry.includes(".dosu-capture-"))).toBe(false);
    });

    it("does not follow a target or predictable temporary-file symlink", () => {
      const path = join(tempDir, "project.json");
      const victim = join(tempDir, "important.txt");
      writeFileSync(victim, "USER DATA\n");
      symlinkSync("important.txt", `${path}.${process.pid}.tmp`);

      writeProjectFile(path, "project metadata\n", null);

      expect(readFileSync(victim, "utf8")).toBe("USER DATA\n");
      expect(lstatSync(path).isFile()).toBe(true);

      const linked = join(tempDir, "linked.json");
      symlinkSync("important.txt", linked);
      expect(() => writeProjectFile(linked, "replace\n")).toThrow(/non-regular/i);
      expect(readFileSync(victim, "utf8")).toBe("USER DATA\n");
    });

    it.each([
      "file",
      "symlink",
    ] as const)("refuses to create a project file through a parent %s", (kind) => {
      const parent = join(tempDir, "unsafe-parent");
      const outside = join(tempDir, "outside-directory");
      if (kind === "file") writeFileSync(parent, "user data\n");
      else {
        mkdirSync(outside);
        symlinkSync(outside, parent);
      }

      expect(() => writeProjectFile(join(parent, "config.json"), "Dosu edit\n", null)).toThrow(
        /project directory/i,
      );
      if (kind === "file") expect(readFileSync(parent, "utf8")).toBe("user data\n");
      else expect(readdirSync(outside)).toEqual([]);
    });

    it("refuses to remove a project file whose bytes differ from the caller's proof", () => {
      const path = join(tempDir, "project.json");
      writeFileSync(path, "user edit\n");

      expect(() => removeProjectFile(path, "Dosu-owned bytes\n")).toThrow(/changed/i);

      expect(readFileSync(path, "utf8")).toBe("user edit\n");
    });

    it("refuses to overwrite content that no longer matches the caller's preimage", () => {
      const path = join(tempDir, "project.json");
      writeFileSync(path, "user edit\n");

      expect(() => writeProjectFile(path, "Dosu edit\n", "stale preimage\n")).toThrow(/changed/i);
      expect(readFileSync(path, "utf8")).toBe("user edit\n");
    });

    it("preserves a concurrent replacement made before the existing file is captured", () => {
      const path = join(tempDir, "project.json");
      writeFileSync(path, "expected preimage\n");

      expect(() =>
        writeProjectFile(path, "Dosu edit\n", "expected preimage\n", {
          beforeCapture: () => writeFileSync(path, "concurrent user edit\n"),
        }),
      ).toThrow(/changed/i);

      expect(readFileSync(path, "utf8")).toBe("concurrent user edit\n");
    });

    it("never overwrites a file created while an absent destination is being published", () => {
      const path = join(tempDir, "project.json");

      expect(() =>
        writeProjectFile(path, "Dosu edit\n", null, {
          beforePublish: () => writeFileSync(path, "concurrent user file\n"),
        }),
      ).toThrow();

      expect(readFileSync(path, "utf8")).toBe("concurrent user file\n");
    });

    it("preserves both a captured preimage and a concurrent replacement", () => {
      const path = join(tempDir, "project.json");
      writeFileSync(path, "expected preimage\n");

      expect(() =>
        writeProjectFile(path, "Dosu edit\n", "expected preimage\n", {
          beforePublish: () => writeFileSync(path, "concurrent user edit\n"),
        }),
      ).toThrow();

      expect(readFileSync(path, "utf8")).toBe("concurrent user edit\n");
      const recoveryRoot = readdirSync(tempDir).find((entry) =>
        entry.startsWith("project.json.dosu-capture-"),
      );
      expect(recoveryRoot).toBeDefined();
      expect(readFileSync(join(tempDir, recoveryRoot as string, "captured"), "utf8")).toBe(
        "expected preimage\n",
      );
    });

    it("removes only the exact file captured for deletion", () => {
      const path = join(tempDir, "project.json");
      writeFileSync(path, "batch output\n");

      removeProjectFile(path, "batch output\n");

      expect(() => lstatSync(path)).toThrow();
    });

    it("never deletes a concurrent replacement during project-file removal", () => {
      const path = join(tempDir, "project.json");
      writeFileSync(path, "batch output\n");

      expect(() =>
        removeProjectFile(path, "batch output\n", {
          beforeCapture: () => writeFileSync(path, "concurrent user edit\n"),
        }),
      ).toThrow(/changed/i);

      expect(readFileSync(path, "utf8")).toBe("concurrent user edit\n");
    });

    it("durably restores a captured file on the next operation after a crash", () => {
      const path = join(tempDir, "project.json");
      writeFileSync(path, "original project config\n", { mode: 0o640 });

      expect(() =>
        writeProjectFile(path, "interrupted edit\n", "original project config\n", {
          crashAfterCapture: true,
        }),
      ).toThrow(/simulated crash/i);
      expect(() => lstatSync(path)).toThrow();
      expect(readdirSync(tempDir).filter((entry) => entry.includes(".dosu-capture-"))).toHaveLength(
        1,
      );

      // A real caller may have observed the missing path and supplied null.
      // Recovery happens first, then the stale CAS fails without changing it.
      expect(() => writeProjectFile(path, "next edit\n", null)).toThrow(/changed/i);
      expect(readFileSync(path, "utf8")).toBe("original project config\n");
      expect(statSync(path).mode & 0o777).toBe(0o640);
      expect(readdirSync(tempDir).filter((entry) => entry.includes(".dosu-capture-"))).toEqual([]);

      const receipt = writeProjectFile(path, "next edit\n", "original project config\n");
      expect(receipt.beforeContent).toBe("original project config\n");
      expect(readFileSync(path, "utf8")).toBe("next edit\n");
    });

    it("recovers a crashed removal before retrying the exact deletion", () => {
      const path = join(tempDir, "project.json");
      writeFileSync(path, "batch output\n");

      expect(() => removeProjectFile(path, "batch output\n", { crashAfterCapture: true })).toThrow(
        /simulated crash/i,
      );
      expect(() => lstatSync(path)).toThrow();

      removeProjectFile(path, "batch output\n");

      expect(() => lstatSync(path)).toThrow();
      expect(readdirSync(tempDir).filter((entry) => entry.includes(".dosu-capture-"))).toEqual([]);
    });

    it("fails closed when the target was recreated beside a pending capture", () => {
      const path = join(tempDir, "project.json");
      writeFileSync(path, "captured original\n");
      expect(() =>
        writeProjectFile(path, "interrupted\n", "captured original\n", {
          crashAfterCapture: true,
        }),
      ).toThrow(/simulated crash/i);
      writeFileSync(path, "user recreated target\n");

      expect(() => writeProjectFile(path, "new\n", "user recreated target\n")).toThrow(
        /pending recovery stage.*existing target/i,
      );
      expect(readFileSync(path, "utf8")).toBe("user recreated target\n");
      const root = readdirSync(tempDir).find((entry) => entry.includes(".dosu-capture-"));
      expect(readFileSync(join(tempDir, root as string, "captured"), "utf8")).toBe(
        "captured original\n",
      );
    });

    it("preserves every stage when more than one pending capture is present", () => {
      const path = join(tempDir, "project.json");
      writeFileSync(path, "captured original\n");
      expect(() =>
        writeProjectFile(path, "interrupted\n", "captured original\n", {
          crashAfterCapture: true,
        }),
      ).toThrow(/simulated crash/i);
      const extra = join(tempDir, "project.json.dosu-capture-extra");
      mkdirSync(extra, { mode: 0o700 });

      expect(() => writeProjectFile(path, "new\n", null)).toThrow(/ambiguous pending/i);
      expect(() => lstatSync(path)).toThrow();
      expect(lstatSync(extra).isDirectory()).toBe(true);
      expect(readdirSync(tempDir).filter((entry) => entry.includes(".dosu-capture-"))).toHaveLength(
        2,
      );
    });

    it("preserves a capture whose journal metadata was tampered with", () => {
      const path = join(tempDir, "project.json");
      writeFileSync(path, "captured original\n");
      expect(() =>
        writeProjectFile(path, "interrupted\n", "captured original\n", {
          crashAfterCapture: true,
        }),
      ).toThrow(/simulated crash/i);
      const root = readdirSync(tempDir).find((entry) => entry.includes(".dosu-capture-"));
      const journal = join(tempDir, root as string, "journal.json");
      writeFileSync(journal, "{}\n");

      expect(() => writeProjectFile(path, "new\n", null)).toThrow(/invalid.*journal/i);
      expect(() => lstatSync(path)).toThrow();
      expect(readFileSync(journal, "utf8")).toBe("{}\n");
      expect(readFileSync(join(tempDir, root as string, "captured"), "utf8")).toBe(
        "captured original\n",
      );
    });

    it.each([
      "hash",
      "inode",
    ] as const)("preserves a capture whose %s no longer matches its journal", (tamper) => {
      const path = join(tempDir, "project.json");
      writeFileSync(path, "captured original\n");
      expect(() =>
        writeProjectFile(path, "interrupted\n", "captured original\n", {
          crashAfterCapture: true,
        }),
      ).toThrow(/simulated crash/i);
      const root = readdirSync(tempDir).find((entry) => entry.includes(".dosu-capture-"));
      const captured = join(tempDir, root as string, "captured");
      if (tamper === "hash") {
        writeFileSync(captured, "tampered captured data\n");
      } else {
        // Allocate the replacement while the captured inode still exists.
        // Unlink-then-create can immediately reuse the same inode on Linux,
        // making this mismatch test nondeterministic in CI.
        const replacement = join(tempDir, "replacement-capture");
        writeFileSync(replacement, "captured original\n");
        unlinkSync(captured);
        renameSync(replacement, captured);
      }

      expect(() => writeProjectFile(path, "new\n", null)).toThrow(/does not match/i);
      expect(() => lstatSync(path)).toThrow();
      expect(readFileSync(captured, "utf8")).toBe(
        tamper === "hash" ? "tampered captured data\n" : "captured original\n",
      );
    });

    it("does not follow or remove a symlinked recovery journal", () => {
      const path = join(tempDir, "project.json");
      const outside = join(tempDir, "outside.txt");
      writeFileSync(path, "captured original\n");
      writeFileSync(outside, "outside user data\n");
      expect(() =>
        writeProjectFile(path, "interrupted\n", "captured original\n", {
          crashAfterCapture: true,
        }),
      ).toThrow(/simulated crash/i);
      const root = readdirSync(tempDir).find((entry) => entry.includes(".dosu-capture-"));
      const journal = join(tempDir, root as string, "journal.json");
      unlinkSync(journal);
      symlinkSync(outside, journal);

      expect(() => writeProjectFile(path, "new\n", null)).toThrow(/non-regular/i);
      expect(readFileSync(outside, "utf8")).toBe("outside user data\n");
      expect(lstatSync(journal).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(tempDir, root as string, "captured"), "utf8")).toBe(
        "captured original\n",
      );
    });

    it.each([
      "invalid JSON",
      "invalid metadata",
      "wrong target",
      "extra stage entry",
    ] as const)("preserves a pending capture with %s", (tamper) => {
      const path = join(tempDir, "project.json");
      writeFileSync(path, "captured original\n");
      expect(() =>
        writeProjectFile(path, "interrupted\n", "captured original\n", {
          crashAfterCapture: true,
        }),
      ).toThrow(/simulated crash/i);
      const rootName = readdirSync(tempDir).find((entry) => entry.includes(".dosu-capture-"));
      const root = join(tempDir, rootName as string);
      const journal = join(root, "journal.json");
      if (tamper === "invalid JSON") {
        writeFileSync(journal, "{");
      } else if (tamper === "extra stage entry") {
        writeFileSync(join(root, "foreign-user-file"), "keep me\n");
      } else {
        const parsed = JSON.parse(readFileSync(journal, "utf8"));
        if (tamper === "invalid metadata") parsed.captured.mode = "0644";
        else parsed.target = join(tempDir, "someone-elses-project.json");
        writeFileSync(journal, `${JSON.stringify(parsed)}\n`);
      }

      expect(() => writeProjectFile(path, "new\n", null)).toThrow();

      expect(() => lstatSync(path)).toThrow();
      expect(readFileSync(join(root, "captured"), "utf8")).toBe("captured original\n");
      if (tamper === "extra stage entry") {
        expect(readFileSync(join(root, "foreign-user-file"), "utf8")).toBe("keep me\n");
      }
    });

    it.skipIf(process.platform === "win32")(
      "preserves a pending capture whose recovery root became public",
      () => {
        const path = join(tempDir, "project.json");
        writeFileSync(path, "captured original\n");
        expect(() =>
          writeProjectFile(path, "interrupted\n", "captured original\n", {
            crashAfterCapture: true,
          }),
        ).toThrow(/simulated crash/i);
        const rootName = readdirSync(tempDir).find((entry) => entry.includes(".dosu-capture-"));
        const root = join(tempDir, rootName as string);
        chmodSync(root, 0o755);

        expect(() => writeProjectFile(path, "new\n", null)).toThrow(/unsafe.*recovery stage/i);

        expect(() => lstatSync(path)).toThrow();
        expect(readFileSync(join(root, "captured"), "utf8")).toBe("captured original\n");
      },
    );
  });

  describe("project JSON server operations", () => {
    const owned = (entry: unknown) =>
      typeof entry === "object" && entry !== null && "command" in entry;

    it.each([
      "install",
      "remove",
    ] as const)("preserves a non-object MCP section during %s", (operation) => {
      const path = join(tempDir, "project.json");
      const original = '{"mcpServers":"user-managed"}\n';
      writeFileSync(path, original);

      expect(() => {
        if (operation === "install") {
          installProjectJSONServer(path, "mcpServers", { command: "npx" }, owned);
        } else {
          removeProjectJSONServer(path, "mcpServers", owned);
        }
      }).toThrow(/not an object/i);

      expect(readFileSync(path, "utf8")).toBe(original);
    });

    it("treats malformed project JSON as unconfigured without modifying it", () => {
      const path = join(tempDir, "project.json");
      writeFileSync(path, '{"mcpServers":');

      expect(isProjectJSONServerConfigured(path, "mcpServers", owned)).toBe(false);
      expect(readFileSync(path, "utf8")).toBe('{"mcpServers":');
    });

    it("refuses to follow a project config symlink for install or removal", () => {
      const outside = join(tempDir, "outside.json");
      const path = join(tempDir, "project.json");
      writeFileSync(outside, '{"mcpServers":{}}\n');
      symlinkSync(outside, path);

      expect(() => installProjectJSONServer(path, "mcpServers", { command: "npx" }, owned)).toThrow(
        /symbolic link/i,
      );
      expect(() => removeProjectJSONServer(path, "mcpServers", owned)).toThrow(/symbolic link/i);
      expect(readFileSync(outside, "utf8")).toBe('{"mcpServers":{}}\n');
    });
  });

  describe("isJSONKeyConfigured", () => {
    it("returns false for non-existent file", () => {
      expect(isJSONKeyConfigured(join(tempDir, "nope.json"), "mcpServers")).toBe(false);
    });

    it("returns false when key section is missing", () => {
      const path = join(tempDir, "cfg.json");
      writeFileSync(path, "{}");
      expect(isJSONKeyConfigured(path, "mcpServers")).toBe(false);
    });

    it("returns false when dosu entry is missing", () => {
      const path = join(tempDir, "cfg.json");
      writeFileSync(path, '{"mcpServers": {"other": {}}}');
      expect(isJSONKeyConfigured(path, "mcpServers")).toBe(false);
    });

    it("returns true when dosu entry exists", () => {
      const path = join(tempDir, "cfg.json");
      writeFileSync(path, '{"mcpServers": {"dosu": {"url": "http://x"}}}');
      expect(isJSONKeyConfigured(path, "mcpServers")).toBe(true);
    });
  });

  describe("installJSONServer", () => {
    it("creates new file with server entry", () => {
      const path = join(tempDir, "new.json");
      installJSONServer(path, "mcpServers", { url: "http://test" });
      const result = loadJSONConfig(path);
      expect(result.mcpServers.dosu).toEqual({ url: "http://test" });
    });

    it("adds to existing config without overwriting other entries", () => {
      const path = join(tempDir, "existing.json");
      writeFileSync(path, '{"mcpServers": {"other": {"url": "http://other"}}}');
      installJSONServer(path, "mcpServers", { url: "http://dosu" });
      const result = loadJSONConfig(path);
      expect(result.mcpServers.dosu).toEqual({ url: "http://dosu" });
      expect(result.mcpServers.other).toEqual({ url: "http://other" });
    });

    it("overwrites existing dosu entry", () => {
      const path = join(tempDir, "overwrite.json");
      writeFileSync(path, '{"mcpServers": {"dosu": {"url": "old"}}}');
      installJSONServer(path, "mcpServers", { url: "new" });
      const result = loadJSONConfig(path);
      expect(result.mcpServers.dosu).toEqual({ url: "new" });
    });
  });

  describe("removeJSONServer", () => {
    it("does nothing for non-existent file", () => {
      // Should not throw
      removeJSONServer(join(tempDir, "nope.json"), "mcpServers");
    });

    it("removes dosu entry from config", () => {
      const path = join(tempDir, "remove.json");
      writeFileSync(path, '{"mcpServers": {"dosu": {"url": "x"}, "other": {"url": "y"}}}');
      removeJSONServer(path, "mcpServers");
      const result = loadJSONConfig(path);
      expect(result.mcpServers.dosu).toBeUndefined();
      expect(result.mcpServers.other).toEqual({ url: "y" });
    });
  });
});
