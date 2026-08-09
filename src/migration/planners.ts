import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  getNodeValue,
  type Node as JsonNode,
  type ParseError,
  parseTree,
} from "jsonc-parser/lib/esm/main.js";
import { parse as parseToml } from "smol-toml";
import type { ProviderId } from "./targets";

export type ContentPlan = {
  disposition: "remove" | "not_found" | "preserved_ambiguous";
  reason: string;
  expectedHash: string;
  mutation?: "write" | "delete";
  nextContent?: string;
};

export type ProjectProxyExpectation =
  | { packageVersion: string; deploymentID: string; oss?: false }
  | { packageVersion: string; oss: true; deploymentID?: never };

const DOSU_RULE_START = "<!-- dosu:rules:start v1 -->";
const DOSU_RULE_END = "<!-- dosu:rules:end -->";
const MCP_REMOTE_VERSION = "mcp-remote@0.1.38";
const API_KEY_HEADER = "X-Dosu-API-Key";
const API_KEY_PLACEHOLDER = "X-Dosu-API-Key:$" + "{X_DOSU_API_KEY}";
// Every released production CLI embeds this origin. Runtime backend overrides
// are deliberately not migration ownership proof: preserving an internal/dev
// entry is safer than deleting a same-shaped user server on an arbitrary host.
const RELEASED_DOSU_MCP_ORIGIN = "https://api.dosu.dev";

const RELEASED_STANDALONE_RULE_HASHES: Readonly<Record<"claude" | "cursor", ReadonlySet<string>>> =
  {
    claude: new Set([
      "82771652853dcf8b4bf7256fbbe039d24b49a7b17604d691deb512464cb74c84",
      "159e7d77db73739c2f06a9859d03cadcf9c3d3d9a412471595cc995aab298330",
    ]),
    cursor: new Set([
      "c1e507aa52dad2c211246aa17fa5bcabc6bf135c31d59046d93c4b64a11cb561",
      "98337c715e5df540d50f5366ec1f88906b3ef038985fcf612b3a451d7f4a911e",
    ]),
  };

// Marker-based rules contain the same normalized body as the released Claude
// standalone rule. Markers identify the range; this hash proves the user did
// not edit that range before migration removes it.
const RELEASED_RULE_BODY_HASHES = RELEASED_STANDALONE_RULE_HASHES.claude;

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function result(
  content: string,
  disposition: ContentPlan["disposition"],
  reason: string,
  mutation?: ContentPlan["mutation"],
  nextContent?: string,
): ContentPlan {
  return {
    disposition,
    reason,
    expectedHash: hashContent(content),
    ...(mutation ? { mutation } : {}),
    ...(nextContent !== undefined ? { nextContent } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isDosuMcpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    if (url.origin !== RELEASED_DOSU_MCP_ORIGIN) return false;
    if (url.username || url.password) return false;
    if (url.search || url.hash) return false;
    return url.pathname === "/v1/mcp" || /^\/v1\/mcp\/deployments\/[^/]+$/.test(url.pathname);
  } catch {
    return false;
  }
}

function isDosuBaseMcpUrl(value: unknown): value is string {
  if (!isDosuMcpUrl(value)) return false;
  const url = new URL(value);
  return url.pathname === "/v1/mcp";
}

function isExactHeaders(value: unknown): boolean {
  return (
    isRecord(value) && exactKeys(value, [API_KEY_HEADER]) && isNonEmptyString(value[API_KEY_HEADER])
  );
}

function isStandardHttpEntry(entry: Record<string, unknown>): boolean {
  return (
    exactKeys(entry, ["type", "url", "headers"]) &&
    entry.type === "http" &&
    isDosuMcpUrl(entry.url) &&
    isExactHeaders(entry.headers)
  );
}

function isCursorEntry(entry: Record<string, unknown>): boolean {
  return (
    exactKeys(entry, ["url", "headers"]) && isDosuMcpUrl(entry.url) && isExactHeaders(entry.headers)
  );
}

function isClineEntry(entry: Record<string, unknown>): boolean {
  return (
    exactKeys(entry, ["type", "disabled", "url", "headers"]) &&
    entry.type === "streamableHttp" &&
    entry.disabled === false &&
    isDosuMcpUrl(entry.url) &&
    isExactHeaders(entry.headers)
  );
}

function isOpenCodeEntry(entry: Record<string, unknown>): boolean {
  return (
    exactKeys(entry, ["type", "enabled", "url", "headers"]) &&
    entry.type === "remote" &&
    entry.enabled === true &&
    isDosuMcpUrl(entry.url) &&
    isExactHeaders(entry.headers)
  );
}

function isZedEntry(entry: Record<string, unknown>): boolean {
  return (
    exactKeys(entry, ["source", "type", "url", "headers"]) &&
    entry.source === "custom" &&
    entry.type === "http" &&
    isDosuMcpUrl(entry.url) &&
    isExactHeaders(entry.headers)
  );
}

function isAntigravityEntry(entry: Record<string, unknown>): boolean {
  return (
    exactKeys(entry, ["serverUrl", "headers"]) &&
    isDosuMcpUrl(entry.serverUrl) &&
    isExactHeaders(entry.headers)
  );
}

function isCopilotEntry(entry: Record<string, unknown>): boolean {
  return (
    exactKeys(entry, ["type", "url", "tools", "headers"]) &&
    entry.type === "http" &&
    isDosuMcpUrl(entry.url) &&
    Array.isArray(entry.tools) &&
    entry.tools.length === 1 &&
    entry.tools[0] === "*" &&
    isExactHeaders(entry.headers)
  );
}

function isAbsoluteNpx(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const absolute = isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
  return absolute && /(?:^|[\\/])npx(?:\.cmd)?$/i.test(value);
}

function isAbsolutePathList(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  const windowsParts = value.includes(";");
  const parts = windowsParts
    ? value.split(";")
    : /^[A-Za-z]:[\\/]/.test(value)
      ? [value]
      : value.split(":");
  return parts.every(
    (part) => part.length > 0 && (isAbsolute(part) || /^[A-Za-z]:[\\/]/.test(part)),
  );
}

function isMcpRemoteArgs(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 7 &&
    value[0] === "-y" &&
    value[1] === MCP_REMOTE_VERSION &&
    isDosuMcpUrl(value[2]) &&
    value[3] === "--header" &&
    value[4] === API_KEY_PLACEHOLDER &&
    value[5] === "--transport" &&
    value[6] === "http-only"
  );
}

