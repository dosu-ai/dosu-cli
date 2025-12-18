package mcp

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/BurntSushi/toml"
	"github.com/dosu-ai/dosu-cli/internal/config"
)

// Provider defines the interface for MCP server installation
type Provider interface {
	// Name returns the display name of the AI tool
	Name() string
	// ID returns the identifier used in commands and config
	ID() string
	// SupportsLocal returns true if the provider supports project-local installation
	SupportsLocal() bool
	// Install adds the Dosu MCP server to this AI tool
	Install(cfg *config.Config, global bool) error
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
	}
}

// =============================================================================
// Claude Provider
// =============================================================================

// ClaudeProvider implements Provider for Claude Code CLI
type ClaudeProvider struct{}

func (p *ClaudeProvider) Name() string        { return "Claude Code" }
func (p *ClaudeProvider) ID() string          { return "claude" }
func (p *ClaudeProvider) SupportsLocal() bool { return true }

func (p *ClaudeProvider) Install(cfg *config.Config, global bool) error {
	url := fmt.Sprintf("%s/v1/mcp", config.GetBackendURL())

	args := []string{"mcp", "add", "--transport", "http"}
	if global {
		args = append(args, "--scope", "user")
	}
	args = append(args,
		"dosu",
		url,
		"--header", fmt.Sprintf("Authorization: Bearer %s", cfg.AccessToken),
		"--header", fmt.Sprintf("X-Deployment-ID: %s", cfg.DeploymentID),
	)

	cmd := exec.Command("claude", args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("claude mcp add failed: %w: %s", err, string(output))
	}
	return nil
}

// =============================================================================
// Gemini Provider
// =============================================================================

// GeminiProvider implements Provider for Gemini CLI
type GeminiProvider struct{}

func (p *GeminiProvider) Name() string        { return "Gemini CLI" }
func (p *GeminiProvider) ID() string          { return "gemini" }
func (p *GeminiProvider) SupportsLocal() bool { return true }

func (p *GeminiProvider) Install(cfg *config.Config, global bool) error {
	url := fmt.Sprintf("%s/v1/mcp", config.GetBackendURL())

	// gemini mcp add --transport http --scope <user|project> -H "Header: value" <name> <url>
	scope := "project"
	if global {
		scope = "user"
	}

	args := []string{
		"mcp", "add",
		"--transport", "http",
		"--scope", scope,
		"-H", fmt.Sprintf("Authorization: Bearer %s", cfg.AccessToken),
		"-H", fmt.Sprintf("X-Deployment-ID: %s", cfg.DeploymentID),
		"dosu",
		url,
	}

	cmd := exec.Command("gemini", args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("gemini mcp add failed: %w: %s", err, string(output))
	}
	return nil
}

// =============================================================================
// Codex Provider
// =============================================================================

// CodexProvider implements Provider for OpenAI Codex CLI
type CodexProvider struct{}

func (p *CodexProvider) Name() string        { return "Codex CLI" }
func (p *CodexProvider) ID() string          { return "codex" }
func (p *CodexProvider) SupportsLocal() bool { return false } // Global only

func (p *CodexProvider) Install(cfg *config.Config, global bool) error {
	// Codex uses ~/.codex/config.toml for configuration
	// We need to add/update the [mcp_servers.dosu] section

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
			"X-Deployment-ID": cfg.DeploymentID,
		},
		BearerTokenEnvVar: "DOSU_TOKEN",
	}

	// Save the config
	if err := p.saveConfig(configPath, codexConfig); err != nil {
		return fmt.Errorf("failed to save codex config: %w", err)
	}

	// Store the token for the user to add to their environment
	// We'll return instructions about this in the TUI/CLI
	return &CodexTokenSetupRequired{
		Token:      cfg.AccessToken,
		ConfigPath: configPath,
	}
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
	// Ensure directory exists
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()

	encoder := toml.NewEncoder(f)
	return encoder.Encode(cfg)
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

// CodexTokenSetupRequired is returned when Codex installation succeeds
// but the user needs to set up their DOSU_TOKEN environment variable
type CodexTokenSetupRequired struct {
	Token      string
	ConfigPath string
}

func (e *CodexTokenSetupRequired) Error() string {
	return "codex config updated - DOSU_TOKEN environment variable setup required"
}

// IsCodexTokenSetupRequired checks if an error is a CodexTokenSetupRequired
func IsCodexTokenSetupRequired(err error) (*CodexTokenSetupRequired, bool) {
	if setup, ok := err.(*CodexTokenSetupRequired); ok {
		return setup, true
	}
	return nil, false
}
