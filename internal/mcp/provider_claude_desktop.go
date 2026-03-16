package mcp

import (
	"fmt"
	"path/filepath"

	"github.com/dosu-ai/dosu-cli/internal/config"
)

// ErrStdioOnly indicates a provider only supports stdio transport.
var ErrStdioOnly = fmt.Errorf("this tool only supports local (stdio) servers and cannot be configured for remote MCP")

type ClaudeDesktopProvider struct{}

func (p *ClaudeDesktopProvider) Name() string        { return "Claude Desktop" }
func (p *ClaudeDesktopProvider) ID() string          { return "claude-desktop" }
func (p *ClaudeDesktopProvider) SupportsLocal() bool { return false }
func (p *ClaudeDesktopProvider) Priority() int       { return 2 }

func (p *ClaudeDesktopProvider) DetectPaths() []string {
	return []string{filepath.Join(appSupportDir(), "Claude")}
}

func (p *ClaudeDesktopProvider) IsInstalled() bool {
	return isInstalled(p.DetectPaths())
}

func (p *ClaudeDesktopProvider) GlobalConfigPath() string {
	return filepath.Join(appSupportDir(), "Claude", "claude_desktop_config.json")
}

func (p *ClaudeDesktopProvider) Install(cfg *config.Config, global bool) error {
	return ErrStdioOnly
}

func (p *ClaudeDesktopProvider) IsConfigured() bool {
	return false
}

func (p *ClaudeDesktopProvider) Remove(global bool) error {
	return ErrStdioOnly
}
