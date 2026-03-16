package cli

import (
	"github.com/dosu-ai/dosu-cli/internal/setup"
	"github.com/spf13/cobra"
)

var setupCmd = &cobra.Command{
	Use:   "setup",
	Short: "Set up Dosu MCP for your AI tools",
	Long: `Interactive setup wizard that authenticates, selects a deployment,
detects installed AI tools, and configures MCP servers automatically.`,
	SilenceUsage:  true,
	SilenceErrors: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		return setup.Run()
	},
}

func init() {
	rootCmd.AddCommand(setupCmd)
}
