package client

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/dosu-ai/dosu-cli/internal/config"
)

// ErrSessionExpired indicates the token is expired and refresh failed.
var ErrSessionExpired = errors.New("session expired")

// Client is an HTTP client for making authenticated requests to the Dosu backend
type Client struct {
	baseURL    string
	httpClient *http.Client
	config     *config.Config
}

// NewClient creates a new API client
func NewClient(cfg *config.Config) *Client {
	return &Client{
		baseURL:    config.GetBackendURL(),
		config:     cfg,
		httpClient: &http.Client{Timeout: 30 * time.Second},
	}
}

// DoRequest performs an authenticated HTTP request to the backend.
// Automatically refreshes the token on expiry or 401/403 responses and retries once.
func (c *Client) DoRequest(method, path string, body interface{}) (*http.Response, error) {
	if !c.config.IsAuthenticated() {
		return nil, fmt.Errorf("not authenticated - please run setup first")
	}

	// Pre-emptive refresh if locally known to be expired
	if c.config.IsTokenExpired() {
		if err := c.refreshToken(); err != nil {
			return nil, fmt.Errorf("token expired and refresh failed: %w", err)
		}
	}

	resp, err := c.doRequestOnce(method, path, body)
	if err != nil {
		return nil, err
	}

	// If backend says unauthorized, try refresh + retry once
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		resp.Body.Close()
		if refreshErr := c.refreshToken(); refreshErr != nil {
			return nil, ErrSessionExpired
		}
		return c.doRequestOnce(method, path, body)
	}

	return resp, nil
}

// DoRequestRaw performs a single authenticated request without any retry/refresh logic.
// Used for token verification during auth step.
func (c *Client) DoRequestRaw(method, path string) (*http.Response, error) {
	return c.doRequestOnce(method, path, nil)
}

func (c *Client) doRequestOnce(method, path string, body interface{}) (*http.Response, error) {
	var reqBody io.Reader
	if body != nil {
		jsonBody, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal request body: %w", err)
		}
		reqBody = bytes.NewBuffer(jsonBody)
	}

	url := c.baseURL + path
	req, err := http.NewRequest(method, url, reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Supabase-Access-Token", c.config.AccessToken)

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

// RefreshToken attempts to refresh the access token using the refresh token.
func (c *Client) RefreshToken() error {
	return c.refreshToken()
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
		detail := readErrorBody(resp.Body)
		if detail == "" || detail == "Internal Server Error" {
			detail = "check backend logs for details"
		}
		return nil, fmt.Errorf("failed to fetch deployments (status %d): %s", resp.StatusCode, detail)
	}

	var deployments []Deployment
	if err := json.NewDecoder(resp.Body).Decode(&deployments); err != nil {
		return nil, err
	}

	return deployments, nil
}

// Org represents a user's organization.
type Org struct {
	OrgID string `json:"org_id"`
	Name  string `json:"name"`
}

// GetOrgs lists organizations the authenticated user belongs to.
func (c *Client) GetOrgs() ([]Org, error) {
	resp, err := c.Get("/v1/mcp/orgs")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("failed to fetch orgs (status %d): %s", resp.StatusCode, readErrorBody(resp.Body))
	}

	var orgs []Org
	if err := json.NewDecoder(resp.Body).Decode(&orgs); err != nil {
		return nil, err
	}
	return orgs, nil
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

// APIKeyResponse represents the response from creating an API key.
type APIKeyResponse struct {
	APIKey    string `json:"api_key"`
	ID        string `json:"id"`
	Name      string `json:"name"`
	KeyPrefix string `json:"key_prefix"`
}

// CreateAPIKey mints a new API key for the given deployment.
func (c *Client) CreateAPIKey(deploymentID string, name string) (*APIKeyResponse, error) {
	path := fmt.Sprintf("/v1/mcp/deployments/%s/api-keys", deploymentID)
	payload := map[string]string{"name": name}
	resp, err := c.Post(path, payload)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("failed to create API key (status %d): %s", resp.StatusCode, readErrorBody(resp.Body))
	}

	var result APIKeyResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode API key response: %w", err)
	}
	return &result, nil
}

// readErrorBody reads up to 1KB from an error response body for use in error messages.
func readErrorBody(body io.Reader) string {
	b, _ := io.ReadAll(io.LimitReader(body, 1024))
	return string(b)
}
