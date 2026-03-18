package mcp

import (
	"fmt"

	"github.com/dosu-ai/dosu-cli/internal/config"
)

type Provider interface {
	Name() string
	ID() string
	SupportsLocal() bool
	Install(cfg *config.Config, global bool) error
	Remove(global bool) error
}

// GetProvider returns a provider for the given tool ID.
func GetProvider(toolID string) (Provider, error) {
	for _, p := range AllProviders() {
		if p.ID() == toolID {
			return p, nil
		}
	}
	return nil, fmt.Errorf("unknown tool: %s", toolID)
}

// AllProviders returns all available providers (for CLI mcp add/list commands)
func AllProviders() []Provider {
	return []Provider{
		&ClaudeProvider{},
		&ClaudeDesktopProvider{},
		&CursorProvider{},
		&VSCodeProvider{},
		&GeminiProvider{},
		&CodexProvider{},
		&WindsurfProvider{},
		&ZedProvider{},
		&ClineProvider{},
		&ClineCliProvider{},
		&CopilotProvider{},
		&OpenCodeProvider{},
		&AntigravityProvider{},
		&MCPorterProvider{},
		&ManualProvider{},
	}
}