function isMcpRemoteEnv(value: unknown): boolean {
  return (
    isRecord(value) &&
    exactKeys(value, ["PATH", "X_DOSU_API_KEY"]) &&
    isAbsolutePathList(value.PATH) &&
    isNonEmptyString(value.X_DOSU_API_KEY)
  );
}

function isClaudeDesktopEntry(entry: Record<string, unknown>): boolean {
  return (
    exactKeys(entry, ["command", "args", "env"]) &&
    isAbsoluteNpx(entry.command) &&
    isMcpRemoteArgs(entry.args) &&
    isMcpRemoteEnv(entry.env)
  );
}

function expectedProjectProxyParts(expectation: ProjectProxyExpectation): string[] {
  const prefix = ["npx", "-y", `@dosu/cli@${expectation.packageVersion}`, "mcp", "proxy"];
  return expectation.oss
    ? [...prefix, "--oss"]
    : [...prefix, "--deployment", expectation.deploymentID];
}

function exactStringArray(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((part, index) => part === expected[index])
  );
}

function isExactProjectProxyEntry(
  provider: ProviderId,
  entry: Record<string, unknown>,
  expectation: ProjectProxyExpectation,
): boolean {
  const parts = expectedProjectProxyParts(expectation);
  const args = parts.slice(1);
  switch (provider) {
    case "claude":
    case "cursor":
    case "vscode":
    case "copilot":
    case "factory":
      return (
        exactKeys(entry, ["type", "command", "args"]) &&
        entry.type === "stdio" &&
        entry.command === "npx" &&
        exactStringArray(entry.args, args)
      );
    case "gemini":
    case "antigravity":
    case "mcporter":
      return (
        exactKeys(entry, ["command", "args"]) &&
        entry.command === "npx" &&
        exactStringArray(entry.args, args)
      );
    case "zed":
      return (
        exactKeys(entry, ["command", "args", "env"]) &&
        entry.command === "npx" &&
        exactStringArray(entry.args, args) &&
        isRecord(entry.env) &&
        exactKeys(entry.env, [])
      );
    case "opencode":
      return (
        exactKeys(entry, ["type", "command", "enabled"]) &&
        entry.type === "local" &&
        entry.enabled === true &&
        exactStringArray(entry.command, parts)
      );
    default:
      return false;
  }
}

