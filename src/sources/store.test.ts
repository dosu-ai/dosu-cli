/** Joining the org's session store: what each kind asks, that nothing is saved before Dosu
 * enrolls the member, and what a taken folder or a mismatched server does. */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerError, StoreError } from "@dosu/sessiondb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliUsageError } from "../cli/errors";
import { loadConfig, saveConfig } from "../config/config";
import { makeTestConfig } from "../config/config.test-utils";
import type { BucketTarget } from "../config/schema";
import * as p from "../tui/prompts";
import { type Enrollment, type SessionStore, SourcesApiError, type StoreApi } from "./api";
import { runBucketWizard } from "./bucket-wizard";
import { checkWithServer } from "./hosted";
import { serverClient } from "./server-client";
import { describeStore, joinOrgStore, orgStore, storeTokenSource } from "./store";

vi.mock("../tui/prompts", () => ({
  text: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
  isCancel: (value: unknown) => value === CANCEL,
  log: { success: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn(), message: vi.fn() },
}));
vi.mock("./bucket-wizard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bucket-wizard")>()),
  defaultOwner: () => "james",
  runBucketWizard: vi.fn(),
}));
vi.mock("./hosted", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./hosted")>()),
  checkWithServer: vi.fn(),
}));
vi.mock("./server-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./server-client")>()),
  serverClient: vi.fn(),
}));

const CANCEL = Symbol("cancel");

const BASE: SessionStore = {
  kind: "bucket",
  configured: true,
  server_url: null,
  url: "s3://acme-sessions/agents",
  bucket_kind: "s3",
  bucket: "acme-sessions",
  prefix: "agents",
  region: "us-east-1",
  account_id: null,
  endpoint: null,
  issues_tokens: false,
  updated_at: null,
  owner: null,
  source_id: null,
  members: null,
};

const SERVER: SessionStore = {
  ...BASE,
  kind: "server",
  server_url: "https://sessions.acme.test",
};

const HOSTED: SessionStore = {
  ...BASE,
  kind: "hosted",
  server_url: "https://sessiondb.dosu.test",
  issues_tokens: true,
};

function enrollment(owner: string, extra: Partial<Enrollment> = {}): Enrollment {
  return {
    kind: "bucket",
    owner,
    server_url: null,
    token: null,
    expires_at: null,
    url: BASE.url,
    bucket_kind: "s3",
    bucket: "acme-sessions",
    prefix: "agents",
    region: "us-east-1",
    account_id: null,
    endpoint: null,
    source: { id: "src-1" } as Enrollment["source"],
    ...extra,
  };
}

const MINTED = enrollment("o-org1.u-42", {
  kind: "hosted",
  server_url: "https://sessiondb.dosu.test/",
  token: "minted",
  expires_at: "2027-02-01T00:00:00Z",
});

function storeApi(enroll: StoreApi["enroll"], get?: StoreApi["get"]): StoreApi {
  return {
    deploymentId: "dep1",
    backendUrl: "https://api.dosu.test",
    get: vi.fn(get ?? (async () => BASE)),
    set: vi.fn(),
    enroll: vi.fn(enroll),
  };
}

function me(owner: string, url = "s3://acme-sessions/agents"): void {
  vi.mocked(serverClient).mockReturnValue({
    me: async () => ({ owner, storage: { url } }),
  } as unknown as ReturnType<typeof serverClient>);
}

let home: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "dosu-store-")));
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
  saveConfig(makeTestConfig({ access_token: "t", refresh_token: "r", expires_at: 0 }));
  vi.mocked(checkWithServer).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  rmSync(home, { recursive: true, force: true });
});

describe("describeStore", () => {
  it("names each kind", () => {
    expect(describeStore(HOSTED)).toBe("Dosu's sessiondb");
    expect(describeStore(SERVER)).toBe("the org's sessiondb server https://sessions.acme.test");
    expect(describeStore(BASE)).toBe("the org's bucket s3://acme-sessions/agents");
  });
});

