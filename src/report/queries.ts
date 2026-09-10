/** Cursor / Claude user-query text, same rules as parse_agent_logs.extract_user_queries. */

const TITLE_CHARS = 80;
const USER_QUERY_RE = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/gi;
const TIMESTAMP_RE = /<timestamp>[\s\S]*?<\/timestamp>/gi;

export function extractUserQueries(text: string): string[] {
  const matches = [...text.matchAll(USER_QUERY_RE)].map((m) => m[1].trim()).filter(Boolean);
  if (matches.length > 0) return matches;
  const cleaned = text.replace(TIMESTAMP_RE, "").trim();
  if (
    cleaned.startsWith("# AGENTS.md") ||
    cleaned.startsWith("<INSTRUCTIONS>") ||
    cleaned.startsWith("<permissions instructions>")
  ) {
    return [];
  }
  return cleaned ? [cleaned] : [];
}

export function sessionTitleFromUserText(text: string, max = TITLE_CHARS): string {
  const first = extractUserQueries(text)[0] ?? "";
  const collapsed = first.replace(/\s+/g, " ").trim();
  if (collapsed.length > max) return `${collapsed.slice(0, max - 1).trimEnd()}…`;
  return collapsed;
}