function hasDuplicateObjectKey(node: JsonNode): boolean {
  if (node.type === "object") {
    const seen = new Set<string>();
    for (const property of node.children ?? []) {
      const keyNode = property.children?.[0];
      const key = keyNode ? getNodeValue(keyNode) : undefined;
      if (typeof key === "string") {
        if (seen.has(key)) return true;
        seen.add(key);
      }
    }
  }
  return (node.children ?? []).some(hasDuplicateObjectKey);
}

function objectProperty(node: JsonNode, key: string): JsonNode | undefined {
  return objectPropertyNode(node, key)?.children?.[1];
}

function objectPropertyNode(node: JsonNode, key: string): JsonNode | undefined {
  if (node.type !== "object") return undefined;
  for (const property of node.children ?? []) {
    const keyNode = property.children?.[0];
    if (keyNode && getNodeValue(keyNode) === key) return property;
  }
  return undefined;
}

function jsonSeparatorComma(content: string, start: number, end: number): number | null {
  let comma = -1;
  let state: "normal" | "line_comment" | "block_comment" = "normal";
  for (let index = start; index < end; index += 1) {
    const character = content[index];
    if (state === "line_comment") {
      if (character === "\n" || character === "\r") state = "normal";
      continue;
    }
    if (state === "block_comment") {
      if (character === "*" && content[index + 1] === "/") {
        state = "normal";
        index += 1;
      }
      continue;
    }
    if (/\s/.test(character)) continue;
    if (character === "/" && content[index + 1] === "/") {
      state = "line_comment";
      index += 1;
      continue;
    }
    if (character === "/" && content[index + 1] === "*") {
      state = "block_comment";
      index += 1;
      continue;
    }
    if (character === "," && comma === -1) {
      comma = index;
      continue;
    }
    return null;
  }
  return state === "block_comment" || comma === -1 ? null : comma;
}

/** Delete one parsed JSONC object property without rewriting any unrelated byte. */
export function removeJsonObjectPropertyRaw(
  content: string,
  objectNode: JsonNode,
  key: string,
): string | null {
  if (objectNode.type !== "object") return null;
  const properties = objectNode.children ?? [];
  const propertyIndex = properties.findIndex((property) => {
    const keyNode = property.children?.[0];
    return keyNode ? getNodeValue(keyNode) === key : false;
  });
  if (propertyIndex < 0) return null;
  const property = properties[propertyIndex];
  const propertyStart = property.offset;
  const propertyEnd = property.offset + property.length;
  const ranges: Array<{ start: number; end: number }> = [
    { start: propertyStart, end: propertyEnd },
  ];

  const next = properties[propertyIndex + 1];
  const previous = properties[propertyIndex - 1];
  if (next) {
    const comma = jsonSeparatorComma(content, propertyEnd, next.offset);
    if (comma === null) return null;
    ranges.push({ start: comma, end: comma + 1 });
  } else if (previous) {
    const previousEnd = previous.offset + previous.length;
    const comma = jsonSeparatorComma(content, previousEnd, propertyStart);
    if (comma === null) return null;
    ranges.push({ start: comma, end: comma + 1 });
  } else {
    // With a single child, a JSONC trailing comma belongs to the removed
    // property. Leaving it behind would turn `{ "dosu": {...}, }` into `{,}`.
    const trailingComma = jsonSeparatorComma(
      content,
      propertyEnd,
      objectNode.offset + objectNode.length - 1,
    );
    if (trailingComma !== null) ranges.push({ start: trailingComma, end: trailingComma + 1 });
  }

  let nextContent = content;
  for (const range of ranges.sort((left, right) => right.start - left.start)) {
    nextContent = nextContent.slice(0, range.start) + nextContent.slice(range.end);
  }
  return nextContent;
}

function candidateUrl(entry: Record<string, unknown>): unknown {
  if ("url" in entry) return entry.url;
  if ("serverUrl" in entry) return entry.serverUrl;
  if (Array.isArray(entry.args)) return entry.args[2];
  return undefined;
}

function matchesReleasedJsonShape(provider: ProviderId, entry: Record<string, unknown>): boolean {
  if (provider === "claude-desktop") return isClaudeDesktopEntry(entry);
  if (isStandardHttpEntry(entry)) {
    switch (provider) {
      case "cursor":
      case "cline":
      case "cline-cli":
      case "opencode":
      case "zed":
      case "antigravity":
        return isDosuBaseMcpUrl(entry.url);
      case "copilot":
        return false;
      case "claude":
      case "vscode":
      case "gemini":
      case "windsurf":
      case "factory":
      case "mcporter":
        return true;
      default:
        return false;
    }
  }
  switch (provider) {
    case "cursor":
      return isCursorEntry(entry);
    case "cline":
    case "cline-cli":
      return isClineEntry(entry);
    case "opencode":
      return isOpenCodeEntry(entry);
    case "zed":
      return isZedEntry(entry);
    case "antigravity":
      return isAntigravityEntry(entry);
    case "copilot":
      return isCopilotEntry(entry);
    default:
      return false;
  }
}

