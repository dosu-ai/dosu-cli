const unicode = supportsUnicode();

export const ACTIVE_SYMBOL = symbol("◆", "*");
export const SUBMIT_SYMBOL = symbol("◇", "o");
export const CANCEL_SYMBOL = symbol("■", "x");
export const BAR = symbol("│", "|");
export const FOOTER = symbol("└", "-");
export const CHECKBOX_OFF = symbol("◻", "[ ]");
export const CHECKBOX_ON = symbol("◼", "[+]");
export const ELLIPSIS = "...";

export function symbol(unicodeValue: string, asciiValue: string): string {
  return unicode ? unicodeValue : asciiValue;
}

function supportsUnicode(): boolean {
  if (process.platform !== "win32") {
    return process.env.TERM !== "linux";
  }
  /* v8 ignore start -- win32-only; cannot be exercised on Linux CI */
  return !!(
    process.env.CI ||
    process.env.WT_SESSION ||
    process.env.TERMINUS_SUBLIME ||
    process.env.ConEmuTask === "{cmd::Cmder}" ||
    process.env.TERM_PROGRAM === "Terminus-Sublime" ||
    process.env.TERM_PROGRAM === "vscode" ||
    process.env.TERM === "xterm-256color" ||
    process.env.TERM === "alacritty" ||
    process.env.TERMINAL_EMULATOR === "JetBrains-JediTerm"
  );
  /* v8 ignore stop */
}