describe("orgStore", () => {
  it("is the store only when an admin set one", async () => {
    expect(await orgStore(undefined)).toBeUndefined();
    expect(await orgStore(storeApi(vi.fn(), async () => BASE))).toBe(BASE);
    const fallback = { ...HOSTED, configured: false };
    expect(await orgStore(storeApi(vi.fn(), async () => fallback))).toBeUndefined();
  });

  it("is none when Dosu cannot be asked", async () => {
    const down = storeApi(vi.fn(), async () => {
      throw new SourcesApiError(404, "Not Found");
    });
    expect(await orgStore(down)).toBeUndefined();
    const odd = storeApi(vi.fn(), () => Promise.reject("boom"));
    expect(await orgStore(odd)).toBeUndefined();
  });
});

describe("storeTokenSource", () => {
  it("renews by enrolling again", async () => {
    const api = storeApi(async () => MINTED);
    expect(await storeTokenSource(api).hosted()).toEqual({
      server_url: "https://sessiondb.dosu.test/",
      token: "minted",
      owner: "o-org1.u-42",
      expires_at: "2027-02-01T00:00:00Z",
      source: MINTED.source,
    });
  });

  it("fails when the store stopped issuing tokens", async () => {
    const api = storeApi(async () => enrollment("james"));
    await expect(storeTokenSource(api).hosted()).rejects.toThrow("no longer issues tokens");
  });
});

describe("joinOrgStore: a store that issues tokens", () => {
  it("enrolls, checks the minted token and saves an org target as the default", async () => {
    const api = storeApi(async () => MINTED);
    const joined = await joinOrgStore(loadConfig(), api, HOSTED);

    expect(api.enroll).toHaveBeenCalledWith();
    expect(checkWithServer).toHaveBeenCalledOnce();
    expect(joined?.target).toMatchObject({
      name: "org",
      url: "https://sessiondb.dosu.test",
      owner: "o-org1.u-42",
      token: "minted",
      hosted: true,
      store: true,
      source_id: "src-1",
    });
    const cfg = loadConfig();
    expect(cfg.targets).toEqual([joined?.target]);
    expect(cfg.default_target).toBe("org");
  });

  it("saves nothing when the server refuses the token", async () => {
    vi.mocked(checkWithServer).mockRejectedValueOnce(new CliUsageError("refused"));
    const api = storeApi(async () => MINTED);
    await expect(joinOrgStore(loadConfig(), api, HOSTED, { name: "x" })).rejects.toThrow("refused");
    expect(loadConfig().targets ?? []).toEqual([]);
  });

  it("says why Dosu did not enroll", async () => {
    const refused = storeApi(async () => {
      throw new SourcesApiError(503, "no hosted sessiondb");
    });
    await expect(joinOrgStore(loadConfig(), refused, HOSTED)).rejects.toThrow(
      "Dosu did not enroll you in the org's session store: no hosted sessiondb",
    );
    const down = storeApi(() => Promise.reject(new Error("ECONNREFUSED")));
    await expect(joinOrgStore(loadConfig(), down, HOSTED)).rejects.toThrow(
      "Could not reach Dosu to enroll you: ECONNREFUSED",
    );
    const odd = storeApi(() => Promise.reject("boom"));
    await expect(joinOrgStore(loadConfig(), odd, HOSTED)).rejects.toThrow("boom");
  });
});

