package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/adrg/xdg"
)

// Config holds the CLI configuration including authentication tokens
type Config struct {
	AccessToken    string `json:"access_token"`
	RefreshToken   string `json:"refresh_token"`
	ExpiresAt      int64  `json:"expires_at"`
	DeploymentID   string `json:"deployment_id,omitempty"`
	DeploymentName string `json:"deployment_name,omitempty"`
}

func configPath() (string, error) {
	// Use XDG config directory (e.g., ~/.config/dosu-cli/)
	configDir := filepath.Join(xdg.ConfigHome, "dosu-cli")

	// Create directory if it doesn't exist
	if err := os.MkdirAll(configDir, 0700); err != nil {
		return "", fmt.Errorf("failed to create config directory: %w", err)
	}

	return filepath.Join(configDir, "config.json"), nil
}

func LoadConfig() (*Config, error) {
	path, err := configPath()
	if err != nil {
		return nil, err
	}

	// If config doesn't exist, return empty config
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return &Config{}, nil
	}

	// Read config file
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("failed to read config: %w", err)
	}

	// Parse JSON
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("failed to parse config: %w", err)
	}

	return &cfg, nil
}

func SaveConfig(cfg *Config) error {
	path, err := configPath()
	if err != nil {
		return err
	}

	// Marshal to JSON with indentation for readability
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal config: %w", err)
	}

	// Write with 0600 permissions (read/write for user only)
	if err := os.WriteFile(path, data, 0600); err != nil {
		return fmt.Errorf("failed to write config: %w", err)
	}

	return nil
}

// GetConfigPath returns the path where config is stored (useful for user feedback)
func GetConfigPath() (string, error) {
	return configPath()
}

func (c *Config) IsAuthenticated() bool {
	if c.AccessToken == "" {
		return false
	}

	// Check if token is expired (with 5 minute buffer)
	if c.ExpiresAt > 0 && time.Now().Unix() > (c.ExpiresAt-300) {
		return false
	}

	return true
}

func (c *Config) Clear() {
	c.AccessToken = ""
	c.RefreshToken = ""
	c.ExpiresAt = 0
}
