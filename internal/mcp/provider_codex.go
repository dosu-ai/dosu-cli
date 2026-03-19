package mcp

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/BurntSushi/toml"
	"github.com/dosu-ai/dosu-cli/internal/config"
)

type CodexProvider struct{}

func (p *CodexProvider) Name() string        { return "Codex CLI" }
func (p *CodexProvider) ID() string          { return "codex" }
func (p *CodexProvider) SupportsLocal() bool { return true }
func (p *CodexProvider) Priority() int       { return 8 }
func (p *CodexProvider) DetectPaths() []string {
	return []string{"~/.codex"}
}
func (p *CodexProvider) IsInstalled() bool {
	return isInstalled(p.DetectPaths())
}

// codexHome returns the Codex home directory, respecting $CODEX_HOME.
func (p *CodexProvider) codexHome() string {
	if codexHome := os.Getenv("CODEX_HOME"); codexHome != "" {
		return codexHome
	}
	return expandHome("~/.codex")
}

func (p *CodexProvider) GlobalConfigPath() string {
	return filepath.Join(p.codexHome(), "config.toml")
}

func (p *CodexProvider) configPath(global bool) (string, error) {
	if global {
		return p.GlobalConfigPath(), nil
	}
	cwd, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("failed to get current directory: %w", err)
	}
	return filepath.Join(cwd, ".codex", "config.toml"), nil
}

func (p *CodexProvider) loadConfig(path string) (*CodexConfig, error) {
	cfg := &CodexConfig{}
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return cfg, nil
	}
	_, err := toml.DecodeFile(path, cfg)
	if err != nil {
		return nil, err
	}
	return cfg, nil
}

func (p *CodexProvider) saveConfig(path string, cfg *CodexConfig) error {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return toml.NewEncoder(f).Encode(cfg)
}

func (p *CodexProvider) Install(cfg *config.Config, global bool) error {
	if cfg.DeploymentID == "" {
		return fmt.Errorf("deployment ID is required")
	}

	configPath, err := p.configPath(global)
	if err != nil {
		return fmt.Errorf("failed to get codex config path: %w", err)
	}

	codexConfig, err := p.loadConfig(configPath)
	if err != nil {
		return fmt.Errorf("failed to load codex config: %w", err)
	}

	url := mcpURL(cfg.DeploymentID)

	if codexConfig.MCPServers == nil {
		codexConfig.MCPServers = make(map[string]CodexMCPServer)
	}

	codexConfig.MCPServers["dosu"] = CodexMCPServer{
		Type:        "http",
		URL:         url,
		HTTPHeaders: mcpHeaders(cfg),
	}

	if err := p.saveConfig(configPath, codexConfig); err != nil {
		return fmt.Errorf("failed to save codex config: %w", err)
	}

	return nil
}

func (p *CodexProvider) IsConfigured() bool {
	cfg, err := p.loadConfig(p.GlobalConfigPath())
	if err != nil {
		return false
	}
	_, exists := cfg.MCPServers["dosu"]
	return exists
}

func (p *CodexProvider) Remove(global bool) error {
	configPath, err := p.configPath(global)
	if err != nil {
		return fmt.Errorf("failed to get codex config path: %w", err)
	}

	codexConfig, err := p.loadConfig(configPath)
	if err != nil {
		return fmt.Errorf("failed to load codex config: %w", err)
	}

	if codexConfig.MCPServers == nil {
		return nil
	}

	delete(codexConfig.MCPServers, "dosu")

	if err := p.saveConfig(configPath, codexConfig); err != nil {
		return fmt.Errorf("failed to save codex config: %w", err)
	}

	return nil
}

// CodexConfig represents the structure of ~/.codex/config.toml
type CodexConfig struct {
	MCPServers map[string]CodexMCPServer `toml:"mcp_servers"`
}

// CodexMCPServer represents an MCP server entry in Codex config
type CodexMCPServer struct {
	Type              string            `toml:"type,omitempty"`
	URL               string            `toml:"url"`
	HTTPHeaders       map[string]string `toml:"http_headers,omitempty"`
	BearerTokenEnvVar string            `toml:"bearer_token_env_var,omitempty"`
	EnvHTTPHeaders    map[string]string `toml:"env_http_headers,omitempty"`
}
