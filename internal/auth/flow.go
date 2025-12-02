package auth

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"time"

	"github.com/pkg/browser"
	"github.com/dosu-ai/dosu-cli/internal/config"
)

// StartOAuthFlow initiates the browser-based OAuth flow
// This function:
// 1. Starts a local HTTP server on a random port
// 2. Opens the browser to the Dosu web app login page
// 3. Waits for the web app to redirect back with the token
// 4. Returns the token or an error
func StartOAuthFlow() (*TokenResponse, error) {
	// Create channels for communication between goroutines
	// tokenChan receives the token when auth succeeds
	// errChan receives any errors from the callback server
	tokenChan := make(chan *TokenResponse, 1)
	errChan := make(chan error, 1)

	// Start the local callback server on a random available port
	server, port := startCallbackServer(tokenChan, errChan)
	if server == nil {
		// If server is nil, an error was sent to errChan
		return nil, <-errChan
	}

	// Ensure the server is shut down when we're done
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		server.Shutdown(ctx)
	}()

	// Build the callback URL (where the web app will redirect to)
	callbackURL := fmt.Sprintf("http://localhost:%d/callback", port)

	// Build the web app URL with the callback parameter
	authURL := buildAuthURL(callbackURL)

	// Open the user's default browser to the auth page
	if err := browser.OpenURL(authURL); err != nil {
		return nil, fmt.Errorf("failed to open browser: %w", err)
	}

	// Wait for one of three things to happen:
	// 1. Token is received (success)
	// 2. An error occurs
	// 3. Timeout after 5 minutes
	select {
	case token := <-tokenChan:
		return token, nil
	case err := <-errChan:
		return nil, err
	case <-time.After(5 * time.Minute):
		return nil, errors.New("authentication timeout - please try again")
	}
}

// buildAuthURL constructs the URL to the Dosu web app's CLI login page
func buildAuthURL(callbackURL string) string {
	// Get the web app URL based on environment (dev or prod)
	webAppURL := config.GetWebAppURL()

	// Build URL with callback parameter
	params := url.Values{}
	params.Set("callback", callbackURL)

	return fmt.Sprintf("%s/cli-login?%s", webAppURL, params.Encode())
}
