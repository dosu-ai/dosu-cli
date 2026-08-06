/**
 * Embedded Claude Code status-line renderer.
 *
 * The npm package ships as a single bundled file and the native release as a
 * single compiled binary, so this script must be embedded rather than read
 * from the repository at runtime. Two hard constraints on the embedded source:
 *
 *  - No backticks — they terminate the String.raw template (and escaping
 *    doesn't help, since String.raw keeps the backslash).
 *  - ASCII only — Bun's transpiler rewrites non-ASCII characters into JS
 *    \u{...} escapes even inside String.raw, so a literal emoji ships as the
 *    escape text and breaks the Python. Use Python's own \uXXXX / \UXXXXXXXX
 *    escapes instead (they pass through String.raw untouched).
 *
 * The per-session state it renders is written by 'dosu hooks post-tool-use' /
 * 'stop' (src/statusline/state.ts) — STATE_DIR here must match
 * knowledgeStateDir() exactly.
 */

export const STATUS_LINE_SOURCE = String.raw`#!/usr/bin/env python3
"""Claude Code status line: Dosu knowledge only.

Shows how much knowledge Dosu last delivered to this session: org-knowledge
pages and branch notes. Prints nothing until a delivery happens (that empty
pre-delivery state is deliberate).

Populated by 'dosu hooks post-tool-use' / 'dosu hooks stop'.
"""

import json
import os
import sys

STATE_DIR = os.path.expanduser("~/.dosu/statusline-state")
SEPARATOR = " \u00b7 "
BOOKS = "\U0001f4da"
MEMO = "\U0001f4dd"


def plural(count, word):
    return f"{count} {word}" if count == 1 else f"{count} {word}s"


def knowledge_row(session_id):
    path = os.path.join(STATE_DIR, f"{session_id}.knowledge.json")
    try:
        with open(path) as handle:
            state = json.load(handle)
    except (OSError, json.JSONDecodeError, TypeError):
        return None

    parts = []
    if state.get("pages"):
        parts.append(BOOKS + " " + plural(state["pages"], "page"))
    # Absent whenever the lookup omitted repo/branch, so only show when present.
    if state.get("notes"):
        parts.append(MEMO + " " + plural(state["notes"], "note"))

    if not parts:
        return None
    return "\033[2mKnowledge\033[0m " + SEPARATOR.join(parts)


def main():
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError, TypeError):
        return

    row = knowledge_row(data.get("session_id") or "")
    if row:
        print(row)


if __name__ == "__main__":
    main()
`;
