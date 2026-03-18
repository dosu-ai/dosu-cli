package mcp

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/dosu-ai/dosu-cli/internal/config"
)

type CopilotProvider struct{}

func (p *CopilotProvider) Name() string        { return "GitHub Copilot CLI" }
func (p *CopilotProvider) ID() string          { return "copilot" }
func (p *CopilotProvider) SupportsLocal() bool { return true }
func (p *CopilotProvider) Priority() int       { return 13 }

func (p *CopilotProvider) DetectPaths() []string {
	return []string{expandHome("~/.copilot")}
}

func (p *CopilotProvider) IsInstalled() bool {
	return isInstalled(p.DetectPaths())
}

func (p *CopilotProvider) GlobalConfigPath() string {
	if xdg := os.Getenv("XDG_CONFIG_HOME"); xdg != "" {
		return filepath.Join(xdg, ".copilot", "mcp-config.json")
	}
	return expandHome("~/.copilot/mcp-config.json")
}

func (p *CopilotProvider) IsConfigured() bool {
	return isJSONKeyConfigured(p.GlobalConfigPath(), "mcpServers")
}

func (p *CopilotProvider) Install(cfg *config.Config, global bool) error {
	if cfg.DeploymentID == "" {
		return fmt.Errorf("deployment ID is required")
	}
	url := mcpURL(cfg.DeploymentID)

	if global {
		server := map[string]any{
			"type":    "http",
			"url":     url,
			"tools":   []string{"*"},
			"headers": mcpHeaders(cfg),
		}
		return installJSONServer(p.GlobalConfigPath(), "mcpServers", server)
	}

	// Local: uses .vscode/mcp.json with "servers" key
	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("failed to get current directory: %w", err)
	}
	configPath := filepath.Join(cwd, ".vscode", "mcp.json")
	server := map[string]any{
		"type":    "http",
		"url":     url,
		"headers": mcpHeaders(cfg),
	}
	return installJSONServer(configPath, "servers", server)
}

func (p *CopilotProvider) Remove(global bool) error {
	if global {
		return removeJSONServer(p.GlobalConfigPath(), "mcpServers")
	}
	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("failed to get current directory: %w", err)
	}
	configPath := filepath.Join(cwd, ".vscode", "mcp.json")
	return removeJSONServer(configPath, "servers")
}
