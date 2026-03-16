package mcp

import (
	"os"
	"path/filepath"
	"runtime"
	"sort"
)

// SetupProvider extends Provider with detection and metadata for dosu setup.
type SetupProvider interface {
	Provider
	DetectPaths() []string
	IsInstalled() bool
	IsConfigured() bool
	GlobalConfigPath() string
	Priority() int // lower = higher priority in display order
}

// AllSetupProviders returns all providers that implement SetupProvider, sorted by priority.
func AllSetupProviders() []SetupProvider {
	providers := []SetupProvider{
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
	}

	sort.Slice(providers, func(i, j int) bool {
		return providers[i].Priority() < providers[j].Priority()
	})

	return providers
}

// DetectInstalledProviders returns only providers that are detected on the system.
func DetectInstalledProviders() []SetupProvider {
	var detected []SetupProvider
	for _, p := range AllSetupProviders() {
		if p.IsInstalled() {
			detected = append(detected, p)
		}
	}
	return detected
}

// isInstalled checks if any of the given paths exist on the filesystem.
func isInstalled(paths []string) bool {
	for _, p := range paths {
		expanded := expandHome(p)
		if _, err := os.Stat(expanded); err == nil {
			return true
		}
	}
	return false
}

// expandHome expands ~ to the user's home directory.
func expandHome(path string) string {
	if len(path) == 0 || path[0] != '~' {
		return path
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return path
	}
	return filepath.Join(home, path[1:])
}

// appSupportDir returns the platform-specific Application Support directory.
func appSupportDir() string {
	switch runtime.GOOS {
	case "darwin":
		home, _ := os.UserHomeDir()
		return filepath.Join(home, "Library", "Application Support")
	case "windows":
		return os.Getenv("APPDATA")
	default: // linux
		if xdg := os.Getenv("XDG_CONFIG_HOME"); xdg != "" {
			return xdg
		}
		home, _ := os.UserHomeDir()
		return filepath.Join(home, ".config")
	}
}
