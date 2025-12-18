package cli

import (
	"fmt"
	"strings"

	"github.com/dosu-ai/dosu-cli/internal/config"
	"github.com/dosu-ai/dosu-cli/internal/mcp"
	"github.com/spf13/cobra"
)

var mcpCmd = &cobra.Command{
	Use:   "mcp",
	Short: "Manage MCP server integrations",
	Long:  `Add or manage Dosu MCP server integrations with AI coding tools.`,
}

var mcpAddCmd = &cobra.Command{
	Use:   "add <tool>",
	Short: "Add Dosu MCP to an AI tool",
	Long: `Add the Dosu MCP server to an AI coding tool.

Available tools:
  claude  - Claude Code CLI (Anthropic)
  gemini  - Gemini CLI (Google)
  codex   - Codex CLI (OpenAI)

Examples:
  dosu mcp add claude           # Add to Claude Code (project-local)
  dosu mcp add claude --global  # Add to Claude Code (all projects)
  dosu mcp add gemini --global  # Add to Gemini CLI (all projects)
  dosu mcp add codex            # Add to Codex CLI (global only)`,
	Args:      cobra.ExactArgs(1),
	ValidArgs: []string{"claude", "gemini", "codex"},
	RunE:      runMCPAdd,
}

var mcpListCmd = &cobra.Command{
	Use:   "list",
	Short: "List available AI tools",
	Long:  `List all AI tools that can be configured with Dosu MCP.`,
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println("Available AI tools:")
		fmt.Println()
		for _, p := range mcp.AllProviders() {
			scope := "local + global"
			if !p.SupportsLocal() {
				scope = "global only"
			}
			fmt.Printf("  %-10s %s (%s)\n", p.ID(), p.Name(), scope)
		}
		fmt.Println()
		fmt.Println("Use 'dosu mcp add <tool>' to add Dosu MCP to a tool.")
	},
}

var globalFlag bool

func init() {
	rootCmd.AddCommand(mcpCmd)
	mcpCmd.AddCommand(mcpAddCmd)
	mcpCmd.AddCommand(mcpListCmd)

	mcpAddCmd.Flags().BoolVarP(&globalFlag, "global", "g", false,
		"Add globally (all projects) instead of project-local")
}

func runMCPAdd(cmd *cobra.Command, args []string) error {
	toolID := strings.ToLower(args[0])

	// Get the provider
	provider, err := mcp.GetProvider(toolID)
	if err != nil {
		return fmt.Errorf("unknown tool '%s'. Use 'dosu mcp list' to see available tools", toolID)
	}

	// Check authentication
	cfg, err := config.LoadConfig()
	if err != nil {
		return fmt.Errorf("not logged in. Run 'dosu login' first")
	}
	if !cfg.IsAuthenticated() {
		return fmt.Errorf("not logged in. Run 'dosu login' first")
	}
	if cfg.IsTokenExpired() {
		return fmt.Errorf("session expired. Run 'dosu login' to re-authenticate")
	}

	// Check deployment selected
	if cfg.DeploymentID == "" {
		return fmt.Errorf("no deployment selected. Run 'dosu' to open the TUI and select a deployment")
	}

	// Handle scope
	global := globalFlag
	if !provider.SupportsLocal() && !global {
		// Tool only supports global - auto-set and inform user
		fmt.Printf("Note: %s only supports global installation.\n\n", provider.Name())
		global = true
	}

	// Show what we're doing
	scope := "project-local"
	if global {
		scope = "global (all projects)"
	}
	fmt.Printf("Adding Dosu MCP to %s (%s)...\n", provider.Name(), scope)

	err = provider.Install(cfg, global)
	if err != nil {
		return fmt.Errorf("failed to add MCP: %w", err)
	}

	fmt.Println()
	fmt.Printf("✓ Successfully added Dosu MCP to %s!\n", provider.Name())

	if global {
		fmt.Printf("\nStart %s in any project to use the Dosu MCP.\n", provider.Name())
	} else {
		fmt.Printf("\nStart %s in this project directory to use the Dosu MCP.\n", provider.Name())
	}

	return nil
}
