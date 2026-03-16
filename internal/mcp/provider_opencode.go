package mcp

import (
	"fmt"

	"github.com/dosu-ai/dosu-cli/internal/config"
)

type OpenCodeProvider struct{}

func (p *OpenCodeProvider) Name() string        { return "OpenCode" }
func (p *OpenCodeProvider) ID() string          { return "opencode" }
func (p *OpenCodeProvider) SupportsLocal() bool { return true }
func (p *OpenCodeProvider) Priority() int       { return 14 }

func (p *OpenCodeProvider) DetectPaths() []string {
	return []string{expandHome("~/.config/opencode")}
}

func (p *OpenCodeProvider) IsInstalled() bool {
	return isInstalled(p.DetectPaths())
}

func (p *OpenCodeProvider) GlobalConfigPath() string {
	return expandHome("~/.config/opencode/opencode.json")
}

func (p *OpenCodeProvider) IsConfigured() bool {
	return isJSONKeyConfigured(p.GlobalConfigPath(), "mcp")
}

func (p *OpenCodeProvider) Install(cfg *config.Config, global bool) error {
	if cfg.DeploymentID == "" {
		return fmt.Errorf("deployment ID is required")
	}

	url := fmt.Sprintf("%s/v1/mcp", config.GetBackendURL())
	configPath := p.GlobalConfigPath()

	ocConfig, err := loadJSONConfig(configPath)
	if err != nil {
		return fmt.Errorf("failed to load opencode config: %w", err)
	}

	// OpenCode uses "mcp" key with type: "remote" and enabled: true
	server := map[string]any{
		"type":    "remote",
		"url":     url,
		"enabled": true,
		"headers": map[string]string{
			"X-Deployment-ID": cfg.DeploymentID,
		},
	}

	mcpSection, ok := ocConfig["mcp"].(map[string]any)
	if !ok {
		mcpSection = make(map[string]any)
	}
	mcpSection["dosu"] = server
	ocConfig["mcp"] = mcpSection

	if err := saveJSONConfig(configPath, ocConfig); err != nil {
		return fmt.Errorf("failed to save opencode config: %w", err)
	}

	return nil
}

func (p *OpenCodeProvider) Remove(global bool) error {
	configPath := p.GlobalConfigPath()

	ocConfig, err := loadJSONConfig(configPath)
	if err != nil {
		return nil
	}

	if mcpSection, ok := ocConfig["mcp"].(map[string]any); ok {
		delete(mcpSection, "dosu")
	}

	return saveJSONConfig(configPath, ocConfig)
}
