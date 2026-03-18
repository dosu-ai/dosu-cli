package mcp

import (
	"fmt"

	"github.com/dosu-ai/dosu-cli/internal/config"
)

type AntigravityProvider struct{}

func (p *AntigravityProvider) Name() string        { return "Antigravity" }
func (p *AntigravityProvider) ID() string          { return "antigravity" }
func (p *AntigravityProvider) SupportsLocal() bool { return false }
func (p *AntigravityProvider) Priority() int       { return 15 }

func (p *AntigravityProvider) DetectPaths() []string {
	// Shares ~/.gemini with Gemini CLI
	return []string{expandHome("~/.gemini")}
}

func (p *AntigravityProvider) IsInstalled() bool {
	return isInstalled(p.DetectPaths())
}

func (p *AntigravityProvider) GlobalConfigPath() string {
	return expandHome("~/.gemini/antigravity/mcp_config.json")
}

func (p *AntigravityProvider) IsConfigured() bool {
	return isJSONKeyConfigured(p.GlobalConfigPath(), "mcpServers")
}

func (p *AntigravityProvider) Install(cfg *config.Config, global bool) error {
	if cfg.DeploymentID == "" {
		return fmt.Errorf("deployment ID is required")
	}

	url := mcpURL(cfg.DeploymentID)
	configPath := p.GlobalConfigPath()

	agConfig, err := loadJSONConfig(configPath)
	if err != nil {
		return fmt.Errorf("failed to load antigravity config: %w", err)
	}

	// Antigravity uses "serverUrl" instead of "url"
	server := map[string]any{
		"serverUrl": url,
		"headers":   mcpHeaders(cfg),
	}

	mcpServers, ok := agConfig["mcpServers"].(map[string]any)
	if !ok {
		mcpServers = make(map[string]any)
	}
	mcpServers["dosu"] = server
	agConfig["mcpServers"] = mcpServers

	if err := saveJSONConfig(configPath, agConfig); err != nil {
		return fmt.Errorf("failed to save antigravity config: %w", err)
	}

	return nil
}

func (p *AntigravityProvider) Remove(global bool) error {
	configPath := p.GlobalConfigPath()

	agConfig, err := loadJSONConfig(configPath)
	if err != nil {
		return nil
	}

	if mcpServers, ok := agConfig["mcpServers"].(map[string]any); ok {
		delete(mcpServers, "dosu")
	}

	return saveJSONConfig(configPath, agConfig)
}
