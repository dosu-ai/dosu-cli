package mcp

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/dosu-ai/dosu-cli/internal/config"
)

type ClineCliProvider struct{}

func (p *ClineCliProvider) Name() string        { return "Cline CLI" }
func (p *ClineCliProvider) ID() string          { return "cline-cli" }
func (p *ClineCliProvider) SupportsLocal() bool { return false }
func (p *ClineCliProvider) Priority() int       { return 12 }

func (p *ClineCliProvider) DetectPaths() []string {
	return []string{p.configDir()}
}

func (p *ClineCliProvider) IsInstalled() bool {
	return isInstalled(p.DetectPaths())
}

func (p *ClineCliProvider) GlobalConfigPath() string {
	return filepath.Join(p.configDir(), "data", "settings", "cline_mcp_settings.json")
}

func (p *ClineCliProvider) IsConfigured() bool {
	return isJSONKeyConfigured(p.GlobalConfigPath(), "mcpServers")
}

func (p *ClineCliProvider) configDir() string {
	if dir := os.Getenv("CLINE_DIR"); dir != "" {
		return dir
	}
	return expandHome("~/.cline")
}

func (p *ClineCliProvider) Install(cfg *config.Config, global bool) error {
	if cfg.DeploymentID == "" {
		return fmt.Errorf("deployment ID is required")
	}

	url := mcpURL(cfg.DeploymentID)
	configPath := p.GlobalConfigPath()

	clineConfig, err := loadJSONConfig(configPath)
	if err != nil {
		return fmt.Errorf("failed to load cline cli config: %w", err)
	}

	// Same format as Cline VS Code: streamableHttp + disabled field
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
		return fmt.Errorf("failed to save cline cli config: %w", err)
	}

	return nil
}

func (p *ClineCliProvider) Remove(global bool) error {
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
