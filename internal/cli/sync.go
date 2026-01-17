package cli

import (
	"fmt"

	"github.com/dosu-ai/dosu-cli/internal/config"
	"github.com/spf13/cobra"
)

var apiKeyFlag string

var syncCmd = &cobra.Command{
	Use:   "sync",
	Short: "Sync data with Dosu (coming soon)",
	Long: `Sync local data with your Dosu deployment.

This command supports multiple authentication methods:
  1. API Key via flag: dosu sync --key=<key>
  2. API Key via environment variable: DOSU_API_KEY=<key> dosu sync
  3. OAuth (default): Uses your logged-in session

API key (flag or env var) takes precedence over OAuth when provided.`,
	RunE: runSync,
}

func init() {
	rootCmd.AddCommand(syncCmd)
	syncCmd.Flags().StringVar(&apiKeyFlag, "key", "", "API key for authentication")
}

func runSync(cmd *cobra.Command, args []string) error {
	// Determine which authentication method is being used
	apiKey := resolveAPIKey()

	if apiKey != "" {
		fmt.Println("Authentication: API key detected")
	} else {
		// Fall back to OAuth
		cfg, err := config.LoadConfig()
		if err != nil || !cfg.IsAuthenticated() {
			fmt.Println("Error: Not authenticated.")
			fmt.Println()
			fmt.Println("Provide an API key via --key flag or DOSU_API_KEY environment variable,")
			fmt.Println("or run 'dosu login' to authenticate via OAuth.")
			return fmt.Errorf("authentication required")
		}
		if cfg.IsTokenExpired() {
			fmt.Println("Warning: OAuth token expired.")
			fmt.Println()
			fmt.Println("Run 'dosu login' to re-authenticate,")
			fmt.Println("or provide an API key via --key flag or DOSU_API_KEY.")
			return fmt.Errorf("token expired")
		}
		fmt.Println("Authentication: OAuth session")
	}

	fmt.Println()
	fmt.Println("Sync command is not yet available.")
	fmt.Println("This feature will be available in a future release.")
	return nil
}

// resolveAPIKey returns the API key from flag or environment variable.
// Flag takes precedence over environment variable.
func resolveAPIKey() string {
	if apiKeyFlag != "" {
		return apiKeyFlag
	}
	return config.GetAPIKey()
}
