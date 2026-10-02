import type { NormalizedRecord } from "@letta-ai/trajectory";
import { describe, expect, it } from "vitest";
import { planShipment, prefixSha256 } from "./continuation";

const meta = { role: "meta", source: "claude-code" } as NormalizedRecord;
const user = (content: string) => ({ role: "user", content, timestamp: "t" }) as NormalizedRecord;

describe("prefixSha256", () => {
  it("hashes content, not key order or absent fields", () => {
    const a = [{ role: "user", content: "x", timestamp: "t" }] as NormalizedRecord[];
    const b = [{ timestamp: "t", content: "x", role: "user", ok: undefined }] as never;

    expect(prefixSha256(a, 1)).toBe(prefixSha256(b, 1));
    expect(prefixSha256(a, 1)).not.toBe(prefixSha256([user("y")], 1));
  });

  it("covers only the first `count` records", () => {
    expect(prefixSha256([meta, user("a"), user("b")], 2)).toBe(prefixSha256([meta, user("a")], 2));
  });
});

describe("planShipment", () => {
  it("never continues from an empty or longer-than-now prefix", () => {
    const records = [meta, user("a")];
    for (const shipped of [
      { records: 0, prefix_sha256: prefixSha256(records, 0) },
      { records: 3, prefix_sha256: "x" },
    ]) {
      expect(planShipment(records, shipped).continuation).toBeUndefined();
    }
  });

  it("sends a tail without a meta record when the session has none", () => {
    const records = [user("a"), user("b")];
    const plan = planShipment(records, { records: 1, prefix_sha256: prefixSha256(records, 1) });

    expect(plan.records).toEqual([user("b")]);
    expect(plan.continuation?.from_record).toBe(1);
  });
});
