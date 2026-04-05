/**
 * Local OAuth callback server.
 */

import { MODE_OSS, type SetupMode } from "../config/config";

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  email?: string;
  mode?: SetupMode;
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
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
}
.container {
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
    margin-bottom: 8px;
}
.subtitle {
    font-size: 16px;
    color: #666;
    margin-bottom: 8px;
}
.email {
    font-size: 14px;
    color: #999;
    margin-bottom: 28px;
}
.card {
    background: #fff;
    border: 1px solid #eaeaea;
    border-radius: 8px;
    padding: 16px 20px;
    font-size: 16px;
    color: #666;
    line-height: 1.5;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
}
.card:hover {
    background: #f5f5f5;
    border-color: #ccc;
}
.close-hint {
    margin-top: 20px;
    font-size: 14px;
    color: #999;
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
    <p class="subtitle">You're all set. The CLI is now authenticated.</p>
    ${emailLine}
    <div class="card" id="close-card" onclick="tryClose()">Close this tab and return to your terminal.</div>
    <p class="close-hint" id="close-hint">This tab will close automatically in <span id="countdown">10</span>s</p>
</div>
<script>
function tryClose(){
    window.close();
    setTimeout(function(){
        var c=document.getElementById('close-card');
        c.textContent='You can close this tab now.';
        c.style.cursor='default';
        c.onclick=null;
        var h=document.getElementById('close-hint');
        if(h)h.style.display='none';
        clearInterval(t);
    },500);
}
var s=10,el=document.getElementById('countdown');
var t=setInterval(function(){if(--s<=0){clearInterval(t);tryClose();}el.textContent=s;},1000);
</script>
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

  const tokenPromise = new Promise<TokenResponse>((resolve) => {
    resolveToken = resolve;
  });

  const http = require("node:http") as typeof import("node:http");

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost`);

    if (url.pathname !== "/callback") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const accessToken = url.searchParams.get("access_token");
    const refreshToken = url.searchParams.get("refresh_token");
    const expiresIn = url.searchParams.get("expires_in");
    const email = url.searchParams.get("email");
    const mode = url.searchParams.get("mode");

    if (!accessToken) {
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

    resolveToken?.({
      access_token: accessToken,
      refresh_token: refreshToken && refreshToken !== "null" ? refreshToken : "",
      expires_in: expiresInInt,
      email: email ?? undefined,
      ...(mode === MODE_OSS && { mode: MODE_OSS }),
    });

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(buildSuccessHtml(email ?? undefined));
  });

  // Listen on random port and wait for it to be ready
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "localhost", () => resolve());
  });
  const addr = httpServer.address() as import("node:net").AddressInfo;

  return {
    server: {
      port: addr.port,
      close: () => httpServer.close(),
    },
    tokenPromise,
  };
}
