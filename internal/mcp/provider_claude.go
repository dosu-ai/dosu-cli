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

func (p *ClaudeProvider) getConfigPath() (string, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(homeDir, ".claude.json"), nil
}

func (p *ClaudeProvider) Install(cfg *config.Config, global bool) error {
	if cfg.DeploymentID == "" {
		return fmt.Errorf("deployment ID is required")
	}

	url := mcpURL(cfg.DeploymentID)

	configPath, err := p.getConfigPath()
	if err != nil {
		return fmt.Errorf("failed to get claude config path: %w", err)
	}

	claudeConfig, err := loadJSONConfig(configPath)
	if err != nil {
		return fmt.Errorf("failed to load claude config: %w", err)
	}

	server := map[string]any{
		"type":    "http",
		"url":     url,
		"headers": mcpHeaders(cfg),
	}

	if global {
		mcpServers, ok := claudeConfig["mcpServers"].(map[string]any)
		if !ok {
			mcpServers = make(map[string]any)
		}
		mcpServers["dosu"] = server
		claudeConfig["mcpServers"] = mcpServers
	} else {
		cwd, err := os.Getwd()
		if err != nil {
			return fmt.Errorf("failed to get current directory: %w", err)
		}

		projects, ok := claudeConfig["projects"].(map[string]any)
		if !ok {
			projects = make(map[string]any)
		}

		project, ok := projects[cwd].(map[string]any)
		if !ok {
			project = make(map[string]any)
		}

		mcpServers, ok := project["mcpServers"].(map[string]any)
		if !ok {
			mcpServers = make(map[string]any)
		}

		mcpServers["dosu"] = server
		project["mcpServers"] = mcpServers
		projects[cwd] = project
		claudeConfig["projects"] = projects
	}

	if err := saveJSONConfig(configPath, claudeConfig); err != nil {
		return fmt.Errorf("failed to save claude config: %w", err)
	}

	return nil
}

func (p *ClaudeProvider) IsConfigured() bool {
	configPath, err := p.getConfigPath()
	if err != nil {
		return false
	}
	cfg, err := loadJSONConfig(configPath)
	if err != nil {
		return false
	}
	if mcpServers, ok := cfg["mcpServers"].(map[string]any); ok {
		if _, exists := mcpServers["dosu"]; exists {
			return true
		}
	}
	return false
}

func (p *ClaudeProvider) Remove(global bool) error {
	configPath, err := p.getConfigPath()
	if err != nil {
		return fmt.Errorf("failed to get claude config path: %w", err)
	}

	if _, err := os.Stat(configPath); os.IsNotExist(err) {
		return nil
	}

	claudeConfig, err := loadJSONConfig(configPath)
	if err != nil {
		return fmt.Errorf("failed to load claude config: %w", err)
	}

	if global {
		if mcpServers, ok := claudeConfig["mcpServers"].(map[string]any); ok {
			delete(mcpServers, "dosu")
		}
	} else {
		cwd, err := os.Getwd()
		if err != nil {
			return fmt.Errorf("failed to get current directory: %w", err)
		}

		if projects, ok := claudeConfig["projects"].(map[string]any); ok {
			if project, ok := projects[cwd].(map[string]any); ok {
				if mcpServers, ok := project["mcpServers"].(map[string]any); ok {
					delete(mcpServers, "dosu")
				}
			}
		}
	}

	if err := saveJSONConfig(configPath, claudeConfig); err != nil {
		return fmt.Errorf("failed to save claude config: %w", err)
	}

	return nil
}
