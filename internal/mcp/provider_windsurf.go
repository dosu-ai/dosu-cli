package mcp

import (
	"fmt"
	"path/filepath"

	"github.com/dosu-ai/dosu-cli/internal/config"
)

type WindsurfProvider struct{}

func (p *WindsurfProvider) Name() string        { return "Windsurf" }
func (p *WindsurfProvider) ID() string          { return "windsurf" }
func (p *WindsurfProvider) SupportsLocal() bool { return false }
func (p *WindsurfProvider) Priority() int       { return 9 }

func (p *WindsurfProvider) DetectPaths() []string {
	return []string{filepath.Join(expandHome("~"), ".codeium", "windsurf")}
}

func (p *WindsurfProvider) IsInstalled() bool {
	return isInstalled(p.DetectPaths())
}

func (p *WindsurfProvider) GlobalConfigPath() string {
	return filepath.Join(expandHome("~"), ".codeium", "windsurf", "mcp_config.json")
}

func (p *WindsurfProvider) IsConfigured() bool {
	return isJSONKeyConfigured(p.GlobalConfigPath(), "mcpServers")
}

func (p *WindsurfProvider) Install(cfg *config.Config, global bool) error {
	if cfg.DeploymentID == "" {
		return fmt.Errorf("deployment ID is required")
	}

	url := fmt.Sprintf("%s/v1/mcp", config.GetBackendURL())
	configPath := p.GlobalConfigPath()

	wsConfig, err := loadJSONConfig(configPath)
	if err != nil {
		return fmt.Errorf("failed to load windsurf config: %w", err)
	}

	server := map[string]any{
		"type": "http",
		"url":  url,
		"headers": map[string]string{
			"X-Deployment-ID": cfg.DeploymentID,
		},
	}

	mcpServers, ok := wsConfig["mcpServers"].(map[string]any)
	if !ok {
		mcpServers = make(map[string]any)
	}
	mcpServers["dosu"] = server
	wsConfig["mcpServers"] = mcpServers

	if err := saveJSONConfig(configPath, wsConfig); err != nil {
		return fmt.Errorf("failed to save windsurf config: %w", err)
	}

	return nil
}

func (p *WindsurfProvider) Remove(global bool) error {
	configPath := p.GlobalConfigPath()

	wsConfig, err := loadJSONConfig(configPath)
	if err != nil {
		return nil
	}

	if mcpServers, ok := wsConfig["mcpServers"].(map[string]any); ok {
		delete(mcpServers, "dosu")
	}

	return saveJSONConfig(configPath, wsConfig)
}
