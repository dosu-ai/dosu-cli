package cli

import (
	"github.com/dosu-ai/dosu-cli/internal/setup"
	"github.com/spf13/cobra"
)

var setupCmd = &cobra.Command{
	Use:   "setup",
	Short: "Set up Dosu MCP for your AI tools",
	Long: `Interactive setup wizard that authenticates, selects a deployment,
detects installed AI tools, and configures MCP servers automatically.

Use --deployment to skip deployment selection and go straight to tool configuration:
  dosu setup --deployment <deployment-id>`,
	SilenceUsage:  true,
	SilenceErrors: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		deploymentID, _ := cmd.Flags().GetString("deployment")
		return setup.Run(setup.Options{DeploymentID: deploymentID})
	},
}

func init() {
	setupCmd.Flags().String("deployment", "", "Skip to tool configuration for a specific deployment")
	rootCmd.AddCommand(setupCmd)
}
