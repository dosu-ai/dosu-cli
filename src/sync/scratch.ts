/** Scratch working directories: sessions run in a temp dir are benchmark replays, throwaway
 * repros and agent sandboxes, not work worth teaching the team's memory. Shipping is on by
 * default, so these are settled locally instead of uploaded. */

import { tmpdir } from "node:os";
import { isUnderDir } from "./watermark";

/** macOS keeps per-user temp dirs under /var/folders, reached through /private as well. */
const SCRATCH_ROOTS = ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];

export function isScratchDir(dir: string, osTmp: string = tmpdir()): boolean {
  return [...SCRATCH_ROOTS, osTmp].some((root) => isUnderDir(dir, root));
}