export function planLegacyJsonMcp(input: {
  content: string;
  provider: ProviderId;
  topKey: string;
}): ContentPlan {
  const errors: ParseError[] = [];
  const root = parseTree(input.content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (!root || errors.length > 0) {
    return result(input.content, "preserved_ambiguous", "parse_error");
  }
  if (hasDuplicateObjectKey(root)) {
    return result(input.content, "preserved_ambiguous", "duplicate_key");
  }
  if (root.type !== "object") {
    return result(input.content, "preserved_ambiguous", "root_not_object");
  }

  const parent = objectProperty(root, input.topKey);
  if (!parent) return result(input.content, "not_found", "dosu_entry_absent");
  if (parent.type !== "object") {
    return result(input.content, "preserved_ambiguous", "top_key_not_object");
  }
  const entryNode = objectProperty(parent, "dosu");
  if (!entryNode) return result(input.content, "not_found", "dosu_entry_absent");

  const entry: unknown = getNodeValue(entryNode);
  if (!isRecord(entry)) {
    return result(input.content, "preserved_ambiguous", "foreign_dosu_entry");
  }
  const url = candidateUrl(entry);
  if (!isDosuMcpUrl(url)) {
    return result(input.content, "preserved_ambiguous", "foreign_dosu_entry");
  }
  if (!matchesReleasedJsonShape(input.provider, entry)) {
    return result(input.content, "preserved_ambiguous", "unknown_dosu_shape");
  }

  const nextContent = removeJsonObjectPropertyRaw(input.content, parent, "dosu");
  if (nextContent === null) {
    return result(input.content, "preserved_ambiguous", "raw_edit_failed");
  }
  return result(input.content, "remove", "released_dosu_shape", "write", nextContent);
}

/** Verify only the exact, current, secretless project proxy child for a JSON/JSONC provider. */
export function isExactProjectJsonProxy(input: {
  content: string;
  provider: ProviderId;
  topKey: string;
  expectation: ProjectProxyExpectation;
}): boolean {
  const errors: ParseError[] = [];
  const root = parseTree(input.content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (!root || errors.length > 0 || root.type !== "object" || hasDuplicateObjectKey(root)) {
    return false;
  }
  const parent = objectProperty(root, input.topKey);
  const entryNode = parent ? objectProperty(parent, "dosu") : undefined;
  const entry: unknown = entryNode ? getNodeValue(entryNode) : undefined;
  return isRecord(entry) && isExactProjectProxyEntry(input.provider, entry, input.expectation);
}

interface TomlSection {
  name: string;
  start: number;
  end: number;
  bodyStart: number;
}

interface ParsedTomlHeader {
  section: Omit<TomlSection, "end">;
  nextIndex: number;
}

function parseStrictTomlDocument(content: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = parseToml(content);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasSemanticDosuTable(document: Record<string, unknown>): boolean {
  return isRecord(document.mcp_servers) && Object.hasOwn(document.mcp_servers, "dosu");
}

function parseTomlHeader(
  content: string,
  lineStart: number,
  bracketIndex: number,
): ParsedTomlHeader | null {
  const arrayTable = content[bracketIndex + 1] === "[";
  const openingLength = arrayTable ? 2 : 1;
  let index = bracketIndex + openingLength;
  let quote: "basic" | "literal" | null = null;
  let escaped = false;
  let closingIndex = -1;

  while (index < content.length) {
    const character = content[index];
    if (character === "\n" || character === "\r") return null;
    if (quote === "basic") {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quote = null;
      index += 1;
      continue;
    }
    if (quote === "literal") {
      if (character === "'") quote = null;
      index += 1;
      continue;
    }
    if (character === '"') {
      quote = "basic";
      index += 1;
      continue;
    }
    if (character === "'") {
      quote = "literal";
      index += 1;
      continue;
    }
    if (
      (!arrayTable && character === "]") ||
      (arrayTable && character === "]" && content[index + 1] === "]")
    ) {
      closingIndex = index;
      break;
    }
    index += 1;
  }
  if (closingIndex < 0 || quote !== null) return null;

  const rawName = content.slice(bracketIndex + openingLength, closingIndex).trim();
  if (!rawName) return null;
  index = closingIndex + (arrayTable ? 2 : 1);
  while (index < content.length && (content[index] === " " || content[index] === "\t")) index += 1;
  if (content[index] === "#") {
    while (index < content.length && content[index] !== "\n" && content[index] !== "\r") index += 1;
  }
  if (content[index] === "\r") index += 1;
  if (content[index] === "\n") index += 1;
  else if (index !== content.length) return null;

  return {
    section: {
      name: arrayTable ? `[[${rawName}]]` : rawName,
      start: lineStart,
      bodyStart: index,
    },
    nextIndex: index,
  };
}

function scanTomlSections(content: string): TomlSection[] | null {
  const headers: Array<Omit<TomlSection, "end">> = [];
  let state: "normal" | "comment" | "basic" | "literal" | "multi_basic" | "multi_literal" =
    "normal";
  let lineStart = 0;
  let lineOnlyWhitespace = true;
  let arrayDepth = 0;
  let inlineTableDepth = 0;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (state === "comment") {
      if (character === "\n") {
        state = "normal";
        lineStart = index + 1;
        lineOnlyWhitespace = true;
      }
      continue;
    }
    if (state === "basic") {
      if (character === "\\") {
        index += 1;
        if (index >= content.length || content[index] === "\n" || content[index] === "\r") {
          return null;
        }
      } else if (character === '"') state = "normal";
      else if (character === "\n" || character === "\r") return null;
      continue;
    }
    if (state === "literal") {
      if (character === "'") state = "normal";
      else if (character === "\n" || character === "\r") return null;
      continue;
    }
    if (state === "multi_basic") {
      if (character === "\\") index += 1;
      else if (content.startsWith('"""', index)) {
        state = "normal";
        index += 2;
      }
      continue;
    }
    if (state === "multi_literal") {
      if (content.startsWith("'''", index)) {
        state = "normal";
        index += 2;
      }
      continue;
    }

    if (character === "\n") {
      lineStart = index + 1;
      lineOnlyWhitespace = true;
      continue;
    }
    if (lineOnlyWhitespace && (character === " " || character === "\t" || character === "\r")) {
      continue;
    }
    if (lineOnlyWhitespace && character === "[" && arrayDepth === 0 && inlineTableDepth === 0) {
      const header = parseTomlHeader(content, lineStart, index);
      if (!header) return null;
      headers.push(header.section);
      index = header.nextIndex - 1;
      lineStart = header.nextIndex;
      lineOnlyWhitespace = true;
      continue;
    }
    lineOnlyWhitespace = false;
    if (character === "#") {
      state = "comment";
    } else if (content.startsWith('"""', index)) {
      state = "multi_basic";
      index += 2;
    } else if (content.startsWith("'''", index)) {
      state = "multi_literal";
      index += 2;
    } else if (character === '"') {
      state = "basic";
    } else if (character === "'") {
      state = "literal";
    } else if (character === "[") {
      arrayDepth += 1;
    } else if (character === "]") {
      if (arrayDepth === 0) return null;
      arrayDepth -= 1;
    } else if (character === "{") {
      inlineTableDepth += 1;
    } else if (character === "}") {
      if (inlineTableDepth === 0) return null;
      inlineTableDepth -= 1;
    }
  }

  if ((state !== "normal" && state !== "comment") || arrayDepth !== 0 || inlineTableDepth !== 0) {
    return null;
  }
  return headers.map((header, index) => ({
    ...header,
    end: headers[index + 1]?.start ?? content.length,
  }));
}

function stripTomlComment(value: string): string {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quoted) {
      escaped = true;
      continue;
    }
    if (character === '"') quoted = !quoted;
    if (character === "#" && !quoted) return value.slice(0, index).trim();
  }
  return value.trim();
}

