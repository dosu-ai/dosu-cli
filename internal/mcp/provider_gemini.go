package mcp

import (
	"fmt"
	"os/exec"

	"github.com/dosu-ai/dosu-cli/internal/config"
)

type GeminiProvider struct{}

func (p *GeminiProvider) Name() string        { return "Gemini CLI" }
func (p *GeminiProvider) ID() string          { return "gemini" }
func (p *GeminiProvider) SupportsLocal() bool { return true }
func (p *GeminiProvider) Priority() int       { return 7 }
func (p *GeminiProvider) DetectPaths() []string {
	return []string{"~/.gemini"}
}
func (p *GeminiProvider) IsInstalled() bool {
	if !isInstalled(p.DetectPaths()) {
		return false
	}
	_, err := exec.LookPath("gemini")
	return err == nil
}
func (p *GeminiProvider) GlobalConfigPath() string {
	return expandHome("~/.gemini/settings.json")
}

func (p *GeminiProvider) Install(cfg *config.Config, global bool) error {
	if cfg.DeploymentID == "" {
		return fmt.Errorf("deployment ID is required")
	}

	url := mcpURL(cfg.DeploymentID)

	args := []string{"mcp", "add", "--transport", "http"}
	if global {
		args = append(args, "--scope", "user")
	} else {
		args = append(args, "--scope", "project")
	}
	args = append(args,
		"--header", fmt.Sprintf("X-Dosu-API-Key: %s", cfg.APIKey),
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

func (p *GeminiProvider) IsConfigured() bool {
	return false
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
