package mcp

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/dosu-ai/dosu-cli/internal/config"
)

type GeminiProvider struct{}

func (p *GeminiProvider) Name() string        { return "Gemini CLI" }
func (p *GeminiProvider) ID() string          { return "gemini" }
func (p *GeminiProvider) SupportsLocal() bool { return true }
func (p *GeminiProvider) Priority() int       { return 7 }
func (p *GeminiProvider) DetectPaths() []string {
	return []string{"~/.gemini"}
}
func (p *GeminiProvider) IsInstalled() bool {
	return isInstalled(p.DetectPaths())
}
func (p *GeminiProvider) GlobalConfigPath() string {
	return expandHome("~/.gemini/settings.json")
}

func (p *GeminiProvider) IsConfigured() bool {
	return isJSONKeyConfigured(p.GlobalConfigPath(), "mcpServers")
}

func (p *GeminiProvider) configPath(global bool) (string, error) {
	if global {
		return p.GlobalConfigPath(), nil
	}
	cwd, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("failed to get current directory: %w", err)
	}
	return filepath.Join(cwd, ".gemini", "settings.json"), nil
}

func (p *GeminiProvider) Install(cfg *config.Config, global bool) error {
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

func (p *GeminiProvider) Remove(global bool) error {
	configPath, err := p.configPath(global)
	if err != nil {
		return err
	}
	return removeJSONServer(configPath, "mcpServers")
}
