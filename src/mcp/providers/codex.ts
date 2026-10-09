/** Codex provider: CLI and desktop share ~/.codex/config.toml, plus a project-local
 * .codex/config.toml when the cwd has one. Codex merges the two per-key *inside* each
 * `mcp_servers.<name>` table, so both scopes must agree on the entry's shape. Written via
 * minimal manual TOML serialization instead of a TOML library. */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Config, MODE_OSS } from "../../config/config";
import { mcpEndpoint, npxRemoteEntry, writeSecureFile } from "../config-helpers";
import { expandHome, findNpx, isInstalled, npxPathEnv } from "../detect";
import type { SetupProvider } from "../providers";
import { ANY, entryHasShape, isUserChoiceKey, shapeEndpoint } from "../shape";

/** Codex treats an empty CODEX_HOME as unset, so this does too. */
function codexHome(): string {
  return process.env.CODEX_HOME || expandHome("~/.codex");
}

function getConfigPath(global: boolean): string {
  if (global) return join(codexHome(), "config.toml");
  return join(process.cwd(), ".codex", "config.toml");
}

/** Minimal TOML read/write, just enough to add/remove the [mcp_servers.dosu] entry. */
function readTOML(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf-8");
}

function writeTOML(path: string, content: string): void {
  writeSecureFile(path, content);
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

type TOMLValue = string | string[];
/** The Dosu entry as data: root-table keys, plus one record per subtable (`env`). */
type DosuEntry = Record<string, TOMLValue | Record<string, TOMLValue>>;

function tomlValue(value: TOMLValue): string {
  return Array.isArray(value) ? `[${value.map(tomlString).join(", ")}]` : tomlString(value);
}

/** Codex desktop only renders MCP Apps for stdio servers, so the entry proxies through
 * `npx mcp-remote`. Codex defers MCP tools behind tool_search and ignores the server's alwaysLoad
 * hint; omit_tools_from = ["deferred"] (Codex 0.147.0+) lists them up front. Older releases ignore
 * the key unless run with --strict-config. */
function dosuEntry(url: string, apiKey: string | undefined, npx: string, path: string): DosuEntry {
  return { ...npxRemoteEntry(url, apiKey, npx, path), omit_tools_from: ["deferred"] };
}

const DOSU_TABLE = "mcp_servers.dosu";

/** Settings Codex or the user writes into the Dosu table: the on/off, approval, tool filter, and
 * timeout keys (see `isUserChoiceKey`), and the per-tool `tools.<name>` approvals Codex saves when
 * the user picks "always allow". They are the user's, not the entry's format, so `isCurrent` skips
 * them and a rewrite carries them over. */
function isUserKey(key: string): boolean {
  return isUserChoiceKey(key) || key === "tools" || key.startsWith("tools.");
}

function isUserTable(name: string): boolean {
  return name === `${DOSU_TABLE}.tools` || name.startsWith(`${DOSU_TABLE}.tools.`);
}

/** The user's settings in an existing Dosu entry, as the TOML text to carry into its rewrite. */
interface UserSettings {
  /** Key lines of the root `[mcp_servers.dosu]` table. */
  root: string[];
  /** Whole `[mcp_servers.dosu.tools.*]` tables, header included. */
  tables: string[];
}

function renderDosuEntry(entry: DosuEntry, kept: UserSettings): string {
  const tables: Array<[string, string[]]> = [[DOSU_TABLE, []]];
  for (const [key, value] of Object.entries(entry)) {
    if (typeof value === "string" || Array.isArray(value)) {
      tables[0][1].push(`${key} = ${tomlValue(value)}`);
    } else {
      const lines = Object.entries(value).map(([k, v]) => `${k} = ${tomlValue(v)}`);
      tables.push([`${DOSU_TABLE}.${key}`, lines]);
    }
  }
  tables[0][1].push(...kept.root);
  return (
    tables.map(([name, lines]) => `\n[${name}]\n${lines.join("\n")}\n`).join("") +
    kept.tables.map((table) => `\n${table}\n`).join("")
  );
}

/** Net open brackets on a line of TOML, outside strings and comments: nonzero while a
 * multi-line array (`disabled_tools = [` ...) is still open. */
function openBrackets(text: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#") break;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
  }
  return depth;
}

interface TOMLStatement {
  key: string;
  /** The value text, every line of it for a multi-line array. */
  value: string;
  /** The statement's lines as written. */
  text: string;
}

interface DosuTable {
  name: string;
  header: string;
  statements: TOMLStatement[];
}

