package mcp

import (
	"fmt"
	"path/filepath"
	"runtime"

	"github.com/dosu-ai/dosu-cli/internal/config"
)

type ZedProvider struct{}

func (p *ZedProvider) Name() string        { return "Zed" }
func (p *ZedProvider) ID() string          { return "zed" }
func (p *ZedProvider) SupportsLocal() bool { return true }
func (p *ZedProvider) Priority() int       { return 10 }

func (p *ZedProvider) DetectPaths() []string {
	return []string{p.configDir()}
}

func (p *ZedProvider) IsInstalled() bool {
	return isInstalled(p.DetectPaths())
}

func (p *ZedProvider) GlobalConfigPath() string {
	return filepath.Join(p.configDir(), "settings.json")
}

func (p *ZedProvider) IsConfigured() bool {
	return isJSONKeyConfigured(p.GlobalConfigPath(), "context_servers")
}

// configDir returns the platform-specific Zed config directory.
func (p *ZedProvider) configDir() string {
	if runtime.GOOS == "darwin" || runtime.GOOS == "windows" {
		return filepath.Join(appSupportDir(), "Zed")
	}
	// Linux uses lowercase
	return filepath.Join(appSupportDir(), "zed")
}

func (p *ZedProvider) Install(cfg *config.Config, global bool) error {
	if cfg.DeploymentID == "" {
		return fmt.Errorf("deployment ID is required")
	}

	url := mcpURL(cfg.DeploymentID)
	configPath := p.GlobalConfigPath()

	zedConfig, err := loadJSONConfig(configPath)
	if err != nil {
		return fmt.Errorf("failed to load zed config: %w", err)
	}

	// Zed uses context_servers with a "source: custom" wrapper
	server := map[string]any{
		"source":  "custom",
		"type":    "http",
		"url":     url,
		"headers": mcpHeaders(cfg),
	}

	contextServers, ok := zedConfig["context_servers"].(map[string]any)
	if !ok {
		contextServers = make(map[string]any)
	}
	contextServers["dosu"] = server
	zedConfig["context_servers"] = contextServers

	if err := saveJSONConfig(configPath, zedConfig); err != nil {
		return fmt.Errorf("failed to save zed config: %w", err)
	}

	return nil
}

func (p *ZedProvider) Remove(global bool) error {
	configPath := p.GlobalConfigPath()

	zedConfig, err := loadJSONConfig(configPath)
	if err != nil {
		return nil
	}

	if contextServers, ok := zedConfig["context_servers"].(map[string]any); ok {
		delete(contextServers, "dosu")
	}

	return saveJSONConfig(configPath, zedConfig)
}