function parseTomlValue(raw: string): unknown {
  const value = stripTomlComment(raw);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.startsWith('"') || value.startsWith("[")) {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parseTomlAssignments(
  content: string,
  section: TomlSection,
): { values: Record<string, unknown>; duplicate: boolean; invalid: boolean; ownedEnd: number } {
  const values: Record<string, unknown> = {};
  let duplicate = false;
  let invalid = false;
  let ownedEnd = section.bodyStart;
  let sawAssignment = false;
  let trailingTrivia = false;
  const header = content.slice(section.start, section.bodyStart);
  const expectedHeader = `[${section.name}]${header.endsWith("\r\n") ? "\r\n" : "\n"}`;
  if (header !== expectedHeader) invalid = true;
  const body = content.slice(section.bodyStart, section.end);
  let bodyOffset = 0;
  for (const match of body.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
    const completeLine = match[0];
    if (!completeLine) break;
    const line = completeLine.replace(/(?:\r\n|\n|\r)$/, "");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      if (sawAssignment) trailingTrivia = true;
      else invalid = true;
      bodyOffset += completeLine.length;
      continue;
    }
    if (trailingTrivia) invalid = true;
    const assignment = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*$/);
    if (!assignment) {
      invalid = true;
      bodyOffset += completeLine.length;
      continue;
    }
    const key = assignment[1];
    if (Object.hasOwn(values, key)) duplicate = true;
    if (stripTomlComment(assignment[2]) !== assignment[2].trim()) invalid = true;
    const value = parseTomlValue(assignment[2]);
    if (value === undefined) invalid = true;
    values[key] = value;
    sawAssignment = true;
    ownedEnd = section.bodyStart + bodyOffset + completeLine.length;
    bodyOffset += completeLine.length;
  }
  return { values, duplicate, invalid, ownedEnd };
}

