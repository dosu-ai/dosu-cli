package mcp

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/dosu-ai/dosu-cli/internal/config"
)

type ClaudeProvider struct{}

func (p *ClaudeProvider) Name() string        { return "Claude Code" }
func (p *ClaudeProvider) ID() string          { return "claude" }
func (p *ClaudeProvider) SupportsLocal() bool { return true }
func (p *ClaudeProvider) Priority() int       { return 1 }
func (p *ClaudeProvider) DetectPaths() []string {
	return []string{"~/.claude"}
}
func (p *ClaudeProvider) IsInstalled() bool {
	return isInstalled(p.DetectPaths())
}
func (p *ClaudeProvider) GlobalConfigPath() string {
	return expandHome("~/.claude.json")
}

func (p *ClaudeProvider) configPath(global bool) (string, error) {
	if global {
		return p.GlobalConfigPath(), nil
	}
	cwd, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("failed to get current directory: %w", err)
	}
	return filepath.Join(cwd, ".mcp.json"), nil
}

func (p *ClaudeProvider) Install(cfg *config.Config, global bool) error {
	if cfg.DeploymentID == "" {
		return fmt.Errorf("deployment ID is required")
	}
	configPath, err := p.configPath(global)
	if err != nil {
		return err
	}
	server := map[string]any{
		"type":    "http",
		"url":     mcpURL(cfg.DeploymentID),
		"headers": mcpHeaders(cfg),
	}
	return installJSONServer(configPath, "mcpServers", server)
}

func (p *ClaudeProvider) IsConfigured() bool {
	return isJSONKeyConfigured(p.GlobalConfigPath(), "mcpServers")
}

func (p *ClaudeProvider) Remove(global bool) error {
	configPath, err := p.configPath(global)
	if err != nil {
		return err
	}
	return removeJSONServer(configPath, "mcpServers")
}
