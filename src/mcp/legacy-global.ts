type JsonObject = Record<string, unknown>;
type EndpointKind = "deployment" | "oss";

const OFFICIAL_BACKEND_ORIGIN = "https://api.dosu.dev";
const SAFE_DEPLOYMENT_PATH = /^\/v1\/mcp\/deployments\/[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const BASE_PROVIDER_IDS = new Set([
  "antigravity",
  "claude",
  "cline",
  "cline-cli",
  "cursor",
  "factory",
  "gemini",
  "opencode",
  "vscode",
  "windsurf",
  "zed",
]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: JsonObject, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasExactDosuHeader(value: unknown): boolean {
  if (!isObject(value) || !hasExactKeys(value, ["X-Dosu-API-Key"])) return false;
  return typeof value["X-Dosu-API-Key"] === "string" && value["X-Dosu-API-Key"].length > 0;
}

function endpointKind(value: unknown): EndpointKind | null {
  if (typeof value !== "string") return null;
  try {
    const endpoint = new URL(value);
    if (
      (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.origin !== OFFICIAL_BACKEND_ORIGIN
    ) {
      return null;
    }
    if (endpoint.pathname === "/v1/mcp") return "oss";
    return SAFE_DEPLOYMENT_PATH.test(endpoint.pathname) ? "deployment" : null;
  } catch {
    return null;
  }
}

function defaultHTTPShape(value: JsonObject): boolean {
  return (
    hasExactKeys(value, ["headers", "type", "url"]) &&
    value.type === "http" &&
    hasExactDosuHeader(value.headers)
  );
}

/**
 * Strict ownership proof for destructive cleanup of released global JSON entries.
 * Command-based global entries belong to shared clients we intentionally do not clean.
 */
export function isReleasedLegacyGlobalMcpServer(providerID: string, value: unknown): boolean {
  if (!isObject(value) || !hasExactDosuHeader(value.headers)) return false;
  const kind =
    endpointKind(value.url) ??
    (providerID === "antigravity" ? endpointKind(value.serverUrl) : null);
  if (!kind) return false;

  if (kind === "oss") {
    if (providerID === "copilot") {
      return (
        hasExactKeys(value, ["headers", "tools", "type", "url"]) &&
        value.type === "http" &&
        Array.isArray(value.tools) &&
        value.tools.length === 1 &&
        value.tools[0] === "*"
      );
    }
    return BASE_PROVIDER_IDS.has(providerID) || providerID === "mcporter"
      ? defaultHTTPShape(value)
      : false;
  }

  switch (providerID) {
    case "claude":
    case "factory":
    case "gemini":
    case "mcporter":
    case "vscode":
    case "windsurf":
      return defaultHTTPShape(value);
    case "cursor":
      return hasExactKeys(value, ["headers", "url"]);
    case "zed":
      return (
        hasExactKeys(value, ["headers", "source", "type", "url"]) &&
        value.source === "custom" &&
        value.type === "http"
      );
    case "opencode":
      return (
        hasExactKeys(value, ["enabled", "headers", "type", "url"]) &&
        value.type === "remote" &&
        value.enabled === true
      );
    case "copilot":
      return (
        hasExactKeys(value, ["headers", "tools", "type", "url"]) &&
        value.type === "http" &&
        Array.isArray(value.tools) &&
        value.tools.length === 1 &&
        value.tools[0] === "*"
      );
    case "cline":
    case "cline-cli":
      return (
        hasExactKeys(value, ["disabled", "headers", "type", "url"]) &&
        value.type === "streamableHttp" &&
        value.disabled === false
      );
    case "antigravity":
      return hasExactKeys(value, ["headers", "serverUrl"]);
    default:
      return false;
  }
}
