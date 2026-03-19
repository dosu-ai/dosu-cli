package mcp

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/dosu-ai/dosu-cli/internal/config"
)

type VSCodeProvider struct{}

func (p *VSCodeProvider) Name() string        { return "VS Code" }
func (p *VSCodeProvider) ID() string          { return "vscode" }
func (p *VSCodeProvider) SupportsLocal() bool { return true }
func (p *VSCodeProvider) Priority() int       { return 6 }

func (p *VSCodeProvider) DetectPaths() []string {
	return []string{filepath.Join(appSupportDir(), "Code")}
}

func (p *VSCodeProvider) IsInstalled() bool {
	return isInstalled(p.DetectPaths())
}

func (p *VSCodeProvider) GlobalConfigPath() string {
	return filepath.Join(appSupportDir(), "Code", "User", "mcp.json")
}

func (p *VSCodeProvider) IsConfigured() bool {
	return isJSONKeyConfigured(p.GlobalConfigPath(), "servers")
}

func (p *VSCodeProvider) configPath(global bool) (string, error) {
	if global {
		return p.GlobalConfigPath(), nil
	}
	cwd, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("failed to get current directory: %w", err)
	}
	return filepath.Join(cwd, ".vscode", "mcp.json"), nil
}

func (p *VSCodeProvider) Install(cfg *config.Config, global bool) error {
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
	return installJSONServer(configPath, "servers", server)
}

func (p *VSCodeProvider) Remove(global bool) error {
	configPath, err := p.configPath(global)
	if err != nil {
		return err
	}
	return removeJSONServer(configPath, "servers")
}