function removeTomlRanges(
  content: string,
  ranges: readonly { start: number; end: number }[],
): string {
  let nextContent = content;
  for (const range of [...ranges].sort((left, right) => right.start - left.start)) {
    nextContent = nextContent.slice(0, range.start) + nextContent.slice(range.end);
  }
  return nextContent;
}

function isRemoteCodexShape(
  base: Record<string, unknown>,
  nested: Record<string, unknown>,
): boolean {
  return (
    exactKeys(base, ["type", "url"]) &&
    base.type === "http" &&
    isDosuMcpUrl(base.url) &&
    exactKeys(nested, [API_KEY_HEADER]) &&
    isNonEmptyString(nested[API_KEY_HEADER])
  );
}

function isCurrentCodexShape(
  base: Record<string, unknown>,
  nested: Record<string, unknown>,
): boolean {
  return (
    exactKeys(base, ["command", "args"]) &&
    isAbsoluteNpx(base.command) &&
    isMcpRemoteArgs(base.args) &&
    exactKeys(nested, ["PATH", "X_DOSU_API_KEY"]) &&
    isAbsolutePathList(nested.PATH) &&
    isNonEmptyString(nested.X_DOSU_API_KEY)
  );
}

export function planLegacyCodexMcp(content: string): ContentPlan {
  const document = parseStrictTomlDocument(content);
  if (!document) {
    return result(content, "preserved_ambiguous", "parse_error");
  }
  const sections = scanTomlSections(content);
  if (!sections) return result(content, "preserved_ambiguous", "parse_error");
  const dosuSections = sections.filter(
    (section) =>
      section.name === "mcp_servers.dosu" || section.name.startsWith("mcp_servers.dosu."),
  );
  if (dosuSections.length === 0) {
    return hasSemanticDosuTable(document)
      ? result(content, "preserved_ambiguous", "semantic_dosu_table_unowned")
      : result(content, "not_found", "dosu_entry_absent");
  }

  const sectionNames = new Set<string>();
  for (const section of dosuSections) {
    if (sectionNames.has(section.name)) {
      return result(content, "preserved_ambiguous", "duplicate_section");
    }
    sectionNames.add(section.name);
  }

  const base = dosuSections.find((section) => section.name === "mcp_servers.dosu");
  if (!base) {
    return result(content, "preserved_ambiguous", "incomplete_dosu_shape");
  }
  const baseAssignments = parseTomlAssignments(content, base);
  if (baseAssignments.duplicate) {
    return result(content, "preserved_ambiguous", "duplicate_key");
  }
  if (baseAssignments.invalid) {
    return result(content, "preserved_ambiguous", "unknown_dosu_shape");
  }
  const urlCandidate =
    baseAssignments.values.url ??
    (Array.isArray(baseAssignments.values.args) ? baseAssignments.values.args[2] : undefined);
  if (!isDosuMcpUrl(urlCandidate)) {
    return result(content, "preserved_ambiguous", "foreign_dosu_entry");
  }
  if (
    !exactKeys(baseAssignments.values, ["type", "url"]) &&
    !exactKeys(baseAssignments.values, ["command", "args"])
  ) {
    return result(content, "preserved_ambiguous", "unknown_dosu_shape");
  }
  if (dosuSections.length < 2) {
    return result(content, "preserved_ambiguous", "incomplete_dosu_shape");
  }
  if (dosuSections.length !== 2) {
    return result(content, "preserved_ambiguous", "unknown_dosu_shape");
  }
  const nested = dosuSections.find((section) => section !== base);
  if (!nested) return result(content, "preserved_ambiguous", "incomplete_dosu_shape");

  const baseIndex = sections.indexOf(base);
  const nestedIndex = sections.indexOf(nested);
  if (nestedIndex !== baseIndex + 1) {
    return result(content, "preserved_ambiguous", "noncontiguous_dosu_sections");
  }

  const nestedAssignments = parseTomlAssignments(content, nested);
  if (baseAssignments.duplicate || nestedAssignments.duplicate) {
    return result(content, "preserved_ambiguous", "duplicate_key");
  }
  if (baseAssignments.invalid || nestedAssignments.invalid) {
    return result(content, "preserved_ambiguous", "unknown_dosu_shape");
  }

  const released =
    (nested.name === "mcp_servers.dosu.http_headers" &&
      isRemoteCodexShape(baseAssignments.values, nestedAssignments.values)) ||
    (nested.name === "mcp_servers.dosu.env" &&
      isCurrentCodexShape(baseAssignments.values, nestedAssignments.values));
  if (!released) return result(content, "preserved_ambiguous", "unknown_dosu_shape");

  const nextContent = removeTomlRanges(content, [
    { start: base.start, end: baseAssignments.ownedEnd },
    { start: nested.start, end: nestedAssignments.ownedEnd },
  ]);
  return result(content, "remove", "released_dosu_shape", "write", nextContent);
}

