/**
 * Marker contract for the canonical miner rules maintained in the dosu-skill
 * repo (skills/log-to-dosu-knowledge/references/miner-system-prompt.md).
 * Shared by the runtime resolver (prompt-source.ts), the vendoring script
 * (scripts/vendor-miner-prompt.ts), and the drift test.
 */

export const MINER_CORE_START = "<!-- dosu:miner-core:start -->";
export const MINER_CORE_END = "<!-- dosu:miner-core:end -->";

/** The verbatim rules block between the markers, trimmed. Throws when absent. */
export function extractMinerCore(markdown: string): string {
  const start = markdown.indexOf(MINER_CORE_START);
  const end = markdown.indexOf(MINER_CORE_END);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      `miner-core markers not found (expected ${MINER_CORE_START} … ${MINER_CORE_END})`,
    );
  }
  return markdown.slice(start + MINER_CORE_START.length, end).trim();
}
