package cli

import (
	"fmt"
	"time"

	"github.com/dosu-ai/dosu-cli/internal/auth"
	"github.com/dosu-ai/dosu-cli/internal/config"
	"github.com/spf13/cobra"
)

var loginCmd = &cobra.Command{
	Use:   "login",
	Short: "Authenticate with Dosu via OAuth",
	Long: `Opens your browser for OAuth authentication with Dosu.
Credentials are saved to ~/.config/dosu-cli/config.json`,
	RunE: func(cmd *cobra.Command, args []string) error {
		// Check if already authenticated
		cfg, _ := config.LoadConfig()
		if cfg.IsAuthenticated() && !cfg.IsTokenExpired() {
			fmt.Println("You are already logged in.")
			fmt.Println("Run 'dosu logout' first to re-authenticate.")
			return nil
		}

		fmt.Println("Opening browser for authentication...")
		token, err := auth.StartOAuthFlow()
		if err != nil {
			return fmt.Errorf("authentication failed: %w", err)
		}

		// Save token to config
		cfg.AccessToken = token.AccessToken
		cfg.RefreshToken = token.RefreshToken
		cfg.ExpiresAt = time.Now().Unix() + int64(token.ExpiresIn)

		if err := config.SaveConfig(cfg); err != nil {
			return fmt.Errorf("failed to save credentials: %w", err)
		}

		fmt.Println("Successfully authenticated!")
		if path, err := config.GetConfigPath(); err == nil {
			fmt.Printf("Credentials saved to %s\n", path)
		}
		return nil
	},
}

func init() {
	rootCmd.AddCommand(loginCmd)
}
