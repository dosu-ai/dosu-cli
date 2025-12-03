package auth

import (
	"fmt"
	"net"
	"net/http"
)

// TokenResponse represents the OAuth token response from the web app
type TokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"` // seconds
}

// startCallbackServer starts a local HTTP server to receive the OAuth callback
// Returns the server instance and the port it's listening on
func startCallbackServer(tokenChan chan *TokenResponse, errChan chan error) (*http.Server, int) {
	mux := http.NewServeMux()

	// Handle OAuth callback from web app
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		// Try to get token from query params first
		accessToken := r.URL.Query().Get("access_token")
		refreshToken := r.URL.Query().Get("refresh_token")
		expiresIn := r.URL.Query().Get("expires_in")

		if accessToken == "" {
			// If no token in query params, serve HTML that extracts from URL fragment
			// This handles the case where the web app redirects with #access_token=...
			html := `<!DOCTYPE html>
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
</html>`

			w.Header().Set("Content-Type", "text/html")
			w.Write([]byte(html))
			return
		}

		// Parse expiry (default to 1 hour if not provided)
		expiresInInt := 3600
		if expiresIn != "" {
			fmt.Sscanf(expiresIn, "%d", &expiresInInt)
		}

		// Send token to main goroutine via channel
		tokenChan <- &TokenResponse{
			AccessToken:  accessToken,
			RefreshToken: refreshToken,
			ExpiresIn:    expiresInInt,
		}

		// Show success page to user
		html := `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Dosu CLI - Authentication Successful</title>
<style>
* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}
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
.checkmark svg {
    width: 32px;
    height: 32px;
    stroke: white;
    stroke-width: 3;
    stroke-linecap: round;
    stroke-linejoin: round;
    fill: none;
}
h1 {
    font-size: 24px;
    font-weight: 600;
    color: #111827;
    margin-bottom: 8px;
}
.subtitle {
    font-size: 15px;
    color: #6b7280;
    margin-bottom: 28px;
}
.info {
    background: #f9fafb;
    border-radius: 8px;
    padding: 16px;
    text-align: left;
    border: 1px solid #e5e7eb;
}
.info p {
    font-size: 14px;
    color: #374151;
    line-height: 1.5;
}
.info strong {
    display: block;
    margin-bottom: 4px;
    color: #111827;
}
.footer {
    margin-top: 24px;
    font-size: 13px;
    color: #9ca3af;
}
</style>
</head>
<body>
<div class="container">
    <div class="checkmark">
        <svg viewBox="0 0 24 24">
            <polyline points="20 6 9 17 4 12"/>
        </svg>
    </div>
    <h1>Authentication Successful</h1>
    <p class="subtitle">You've successfully authenticated the Dosu CLI</p>
    <div class="info">
        <p><strong>Next step:</strong> Return to your terminal to continue. You can safely close this window.</p>
    </div>
    <div class="footer">Dosu CLI</div>
</div>
</body>
</html>`
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte(html))
	})

	// Use :0 to get a random available port from the OS
	listener, err := net.Listen("tcp", "localhost:0")
	if err != nil {
		errChan <- fmt.Errorf("failed to start callback server: %w", err)
		return nil, 0
	}

	// Extract the port number from the listener address
	port := listener.Addr().(*net.TCPAddr).Port

	server := &http.Server{
		Handler: mux,
	}

	// Channel to signal when server is ready
	ready := make(chan struct{})

	// Start server in a goroutine
	go func() {
		// Signal that server is ready to accept connections
		close(ready)

		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			errChan <- fmt.Errorf("callback server error: %w", err)
		}
	}()

	// Wait for server to be ready before returning
	<-ready

	return server, port
}
