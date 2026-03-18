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
	server := map[string]any{
		"type":    "http",
		"url":     mcpURL(cfg.DeploymentID),
		"headers": mcpHeaders(cfg),
	}
	return installJSONServer(p.GlobalConfigPath(), "mcpServers", server)
}

func (p *WindsurfProvider) Remove(global bool) error {
	return removeJSONServer(p.GlobalConfigPath(), "mcpServers")
}
