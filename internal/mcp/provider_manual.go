package mcp

import (
	"fmt"

	"github.com/dosu-ai/dosu-cli/internal/config"
)

type ManualProvider struct{}

func (p *ManualProvider) Name() string        { return "Manual Configuration" }
func (p *ManualProvider) ID() string          { return "manual" }
func (p *ManualProvider) SupportsLocal() bool { return false }

func (p *ManualProvider) Install(cfg *config.Config, global bool) error {
	url := mcpURL(cfg.DeploymentID)

	fmt.Println("Use these details to configure the Dosu MCP server in your client:")
	fmt.Println()
	fmt.Printf("  Transport:      HTTP\n")
	fmt.Printf("  Endpoint:       %s\n", url)
	fmt.Printf("  Header:         X-Dosu-API-Key: %s\n", cfg.APIKey)
	fmt.Println()

	return nil
}

func (p *ManualProvider) Remove(global bool) error {
	fmt.Println("\nTo remove the Dosu MCP server, manually delete the configuration from your client.")
	return nil
}
