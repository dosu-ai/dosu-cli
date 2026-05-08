/**
 * Local OAuth callback server.
 */

import { logger } from "../debug/logger";
import { OAuthCallbackError } from "./errors";

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  email?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildErrorHtml(message: string): string {
  const safe = escapeHtml(message);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Dosu CLI - Authentication Failed</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #fafafa;
    color: #171717;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
}
.container {
    max-width: 480px;
    width: 100%;
    text-align: center;
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    padding: 40px 32px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
}
h1 { font-size: 20px; font-weight: 600; color: #b91c1c; margin-bottom: 12px; }
p { font-size: 14px; color: #4b5563; line-height: 1.5; }
.detail { margin-top: 16px; padding: 12px; background: #fef2f2; border-radius: 8px; color: #991b1b; font-size: 13px; }
.next { margin-top: 20px; color: #6b7280; font-size: 13px; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #f3f4f6; padding: 2px 6px; border-radius: 4px; color: #111827; }
</style>
</head>
<body>
<div class="container">
    <h1>Authentication Failed</h1>
    <p>The OAuth flow could not be completed.</p>
    <div class="detail">${safe}</div>
    <p class="next">You can close this tab. In your terminal, run <code>dosu login</code> again.</p>
</div>
</body>
</html>`;
}

const CALLBACK_HTML_EXTRACT = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Dosu CLI - Completing Authentication</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #fafafa;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
}
.container {
    background: white;
    border-radius: 12px;
    padding: 48px 40px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
    max-width: 480px;
    width: 100%;
    text-align: center;
    border: 1px solid #e5e7eb;
}
.spinner {
    width: 48px;
    height: 48px;
    border: 4px solid #e5e7eb;
    border-top-color: #3b82f6;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin: 0 auto 24px;
}
@keyframes spin { to { transform: rotate(360deg); } }
h1 { font-size: 20px; font-weight: 600; color: #111827; margin-bottom: 8px; }
p { font-size: 14px; color: #6b7280; }
</style>
</head>
<body>
<div class="container">
    <div class="spinner"></div>
    <h1>Completing authentication...</h1>
    <p>Please wait</p>
</div>
<script>
const hash = window.location.hash.substring(1);
if (hash) {
    const params = new URLSearchParams(hash);
    const token = params.get('access_token');
    const refresh = params.get('refresh_token') || '';
    const expires = params.get('expires_in') || '';
    const email = params.get('email');
    if (token) {
        window.location.href = '/callback?access_token=' + encodeURIComponent(token) +
            '&refresh_token=' + encodeURIComponent(refresh) +
            '&expires_in=' + encodeURIComponent(expires) +
            (email ? '&email=' + encodeURIComponent(email) : '');
    }
}
</script>
</body>
</html>`;

function buildSuccessHtml(email?: string): string {
  const emailLine = email
    ? `<p class="email">Signed in as <strong>${email.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</strong></p>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Dosu CLI - Authentication Successful</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
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
    max-width: 420px;
    width: 100%;
    text-align: center;
}
.logo {
    width: 52px;
    height: 52px;
    margin: 0 auto 28px;
}
h1 {
    font-size: 24px;
    font-weight: 600;
    color: #171717;
    letter-spacing: -0.02em;
    margin-bottom: 18px;
}
.email {
    font-size: 14px;
    color: #999;
    margin-bottom: 18px;
}
.close-msg {
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
    <div class="logo">
        <svg width="52" height="54" viewBox="0 0 86 89" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M5.29236 12.7928L17.7593 6.68188V72.5667L5.29236 84.0618V12.7928Z" fill="#B4BB91"/>
        <path d="M18.2575 73.1196L59.1329 72.748L51.7011 82.4095L29.0338 86.291L6.23962 85.1554L18.2575 73.1196Z" fill="#778561"/>
        <path d="M17.4916 3.73633L3.58557 12.7099V83.5792C3.58557 84.7542 4.98563 85.3652 5.84705 84.566L19.6296 71.7801" stroke="black" stroke-width="6.42844" stroke-linecap="round"/>
        <mask id="path-4-inside-1_355_26707" fill="white">
        <path fill-rule="evenodd" clip-rule="evenodd" d="M40.704 0.518066H17.0439V76.2221H40.704H42.5805H47.8013C68.7064 76.2221 85.6533 59.2752 85.6533 38.3701C85.6533 17.465 68.7063 0.518066 47.8013 0.518066H42.5805H40.704Z"/>
        </mask>
        <path fill-rule="evenodd" clip-rule="evenodd" d="M40.704 0.518066H17.0439V76.2221H40.704H42.5805H47.8013C68.7064 76.2221 85.6533 59.2752 85.6533 38.3701C85.6533 17.465 68.7063 0.518066 47.8013 0.518066H42.5805H40.704Z" fill="#F3F6F1"/>
        <path d="M17.0439 0.518066V-6.57919H9.94669V0.518066H17.0439ZM17.0439 76.2221H9.94669V83.3194H17.0439V76.2221ZM17.0439 7.61532H40.704V-6.57919H17.0439V7.61532ZM24.1412 76.2221V0.518066H9.94669V76.2221H24.1412ZM40.704 69.1249H17.0439V83.3194H40.704V69.1249ZM42.5805 69.1249H40.704V83.3194H42.5805V69.1249ZM47.8013 69.1249H42.5805V83.3194H47.8013V69.1249ZM78.556 38.3701C78.556 55.3555 64.7867 69.1249 47.8013 69.1249V83.3194C72.6261 83.3194 92.7505 63.1949 92.7505 38.3701H78.556ZM47.8013 7.61532C64.7866 7.61532 78.556 21.3847 78.556 38.3701H92.7505C92.7505 13.5453 72.626 -6.57919 47.8013 -6.57919V7.61532ZM42.5805 7.61532H47.8013V-6.57919H42.5805V7.61532ZM40.704 7.61532H42.5805V-6.57919H40.704V7.61532Z" fill="black" mask="url(#path-4-inside-1_355_26707)"/>
        <path d="M68.9215 36.0135C68.9215 36.0135 65.7369 49.4738 51.4231 49.4738C37.1093 49.4738 32.5787 37.3596 32.5787 36.0135" stroke="black" stroke-width="7.69161" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M0.348633 85.4946C0.348633 85.4946 29.4856 85.8309 34.809 85.698C44.8337 85.4477 51.2872 84.402 57.5269 78.9724C62.8129 74.3727 75.1342 59.6836 75.1342 59.6836" stroke="black" stroke-width="6.16482"/>
        </svg>
    </div>
    <h1>Authentication Successful</h1>
    ${emailLine}
    <p class="close-msg">You can close this tab and return to your terminal.</p>
</div>
<div class="tip">
    <div class="tip-rule" aria-hidden="true"><span class="tip-dot"></span></div>
    <span class="tip-label">Did you know?</span>
    You can use Dosu to make your coding agents faster and cheaper. Just ask your agent to use Dosu to update your AGENTS.md.
</div>
</body>
</html>`;
}

export interface CallbackServer {
  port: number;
  close: () => void;
}

/**
 * Starts a local HTTP server to receive the OAuth callback.
 * Returns a promise that resolves with the token when received.
 */
export async function startCallbackServer(): Promise<{
  server: CallbackServer;
  tokenPromise: Promise<TokenResponse>;
}> {
  let resolveToken: (token: TokenResponse) => void;
  let rejectToken: (err: Error) => void;

  const tokenPromise = new Promise<TokenResponse>((resolve, reject) => {
    resolveToken = resolve;
    rejectToken = reject;
  });

  const http = require("node:http") as typeof import("node:http");

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost`);

    const cookieLen = (req.headers.cookie ?? "").length;
    const ua = req.headers["user-agent"] ?? "none";
    logger.debug(
      "auth.server",
      `Request: ${req.method} ${req.url} cookie-len=${cookieLen} ua=${ua} has-token=${url.searchParams.has("access_token")}`,
    );

    if (url.pathname !== "/callback") {
      logger.debug("auth.server", `404: ${url.pathname}`);
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    // OAuth error forwarded by the web side — reject so the CLI exits now.
    const errorParam = url.searchParams.get("error");
    const errorCodeParam = url.searchParams.get("error_code");
    const errorDescriptionParam = url.searchParams.get("error_description");
    if (errorParam || errorCodeParam || errorDescriptionParam) {
      const rawDescription =
        errorDescriptionParam ?? errorCodeParam ?? errorParam ?? "OAuth authentication failed";
      // Tag-strip for plaintext surfaces; HTML escape happens in the template.
      const sanitized = rawDescription.replace(/<[^>]*>/g, "");
      logger.warn(
        "auth.server",
        `OAuth callback received error: code=${errorCodeParam ?? "n/a"} description=${sanitized}`,
      );
      rejectToken?.(
        new OAuthCallbackError(sanitized, {
          error: errorParam ?? undefined,
          errorCode: errorCodeParam ?? undefined,
          errorDescription: sanitized,
        }),
      );
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(buildErrorHtml(rawDescription));
      return;
    }

    const accessToken = url.searchParams.get("access_token");
    const refreshToken = url.searchParams.get("refresh_token");
    const expiresIn = url.searchParams.get("expires_in");
    const email = url.searchParams.get("email");

    if (!accessToken) {
      logger.debug("auth.server", "Served extract HTML (no token in query)");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(CALLBACK_HTML_EXTRACT);
      return;
    }

    // Parse expiry (default 1 hour)
    let expiresInInt = 3600;
    if (expiresIn) {
      const parsed = parseInt(expiresIn, 10);
      if (!Number.isNaN(parsed)) expiresInInt = parsed;
    }

    logger.info("auth.server", `Token resolved, email=${email ?? "none"}`);
    resolveToken?.({
      access_token: accessToken,
      refresh_token: refreshToken && refreshToken !== "null" ? refreshToken : "",
      expires_in: expiresInInt,
      email: email ?? undefined,
    });

    logger.info("auth.server", "Served success HTML");
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(buildSuccessHtml(email ?? undefined));
  });

  // Listen on random port and wait for it to be ready
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "localhost", () => resolve());
  });
  const addr = httpServer.address() as import("node:net").AddressInfo;
  logger.info("auth.server", `Callback server listening on port ${addr.port}`);

  return {
    server: {
      port: addr.port,
      close: () => httpServer.close(),
    },
    tokenPromise,
  };
}
