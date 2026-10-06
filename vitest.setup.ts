import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate every test file from the developer's real ~/.config/dosu-cli:
// the Client re-reads the config file during token refresh (multi-process
// self-healing), so any test exercising refresh paths would otherwise read
// — and could try to mutate — real credentials. Each vitest fork gets its
// own empty config home; tests that need specific config contents (e.g.
// config.test.ts) still override this per-test.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "dosu-vitest-"));

// Likewise the agents' own config: a test that reaches a hook or command installer without
// faking the home must write into a scratch ~/.claude (or ~/.codex, ~/.cursor), never the
// developer's. Tests that need a particular home still set their own.
process.env.HOME = mkdtempSync(join(tmpdir(), "dosu-vitest-home-"));
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;

// Tests run the same from an agent's shell as from CI: the session an agent names in the
// environment of the commands it runs (mcp/call-session.ts shellSessions) is the test's to set.
for (const name of [
  "AI_AGENT",
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_THREAD_ID",
  "PI_CODING_AGENT",
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
]) {
  delete process.env[name];
}
