package mcp

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/dosu-ai/dosu-cli/internal/config"
)

type CursorProvider struct{}

func (p *CursorProvider) Name() string        { return "Cursor" }
func (p *CursorProvider) ID() string          { return "cursor" }
func (p *CursorProvider) SupportsLocal() bool { return true }
func (p *CursorProvider) Priority() int       { return 5 }

func (p *CursorProvider) DetectPaths() []string {
	return []string{"~/.cursor"}
}

func (p *CursorProvider) IsInstalled() bool {
	return isInstalled(p.DetectPaths())
}

func (p *CursorProvider) GlobalConfigPath() string {
	return expandHome("~/.cursor/mcp.json")
}

func (p *CursorProvider) IsConfigured() bool {
	return isJSONKeyConfigured(p.GlobalConfigPath(), "mcpServers")
}

func (p *CursorProvider) configPath(global bool) (string, error) {
	if global {
		return p.GlobalConfigPath(), nil
	}
	cwd, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("failed to get current directory: %w", err)
	}
	return filepath.Join(cwd, ".cursor", "mcp.json"), nil
}

func (p *CursorProvider) Install(cfg *config.Config, global bool) error {
	if cfg.DeploymentID == "" {
		return fmt.Errorf("deployment ID is required")
	}
	configPath, err := p.configPath(global)
	if err != nil {
		return err
	}
	server := map[string]any{
		"url":     mcpURL(cfg.DeploymentID),
		"headers": mcpHeaders(cfg),
	}
	return installJSONServer(configPath, "mcpServers", server)
}

func (p *CursorProvider) Remove(global bool) error {
	configPath, err := p.configPath(global)
	if err != nil {
		return err
	}
	return removeJSONServer(configPath, "mcpServers")
}
