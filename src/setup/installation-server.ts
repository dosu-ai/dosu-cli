/**
 * Local HTTP server that receives the GitHub App installation callback from
 * the web `/cli/connect-github-done` page.
 *
 * Sibling of `auth/server.ts` (OAuth callback) — same shape, different payload.
 * Waits for exactly one GET on `/callback?installation_id=<int>` and resolves
 * the pending promise with the installation id.
 */

import { logger } from "../debug/logger";

export interface InstallationResponse {
  installation_id: number;
}

export interface InstallationCallbackServer {
  port: number;
  close: () => void;
}

const SUCCESS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Dosu CLI - GitHub Connected</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #fafafa; color: #171717; min-height: 100vh;
    display: flex; align-items: center; justify-content: center; padding: 20px;
  }
  .container { max-width: 420px; width: 100%; text-align: center; }
  h1 { font-size: 24px; font-weight: 600; letter-spacing: -0.02em; margin-bottom: 8px; }
  .msg { font-size: 16px; color: #666; }
</style>
</head>
<body>
<div class="container">
  <h1>GitHub App connected</h1>
  <p class="msg">You can close this tab and return to your terminal.</p>
</div>
</body>
</html>`;

export async function startInstallationCallbackServer(): Promise<{
  server: InstallationCallbackServer;
  installationPromise: Promise<InstallationResponse>;
}> {
  let resolveInstallation: (resp: InstallationResponse) => void;
  const installationPromise = new Promise<InstallationResponse>((resolve) => {
    resolveInstallation = resolve;
  });

  const http = require("node:http") as typeof import("node:http");

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname !== "/callback") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const installationIdStr = url.searchParams.get("installation_id");
    const installationId = installationIdStr ? parseInt(installationIdStr, 10) : Number.NaN;

    if (!installationIdStr || Number.isNaN(installationId)) {
      logger.warn("installation.server", "Missing or invalid installation_id");
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing installation_id");
      return;
    }

    logger.info("installation.server", `installation_id=${installationId} received`);
    resolveInstallation?.({ installation_id: installationId });

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(SUCCESS_HTML);
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, "localhost", () => resolve());
  });
  const addr = httpServer.address() as import("node:net").AddressInfo;
  logger.info("installation.server", `Listening on port ${addr.port}`);

  return {
    server: {
      port: addr.port,
      close: () => httpServer.close(),
    },
    installationPromise,
  };
}