/** Every `[mcp_servers.dosu]` and `[mcp_servers.dosu.*]` table in `content`, with its key/value
 * statements (comments and blank lines dropped). A multi-line array stays one statement; a table
 * header always starts a new table, so an unclosed bracket never swallows another table. */
function dosuTables(content: string): DosuTable[] {
  const tables: DosuTable[] = [];
  let table: DosuTable | undefined;
  let open: TOMLStatement | undefined;
  let depth = 0;
  for (const line of content.split("\n")) {
    const name = sectionName(line);
    if (name !== null) {
      open = undefined;
      table = isDosuSection(name) ? { name, header: line.trim(), statements: [] } : undefined;
      if (table) tables.push(table);
      continue;
    }
    if (open && depth > 0) {
      open.value += `\n${line}`;
      open.text += `\n${line}`;
      depth += openBrackets(line);
      continue;
    }
    open = undefined;
    const text = line.trim();
    if (!table || !text || text.startsWith("#")) continue;
    const eq = text.indexOf("=");
    const key = eq === -1 ? text : text.slice(0, eq).trim();
    const value = eq === -1 ? "" : text.slice(eq + 1).trim();
    open = { key, value, text: line };
    table.statements.push(open);
    depth = openBrackets(value);
  }
  return tables;
}

/** The Dosu entry in `content` in `DosuEntry` form, without the user's settings (`isUserKey`),
 * or undefined when there is none. Values are read as JSON, which covers the strings and string
 * arrays this provider writes; anything else (a hand-written literal string, a trailing comment)
 * stays raw text and compares as different. */
function readDosuEntry(content: string): Record<string, unknown> | undefined {
  let entry: Record<string, unknown> | undefined;
  for (const { name, statements } of dosuTables(content)) {
    entry ??= {};
    if (isUserTable(name)) continue;
    const isRoot = name === DOSU_TABLE;
    const table: Record<string, unknown> = isRoot ? entry : {};
    if (!isRoot) entry[name.slice(DOSU_TABLE.length + 1)] = table;
    for (const { key, value } of statements) {
      if (isRoot && isUserKey(key)) continue;
      try {
        table[key] = JSON.parse(value);
      } catch {
        table[key] = value;
      }
    }
  }
  return entry;
}

function userSettings(content: string): UserSettings {
  const kept: UserSettings = { root: [], tables: [] };
  for (const { name, header, statements } of dosuTables(content)) {
    if (name === DOSU_TABLE) {
      kept.root.push(...statements.filter(({ key }) => isUserKey(key)).map(({ text }) => text));
    } else if (isUserTable(name)) {
      kept.tables.push([header, ...statements.map(({ text }) => text)].join("\n"));
    }
  }
  return kept;
}

/** Write the Dosu entry for `cfg` to `path`, replacing any Dosu tables there but keeping the
 * user's own settings on the entry (`isUserKey`), so a format update never switches Dosu back on
 * or drops the tool approvals and filters the user set in Codex. */
function installDosuToTOML(path: string, cfg: Config): void {
  const existing = readTOML(path);
  // Remove existing [mcp_servers.dosu] section if present (including the
  // legacy [mcp_servers.dosu.http_headers] subtable from the remote-HTTP form)
  const content = removeDosuFromTOML(existing);
  const npx = findNpx();
  const entry = dosuEntry(
    mcpEndpoint(cfg),
    cfg.active_account?.target?.api_key,
    npx,
    npxPathEnv(npx),
  );
  writeTOML(path, content + renderDosuEntry(entry, userSettings(existing)));
}

/** The table name from a TOML table or array-of-tables header, tolerating a trailing comment and
 * TOML's optional inner whitespace: `[ mcp_servers.dosu ] # override` -> `mcp_servers.dosu`. Null if not a header. */