describe("joinOrgStore: a server with admin-issued tokens", () => {
  it("enrolls under the token's owner before saving", async () => {
    me("alice");
    const api = storeApi(async (owner) => enrollment(owner ?? "?"));
    const joined = await joinOrgStore(loadConfig(), api, SERVER, {
      token: " sdb_alice ",
      makeDefault: false,
    });

    expect(serverClient).toHaveBeenCalledWith(
      { url: "https://sessions.acme.test", token: "sdb_alice" },
      fetch,
    );
    expect(api.enroll).toHaveBeenCalledWith("alice");
    expect(joined?.target).toEqual({
      name: "org",
      url: "https://sessions.acme.test",
      owner: "alice",
      token: "sdb_alice",
      source_id: "src-1",
      store: true,
    });
    expect(loadConfig().default_target).toBeUndefined();
  });

  it("asks for the token when none was given", async () => {
    me("alice");
    vi.mocked(p.text).mockResolvedValueOnce("sdb_typed");
    const api = storeApi(async (owner) => enrollment(owner ?? "?"));
    const joined = await joinOrgStore(loadConfig(), api, SERVER);
    expect(joined?.target).toMatchObject({ token: "sdb_typed", owner: "alice" });
  });

  it("refuses a token another member already ships as, saving nothing", async () => {
    me("bob");
    const api = storeApi(async () => {
      throw new SourcesApiError(409, "taken");
    });
    await expect(joinOrgStore(loadConfig(), api, SERVER, { token: "t" })).rejects.toThrow(
      "the token is for bob, which another member of the org already ships as",
    );
    expect(loadConfig().targets ?? []).toEqual([]);

    const other = storeApi(async () => {
      throw new SourcesApiError(500, "oops");
    });
    await expect(joinOrgStore(loadConfig(), other, SERVER, { token: "t" })).rejects.toThrow(
      "Dosu did not enroll you",
    );
  });

  it("refuses a server that writes another bucket", async () => {
    me("alice", "s3://elsewhere/agents");
    const api = storeApi(vi.fn());
    await expect(joinOrgStore(loadConfig(), api, SERVER, { token: "t" })).rejects.toThrow(
      "writes s3://elsewhere/agents, not the org's s3://acme-sessions/agents",
    );
    me("alice", "s3://acme-sessions/other");
    await expect(joinOrgStore(loadConfig(), api, SERVER, { token: "t" })).rejects.toThrow(
      "not the org's",
    );
    me("alice", "file:///srv/sessions");
    await expect(joinOrgStore(loadConfig(), api, SERVER, { token: "t" })).rejects.toThrow(
      "not the org's",
    );
    expect(api.enroll).not.toHaveBeenCalled();
  });

  it("explains a token the server refuses or a server it cannot reach", async () => {
    const failing = (err: unknown) =>
      vi.mocked(serverClient).mockReturnValue({
        me: () => Promise.reject(err),
      } as unknown as ReturnType<typeof serverClient>);
    const api = storeApi(vi.fn());

    failing(new ServerError(401, "unauthorized", "bad token"));
    await expect(joinOrgStore(loadConfig(), api, SERVER, { token: "t" })).rejects.toThrow(
      "https://sessions.acme.test did not accept that token",
    );
    failing(new StoreError("cannot reach https://sessions.acme.test", new Error("ECONNREFUSED")));
    await expect(joinOrgStore(loadConfig(), api, SERVER, { token: "t" })).rejects.toThrow(
      /^cannot reach/,
    );
    failing(new ServerError(500, "unknown", "HTTP 500"));
    await expect(joinOrgStore(loadConfig(), api, SERVER, { token: "t" })).rejects.toThrow(
      "https://sessions.acme.test answered HTTP 500",
    );
  });

  it("refuses a store whose server URL is unusable", async () => {
    const api = storeApi(vi.fn());
    const broken = { ...SERVER, server_url: "ftp://nope" };
    await expect(joinOrgStore(loadConfig(), api, broken, { token: "t" })).rejects.toThrow(
      "the org's server URL is not usable: ftp://nope",
    );
    const missing = { ...SERVER, server_url: null };
    await expect(joinOrgStore(loadConfig(), api, missing, { token: "t" })).rejects.toThrow(
      "not usable",
    );
  });

  it("is cancelled when the token question is", async () => {
    vi.mocked(p.text).mockResolvedValueOnce(CANCEL as unknown as string);
    expect(await joinOrgStore(loadConfig(), storeApi(vi.fn()), SERVER)).toBeNull();
  });
});

