package mcp

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/dosu-ai/dosu-cli/internal/config"
)

type CursorProvider struct{}

func (p *CursorProvider) Name() string        { return "Cursor" }
func (p *CursorProvider) ID() string          { return "cursor" }
func (p *CursorProvider) SupportsLocal() bool { return true }
func (p *CursorProvider) Priority() int       { return 5 }

func (p *CursorProvider) DetectPaths() []string {
	return []string{"~/.cursor"}
}

func (p *CursorProvider) IsInstalled() bool {
	return isInstalled(p.DetectPaths())
}

func (p *CursorProvider) GlobalConfigPath() string {
	return expandHome("~/.cursor/mcp.json")
}

func (p *CursorProvider) Install(cfg *config.Config, global bool) error {
	if cfg.DeploymentID == "" {
		return fmt.Errorf("deployment ID is required")
	}

	url := fmt.Sprintf("%s/v1/mcp", config.GetBackendURL())

	var configPath string
	if global {
		configPath = p.GlobalConfigPath()
	} else {
		cwd, err := os.Getwd()
		if err != nil {
			return fmt.Errorf("failed to get current directory: %w", err)
		}
		configPath = filepath.Join(cwd, ".cursor", "mcp.json")
	}

	cursorConfig, err := loadJSONConfig(configPath)
	if err != nil {
		return fmt.Errorf("failed to load cursor config: %w", err)
	}

	// Cursor remote servers omit the "type" field
	server := map[string]any{
		"url": url,
		"headers": map[string]string{
			"X-Deployment-ID": cfg.DeploymentID,
		},
	}

	mcpServers, ok := cursorConfig["mcpServers"].(map[string]any)
	if !ok {
		mcpServers = make(map[string]any)
	}
	mcpServers["dosu"] = server
	cursorConfig["mcpServers"] = mcpServers

	if err := saveJSONConfig(configPath, cursorConfig); err != nil {
		return fmt.Errorf("failed to save cursor config: %w", err)
	}

	return nil
}

func (p *CursorProvider) IsConfigured() bool {
	return isJSONKeyConfigured(p.GlobalConfigPath(), "mcpServers")
}

func (p *CursorProvider) Remove(global bool) error {
	var configPath string
	if global {
		configPath = p.GlobalConfigPath()
	} else {
		cwd, err := os.Getwd()
		if err != nil {
			return fmt.Errorf("failed to get current directory: %w", err)
		}
		configPath = filepath.Join(cwd, ".cursor", "mcp.json")
	}

	if _, err := os.Stat(configPath); os.IsNotExist(err) {
		return nil
	}

	cursorConfig, err := loadJSONConfig(configPath)
	if err != nil {
		return fmt.Errorf("failed to load cursor config: %w", err)
	}

	if mcpServers, ok := cursorConfig["mcpServers"].(map[string]any); ok {
		delete(mcpServers, "dosu")
	}

	if err := saveJSONConfig(configPath, cursorConfig); err != nil {
		return fmt.Errorf("failed to save cursor config: %w", err)
	}

	return nil
}

// Shared JSON config helpers used by multiple providers.

func loadJSONConfig(path string) (map[string]any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return make(map[string]any), nil
		}
		return nil, err
	}
	var cfg map[string]any
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	return cfg, nil
}

// isJSONKeyConfigured checks if "dosu" exists under the given top-level key in a JSON config file.
func isJSONKeyConfigured(configPath string, topLevelKey string) bool {
	cfg, err := loadJSONConfig(configPath)
	if err != nil {
		return false
	}
	section, ok := cfg[topLevelKey].(map[string]any)
	if !ok {
		return false
	}
	_, exists := section["dosu"]
	return exists
}

func saveJSONConfig(path string, cfg map[string]any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}
