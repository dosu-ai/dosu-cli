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
	server := map[string]any{
		"type":    "remote",
		"url":     mcpURL(cfg.DeploymentID),
		"enabled": true,
		"headers": mcpHeaders(cfg),
	}
	return installJSONServer(p.GlobalConfigPath(), "mcp", server)
}

func (p *OpenCodeProvider) Remove(global bool) error {
	return removeJSONServer(p.GlobalConfigPath(), "mcp")
}
