package client

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/dosu-ai/dosu-cli/internal/config"
)

// Client is an HTTP client for making authenticated requests to the Dosu backend
type Client struct {
	baseURL    string
	httpClient *http.Client
	config     *config.Config
	apiKey     string
}

// NewClient creates a new API client using OAuth authentication
func NewClient(cfg *config.Config) *Client {
	return &Client{
		baseURL:    config.GetBackendURL(),
		config:     cfg,
		httpClient: &http.Client{Timeout: 30 * time.Second},
	}
}

// NewClientWithAPIKey creates a new API client using API key authentication
func NewClientWithAPIKey(apiKey string) *Client {
	return &Client{
		baseURL:    config.GetBackendURL(),
		httpClient: &http.Client{Timeout: 30 * time.Second},
		apiKey:     apiKey,
	}
}

// DoRequest performs an authenticated HTTP request to the backend
// If an API key is set, it uses API key authentication.
// Otherwise, it uses OAuth with automatic token refresh.
func (c *Client) DoRequest(method, path string, body interface{}) (*http.Response, error) {
	// Use API key authentication if available
	if c.apiKey != "" {
		return c.doRequestWithAPIKey(method, path, body)
	}

	// Fall back to OAuth authentication
	// Check if user is authenticated (has a token)
	if !c.config.IsAuthenticated() {
		return nil, fmt.Errorf("not authenticated - please run setup first")
	}

	// Check if token is expired or about to expire (within 5 minutes)
	if c.config.IsTokenExpired() {
		// Try to refresh the token
		if err := c.refreshToken(); err != nil {
			return nil, fmt.Errorf("token expired and refresh failed: %w", err)
		}
	}

	// Prepare request body if provided
	var reqBody io.Reader
	if body != nil {
		jsonBody, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal request body: %w", err)
		}
		reqBody = bytes.NewBuffer(jsonBody)
	}

	// Create HTTP request
	url := c.baseURL + path
	req, err := http.NewRequest(method, url, reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	// Set headers
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Supabase-Access-Token", c.config.AccessToken)

	// Perform request
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}

	return resp, nil
}

// doRequestWithAPIKey performs an HTTP request using API key authentication
func (c *Client) doRequestWithAPIKey(method, path string, body interface{}) (*http.Response, error) {
	// Prepare request body if provided
	var reqBody io.Reader
	if body != nil {
		jsonBody, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal request body: %w", err)
		}
		reqBody = bytes.NewBuffer(jsonBody)
	}

	// Create HTTP request
	url := c.baseURL + path
	req, err := http.NewRequest(method, url, reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	// Set headers with API key
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", c.apiKey)

	// Perform request
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}

	return resp, nil
}

func (c *Client) Get(path string) (*http.Response, error) {
	return c.DoRequest("GET", path, nil)
}

func (c *Client) Post(path string, body interface{}) (*http.Response, error) {
	return c.DoRequest("POST", path, body)
}

func (c *Client) Put(path string, body interface{}) (*http.Response, error) {
	return c.DoRequest("PUT", path, body)
}

func (c *Client) Delete(path string) (*http.Response, error) {
	return c.DoRequest("DELETE", path, nil)
}

// refreshToken attempts to refresh the access token using the refresh token
func (c *Client) refreshToken() error {
	if c.config.RefreshToken == "" {
		return fmt.Errorf("no refresh token available")
	}

	// Get Supabase URL from config
	supabaseURL := config.GetSupabaseURL()

	endpoint := fmt.Sprintf("%s/auth/v1/token?grant_type=refresh_token", supabaseURL)

	payload := map[string]string{
		"refresh_token": c.config.RefreshToken,
	}

	body, _ := json.Marshal(payload)
	req, _ := http.NewRequest("POST", endpoint, bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("refresh request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return fmt.Errorf("refresh failed with status %d", resp.StatusCode)
	}

	var tokenResp struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int    `json:"expires_in"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&tokenResp); err != nil {
		return fmt.Errorf("failed to decode refresh response: %w", err)
	}

	// Update config with new tokens
	c.config.AccessToken = tokenResp.AccessToken
	c.config.RefreshToken = tokenResp.RefreshToken
	c.config.ExpiresAt = time.Now().Unix() + int64(tokenResp.ExpiresIn)

	// Save updated config
	if err := config.SaveConfig(c.config); err != nil {
		return fmt.Errorf("failed to save refreshed token: %w", err)
	}

	return nil
}

func (c *Client) GetDeployments() ([]Deployment, error) {
	resp, err := c.Get("/v1/mcp/deployments")
	if err != nil {
		return nil, err
	}

	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("Could not retrieve deployments with status: %d", resp.StatusCode)
	}

	var deployments []Deployment
	if err := json.NewDecoder(resp.Body).Decode(&deployments); err != nil {
		return nil, err
	}

	return deployments, nil
}

type Deployment struct {
	DeploymentID string `json:"deployment_id"`
	Name         string `json:"name"`
	Description  string `json:"description"`
	ProviderSlug string `json:"provider_slug"`
	Enabled      bool   `json:"enabled"`
	OrgID        string `json:"org_id"`
	OrgName      string `json:"org_name"`
	SpaceID      string `json:"space_id"`
}
