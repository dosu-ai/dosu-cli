package mcp

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/BurntSushi/toml"
	"github.com/dosu-ai/dosu-cli/internal/config"
)

type Provider interface {
	Name() string
	ID() string
	SupportsLocal() bool
	Install(cfg *config.Config, global bool) error
	Remove(global bool) error
}

// GetProvider returns a provider for the given tool ID
func GetProvider(toolID string) (Provider, error) {
	switch toolID {
	case "claude":
		return &ClaudeProvider{}, nil
	case "gemini":
		return &GeminiProvider{}, nil
	case "codex":
		return &CodexProvider{}, nil
	case "manual":
		return &ManualProvider{}, nil
	default:
		return nil, fmt.Errorf("unknown tool: %s", toolID)
	}
}

// AllProviders returns all available providers
func AllProviders() []Provider {
	return []Provider{
		&ClaudeProvider{},
		&GeminiProvider{},
		&CodexProvider{},
		&ManualProvider{},
	}
}

type ClaudeProvider struct{}

func (p *ClaudeProvider) Name() string        { return "Claude Code" }
func (p *ClaudeProvider) ID() string          { return "claude" }
func (p *ClaudeProvider) SupportsLocal() bool { return true }

func (p *ClaudeProvider) getConfigPath() (string, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(homeDir, ".claude.json"), nil
}

func (p *ClaudeProvider) loadConfig(path string) (map[string]any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return make(map[string]any), nil
		}
		return nil, err
	}

	var cfg map[string]any
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	return cfg, nil
}

func (p *ClaudeProvider) saveConfig(path string, cfg map[string]any) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

