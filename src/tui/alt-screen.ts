/**
 * Refcounted alternate-screen-buffer control. Alt-screen mode doesn't nest
 * (the first `?1049l` drops back to the primary screen), so only the
 * outermost enter/leave pair switches buffers; nested views repaint in place.
 */

const ESC = String.fromCharCode(27);
export const ALT_SCREEN_ENTER = `${ESC}[?1049h`;
export const ALT_SCREEN_EXIT = `${ESC}[?1049l`;

let depth = 0;

/**
 * Enter the alternate screen and return an idempotent release function.
 * Nested callers must repaint their caller's screen after releasing.
 */
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
