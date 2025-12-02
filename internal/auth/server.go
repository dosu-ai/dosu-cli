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
<html>
<head>
<title>Dosu CLI Authentication</title>
</head>
<body>
<h1>✓ Authentication successful!</h1>
<p>You can close this window and return to the CLI.</p>
<script>
    // Extract token from URL fragment if present
    const hash = window.location.hash.substring(1);
    if (hash) {
        const params = new URLSearchParams(hash);
        const token = params.get('access_token');
        const refresh = params.get('refresh_token');
        const expires = params.get('expires_in');

        if (token) {
            // Redirect to same endpoint with query params
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
<html>
<head>
<title>Dosu CLI Authentication</title>
<style>
body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    text-align: center;
    padding: 50px;
    background: #f5f5f5;
}
.success {
    background: white;
    border-radius: 8px;
    padding: 40px;
    box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    max-width: 400px;
    margin: 0 auto;
}
h1 {
    color: #00aa00;
    margin-bottom: 20px;
}
p {
    color: #666;
    font-size: 16px;
}
</style>
</head>
<body>
<div class="success">
<h1>✓ Authentication Successful!</h1>
<p>You can now close this window and return to the CLI.</p>
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

	// Start server in a goroutine
	go func() {
		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			errChan <- fmt.Errorf("callback server error: %w", err)
		}
	}()

	return server, port
}