describe("joinOrgStore: a bucket members write", () => {
  const written: BucketTarget = {
    kind: "bucket",
    name: "org",
    url: "s3://acme-sessions/agents",
    region: "us-east-1",
    owner: "james",
    access_key_id: "AKIDWRITE",
    secret_access_key: "writesecret",
  };

  it("claims the folder, then runs the bucket wizard with the store's bucket and no connect", async () => {
    vi.mocked(runBucketWizard).mockResolvedValueOnce({ target: written } as never);
    const api = storeApi(async (owner) => enrollment(owner ?? "?"));
    const write = { access_key_id: "AKIDWRITE", secret_access_key: "writesecret" };
    const joined = await joinOrgStore(loadConfig(), api, BASE, {
      owner: "james",
      write,
      yes: true,
      makeDefault: false,
    });

    expect(api.enroll).toHaveBeenCalledWith("james");
    expect(vi.mocked(runBucketWizard).mock.calls[0]?.[1]).toEqual({
      bucket: "s3://acme-sessions/agents",
      region: "us-east-1",
      endpoint: "",
      owner: "james",
      write,
      name: "org",
      connect: false,
      makeDefault: false,
      yes: true,
    });
    expect(joined?.target).toEqual({ ...written, source_id: "src-1" });
    expect(loadConfig().targets).toEqual([{ ...written, source_id: "src-1" }]);
  });

  it("passes an r2 store's account and endpoint", async () => {
    vi.mocked(runBucketWizard).mockResolvedValueOnce({ target: written } as never);
    const r2: SessionStore = {
      ...BASE,
      url: "r2://acme-sessions/agents",
      bucket_kind: "r2",
      region: null,
      account_id: "acct",
      endpoint: "https://acct.r2.cloudflarestorage.com",
    };
    await joinOrgStore(
      loadConfig(),
      storeApi(async () => enrollment("james")),
      r2,
      {
        owner: "james",
        name: "mine",
      },
    );
    expect(vi.mocked(runBucketWizard).mock.calls[0]?.[1]).toMatchObject({
      bucket: "r2://acme-sessions/agents",
      accountId: "acct",
      endpoint: "https://acct.r2.cloudflarestorage.com",
      name: "mine",
    });
  });

  it("offers the member's current folder first, and asks again when one is taken", async () => {
    vi.mocked(runBucketWizard).mockResolvedValueOnce({ target: written } as never);
    vi.mocked(p.text).mockResolvedValueOnce("bob").mockResolvedValueOnce("james2");
    const api = storeApi(async (owner) => {
      if (owner === "bob") throw new SourcesApiError(409, "taken");
      return enrollment(owner ?? "?");
    });
    await joinOrgStore(loadConfig(), api, { ...BASE, owner: "jim" });

    const asks = vi.mocked(p.text).mock.calls.map(([opts]) => opts);
    expect(asks[0]).toMatchObject({ initialValue: "jim" });
    expect(asks[0]?.validate?.("bad/name")).toContain("one path segment");
    expect(asks[0]?.validate?.("ok")).toBeUndefined();
    expect(vi.mocked(p.log.warn).mock.calls.join(" ")).toContain("bob is another member's folder");
    expect(api.enroll).toHaveBeenLastCalledWith("james2");
  });

  it("under --yes, a taken folder fails rather than asking", async () => {
    const api = storeApi(async () => {
      throw new SourcesApiError(409, "taken");
    });
    await expect(
      joinOrgStore(loadConfig(), api, BASE, { owner: "bob", yes: true }),
    ).rejects.toThrow("Dosu did not enroll you in the org's session store: taken");
    expect(p.text).not.toHaveBeenCalled();
  });

  it("defaults the folder to the user name under --yes, and refuses a bad given one", async () => {
    vi.mocked(runBucketWizard).mockResolvedValueOnce({ target: written } as never);
    const api = storeApi(async (owner) => enrollment(owner ?? "?"));
    await joinOrgStore(loadConfig(), api, BASE, { yes: true });
    expect(api.enroll).toHaveBeenCalledWith("james");

    await expect(joinOrgStore(loadConfig(), api, BASE, { owner: "a/b" })).rejects.toThrow(
      "not an owner name: a/b",
    );
  });

  it("is cancelled when the wizard is, and refuses a store without a bucket", async () => {
    vi.mocked(runBucketWizard).mockResolvedValueOnce(null);
    const api = storeApi(async () => enrollment("james"));
    expect(await joinOrgStore(loadConfig(), api, BASE, { owner: "james" })).toBeNull();
    expect(loadConfig().targets ?? []).toEqual([]);

    await expect(
      joinOrgStore(loadConfig(), api, { ...BASE, url: null }, { owner: "james" }),
    ).rejects.toThrow("names no bucket");
  });
});
