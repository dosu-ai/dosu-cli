import { describe, expect, it } from "vitest";

import { getAccessTokenEmail, getAccessTokenUserID } from "./identity";

function accessTokenFor(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

describe("access token identity", () => {
  it("reads only string user and email claims", () => {
    const token = accessTokenFor({
      sub: "22222222-2222-4222-8222-222222222222",
      email: "user@example.com",
      user_metadata: { name: "Private Name" },
    });

    expect(getAccessTokenUserID(token)).toBe("22222222-2222-4222-8222-222222222222");
    expect(getAccessTokenEmail(token)).toBe("user@example.com");
  });

  it("returns undefined for absent, non-string, or malformed claims", () => {
    expect(getAccessTokenEmail(accessTokenFor({ email: { value: "user@example.com" } }))).toBe(
      undefined,
    );
    expect(getAccessTokenEmail(accessTokenFor({}))).toBeUndefined();
    expect(getAccessTokenEmail("not-a-jwt")).toBeUndefined();
  });
});
