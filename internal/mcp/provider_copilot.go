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

	var configPath string
	if global {
		configPath = p.GlobalConfigPath()
	} else {
		cwd, err := os.Getwd()
		if err != nil {
			return fmt.Errorf("failed to get current directory: %w", err)
		}
		configPath = filepath.Join(cwd, ".vscode", "mcp.json")
	}

	copilotConfig, err := loadJSONConfig(configPath)
	if err != nil {
		return fmt.Errorf("failed to load copilot config: %w", err)
	}

	if global {
		server := map[string]any{
			"type":    "http",
			"url":     url,
			"tools":   []string{"*"},
			"headers": mcpHeaders(cfg),
		}

		mcpServers, ok := copilotConfig["mcpServers"].(map[string]any)
		if !ok {
			mcpServers = make(map[string]any)
		}
		mcpServers["dosu"] = server
		copilotConfig["mcpServers"] = mcpServers
	} else {
		server := map[string]any{
			"type":    "http",
			"url":     url,
			"headers": mcpHeaders(cfg),
		}

		servers, ok := copilotConfig["servers"].(map[string]any)
		if !ok {
			servers = make(map[string]any)
		}
		servers["dosu"] = server
		copilotConfig["servers"] = servers
	}

	if err := saveJSONConfig(configPath, copilotConfig); err != nil {
		return fmt.Errorf("failed to save copilot config: %w", err)
	}

	return nil
}

func (p *CopilotProvider) Remove(global bool) error {
	var configPath string
	if global {
		configPath = p.GlobalConfigPath()
	} else {
		cwd, err := os.Getwd()
		if err != nil {
			return fmt.Errorf("failed to get current directory: %w", err)
		}
		configPath = filepath.Join(cwd, ".vscode", "mcp.json")
	}

	if _, err := os.Stat(configPath); os.IsNotExist(err) {
		return nil
	}

	copilotConfig, err := loadJSONConfig(configPath)
	if err != nil {
		return fmt.Errorf("failed to load copilot config: %w", err)
	}

	if global {
		if mcpServers, ok := copilotConfig["mcpServers"].(map[string]any); ok {
			delete(mcpServers, "dosu")
		}
	} else {
		if servers, ok := copilotConfig["servers"].(map[string]any); ok {
			delete(servers, "dosu")
		}
	}

	return saveJSONConfig(configPath, copilotConfig)
}
