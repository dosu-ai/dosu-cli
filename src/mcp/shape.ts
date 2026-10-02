/** Is an agent's Dosu entry current? An entry is current when it has the shape the running
 * provider code writes. Values that come from the user's target or machine rather than from that
 * code (backend, deployment, API key, npx location) are left open, so pointing an agent at another
 * deployment never counts as stale. This is what lets an upgrade find out-of-date entries by
 * looking at them instead of by tracking which releases changed the format. */

import { type Config, MODE_OSS } from "../config/config";
import { getBackendURL } from "../config/constants";
import { mcpEndpoint, mcpURL } from "./config-helpers";

/** Placeholder for a value left open; never written to disk. */
export const ANY = "\u0000any\u0000";

/** The endpoint an entry built for `cfg`'s mode points at, with backend and deployment open. */
export function shapeEndpoint(cfg: Config | null | undefined): string {
  const url = cfg?.mode === MODE_OSS ? mcpEndpoint(cfg) : mcpURL(ANY);
  return ANY + url.slice(getBackendURL().length);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether `actual` (read from disk) has the shape of `expected` (built with `ANY` for every
 * open value): same keys, same array lengths, equal values, and any text in each `ANY` slot. */
export function hasShape(expected: unknown, actual: unknown): boolean {
  if (typeof expected === "string") {
    if (typeof actual !== "string") return false;
    if (!expected.includes(ANY)) return expected === actual;
    const pattern = expected.split(ANY).map(escapeRegExp).join("[\\s\\S]*");
    return new RegExp(`^${pattern}$`).test(actual);
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, i) => hasShape(item, actual[i]))
    );
  }
  if (typeof expected === "object" && expected !== null) {
    if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return false;
    const expectedKeys = Object.keys(expected);
    const actualRecord = actual as Record<string, unknown>;
    return (
      expectedKeys.length === Object.keys(actualRecord).length &&
      expectedKeys.every(
        (key) =>
          key in actualRecord &&
          hasShape((expected as Record<string, unknown>)[key], actualRecord[key]),
      )
    );
  }
  return expected === actual;
}
