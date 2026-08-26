import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestConfig } from "../config/config.test-utils";

vi.mock("../config/constants", () => ({
  getSupabaseAnonKey: () => "anon-key",
  getSupabaseURL: () => "https://supabase.test",
}));

import { listSpaceDataSourceIds } from "./supabase";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listSpaceDataSourceIds", () => {
  it("reads the exact space attachment set through Supabase RLS", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([{ data_source_id: "ds-1" }, { data_source_id: "ds-2" }]), {
        status: 200,
      }),
    );
    const config = makeTestConfig({
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_at: 0,
    });

    await expect(listSpaceDataSourceIds(config, "space-1")).resolves.toEqual(["ds-1", "ds-2"]);

    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://supabase.test/rest/v1/space_data_source?select=data_source_id&space_id=eq.space-1",
    );
    expect(options.headers).toEqual({
      apikey: "anon-key",
      Authorization: "Bearer access-token",
    });
  });

  it("rejects an invalid response shape", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([{ id: "wrong" }]), { status: 200 }),
    );

    await expect(
      listSpaceDataSourceIds(
        makeTestConfig({ access_token: "token", refresh_token: "refresh", expires_at: 0 }),
        "space-1",
      ),
    ).rejects.toThrow("invalid space_data_source response");
  });
});
