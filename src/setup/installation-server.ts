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
    background: #fafafa;
    color: #171717;
    min-height: 100vh;
    position: relative;
    padding: 20px;
  }
  .container {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    max-width: 520px;
    width: 100%;
    text-align: center;
  }
  .connection-visual {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 16px;
    margin-bottom: 34px;
  }
  .logo-node {
    width: 64px;
    height: 64px;
    display: grid;
    place-items: center;
    border-radius: 12px;
    background: #f7f7f7;
  }
  .dosu-node {
    box-shadow:
      0 0 0 1px rgba(132, 204, 22, 0.2),
      0 2px 4px rgba(132, 204, 22, 0.12),
      0 0 0 4px rgba(132, 204, 22, 0.2);
  }
  .github-node {
    box-shadow:
      0 0 0 1px rgba(0, 0, 0, 0.1),
      0 2px 4px rgba(0, 0, 0, 0.6),
      0 0 0 4px rgba(0, 0, 0, 0.1);
  }
  .logo-node svg {
    display: block;
  }
  .dosu-mark {
    width: 40px;
    height: 42px;
  }
  .connect-icon {
    width: 96px;
    height: 40px;
    color: #171717;
  }
  .github-mark {
    width: 40px;
    height: 40px;
    fill: #171717;
  }
  h1 {
    font-size: 24px;
    font-weight: 600;
    letter-spacing: -0.02em;
    margin-bottom: 18px;
  }
  .msg {
    font-size: 16px;
    color: #666;
  }
  .tip {
    position: fixed;
    left: 50%;
    bottom: 28px;
    transform: translateX(-50%);
    width: calc(100vw - 48px);
    text-align: center;
    font-size: 14px;
    line-height: 1.5;
    color: #666;
    white-space: nowrap;
  }
  .tip-rule {
    display: flex;
    align-items: center;
    gap: 12px;
    width: min(720px, 100%);
    margin-bottom: 14px;
    margin-left: auto;
    margin-right: auto;
  }
  .tip-rule::before,
  .tip-rule::after {
    content: "";
    flex: 1;
    height: 1px;
    background: #eeeeee;
  }
  .tip-dot {
    width: 3px;
    height: 3px;
    border-radius: 999px;
    background: #dddddd;
  }
  .tip-label {
    font-weight: 600;
    color: #171717;
  }
  @media (max-width: 900px) {
    .tip {
      white-space: normal;
    }
  }