function projectCodexArgsMatch(args: unknown, expectation: ProjectProxyExpectation): boolean {
  return exactStringArray(args, expectedProjectProxyParts(expectation).slice(1));
}

function isAnyExactProjectCodexArgs(args: unknown): boolean {
  if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) return false;
  const values = args as string[];
  if (
    values[0] !== "-y" ||
    !/^@dosu\/cli@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(values[1] ?? "") ||
    values[2] !== "mcp" ||
    values[3] !== "proxy"
  ) {
    return false;
  }
  return (
    (values.length === 5 && values[4] === "--oss") ||
    (values.length === 6 && values[4] === "--deployment" && values[5].length > 0)
  );
}

/**
 * Range-plan removal of one exact project proxy. This is path-independent so the
 * Codex provider can safely reuse it for install/remove without a lossy TOML rewrite.
 */
export function planProjectCodexMcp(
  content: string,
  expectation?: ProjectProxyExpectation,
): ContentPlan {
  const document = parseStrictTomlDocument(content);
  if (!document) {
    return result(content, "preserved_ambiguous", "parse_error");
  }
  const sections = scanTomlSections(content);
  if (!sections) return result(content, "preserved_ambiguous", "parse_error");
  const dosuSections = sections.filter(
    (section) =>
      section.name === "mcp_servers.dosu" || section.name.startsWith("mcp_servers.dosu."),
  );
  if (dosuSections.length === 0) {
    return hasSemanticDosuTable(document)
      ? result(content, "preserved_ambiguous", "semantic_dosu_table_unowned")
      : result(content, "not_found", "dosu_entry_absent");
  }

  const names = new Set<string>();
  for (const section of dosuSections) {
    if (names.has(section.name)) {
      return result(content, "preserved_ambiguous", "duplicate_section");
    }
    names.add(section.name);
  }
  const base = dosuSections.find((section) => section.name === "mcp_servers.dosu");
  if (!base) return result(content, "preserved_ambiguous", "incomplete_dosu_shape");
  if (dosuSections.length !== 1) {
    return result(content, "preserved_ambiguous", "unknown_dosu_shape");
  }

  const assignments = parseTomlAssignments(content, base);
  if (assignments.duplicate) return result(content, "preserved_ambiguous", "duplicate_key");
  if (assignments.invalid || !exactKeys(assignments.values, ["command", "args"])) {
    return result(content, "preserved_ambiguous", "unknown_dosu_shape");
  }
  if (assignments.values.command !== "npx") {
    return result(content, "preserved_ambiguous", "foreign_dosu_entry");
  }
  const proxyMatches = expectation
    ? projectCodexArgsMatch(assignments.values.args, expectation)
    : isAnyExactProjectCodexArgs(assignments.values.args);
  if (!proxyMatches) {
    return result(content, "preserved_ambiguous", "project_proxy_mismatch");
  }

  const nextContent = removeTomlRanges(content, [{ start: base.start, end: assignments.ownedEnd }]);
  return result(content, "remove", "exact_project_proxy", "write", nextContent);
}