func (p *ClaudeProvider) Install(cfg *config.Config, global bool) error {
	if cfg.DeploymentID == "" {
		return fmt.Errorf("deployment ID is required")
	}

	url := fmt.Sprintf("%s/v1/mcp", config.GetBackendURL())

	configPath, err := p.getConfigPath()
	if err != nil {
		return fmt.Errorf("failed to get claude config path: %w", err)
	}

	claudeConfig, err := p.loadConfig(configPath)
	if err != nil {
		return fmt.Errorf("failed to load claude config: %w", err)
	}

	server := map[string]any{
		"type": "http",
		"url":  url,
		"headers": map[string]string{
			"X-Deployment-ID": cfg.DeploymentID,
		},
	}

	if global {
		// Add to root-level mcpServers
		mcpServers, ok := claudeConfig["mcpServers"].(map[string]any)
		if !ok {
			mcpServers = make(map[string]any)
		}
		mcpServers["dosu"] = server
		claudeConfig["mcpServers"] = mcpServers
	} else {
		// Add to projects.<cwd>.mcpServers
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

	if err := p.saveConfig(configPath, claudeConfig); err != nil {
		return fmt.Errorf("failed to save claude config: %w", err)
	}

	return nil
}

func (p *ClaudeProvider) Remove(global bool) error {
	configPath, err := p.getConfigPath()
	if err != nil {
		return fmt.Errorf("failed to get claude config path: %w", err)
	}

	// Check if config exists
	if _, err := os.Stat(configPath); os.IsNotExist(err) {
		return nil
	}

	claudeConfig, err := p.loadConfig(configPath)
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

	if err := p.saveConfig(configPath, claudeConfig); err != nil {
		return fmt.Errorf("failed to save claude config: %w", err)
	}

	return nil
}

type GeminiProvider struct{}

func (p *GeminiProvider) Name() string        { return "Gemini CLI" }
func (p *GeminiProvider) ID() string          { return "gemini" }
func (p *GeminiProvider) SupportsLocal() bool { return true }

func (p *GeminiProvider) Install(cfg *config.Config, global bool) error {
	if cfg.DeploymentID == "" {
		return fmt.Errorf("deployment ID is required")
	}

	url := fmt.Sprintf("%s/v1/mcp", config.GetBackendURL())

	args := []string{"mcp", "add", "--transport", "http"}
	if global {
		args = append(args, "--scope", "user")
	} else {
		args = append(args, "--scope", "project")
	}
	args = append(args,
		"--header", fmt.Sprintf("X-Deployment-ID: %s", cfg.DeploymentID),
		"dosu",
		url,
	)

	cmd := exec.Command("gemini", args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("gemini mcp add failed: %w: %s", err, string(output))
	}
	return nil
}

func (p *GeminiProvider) Remove(global bool) error {
	args := []string{"mcp", "remove"}
	if global {
		args = append(args, "--scope", "user")
	} else {
		args = append(args, "--scope", "project")
	}
	args = append(args, "dosu")

	cmd := exec.Command("gemini", args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("gemini mcp remove failed: %w: %s", err, string(output))
	}
	return nil
}

type CodexProvider struct{}

func (p *CodexProvider) Name() string        { return "Codex CLI" }
func (p *CodexProvider) ID() string          { return "codex" }
func (p *CodexProvider) SupportsLocal() bool { return false } // Global only

func (p *CodexProvider) Install(cfg *config.Config, global bool) error {
	if cfg.DeploymentID == "" {
		return fmt.Errorf("deployment ID is required")
	}

	configPath, err := p.getConfigPath()
	if err != nil {
		return fmt.Errorf("failed to get codex config path: %w", err)
	}

	// Load existing config or create new one
	codexConfig, err := p.loadConfig(configPath)
	if err != nil {
		return fmt.Errorf("failed to load codex config: %w", err)
	}

	// Add the Dosu MCP server configuration
	url := fmt.Sprintf("%s/v1/mcp", config.GetBackendURL())

	if codexConfig.MCPServers == nil {
		codexConfig.MCPServers = make(map[string]CodexMCPServer)
	}

	codexConfig.MCPServers["dosu"] = CodexMCPServer{
		URL: url,
		HTTPHeaders: map[string]string{
			"Authorization":   fmt.Sprintf("Bearer %s", cfg.AccessToken),
			"X-Deployment-ID": cfg.DeploymentID,
		},
	}

	if err := p.saveConfig(configPath, codexConfig); err != nil {
		return fmt.Errorf("failed to save codex config: %w", err)
	}

	return nil
}

func (p *CodexProvider) Remove(global bool) error {
	configPath, err := p.getConfigPath()
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

func (p *CodexProvider) getConfigPath() (string, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(homeDir, ".codex", "config.toml"), nil
}

func (p *CodexProvider) loadConfig(path string) (*CodexConfig, error) {
	cfg := &CodexConfig{}

	// Check if file exists
	if _, err := os.Stat(path); os.IsNotExist(err) {
		// Return empty config if file doesn't exist
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

// CodexConfig represents the structure of ~/.codex/config.toml
type CodexConfig struct {
	MCPServers map[string]CodexMCPServer `toml:"mcp_servers"`
	// Other fields can be added as needed
}

// CodexMCPServer represents an MCP server entry in Codex config
type CodexMCPServer struct {
	URL               string            `toml:"url"`
	HTTPHeaders       map[string]string `toml:"http_headers,omitempty"`
	BearerTokenEnvVar string            `toml:"bearer_token_env_var,omitempty"`
	EnvHTTPHeaders    map[string]string `toml:"env_http_headers,omitempty"`
}

type ManualProvider struct{}

func (p *ManualProvider) Name() string        { return "Manual Configuration" }
func (p *ManualProvider) ID() string          { return "manual" }
func (p *ManualProvider) SupportsLocal() bool { return false }

func (p *ManualProvider) Install(cfg *config.Config, global bool) error {
	url := fmt.Sprintf("%s/v1/mcp", config.GetBackendURL())

	fmt.Println("Use these details to configure the Dosu MCP server in your client:")
	fmt.Println()
	fmt.Printf("  Transport:      HTTP\n")
	fmt.Printf("  Authentication: OAuth 2.0 with DCR\n")
	fmt.Printf("  Endpoint:       %s\n", url)
	fmt.Printf("  Custom Headers: X-Deployment-ID: %s\n", cfg.DeploymentID)
	fmt.Println()

	return nil
}

func (p *ManualProvider) Remove(global bool) error {
	fmt.Println("\nTo remove the Dosu MCP server, manually delete the configuration from your client.")
	return nil
}
