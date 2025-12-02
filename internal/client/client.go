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
}

// NewClient creates a new API client
func NewClient(cfg *config.Config) *Client {
	return &Client{
		baseURL:    config.GetBackendURL(),
		config:     cfg,
		httpClient: &http.Client{Timeout: 30 * time.Second},
	}
}

// DoRequest performs an authenticated HTTP request to the backend
// The access token is automatically included in the Supabase-Access-Token header
func (c *Client) DoRequest(method, path string, body interface{}) (*http.Response, error) {
	// Check if user is authenticated
	if !c.config.IsAuthenticated() {
		return nil, fmt.Errorf("not authenticated - please run setup first")
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
	req.Header.Set("Supabase-Access-Token", c.config.AccessToken) // This is the key header!

	// Perform request
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}

	return resp, nil
}

// Get performs a GET request
func (c *Client) Get(path string) (*http.Response, error) {
	return c.DoRequest("GET", path, nil)
}

// Post performs a POST request with a JSON body
func (c *Client) Post(path string, body interface{}) (*http.Response, error) {
	return c.DoRequest("POST", path, body)
}

// Put performs a PUT request with a JSON body
func (c *Client) Put(path string, body interface{}) (*http.Response, error) {
	return c.DoRequest("PUT", path, body)
}

// Delete performs a DELETE request
func (c *Client) Delete(path string) (*http.Response, error) {
	return c.DoRequest("DELETE", path, nil)
}
