/**
 * Swap @clack/prompts diamond symbols so that:
 *   active/in-progress = ◇ (hollow)
 *   submitted/complete = ◆ (filled)
 *
 * Default clack convention is the opposite. This runs as a postinstall hook.
 */

import { existsSync } from "node:fs";

const files = [
  "node_modules/@clack/prompts/dist/index.cjs",
  "node_modules/@clack/prompts/dist/index.mjs",
];

for (const rel of files) {
  const path = `${import.meta.dir}/../${rel}`;
  if (!existsSync(path)) continue;

  let content = await Bun.file(path).text();

  // Submit symbol: ◇ → ◆  (fallback char is "o")
  content = content.replace(
    String.raw`u("\u25C7","o")`,
    String.raw`u("\u25C6","o")`,
  );

  // Active symbol: ◆ → ◇  (fallback char is "*", first occurrence only)
  content = content.replace(
    String.raw`u("\u25C6","*")`,
    String.raw`u("\u25C7","*")`,
  );

  await Bun.write(path, content);
}
