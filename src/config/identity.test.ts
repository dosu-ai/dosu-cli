import { describe, expect, it } from "vitest";

import { getAccessTokenUserID } from "./identity";

function accessTokenFor(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

describe("access token identity", () => {
  it("reads only a string user claim", () => {
    const token = accessTokenFor({
      sub: "22222222-2222-4222-8222-222222222222",
      email: "user@example.com",
      user_metadata: { name: "Private Name" },
    });

    expect(getAccessTokenUserID(token)).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("returns undefined for absent, non-string, or malformed claims", () => {
    expect(getAccessTokenUserID(accessTokenFor({ sub: { value: "x" } }))).toBeUndefined();
    expect(getAccessTokenUserID(accessTokenFor({}))).toBeUndefined();
    expect(getAccessTokenUserID("not-a-jwt")).toBeUndefined();
  });
});
