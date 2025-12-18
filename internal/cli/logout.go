package cli

import (
	"fmt"

	"github.com/dosu-ai/dosu-cli/internal/config"
	"github.com/spf13/cobra"
)

var logoutCmd = &cobra.Command{
	Use:   "logout",
	Short: "Clear saved credentials",
	Long:  `Removes your saved authentication credentials from the local config file.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		cfg, err := config.LoadConfig()
		if err != nil {
			// Config doesn't exist or is invalid - nothing to clear
			fmt.Println("No credentials to clear.")
			return nil
		}

		if !cfg.IsAuthenticated() {
			fmt.Println("You are not logged in.")
			return nil
		}

		cfg.Clear()
		if err := config.SaveConfig(cfg); err != nil {
			return fmt.Errorf("failed to clear credentials: %w", err)
		}

		fmt.Println("Successfully logged out.")
		return nil
	},
}

func init() {
	rootCmd.AddCommand(logoutCmd)
}
