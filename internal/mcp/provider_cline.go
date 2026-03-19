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
	server := map[string]any{
		"url":      mcpURL(cfg.DeploymentID),
		"type":     "streamableHttp",
		"disabled": false,
		"headers":  mcpHeaders(cfg),
	}
	return installJSONServer(p.GlobalConfigPath(), "mcpServers", server)
}

func (p *ClineProvider) Remove(global bool) error {
	return removeJSONServer(p.GlobalConfigPath(), "mcpServers")
}
