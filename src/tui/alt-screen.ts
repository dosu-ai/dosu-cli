/** Refcounted alternate-screen control: alt-screen mode doesn't nest, so only the outermost
 * enter/leave pair switches buffers; nested views repaint in place. */

const ESC = String.fromCharCode(27);
export const ALT_SCREEN_ENTER = `${ESC}[?1049h`;
export const ALT_SCREEN_EXIT = `${ESC}[?1049l`;

let depth = 0;

/** Enter the alternate screen and return an idempotent release; nested callers must repaint. */
export function enterAltScreen(output: { write(text: string): unknown }): () => void {
  depth += 1;
  if (depth === 1) output.write(ALT_SCREEN_ENTER);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    depth -= 1;
    if (depth === 0) output.write(ALT_SCREEN_EXIT);
  };
}