function sectionName(line: string): string | null {
  const header = line.trim();
  const match =
    header.match(/^\[\[([^\]]*)]]\s*(?:#.*)?$/) ?? header.match(/^\[([^\]]*)]\s*(?:#.*)?$/);
  return match ? match[1].trim() : null;
}

function isDosuSection(name: string): boolean {
  return name === DOSU_TABLE || name.startsWith(`${DOSU_TABLE}.`);
}

function removeDosuFromTOML(content: string): string {
  // Remove [mcp_servers.dosu] and [mcp_servers.dosu.*] sections
  const result: string[] = [];
  let inDosuSection = false;

  for (const line of content.split("\n")) {
    const name = sectionName(line);
    if (name !== null) {
      inDosuSection = isDosuSection(name);
      if (inDosuSection) continue;
    }
    if (!inDosuSection) {
      result.push(line);
    }
  }
  return result.join("\n");
}

/** Keys that only ever appear on the remote-HTTP form of an MCP entry. */
const REMOTE_HTTP_KEY = /^(url|type|bearer_token_env_var)\s*=/;

/** Is the dosu entry here the legacy remote-HTTP form? Only the root [mcp_servers.dosu] table is
 * scanned for marker keys — [.env] holds arbitrary variable names and must not match against them. */
function hasRemoteHTTPForm(content: string): boolean {
  let inDosuRoot = false;
  for (const line of content.split("\n")) {
    const name = sectionName(line);
    if (name !== null) {
      // The http_headers subtable exists only on the remote-HTTP form.
      if (name === "mcp_servers.dosu.http_headers") return true;
      inDosuRoot = name === "mcp_servers.dosu";
      continue;
    }
    if (inDosuRoot && REMOTE_HTTP_KEY.test(line.trim())) return true;
  }
  return false;
}

/** Every .codex/config.toml Codex merges for the cwd. Codex walks from the project root — the
 * nearest ancestor holding a .git marker — down to the working directory and loads each one, so a
 * legacy entry at the repo root still conflicts when setup runs from a subdirectory. */
function projectConfigPaths(): string[] {
  const cwd = process.cwd();
  const chain: string[] = [];
  for (let dir = cwd; ; ) {
    chain.push(dir);
    if (existsSync(join(dir, ".git"))) break;
    const parent = dirname(dir);
    // No project root marker anywhere above: Codex treats the cwd as the only project layer.
    if (parent === dir) return [join(cwd, ".codex", "config.toml")];
    dir = parent;
  }
  return chain.reverse().map((dir) => join(dir, ".codex", "config.toml"));
}

/** Drop a legacy remote-HTTP dosu entry from a config layer we are not writing. Codex merges
 * mcp_servers.dosu per-key across every layer, so such a leftover lands in the same table as the
 * stdio entry we just wrote; Codex resolves that table as stdio, rejects the stray `url`, and fails
 * to load the whole bootstrap config — taking every MCP server down, not just dosu. A *stdio* entry
 * in another layer is left alone: it merges cleanly, and a project one is a per-repo override. */
function pruneLegacyRemoteEntry(path: string): void {
  if (!existsSync(path)) return;
  const content = readTOML(path);
  if (!hasRemoteHTTPForm(content)) return;
  writeTOML(path, removeDosuFromTOML(content));
}

export const CodexProvider = (): SetupProvider => ({
  name: () => "Codex (CLI + Desktop)",
  id: () => "codex",
  supportsLocal: () => true,
  priority: () => 8,
  detectPaths: () => ["~/.codex"],
  isInstalled: () => isInstalled(["~/.codex"]),
  globalConfigPath: () => join(codexHome(), "config.toml"),
  isConfigured: () => {
    const content = readTOML(join(codexHome(), "config.toml"));
    return content.includes("[mcp_servers.dosu]");
  },
  isCurrent: (cfg) =>
    entryHasShape(
      dosuEntry(shapeEndpoint(cfg), ANY, ANY, npxPathEnv(join(ANY, "npx"))),
      readDosuEntry(readTOML(join(codexHome(), "config.toml"))),
    ),
  install(cfg: Config, global: boolean): void {
    if (cfg.mode !== MODE_OSS && !cfg.active_account?.target?.deployment_id)
      throw new Error("deployment ID is required");
    // A project-local install must never rewrite the global config — other projects rely on that
    // entry and on its deployment — but a legacy entry there merges into ours and breaks Codex
    // outright. Stop with the remedy rather than silently deleting it or writing a broken config.
    if (!global && hasRemoteHTTPForm(readTOML(getConfigPath(true)))) {
      throw new Error(
        "the global Codex config still holds the legacy remote-HTTP Dosu entry, which Codex would " +
          "merge with a project-local entry and reject. Migrate it first with " +
          "`dosu mcp add codex --global`, then re-run this.",
      );
    }
    const written = getConfigPath(global);
    installDosuToTOML(written, cfg);
    for (const path of projectConfigPaths()) {
      if (path !== written) pruneLegacyRemoteEntry(path);
    }
  },
  remove(global: boolean): void {
    const path = getConfigPath(global);
    const content = readTOML(path);
    if (content) writeTOML(path, removeDosuFromTOML(content));
  },
});
