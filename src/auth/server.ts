/**
 * Local OAuth callback server.
 *
 * Equivalent to Go's internal/auth/server.go
 */

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
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
    const refresh = params.get('refresh_token');
    const expires = params.get('expires_in');
    if (token) {
        window.location.href = '/callback?access_token=' + encodeURIComponent(token) +
            '&refresh_token=' + encodeURIComponent(refresh) +
            '&expires_in=' + encodeURIComponent(expires);
    }
}
</script>
</body>
</html>`;

const CALLBACK_HTML_SUCCESS = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Dosu CLI - Authentication Successful</title>
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
.checkmark {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    background: #10b981;
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0 auto 24px;
}
.checkmark svg { width: 32px; height: 32px; stroke: white; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; fill: none; }
h1 { font-size: 24px; font-weight: 600; color: #111827; margin-bottom: 8px; }
.subtitle { font-size: 15px; color: #6b7280; margin-bottom: 28px; }
.info { background: #f9fafb; border-radius: 8px; padding: 16px; text-align: left; border: 1px solid #e5e7eb; }
.info p { font-size: 14px; color: #374151; line-height: 1.5; }
.info strong { display: block; margin-bottom: 4px; color: #111827; }
.footer { margin-top: 24px; font-size: 13px; color: #9ca3af; }
</style>
</head>
<body>
<div class="container">
    <div class="checkmark">
        <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
    </div>
    <h1>Authentication Successful</h1>
    <p class="subtitle">You've successfully authenticated the Dosu CLI</p>
    <div class="info">
        <p><strong>Next step:</strong> Return to your terminal to continue. You can safely close this window.</p>
    </div>
    <div class="footer">Dosu CLI</div>
</div>
</body>
</html>`;

export interface CallbackServer {
  port: number;
  close: () => void;
}

/**
 * Starts a local HTTP server to receive the OAuth callback.
 * Returns a promise that resolves with the token when received.
 */
export function startCallbackServer(): {
  server: CallbackServer;
  tokenPromise: Promise<TokenResponse>;
} {
  let resolveToken: (token: TokenResponse) => void;
  let rejectToken: (err: Error) => void;

  const tokenPromise = new Promise<TokenResponse>((resolve, reject) => {
    resolveToken = resolve;
    rejectToken = reject;
  });

  const server = Bun.serve({
    port: 0, // random available port
    hostname: "localhost",
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname !== "/callback") {
        return new Response("Not Found", { status: 404 });
      }

      const accessToken = url.searchParams.get("access_token");
      const refreshToken = url.searchParams.get("refresh_token");
      const expiresIn = url.searchParams.get("expires_in");

      if (!accessToken) {
        // Serve HTML that extracts token from URL fragment
        return new Response(CALLBACK_HTML_EXTRACT, {
          headers: { "Content-Type": "text/html" },
        });
      }

      // Parse expiry (default 1 hour)
      let expiresInInt = 3600;
      if (expiresIn) {
        const parsed = parseInt(expiresIn, 10);
        if (!isNaN(parsed)) expiresInInt = parsed;
      }

      // Send token to promise
      resolveToken!({
        access_token: accessToken,
        refresh_token: refreshToken ?? "",
        expires_in: expiresInInt,
      });

      return new Response(CALLBACK_HTML_SUCCESS, {
        headers: { "Content-Type": "text/html" },
      });
    },
  });

  return {
    server: {
      port: server.port,
      close: () => server.stop(),
    },
    tokenPromise,
  };
}
