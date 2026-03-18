package mcp

import (
	"fmt"
	"path/filepath"

	"github.com/dosu-ai/dosu-cli/internal/config"
)

type ClineProvider struct{}

func (p *ClineProvider) Name() string        { return "Cline" }
func (p *ClineProvider) ID() string          { return "cline" }
func (p *ClineProvider) SupportsLocal() bool { return false }
func (p *ClineProvider) Priority() int       { return 11 }

func (p *ClineProvider) DetectPaths() []string {
	return []string{p.extensionDir()}
}

func (p *ClineProvider) IsInstalled() bool {
	return isInstalled(p.DetectPaths())
}

func (p *ClineProvider) GlobalConfigPath() string {
	return filepath.Join(p.extensionDir(), "settings", "cline_mcp_settings.json")
}

func (p *ClineProvider) IsConfigured() bool {
	return isJSONKeyConfigured(p.GlobalConfigPath(), "mcpServers")
}

// extensionDir returns the Cline VS Code extension globalStorage path.
func (p *ClineProvider) extensionDir() string {
	return filepath.Join(appSupportDir(), "Code", "User", "globalStorage", "saoudrizwan.claude-dev")
}

func (p *ClineProvider) Install(cfg *config.Config, global bool) error {
	if cfg.DeploymentID == "" {
		return fmt.Errorf("deployment ID is required")
	}

	url := mcpURL(cfg.DeploymentID)
	configPath := p.GlobalConfigPath()

	clineConfig, err := loadJSONConfig(configPath)
	if err != nil {
		return fmt.Errorf("failed to load cline config: %w", err)
	}

	// Cline uses "streamableHttp" type and "disabled" field
	server := map[string]any{
		"url":      url,
		"type":     "streamableHttp",
		"disabled": false,
		"headers":  mcpHeaders(cfg),
	}

	mcpServers, ok := clineConfig["mcpServers"].(map[string]any)
	if !ok {
		mcpServers = make(map[string]any)
	}
	mcpServers["dosu"] = server
	clineConfig["mcpServers"] = mcpServers

	if err := saveJSONConfig(configPath, clineConfig); err != nil {
		return fmt.Errorf("failed to save cline config: %w", err)
	}

	return nil
}

func (p *ClineProvider) Remove(global bool) error {
	configPath := p.GlobalConfigPath()

	clineConfig, err := loadJSONConfig(configPath)
	if err != nil {
		return nil
	}

	if mcpServers, ok := clineConfig["mcpServers"].(map[string]any); ok {
		delete(mcpServers, "dosu")
	}

	return saveJSONConfig(configPath, clineConfig)
}
