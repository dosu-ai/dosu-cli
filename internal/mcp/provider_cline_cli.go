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
	server := map[string]any{
		"url":      mcpURL(cfg.DeploymentID),
		"type":     "streamableHttp",
		"disabled": false,
		"headers":  mcpHeaders(cfg),
	}
	return installJSONServer(p.GlobalConfigPath(), "mcpServers", server)
}

func (p *ClineCliProvider) Remove(global bool) error {
	return removeJSONServer(p.GlobalConfigPath(), "mcpServers")
}
