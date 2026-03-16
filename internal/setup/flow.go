package setup

import (
	"errors"
	"fmt"

	"github.com/charmbracelet/huh"
	"github.com/dosu-ai/dosu-cli/internal/client"
	"github.com/dosu-ai/dosu-cli/internal/config"
	"github.com/dosu-ai/dosu-cli/internal/mcp"
)

// isUserAbort checks if an error is a user-initiated abort (Ctrl+C / Esc).
func isUserAbort(err error) bool {
	return errors.Is(err, huh.ErrUserAborted) || errors.Is(err, errUserAbort)
}

// errUserAbort indicates the user needs to take action externally before continuing.
var errUserAbort = errors.New("setup paused")

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

// Run executes the full dosu setup flow.
func Run() error {
	fmt.Println()

	// Step 1: Authenticate
	cfg, err := stepAuthenticate()
	if err != nil {
		if isUserAbort(err) {
			return nil
		}
		PrintError(fmt.Sprintf("Authentication failed: %v", err))
		return err
	}
	fmt.Println()

	// Step 2: Select or create deployment
	apiClient := client.NewClient(cfg)
	deployment, err := stepSelectDeployment(cfg, apiClient)
	if err != nil {
		if isUserAbort(err) {
			return nil
		}
		PrintError(fmt.Sprintf("Deployment selection failed: %v", err))
		return err
	}

	// Save deployment to config
	cfg.DeploymentID = deployment.DeploymentID
	cfg.DeploymentName = deployment.Name
	if err := config.SaveConfig(cfg); err != nil {
		PrintError(fmt.Sprintf("Failed to save config: %v", err))
		return err
	}

	fmt.Println()

	// Step 3: Detect installed tools
	detected := stepDetectTools()
	if len(detected) == 0 {
		fmt.Println()
		PrintWarning("No supported AI tools detected on your system.")
		fmt.Printf("  Run %s to manually configure a tool.\n", Info("dosu mcp add <tool>"))
		return nil
	}

	// Step 3b: Let user choose which tools to configure
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

	// Step 4: Configure/remove tools
	results := stepConfigureTools(cfg, selection)

	// Step 5: Show summary
	stepShowSummary(results)

	return nil
}
