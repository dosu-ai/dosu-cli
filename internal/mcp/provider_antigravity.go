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
	// Antigravity uses "serverUrl" instead of "url"
	server := map[string]any{
		"serverUrl": mcpURL(cfg.DeploymentID),
		"headers":   mcpHeaders(cfg),
	}
	return installJSONServer(p.GlobalConfigPath(), "mcpServers", server)
}

func (p *AntigravityProvider) Remove(global bool) error {
	return removeJSONServer(p.GlobalConfigPath(), "mcpServers")
}
