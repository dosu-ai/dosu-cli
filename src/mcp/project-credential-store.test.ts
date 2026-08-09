import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearProjectMcpCredentials,
  getProjectMcpCredentialStorePath,
  readProjectMcpCredential,
  saveProjectMcpCredential,
} from "./project-credential-store";

let directory: string;
let path: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "dosu-project-credentials-"));
  path = join(directory, "credentials.json");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("project MCP credential store", () => {
  it("derives the default store outside project configuration", () => {
    expect(getProjectMcpCredentialStorePath()).toMatch(/project-mcp-credentials\.v1$/);
  });

  it.each([
    { userID: "", targetKey: "deployment:dep-a" },
    { userID: "user-a", targetKey: "" },
  ])("rejects an incomplete credential identity before writing", ({ userID, targetKey }) => {
    expect(() =>
      saveProjectMcpCredential({
        userID,
        targetKey,
        credential: { endpoint: "https://api.test/v1/mcp", api_key: "key-a" },
        path,
      }),
    ).toThrow(/identity is required/i);
    expect(() => lstatSync(path)).toThrow();
  });

  it("retains credentials for multiple deployments without exposing them to a project", () => {
    saveProjectMcpCredential({
      userID: "user-a",
      targetKey: "deployment:dep-a",
      credential: { endpoint: "https://api.test/v1/mcp/deployments/dep-a", api_key: "key-a" },
      path,
    });
    saveProjectMcpCredential({
      userID: "user-a",
      targetKey: "deployment:dep-b",
      credential: { endpoint: "https://api.test/v1/mcp/deployments/dep-b", api_key: "key-b" },
      path,
    });

    expect(
      readProjectMcpCredential({ userID: "user-a", targetKey: "deployment:dep-a", path }),
    ).toEqual({ endpoint: "https://api.test/v1/mcp/deployments/dep-a", api_key: "key-a" });
    expect(
      readProjectMcpCredential({ userID: "user-a", targetKey: "deployment:dep-b", path }),
    ).toEqual({ endpoint: "https://api.test/v1/mcp/deployments/dep-b", api_key: "key-b" });
    const records = readdirSync(path);
    expect(records).toHaveLength(2);
    expect(records.every((record) => (lstatSync(join(path, record)).mode & 0o777) === 0o600)).toBe(
      true,
    );
  });

  it("isolates credentials by authenticated account", () => {
    saveProjectMcpCredential({
      userID: "user-a",
      targetKey: "deployment:dep-a",
      credential: { endpoint: "https://api.test/v1/mcp/deployments/dep-a", api_key: "key-a" },
      path,
    });
    expect(
      readProjectMcpCredential({ userID: "user-b", targetKey: "deployment:dep-a", path }),
    ).toBeUndefined();

    saveProjectMcpCredential({
      userID: "user-b",
      targetKey: "deployment:dep-b",
      credential: { endpoint: "https://api.test/v1/mcp/deployments/dep-b", api_key: "key-b" },
      path,
    });
    expect(
      readProjectMcpCredential({ userID: "user-a", targetKey: "deployment:dep-a", path }),
    ).toEqual({ endpoint: "https://api.test/v1/mcp/deployments/dep-a", api_key: "key-a" });
  });

  it.each([
    ["array record", []],
    [
      "extra record field",
      {
        schema_version: 1,
        user_id: "user-a",
        target_key: "deployment:dep-a",
        credential: { endpoint: "https://api.test/v1/mcp", api_key: "key-a" },
        foreign: true,
      },
    ],
    [
      "wrong schema",
      {
        schema_version: 2,
        user_id: "user-a",
        target_key: "deployment:dep-a",
        credential: { endpoint: "https://api.test/v1/mcp", api_key: "key-a" },
      },
    ],
    [
      "empty user",
      {
        schema_version: 1,
        user_id: "",
        target_key: "deployment:dep-a",
        credential: { endpoint: "https://api.test/v1/mcp", api_key: "key-a" },
      },
    ],
    [
      "empty target",
      {
        schema_version: 1,
        user_id: "user-a",
        target_key: "",
        credential: { endpoint: "https://api.test/v1/mcp", api_key: "key-a" },
      },
    ],
    [
      "non-object credential",
      {
        schema_version: 1,
        user_id: "user-a",
        target_key: "deployment:dep-a",
        credential: [],
      },
    ],
    [
      "extra credential field",
      {
        schema_version: 1,
        user_id: "user-a",
        target_key: "deployment:dep-a",
        credential: {
          endpoint: "https://api.test/v1/mcp",
          api_key: "key-a",
          foreign: true,
        },
      },
    ],
    [
      "empty endpoint",
      {
        schema_version: 1,
        user_id: "user-a",
        target_key: "deployment:dep-a",
        credential: { endpoint: "", api_key: "key-a" },
      },
    ],
    [
      "empty API key",
      {
        schema_version: 1,
        user_id: "user-a",
        target_key: "deployment:dep-a",
        credential: { endpoint: "https://api.test/v1/mcp", api_key: "" },
      },
    ],
  ])("rejects a syntactically valid but unsafe %s", (_name, unsafeRecord) => {
    saveProjectMcpCredential({
      userID: "user-a",
      targetKey: "deployment:dep-a",
      credential: { endpoint: "https://api.test/v1/mcp", api_key: "key-a" },
      path,
    });
    const [recordName] = readdirSync(path);
    const record = join(path, recordName);
    writeFileSync(record, `${JSON.stringify(unsafeRecord)}\n`);

    expect(() =>
      readProjectMcpCredential({ userID: "user-a", targetKey: "deployment:dep-a", path }),
    ).toThrow(/invalid project MCP credential record/i);
    expect(readFileSync(record, "utf8")).toBe(`${JSON.stringify(unsafeRecord)}\n`);
  });

  it("detects a valid record moved under another identity's hashed filename", () => {
    saveProjectMcpCredential({
      userID: "user-a",
      targetKey: "deployment:dep-a",
      credential: { endpoint: "https://api.test/v1/mcp", api_key: "key-a" },
      path,
    });
    const [recordName] = readdirSync(path);
    const record = join(path, recordName);
    const parsed = JSON.parse(readFileSync(record, "utf8"));
    parsed.user_id = "user-b";
    writeFileSync(record, `${JSON.stringify(parsed)}\n`);

    expect(() =>
      readProjectMcpCredential({ userID: "user-a", targetKey: "deployment:dep-a", path }),
    ).toThrow(/identity mismatch/i);
    expect(() =>
      saveProjectMcpCredential({
        userID: "user-a",
        targetKey: "deployment:dep-a",
        credential: { endpoint: "https://api.test/v1/mcp", api_key: "replacement" },
        path,
      }),
    ).toThrow(/identity mismatch/i);
    expect(JSON.parse(readFileSync(record, "utf8")).user_id).toBe("user-b");
  });

  it("fails closed for a malformed file or symlink", () => {
    writeFileSync(path, "not json");
    expect(() =>
      readProjectMcpCredential({ userID: "user-a", targetKey: "deployment:dep-a", path }),
    ).toThrow(/invalid project MCP credential store/i);

    rmSync(path);
    const outside = join(directory, "outside.json");
    writeFileSync(outside, "{}");
    symlinkSync(outside, path);
    expect(() =>
      saveProjectMcpCredential({
        userID: "user-a",
        targetKey: "deployment:dep-a",
        credential: { endpoint: "https://api.test/v1/mcp/deployments/dep-a", api_key: "key-a" },
        path,
      }),
    ).toThrow(/invalid project MCP credential store/i);
    expect(readFileSync(outside, "utf8")).toBe("{}");
  });

  it("removes only strictly validated credential records on logout", () => {
    saveProjectMcpCredential({
      userID: "user-a",
      targetKey: "deployment:dep-a",
      credential: { endpoint: "https://api.test/v1/mcp/deployments/dep-a", api_key: "key-a" },
      path,
    });
    clearProjectMcpCredentials(path);
    expect(() => lstatSync(path)).toThrow();
  });

  it("removes a strictly proven 0600 crash temporary on logout", () => {
    saveProjectMcpCredential({
      userID: "user-a",
      targetKey: "deployment:dep-a",
      credential: { endpoint: "https://api.test/v1/mcp/deployments/dep-a", api_key: "key-a" },
      path,
    });
    const [recordName] = readdirSync(path);
    const record = join(path, recordName);
    const crashTemporary = `${record}.4321.abcdef012345.tmp`;
    writeFileSync(crashTemporary, readFileSync(record), { mode: 0o600 });

    clearProjectMcpCredentials(path);

    expect(() => lstatSync(path)).toThrow();
  });

  it("accepts libuv's 0666 Windows mode for an otherwise proven crash temporary", () => {
    saveProjectMcpCredential({
      userID: "user-a",
      targetKey: "deployment:dep-a",
      credential: { endpoint: "https://api.test/v1/mcp/deployments/dep-a", api_key: "key-a" },
      path,
    });
    const [recordName] = readdirSync(path);
    const record = join(path, recordName);
    const crashTemporary = `${record}.4321.abcdef012345.tmp`;
    writeFileSync(crashTemporary, readFileSync(record), { mode: 0o600 });
    chmodSync(crashTemporary, 0o666);

    clearProjectMcpCredentials(path, { platform: "win32" });

    expect(() => lstatSync(path)).toThrow();
  });

  it("keeps POSIX mode and owner checks strict for crash temporaries", () => {
    saveProjectMcpCredential({
      userID: "user-a",
      targetKey: "deployment:dep-a",
      credential: { endpoint: "https://api.test/v1/mcp/deployments/dep-a", api_key: "key-a" },
      path,
    });
    const [recordName] = readdirSync(path);
    const record = join(path, recordName);
    const crashTemporary = `${record}.4321.abcdef012345.tmp`;
    writeFileSync(crashTemporary, readFileSync(record), { mode: 0o600 });
    chmodSync(crashTemporary, 0o666);

    expect(() => clearProjectMcpCredentials(path, { platform: "darwin" })).toThrow(
      /invalid project MCP credential temporary/i,
    );
    expect(readFileSync(record, "utf8")).toContain('"api_key": "key-a"');
    expect(readFileSync(crashTemporary, "utf8")).toContain('"api_key": "key-a"');

    chmodSync(crashTemporary, 0o600);
    const currentUID = lstatSync(crashTemporary).uid;
    expect(() =>
      clearProjectMcpCredentials(path, {
        platform: "linux",
        getuid: () => currentUID + 1,
      }),
    ).toThrow(/invalid project MCP credential temporary/i);
    expect(readFileSync(record, "utf8")).toContain('"api_key": "key-a"');
    expect(readFileSync(crashTemporary, "utf8")).toContain('"api_key": "key-a"');
  });

  it.each([
    "malformed",
    "foreign",
    "symlink",
  ] as const)("preserves the entire store for a %s crash temporary", (scenario) => {
    saveProjectMcpCredential({
      userID: "user-a",
      targetKey: "deployment:dep-a",
      credential: {
        endpoint: "https://api.test/v1/mcp/deployments/dep-a",
        api_key: "key-a",
      },
      path,
    });
    const [recordName] = readdirSync(path);
    const record = join(path, recordName);
    const temporaryBase = scenario === "foreign" ? `${"0".repeat(64)}.json` : recordName;
    const temporary = join(path, `${temporaryBase}.4321.abcdef012345.tmp`);
    if (scenario === "symlink") {
      const outside = join(directory, "outside-tmp");
      writeFileSync(outside, "keep me");
      symlinkSync(outside, temporary);
    } else {
      writeFileSync(temporary, scenario === "malformed" ? "not json" : readFileSync(record), {
        mode: 0o600,
      });
    }
    const before = readdirSync(path).sort();

    expect(() => clearProjectMcpCredentials(path)).toThrow();
    expect(() => clearProjectMcpCredentials(path, { platform: "win32" })).toThrow();

    expect(readdirSync(path).sort()).toEqual(before);
    expect(readFileSync(record, "utf8")).toContain('"api_key": "key-a"');
    expect(lstatSync(temporary).isSymbolicLink()).toBe(scenario === "symlink");
  });

  it("preserves the entire store for a crash temporary with public permissions", () => {
    saveProjectMcpCredential({
      userID: "user-a",
      targetKey: "deployment:dep-a",
      credential: { endpoint: "https://api.test/v1/mcp", api_key: "key-a" },
      path,
    });
    const [recordName] = readdirSync(path);
    const record = join(path, recordName);
    const temporary = `${record}.4321.abcdef012345.tmp`;
    writeFileSync(temporary, readFileSync(record), { mode: 0o600 });
    chmodSync(temporary, 0o644);
    const before = readdirSync(path).sort();

    expect(() => clearProjectMcpCredentials(path, { platform: "darwin" })).toThrow(
      /invalid.*temporary/i,
    );

    expect(readdirSync(path).sort()).toEqual(before);
    expect(readFileSync(record, "utf8")).toContain('"api_key": "key-a"');
  });

  it("preserves every record when a valid record has the wrong hashed filename", () => {
    saveProjectMcpCredential({
      userID: "user-a",
      targetKey: "deployment:dep-a",
      credential: { endpoint: "https://api.test/v1/mcp", api_key: "key-a" },
      path,
    });
    const [recordName] = readdirSync(path);
    const original = join(path, recordName);
    const misplaced = join(path, `${"0".repeat(64)}.json`);
    writeFileSync(misplaced, readFileSync(original), { mode: 0o600 });
    const before = readdirSync(path).sort();

    expect(() => clearProjectMcpCredentials(path)).toThrow(
      /invalid project MCP credential record/i,
    );

    expect(readdirSync(path).sort()).toEqual(before);
    expect(readFileSync(original, "utf8")).toContain('"api_key": "key-a"');
  });

  it("preserves every record when the store contains a nested directory", () => {
    saveProjectMcpCredential({
      userID: "user-a",
      targetKey: "deployment:dep-a",
      credential: { endpoint: "https://api.test/v1/mcp", api_key: "key-a" },
      path,
    });
    const nested = join(path, "foreign-directory");
    mkdirSync(nested);
    writeFileSync(join(nested, "important.txt"), "user data");
    const recordsBefore = readdirSync(path).sort();

    expect(() => clearProjectMcpCredentials(path)).toThrow(/unrecognized file/i);

    expect(readdirSync(path).sort()).toEqual(recordsBefore);
    expect(readFileSync(join(nested, "important.txt"), "utf8")).toBe("user data");
  });

  it("does not leave a temporary after a successful save", () => {
    saveProjectMcpCredential({
      userID: "user-a",
      targetKey: "deployment:dep-a",
      credential: { endpoint: "https://api.test/v1/mcp/deployments/dep-a", api_key: "key-a" },
      path,
    });

    expect(readdirSync(path)).toEqual([expect.stringMatching(/^[a-f0-9]{64}\.json$/)]);
  });

  it("cleans its temporary when publishing a save fails", () => {
    saveProjectMcpCredential({
      userID: "user-a",
      targetKey: "deployment:dep-a",
      credential: { endpoint: "https://api.test/v1/mcp/deployments/dep-a", api_key: "key-a" },
      path,
    });
    const [recordName] = readdirSync(path);
    rmSync(join(path, recordName));
    mkdirSync(join(path, recordName));

    expect(() =>
      saveProjectMcpCredential({
        userID: "user-a",
        targetKey: "deployment:dep-a",
        credential: {
          endpoint: "https://api.test/v1/mcp/deployments/dep-a",
          api_key: "key-b",
        },
        path,
      }),
    ).toThrow();

    expect(readdirSync(path)).toEqual([recordName]);
  });

  it("closes and removes its temporary when record serialization fails", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() =>
      saveProjectMcpCredential({
        userID: "user-a",
        targetKey: "deployment:dep-a",
        credential: circular as unknown as { endpoint: string; api_key: string },
        path,
      }),
    ).toThrow(/circular/i);

    expect(readdirSync(path)).toEqual([]);
  });

  it("preserves a foreign file instead of recursively deleting the store", () => {
    mkdirSync(path);
    const foreign = join(path, "important.txt");
    writeFileSync(foreign, "keep me");

    expect(() => clearProjectMcpCredentials(path)).toThrow(/unrecognized file/i);

    expect(readFileSync(foreign, "utf8")).toBe("keep me");
  });

  it("preserves a dangling credential-store symlink on logout", () => {
    symlinkSync(join(directory, "missing-store"), path);

    expect(() => clearProjectMcpCredentials(path)).toThrow(/invalid project MCP credential store/i);

    expect(lstatSync(path).isSymbolicLink()).toBe(true);
  });
});
