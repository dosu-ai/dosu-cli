package cli

import (
	"fmt"
	"os"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/dosu-ai/dosu-cli/internal/tui"
	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:   "dosu",
	Short: "Dosu CLI - Manage MCP servers for AI tools",
	Long: `Dosu CLI provides both a TUI and CLI interface for managing
MCP server integration with AI coding tools like Claude, Gemini, and Codex.

Run without arguments to launch the interactive TUI.`,
	Run: func(cmd *cobra.Command, args []string) {
		// Default behavior: launch TUI
		p := tea.NewProgram(tui.New())
		if _, err := p.Run(); err != nil {
			fmt.Fprintf(os.Stderr, "Error running TUI: %v\n", err)
			os.Exit(1)
		}
	},
}

// Execute runs the root command
func Execute() error {
	return rootCmd.Execute()
}