</style>
</head>
<body>
<div class="container">
  <div class="connection-visual" aria-hidden="true">
    <div class="logo-node dosu-node">
      <svg class="dosu-mark" viewBox="0 0 86 89" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M5.29236 12.7928L17.7593 6.68188V72.5667L5.29236 84.0618V12.7928Z" fill="#B4BB91"/>
        <path d="M18.2575 73.1196L59.1329 72.748L51.7011 82.4095L29.0338 86.291L6.23962 85.1554L18.2575 73.1196Z" fill="#778561"/>
        <path d="M17.4916 3.73633L3.58557 12.7099V83.5792C3.58557 84.7542 4.98563 85.3652 5.84705 84.566L19.6296 71.7801" stroke="black" stroke-width="6.42844" stroke-linecap="round"/>
        <mask id="github-success-dosu-mask" fill="white">
          <path fill-rule="evenodd" clip-rule="evenodd" d="M40.704 0.518066H17.0439V76.2221H40.704H42.5805H47.8013C68.7064 76.2221 85.6533 59.2752 85.6533 38.3701C85.6533 17.465 68.7063 0.518066 47.8013 0.518066H42.5805H40.704Z"/>
        </mask>
        <path fill-rule="evenodd" clip-rule="evenodd" d="M40.704 0.518066H17.0439V76.2221H40.704H42.5805H47.8013C68.7064 76.2221 85.6533 59.2752 85.6533 38.3701C85.6533 17.465 68.7063 0.518066 47.8013 0.518066H42.5805H40.704Z" fill="#F3F6F1"/>
        <path d="M17.0439 0.518066V-6.57919H9.94669V0.518066H17.0439ZM17.0439 76.2221H9.94669V83.3194H17.0439V76.2221ZM17.0439 7.61532H40.704V-6.57919H17.0439V7.61532ZM24.1412 76.2221V0.518066H9.94669V76.2221H24.1412ZM40.704 69.1249H17.0439V83.3194H40.704V69.1249ZM42.5805 69.1249H40.704V83.3194H42.5805V69.1249ZM47.8013 69.1249H42.5805V83.3194H47.8013V69.1249ZM78.556 38.3701C78.556 55.3555 64.7867 69.1249 47.8013 69.1249V83.3194C72.6261 83.3194 92.7505 63.1949 92.7505 38.3701H78.556ZM47.8013 7.61532C64.7866 7.61532 78.556 21.3847 78.556 38.3701H92.7505C92.7505 13.5453 72.626 -6.57919 47.8013 -6.57919V7.61532ZM42.5805 7.61532H47.8013V-6.57919H42.5805V7.61532ZM40.704 7.61532H42.5805V-6.57919H40.704V7.61532Z" fill="black" mask="url(#github-success-dosu-mask)"/>
        <path d="M68.9215 36.0135C68.9215 36.0135 65.7369 49.4738 51.4231 49.4738C37.1093 49.4738 32.5787 37.3596 32.5787 36.0135" stroke="black" stroke-width="7.69161" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M0.348633 85.4946C0.348633 85.4946 29.4856 85.8309 34.809 85.698C44.8337 85.4477 51.2872 84.402 57.5269 78.9724C62.8129 74.3727 75.1342 59.6836 75.1342 59.6836" stroke="black" stroke-width="6.16482"/>
      </svg>
    </div>
    <svg class="connect-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 98 35" fill="none">
      <path d="M0.219664 27.9926C-0.0732364 28.2855 -0.0732364 28.7604 0.219664 29.0533L4.99263 33.8262C5.28553 34.1191 5.7604 34.1191 6.05329 33.8262C6.34618 33.5334 6.34618 33.0585 6.05329 32.7656L1.81065 28.5229L6.05329 24.2803C6.34618 23.9874 6.34618 23.5125 6.05329 23.2196C5.7604 22.9268 5.28553 22.9268 4.99263 23.2196L0.219664 27.9926ZM23.4637 20.5306L23.9334 21.1154L23.4637 20.5306ZM36.7859 9.83041L37.2556 10.4151L36.7859 9.83041ZM75.0238 20.8781L75.4935 20.2934L61.7387 9.24567L61.269 9.83041L60.7993 10.4151L74.5542 21.4629L75.0238 20.8781ZM36.7859 9.83041L36.3162 9.24567L22.9941 19.9459L23.4637 20.5306L23.9334 21.1154L37.2556 10.4151L36.7859 9.83041ZM23.4637 20.5306L22.9941 19.9459C16.687 25.0117 8.83963 27.7729 0.74999 27.7729V28.5229V29.2729C9.18123 29.2729 17.3599 26.3951 23.9334 21.1154L23.4637 20.5306ZM49.0275 5.52295V4.77295C44.4047 4.77295 39.9204 6.35084 36.3162 9.24567L36.7859 9.83041L37.2556 10.4151C40.5934 7.73424 44.7463 6.27295 49.0275 6.27295V5.52295ZM61.269 9.83041L61.7387 9.24567C58.1345 6.35084 53.6502 4.77295 49.0275 4.77295V5.52295V6.27295C53.3086 6.27295 57.4615 7.73424 60.7993 10.4151L61.269 9.83041ZM96.75 28.5229V27.7729C89.0195 27.7729 81.5206 25.1343 75.4935 20.2934L75.0238 20.8781L74.5542 21.4629C80.8476 26.5177 88.6779 29.2729 96.75 29.2729V28.5229Z" fill="currentColor" fill-opacity="0.2"/>
      <path d="M19.7805 23.1111L37.5316 9.15351C40.5229 6.8015 44.2177 5.52285 48.0229 5.52285" stroke="url(#paint0_linear_cli_connect)" stroke-width="1.5"/>
      <path d="M97.2803 6.05328C97.5732 5.76039 97.5732 5.28551 97.2803 4.99262L92.5074 0.219649C92.2145 -0.0732447 91.7396 -0.0732447 91.4467 0.219649C91.1538 0.512542 91.1538 0.987416 91.4467 1.28031L95.6893 5.52295L91.4467 9.76559C91.1538 10.0585 91.1538 10.5334 91.4467 10.8262C91.7396 11.1191 92.2145 11.1191 92.5074 10.8262L97.2803 6.05328ZM36.1431 23.369L36.6005 22.7746L36.1431 23.369ZM22.6322 12.9693L22.1748 13.5637L35.6856 23.9633L36.1431 23.369L36.6005 22.7746L23.0897 12.375L22.6322 12.9693ZM60.802 23.369L61.2595 23.9633L74.3306 13.9022L73.8731 13.3078L73.4157 12.7135L60.3446 22.7746L60.802 23.369ZM73.8731 13.3078L74.3306 13.9022C80.7574 8.95531 88.6398 6.27295 96.75 6.27295V5.52295V4.77295C88.3089 4.77295 80.1047 7.56478 73.4157 12.7135L73.8731 13.3078ZM48.4725 27.5646V28.3146C53.0982 28.3146 57.594 26.7847 61.2595 23.9633L60.802 23.369L60.3446 22.7746C56.9413 25.3942 52.7672 26.8146 48.4725 26.8146V27.5646ZM36.1431 23.369L35.6856 23.9633C39.3511 26.7847 43.8469 28.3146 48.4725 28.3146V27.5646V26.8146C44.1779 26.8146 40.0038 25.3942 36.6005 22.7746L36.1431 23.369ZM0.75 5.52295V6.27295C8.50036 6.27295 16.0331 8.8363 22.1748 13.5637L22.6322 12.9693L23.0897 12.375C16.6858 7.44577 8.83133 4.77295 0.75 4.77295V5.52295Z" fill="currentColor" fill-opacity="0.2"/>
      <path d="M77.3279 11.0334L69.669 16.5439L63.01 22.0543" stroke="url(#paint1_linear_cli_connect)" stroke-width="1.5"/>
      <defs>
        <linearGradient id="paint0_linear_cli_connect" x1="46.0229" y1="14.317" x2="19.7805" y2="14.317" gradientUnits="userSpaceOnUse">
          <stop stop-color="#4285F4" stop-opacity="0"/>
          <stop offset="1" stop-color="#4285F4"/>
        </linearGradient>
        <linearGradient id="paint1_linear_cli_connect" x1="77.1134" y1="10.9348" x2="62.4434" y2="18.8207" gradientUnits="userSpaceOnUse">
          <stop stop-color="#5CB712"/>
          <stop offset="1" stop-color="#5CB712" stop-opacity="0"/>
        </linearGradient>
      </defs>
    </svg>
    <div class="logo-node github-node">
      <svg class="github-mark" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
        <path fill-rule="evenodd" clip-rule="evenodd" d="M10 0C4.477 0 0 4.484 0 10.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0110 4.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.203 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.942.359.31.678.921.678 1.856 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0020 10.017C20 4.484 15.522 0 10 0z"/>
      </svg>
    </div>
  </div>
  <h1>GitHub App connected</h1>
  <p class="msg">You can close this tab and return to your terminal.</p>
</div>
<div class="tip">
  <div class="tip-rule" aria-hidden="true"><span class="tip-dot"></span></div>
  <span class="tip-label">Did you know?</span>
  You can use Dosu to make your coding agents faster and cheaper. Just ask your agent to use Dosu to update your AGENTS.md.
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
