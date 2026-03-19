package setup

import (
	"errors"
	"fmt"

	"github.com/charmbracelet/huh"
	"github.com/dosu-ai/dosu-cli/internal/client"
	"github.com/dosu-ai/dosu-cli/internal/mcp"
)

// isUserAbort checks if an error is a user-initiated abort (Ctrl+C / Esc).
func isUserAbort(err error) bool {
	return errors.Is(err, huh.ErrUserAborted)
}

func isSessionExpired(err error) bool {
	return errors.Is(err, client.ErrSessionExpired)
}

type configAction string

const (
	actionInstall configAction = "install"
	actionRemove  configAction = "remove"
	actionSkip    configAction = "skip"
)

// configResult tracks the outcome of configuring a single provider.
type configResult struct {
	Provider mcp.SetupProvider
	Action   configAction
	Err      error
}

// toolSelection categorizes providers based on user selection vs current config state.
type toolSelection struct {
	ToInstall []mcp.SetupProvider // selected + NOT configured
	ToRemove  []mcp.SetupProvider // NOT selected + already configured
	Skipped   []mcp.SetupProvider // selected + already configured (no-op)
}

// Options configures the setup flow behavior.
type Options struct {
	// DeploymentID skips org/deployment selection and jumps straight to tool configuration.
	DeploymentID string
}

// Run executes the full dosu setup flow.
func Run(opts Options) error {
	fmt.Println()

	// Authenticate
	cfg, err := stepAuthenticate()
	if err != nil {
		if isUserAbort(err) {
			return nil
		}
		PrintError(fmt.Sprintf("Authentication failed: %v", err))
		return err
	}
	fmt.Println()

	apiClient := client.NewClient(cfg)

	if opts.DeploymentID != "" {
		// --deployment flag: skip selection, resolve and save directly
		deployment, err := stepResolveDeployment(apiClient, opts.DeploymentID)
		if err != nil {
			if isSessionExpired(err) {
				PrintWarning("Session expired. Please run " + Info("dosu setup") + " again to re-authenticate.")
				return nil
			}
			PrintError(fmt.Sprintf("Deployment not found: %v", err))
			return err
		}
		cfg.DeploymentID = deployment.DeploymentID
		cfg.DeploymentName = deployment.Name
		if err := saveConfig(cfg); err != nil {
			return err
		}
		PrintSuccess(fmt.Sprintf("Using deployment: %s", Success(deployment.Name)))
		fmt.Println()
	} else {
		// Select organization
		org, err := stepSelectOrg(apiClient)
		if err != nil {
			if isUserAbort(err) {
				return nil
			}
			if isSessionExpired(err) {
				PrintWarning("Session expired. Please run " + Info("dosu setup") + " again to re-authenticate.")
				return nil
			}
			PrintError(fmt.Sprintf("Organization selection failed: %v", err))
			return err
		}
		fmt.Println()

		// Select deployment (auto-select if only one, no creation)
		deployment, err := stepSelectDeployment(apiClient, org)
		if err != nil {
			if isUserAbort(err) {
				return nil
			}
			if isSessionExpired(err) {
				PrintWarning("Session expired. Please run " + Info("dosu setup") + " again to re-authenticate.")
				return nil
			}
			PrintError(fmt.Sprintf("Deployment selection failed: %v", err))
			return err
		}

		cfg.DeploymentID = deployment.DeploymentID
		cfg.DeploymentName = deployment.Name
		if err := saveConfig(cfg); err != nil {
			return err
		}
		fmt.Println()
	}

	// Mint API key (or reuse existing)
	apiKey, err := stepMintAPIKey(apiClient, cfg)
	if err != nil {
		if isUserAbort(err) {
			return nil
		}
		PrintError(fmt.Sprintf("API key creation failed: %v", err))
		return err
	}
	cfg.APIKey = apiKey
	if err := saveConfig(cfg); err != nil {
		return err
	}
	fmt.Println()

	// Detect installed tools
	detected := stepDetectTools()
	if len(detected) == 0 {
		fmt.Println()
		PrintWarning("No supported AI tools detected on your system.")
		fmt.Printf("  Run %s to manually configure a tool.\n", Info("dosu mcp add <tool>"))
		return nil
	}

	// Let user choose which tools to configure
	selection, err := stepSelectTools(detected)
	if err != nil {
		if isUserAbort(err) {
			return nil
		}
		PrintError(fmt.Sprintf("Tool selection failed: %v", err))
		return err
	}
	if len(selection.ToInstall) == 0 && len(selection.ToRemove) == 0 && len(selection.Skipped) == 0 {
		PrintWarning("No tools selected. Run " + Info("dosu setup") + " again to configure later.")
		return nil
	}

	// Configure/remove tools
	results := stepConfigureTools(cfg, selection)

	// Show summary
	stepShowSummary(results)

	return nil
}