export function isExactProjectCodexProxy(
  content: string,
  expectation?: ProjectProxyExpectation,
): boolean {
  return planProjectCodexMcp(content, expectation).disposition === "remove";
}

/**
 * Strict shared planner for Codex provider install/remove. It recognizes the
 * exact secretless project proxy and, when allowed, both released global forms.
 */
export function planCodexDosuMcp(
  content: string,
  options: {
    projectProxy?: ProjectProxyExpectation | "any";
    allowLegacyGlobal?: boolean;
  } = { projectProxy: "any", allowLegacyGlobal: true },
): ContentPlan {
  const project =
    options.projectProxy === undefined
      ? undefined
      : planProjectCodexMcp(
          content,
          options.projectProxy === "any" ? undefined : options.projectProxy,
        );
  if (project?.disposition === "remove") return project;

  const legacy = options.allowLegacyGlobal === false ? undefined : planLegacyCodexMcp(content);
  if (legacy?.disposition === "remove") return legacy;
  if (project?.reason === "duplicate_section" || legacy?.reason === "duplicate_section") {
    return result(content, "preserved_ambiguous", "duplicate_section");
  }
  if (project?.reason === "parse_error" || legacy?.reason === "parse_error") {
    return result(content, "preserved_ambiguous", "parse_error");
  }
  if (project && project.disposition !== "not_found") return project;
  if (legacy) return legacy;
  return result(content, "not_found", "dosu_entry_absent");
}

function markerIndexes(content: string, marker: string): number[] {
  const indexes: number[] = [];
  let offset = 0;
  while (offset < content.length) {
    const index = content.indexOf(marker, offset);
    if (index === -1) break;
    indexes.push(index);
    offset = index + marker.length;
  }
  return indexes;
}

export function planLegacyRuleSection(content: string): ContentPlan {
  const starts = markerIndexes(content, DOSU_RULE_START);
  const ends = markerIndexes(content, DOSU_RULE_END);
  if (starts.length === 0 && ends.length === 0) {
    return result(content, "not_found", "dosu_rule_absent");
  }
  if (starts.length > 1 || ends.length > 1) {
    return result(content, "preserved_ambiguous", "duplicate_marker");
  }
  if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0]) {
    return result(content, "preserved_ambiguous", "incomplete_marker");
  }

  const bodyStart = starts[0] + DOSU_RULE_START.length;
  const leadingEol = content.slice(bodyStart, bodyStart + 2) === "\r\n" ? "\r\n" : "\n";
  if (!content.startsWith(leadingEol, bodyStart)) {
    return result(content, "preserved_ambiguous", "modified_rule_section");
  }
  const bodyEnd = ends[0];
  const trailingEol = content.slice(bodyEnd - 2, bodyEnd) === "\r\n" ? "\r\n" : "\n";
  if (
    bodyEnd <= bodyStart + leadingEol.length ||
    !content.slice(0, bodyEnd).endsWith(trailingEol)
  ) {
    return result(content, "preserved_ambiguous", "modified_rule_section");
  }
  const body = content.slice(bodyStart + leadingEol.length, bodyEnd - trailingEol.length);
  const normalizedBody = `${body.replace(/\r\n/g, "\n").trimEnd()}\n`;
  if (!RELEASED_RULE_BODY_HASHES.has(hashContent(normalizedBody))) {
    return result(content, "preserved_ambiguous", "modified_rule_section");
  }

  let removeEnd = ends[0] + DOSU_RULE_END.length;
  if (content.slice(removeEnd, removeEnd + 2) === "\r\n") removeEnd += 2;
  else if (content[removeEnd] === "\n") removeEnd += 1;
  const nextContent = content.slice(0, starts[0]) + content.slice(removeEnd);

  if (!nextContent.trim()) {
    return result(content, "remove", "released_rule_section", "delete");
  }
  return result(content, "remove", "released_rule_section", "write", nextContent);
}

export function planLegacyStandaloneRule(content: string, kind: "claude" | "cursor"): ContentPlan {
  if (!RELEASED_STANDALONE_RULE_HASHES[kind].has(hashContent(content))) {
    return result(content, "preserved_ambiguous", "modified_standalone_rule");
  }
  return result(content, "remove", "released_standalone_rule", "delete");
}
