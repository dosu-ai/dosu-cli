package mcp

import (
	"fmt"

	"github.com/dosu-ai/dosu-cli/internal/config"
)

type MCPorterProvider struct{}

func (p *MCPorterProvider) Name() string        { return "MCPorter" }
func (p *MCPorterProvider) ID() string          { return "mcporter" }
func (p *MCPorterProvider) SupportsLocal() bool { return true }
func (p *MCPorterProvider) Priority() int       { return 16 }

func (p *MCPorterProvider) DetectPaths() []string {
	return []string{expandHome("~/.mcporter")}
}

func (p *MCPorterProvider) IsInstalled() bool {
	return isInstalled(p.DetectPaths())
}

func (p *MCPorterProvider) GlobalConfigPath() string {
	return expandHome("~/.mcporter/mcporter.json")
}

func (p *MCPorterProvider) IsConfigured() bool {
	return isJSONKeyConfigured(p.GlobalConfigPath(), "mcpServers")
}

func (p *MCPorterProvider) Install(cfg *config.Config, global bool) error {
	if cfg.DeploymentID == "" {
		return fmt.Errorf("deployment ID is required")
	}

	url := mcpURL(cfg.DeploymentID)
	configPath := p.GlobalConfigPath()

	mpConfig, err := loadJSONConfig(configPath)
	if err != nil {
		return fmt.Errorf("failed to load mcporter config: %w", err)
	}

	// Standard mcpServers format, no transform needed
	server := map[string]any{
		"type":    "http",
		"url":     url,
		"headers": mcpHeaders(cfg),
	}

	mcpServers, ok := mpConfig["mcpServers"].(map[string]any)
	if !ok {
		mcpServers = make(map[string]any)
	}
	mcpServers["dosu"] = server
	mpConfig["mcpServers"] = mcpServers

	if err := saveJSONConfig(configPath, mpConfig); err != nil {
		return fmt.Errorf("failed to save mcporter config: %w", err)
	}

	return nil
}

func (p *MCPorterProvider) Remove(global bool) error {
	configPath := p.GlobalConfigPath()

	mpConfig, err := loadJSONConfig(configPath)
	if err != nil {
		return nil
	}

	if mcpServers, ok := mpConfig["mcpServers"].(map[string]any); ok {
		delete(mcpServers, "dosu")
	}

	return saveJSONConfig(configPath, mpConfig)
}
