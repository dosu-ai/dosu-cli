package cli

import (
	"fmt"

	"github.com/dosu-ai/dosu-cli/internal/config"
	"github.com/spf13/cobra"
)

var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show current authentication and deployment status",
	Long:  `Displays your current login status and selected deployment.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		cfg, err := config.LoadConfig()
		if err != nil {
			fmt.Println("Status: Not logged in")
			fmt.Println("Run 'dosu login' to authenticate.")
			return nil
		}

		// Authentication status
		if cfg.IsAuthenticated() {
			if cfg.IsTokenExpired() {
				fmt.Println("Status: Token expired")
				fmt.Println("Run 'dosu login' to re-authenticate.")
			} else {
				fmt.Println("Status: Logged in")
			}
		} else {
			fmt.Println("Status: Not logged in")
			fmt.Println("Run 'dosu login' to authenticate.")
			return nil
		}

		// Deployment status
		if cfg.DeploymentID != "" {
			fmt.Printf("Deployment: %s\n", cfg.DeploymentName)
			fmt.Printf("Deployment ID: %s\n", cfg.DeploymentID)
		} else {
			fmt.Println("Deployment: None selected")
			fmt.Println("Run 'dosu' to open the TUI and select a deployment.")
		}

		return nil
	},
}

func init() {
	rootCmd.AddCommand(statusCmd)
}
