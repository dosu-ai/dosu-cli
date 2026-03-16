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

func (p *VSCodeProvider) Install(cfg *config.Config, global bool) error {
	if cfg.DeploymentID == "" {
		return fmt.Errorf("deployment ID is required")
	}

	url := fmt.Sprintf("%s/v1/mcp", config.GetBackendURL())

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

	vscodeConfig, err := loadJSONConfig(configPath)
	if err != nil {
		return fmt.Errorf("failed to load vscode config: %w", err)
	}

	// VS Code uses "servers" key (not "mcpServers")
	server := map[string]any{
		"type": "http",
		"url":  url,
		"headers": map[string]string{
			"X-Deployment-ID": cfg.DeploymentID,
		},
	}

	servers, ok := vscodeConfig["servers"].(map[string]any)
	if !ok {
		servers = make(map[string]any)
	}
	servers["dosu"] = server
	vscodeConfig["servers"] = servers

	if err := saveJSONConfig(configPath, vscodeConfig); err != nil {
		return fmt.Errorf("failed to save vscode config: %w", err)
	}

	return nil
}

func (p *VSCodeProvider) Remove(global bool) error {
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

	vscodeConfig, err := loadJSONConfig(configPath)
	if err != nil {
		return fmt.Errorf("failed to load vscode config: %w", err)
	}

	if servers, ok := vscodeConfig["servers"].(map[string]any); ok {
		delete(servers, "dosu")
	}

	if err := saveJSONConfig(configPath, vscodeConfig); err != nil {
		return fmt.Errorf("failed to save vscode config: %w", err)
	}

	return nil
}
