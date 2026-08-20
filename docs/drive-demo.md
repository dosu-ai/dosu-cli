# How to demo Dosu Drive on macOS

Use one Mac as a persistent Drive Host. Nearby teammates can select one or more repositories,
review the matching local agent sessions, upload the approved redacted copies, and then disconnect.
The team can search the Host from the CLI, dashboard, or Codex MCP.

## Prerequisites

- Every Mac is on the same local network.
- Node.js 22 or newer and npm are installed.
- Each contributor has at least one local Git repository with Claude Code, Codex, or another
  deja-vu-supported session associated with it.
- The Host stays online while the team searches the Drive. Contributors do not need to remain
  online after setup finishes.

## 1. Install the internal alpha

Send `dosu-cli-0.48.2.tgz` to each participant, then run:

```bash
npm install -g ./dosu-cli-0.48.2.tgz
dosu --version
npx -y --package @vshulcz/deja-vu@0.17.3 deja version
```

Expected versions:

```text
v0.48.2
deja 0.17.3
```

The final command downloads and warms the pinned session parser before the meeting.

## 2. Start the Drive Host

On the Host Mac:

```bash
dosu drive host --name "Build Week Drive"
```

Leave this terminal running. It prints the dashboard URL and the command teammates use:

```text
Dosu Drive is ready
Dashboard: http://<host-ip>:7777

Nearby join:
  dosu drive join
```

Open the dashboard URL to show that the Drive begins empty and is waiting for contributions.

## 3. Join and add repositories

On each contributor Mac, start inside a repository you may want to share:

```bash
cd /path/to/a/repository
dosu drive join
```

Select **Build Week Drive** from the nearby Host list and press Enter. Setup starts immediately.

At **Choose repositories to add**:

1. Press Space to toggle every repository you want to include.
2. Select **Browse…** if a repository is not listed.
3. Press Enter to continue.

For an explicit multi-repository setup, use:

```bash
dosu drive setup --repo /path/to/repo-a /path/to/repo-b
```

The scan reports only sessions associated with the selected repositories before anything uploads:

```text
Found 12 project-associated sessions
Found 7 sessions associated with /path/to/repo-a. Only these sessions can be uploaded; other projects are excluded.
Found 5 sessions associated with /path/to/repo-b. Only these sessions can be uploaded; other projects are excluded.
Nothing has been uploaded.
```

## 4. Review and approve the local preview

The terminal prints the credential-redaction count, asks to open the preview, and shows its
loopback-only URL:

```text
Review exactly what will be uploaded
Inspect every selected session and exclude anything before it leaves this computer.
Safety check: 3 potential credentials detected and replaced.
http://127.0.0.1:<port>/preview
```

In the preview:

1. Inspect the repository, agent, date, sample, record count, and redaction count.
2. Clear the checkbox for any session you do not want to share.
3. Click **Approve & Upload**.

The terminal confirms the durable central index is ready:

```text
Drive index is ready
Uploaded 10 sessions from 2 repositories to Build Week Drive. You may close this terminal or disconnect from the network.
```

The local source sessions are never modified or deleted. Dosu removes only its own temporary scan
workspace after the upload. The Host keeps the approved redacted Packages and its isolated deja-vu
index.

## 5. Search the shared Drive

From any Mac that joined the Drive:

```bash
dosu drive status
dosu drive search "why did we change the retry policy"
```

Filter by the exact repository name when useful:

```bash
dosu drive search "retry policy" --repo api-service
```

Each result includes the contributor, repository, agent, matching evidence, and an evidence ID. The
same search is available from the Host dashboard.

## 6. Add the Drive MCP to Codex

On each Mac that should expose Drive knowledge to Codex:

```bash
dosu drive mcp add codex
dosu drive mcp status
```

This adds a separate `dosu-drive` MCP server and preserves existing MCP entries. Start a new Codex
session, then ask:

```text
Use search_drive to find why we changed the retry policy. Read the strongest result with read_drive_evidence and cite the contributor and repository.
```

The MCP exposes exactly two tools:

- `search_drive`: search the active team Drive.
- `read_drive_evidence`: read the complete redacted records behind a result ID.

## 7. Stop and restart without losing the Drive

From a second terminal on the Host Mac:

```bash
dosu drive stop
```

Restart later with:

```bash
dosu drive host
```

The existing Drive name, Packages, contributors, and central index are restored. `dosu drive
destroy` is intentionally not part of the demo because this Drive is long-lived.

## Troubleshooting

### No nearby Drive appears

Confirm both Macs are on the same Wi-Fi and that the Host terminal is still running. Then use the
dashboard URL printed by the Host as a direct fallback:

```bash
dosu drive join http://<host-ip>:7777
```

If port 7777 is occupied, restart the Host on another port:

```bash
dosu drive host --port 7788
```

### No sessions match a repository

Confirm the path is inside a Git repository and that the local agent sessions were created while
working in that repository. Retry with explicit repository roots:

```bash
dosu drive setup --repo /absolute/path/to/repo-a /absolute/path/to/repo-b
```

### The first scan is slow

deja-vu is fetched through `npx` on first use. Run the warm-up command from Step 1 on every Mac
before the demo.

### Codex does not show the Drive tools

Run `dosu drive mcp status`, then start a new Codex session. The MCP reads the active Drive saved by
`dosu drive join`.

## Command reference

| Command | Purpose |
| --- | --- |
| `dosu drive host` | Start or restore the persistent Host and advertise it on the LAN. |
| `dosu drive join` | Discover a nearby Host, join immediately, and start repository setup. |
| `dosu drive setup` | Add one or more repositories to the active Drive. |
| `dosu drive search <query>` | Search the active Drive, optionally with `--repo <name>`. |
| `dosu drive status` | Show Host, repository, session, record, and index status. |
| `dosu drive stop` | Stop the Host while retaining Packages and the central index. |
| `dosu drive mcp add codex` | Add the separate Drive MCP to Codex. |
| `dosu drive mcp status` | Show Codex/Claude MCP configuration and active Drive status. |
| `dosu drive mcp remove codex` | Remove only the Drive MCP entry from Codex. |
