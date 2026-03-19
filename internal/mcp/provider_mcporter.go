package mcp

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/dosu-ai/dosu-cli/internal/config"
)

type MCPorterProvider struct{}

func (p *MCPorterProvider) Name() string        { return "MCPorter" }
func (p *MCPorterProvider) ID() string          { return "mcporter" }
func (p *MCPorterProvider) SupportsLocal() bool { return true }
func (p *MCPorterProvider) Priority() int       { return 16 }

func (p *MCPorterProvider) DetectPaths() []string {
	return []string{expandHome("~/.mcporter")}
}

func (p *MCPorterProvider) IsInstalled() bool {
	return isInstalled(p.DetectPaths())
}

// GlobalConfigPath resolves the MCPorter config file, falling back to .jsonc if .json doesn't exist.
func (p *MCPorterProvider) GlobalConfigPath() string {
	jsonPath := expandHome("~/.mcporter/mcporter.json")
	if _, err := os.Stat(jsonPath); err == nil {
		return jsonPath
	}
	jsoncPath := expandHome("~/.mcporter/mcporter.jsonc")
	if _, err := os.Stat(jsoncPath); err == nil {
		return jsoncPath
	}
	return jsonPath
}

func (p *MCPorterProvider) IsConfigured() bool {
	return isJSONKeyConfigured(p.GlobalConfigPath(), "mcpServers")
}

func (p *MCPorterProvider) configPath(global bool) (string, error) {
	if global {
		return p.GlobalConfigPath(), nil
	}
	cwd, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("failed to get current directory: %w", err)
	}
	return filepath.Join(cwd, "config", "mcporter.json"), nil
}

func (p *MCPorterProvider) Install(cfg *config.Config, global bool) error {
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

func (p *MCPorterProvider) Remove(global bool) error {
	configPath, err := p.configPath(global)
	if err != nil {
		return err
	}
	return removeJSONServer(configPath, "mcpServers")
}
