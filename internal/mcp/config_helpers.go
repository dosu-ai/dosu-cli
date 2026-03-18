package mcp

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/dosu-ai/dosu-cli/internal/config"
)

// mcpURL returns the MCP endpoint URL with deployment ID encoded in the path.
func mcpURL(deploymentID string) string {
	return fmt.Sprintf("%s/v1/mcp/deployments/%s", config.GetBackendURL(), deploymentID)
}

// mcpHeaders returns the standard MCP headers with API key auth.
func mcpHeaders(cfg *config.Config) map[string]string {
	return map[string]string{
		"X-Dosu-API-Key": cfg.APIKey,
	}
}

// loadJSONConfig reads and unmarshals a JSON config file. Returns an empty map if the file doesn't exist.
func loadJSONConfig(path string) (map[string]any, error) {
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

// saveJSONConfig writes a JSON config file, creating parent directories as needed.
func saveJSONConfig(path string, cfg map[string]any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

// isJSONKeyConfigured checks if "dosu" exists under the given top-level key in a JSON config file.
func isJSONKeyConfigured(configPath string, topLevelKey string) bool {
	cfg, err := loadJSONConfig(configPath)
	if err != nil {
		return false
	}
	section, ok := cfg[topLevelKey].(map[string]any)
	if !ok {
		return false
	}
	_, exists := section["dosu"]
	return exists
}

// installJSONServer writes the dosu MCP server entry into a JSON config file.
// configPath is the file to modify, topKey is the section name (e.g. "mcpServers"),
// and server is the complete server entry to write.
func installJSONServer(configPath, topKey string, server map[string]any) error {
	jsonCfg, err := loadJSONConfig(configPath)
	if err != nil {
		return err
	}
	section, ok := jsonCfg[topKey].(map[string]any)
	if !ok {
		section = make(map[string]any)
	}
	section["dosu"] = server
	jsonCfg[topKey] = section
	return saveJSONConfig(configPath, jsonCfg)
}

// removeJSONServer removes the dosu entry from a JSON config file.
func removeJSONServer(configPath, topKey string) error {
	jsonCfg, err := loadJSONConfig(configPath)
	if err != nil {
		return nil // file doesn't exist or can't be read = nothing to remove
	}
	if section, ok := jsonCfg[topKey].(map[string]any); ok {
		delete(section, "dosu")
	}
	return saveJSONConfig(configPath, jsonCfg)
}
