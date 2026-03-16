package setup

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/huh/spinner"
	"github.com/charmbracelet/lipgloss"
	"github.com/dosu-ai/dosu-cli/internal/auth"
	"github.com/dosu-ai/dosu-cli/internal/client"
	"github.com/dosu-ai/dosu-cli/internal/config"
	"github.com/dosu-ai/dosu-cli/internal/mcp"
	"github.com/pkg/browser"
)

const createNewValue = "__create_new__"

// errGoBack signals the user wants to go back to the previous step.
var errGoBack = errors.New("go back")

// setupTheme returns a clean huh theme with no borders and accent colors.
func setupTheme() *huh.Theme {
	theme := huh.ThemeBase()
	theme.Focused.Base = lipgloss.NewStyle()
	theme.Focused.Title = lipgloss.NewStyle()
	theme.Focused.Description = lipgloss.NewStyle().Foreground(lipgloss.Color("245"))
	theme.Focused.SelectedPrefix = lipgloss.NewStyle().Foreground(accentColor).SetString("[x] ")
	theme.Focused.UnselectedPrefix = lipgloss.NewStyle().Foreground(lipgloss.Color("245")).SetString("[ ] ")
	theme.Focused.SelectSelector = lipgloss.NewStyle().Foreground(accentColor).SetString("> ")
	theme.Focused.SelectedOption = lipgloss.NewStyle().Foreground(accentColor)
	theme.Focused.UnselectedOption = lipgloss.NewStyle()
	theme.Focused.MultiSelectSelector = lipgloss.NewStyle().Foreground(accentColor).SetString("> ")
	theme.Focused.FocusedButton = lipgloss.NewStyle().Foreground(accentColor)
	theme.Focused.BlurredButton = lipgloss.NewStyle().Foreground(lipgloss.Color("245"))
	theme.Blurred = theme.Focused
	return theme
}

// stepAuthenticate ensures the user is logged in.
func stepAuthenticate() (*config.Config, error) {
	cfg, err := config.LoadConfig()
	if err != nil {
		return nil, fmt.Errorf("failed to load config: %w", err)
	}

	// Already authenticated with valid token
	if cfg.IsAuthenticated() && !cfg.IsTokenExpired() {
		PrintSuccess("Authenticated")
		return cfg, nil
	}

	// Token expired — try refresh
	if cfg.IsAuthenticated() && cfg.IsTokenExpired() && cfg.RefreshToken != "" {
		var refreshErr error
		_ = spinner.New().
			Title("Refreshing authentication...").
			Action(func() {
				apiClient := client.NewClient(cfg)
				_, refreshErr = apiClient.GetDeployments()
			}).
			Run()

		if refreshErr == nil && cfg.IsAuthenticated() && !cfg.IsTokenExpired() {
			PrintSuccess("Authenticated")
			return cfg, nil
		}
	}

	// Need full OAuth flow
	fmt.Printf("  Opening browser to log in...\n")

	var token *auth.TokenResponse
	var oauthErr error

	err = spinner.New().
		Title("Waiting for authentication...").
		Action(func() {
			token, oauthErr = auth.StartOAuthFlow()
		}).
		Run()
	if err != nil {
		return nil, err
	}
	if oauthErr != nil {
		return nil, oauthErr
	}

	cfg.AccessToken = token.AccessToken
	cfg.RefreshToken = token.RefreshToken
	cfg.ExpiresAt = time.Now().Unix() + int64(token.ExpiresIn)

	if err := config.SaveConfig(cfg); err != nil {
		return nil, fmt.Errorf("failed to save config: %w", err)
	}

	PrintSuccess("Authenticated!")
	return cfg, nil
}

// stepSelectDeployment lets the user select an existing deployment or create a new one.
func stepSelectDeployment(cfg *config.Config, apiClient *client.Client) (*client.Deployment, error) {
	var deployments []client.Deployment
	var fetchErr error

	err := spinner.New().
		Title("Fetching deployments...").
		Action(func() {
			deployments, fetchErr = apiClient.GetDeployments()
		}).
		Run()
	if err != nil {
		return nil, err
	}
	if fetchErr != nil {
		return nil, fmt.Errorf("failed to fetch deployments: %w", fetchErr)
	}

	if len(deployments) == 0 {
		return stepCreateDeployment(apiClient)
	}

	for {
		options := make([]huh.Option[string], 0, len(deployments)+1)
		for _, d := range deployments {
			label := fmt.Sprintf("%s (%s)", d.Name, d.OrgName)
			options = append(options, huh.NewOption(label, d.DeploymentID))
		}
		options = append(options, huh.NewOption(
			fmt.Sprintf("%s Create new deployment", IconAdd),
			createNewValue,
		))

		var selected string
		err = huh.NewForm(
			huh.NewGroup(
				huh.NewSelect[string]().
					Title(Question("Select a deployment")).
					Options(options...).
					Value(&selected),
			),
		).WithTheme(setupTheme()).Run()
		if err != nil {
			return nil, err
		}

		if selected == createNewValue {
			fmt.Print("\0337") // save cursor position
			deployment, createErr := stepCreateDeployment(apiClient)
			if errors.Is(createErr, errGoBack) {
				fmt.Print("\0338\033[J") // restore cursor, clear below
				continue
			}
			if createErr != nil {
				return nil, createErr
			}
			deployments = append(deployments, *deployment)
			return deployment, nil
		}

		for i := range deployments {
			if deployments[i].DeploymentID == selected {
				PrintSuccess(fmt.Sprintf("Using deployment: %s", successStyle.Render(deployments[i].Name)))
				return &deployments[i], nil
			}
		}

		return nil, fmt.Errorf("selected deployment not found")
	}
}

// stepCreateDeployment handles creating a new deployment.
func stepCreateDeployment(apiClient *client.Client) (*client.Deployment, error) {
	var name string

	km := huh.NewDefaultKeyMap()
	km.Quit = key.NewBinding(key.WithKeys("ctrl+c", "esc"))

	err := huh.NewForm(
		huh.NewGroup(
			huh.NewInput().
				Title(Question("Deployment name") + " " + Dim("(Esc to go back)")).
				Placeholder("My MCP Deployment").
				Value(&name),
		),
	).WithKeyMap(km).WithTheme(setupTheme()).Run()
	if err != nil {
		if errors.Is(err, huh.ErrUserAborted) {
			return nil, errGoBack
		}
		return nil, err
	}

	if name == "" {
		name = "My MCP Deployment"
	}

	var deployment *client.Deployment
	var createErr error

	err = spinner.New().
		Title("Creating deployment...").
		Action(func() {
			deployment, createErr = apiClient.CreateDeployment(client.CreateDeploymentRequest{
				Name: name,
			})
		}).
		Run()
	if err != nil {
		return nil, err
	}

	if createErr != nil {
		if errors.Is(createErr, client.ErrEndpointNotAvailable) {
			fmt.Println()
			PrintWarning("Deployment creation via CLI is not yet available.")
			fmt.Printf("  Opening %s to create a deployment...\n", Info(config.GetWebAppURL()))
			fmt.Println()
			_ = browser.OpenURL(config.GetWebAppURL())
			fmt.Printf("  After creating a deployment, run %s again.\n", Info("dosu setup"))
			return nil, errUserAbort
		}
		return nil, createErr
	}

	PrintSuccess(fmt.Sprintf("Created deployment: %s", name))
	return deployment, nil
}

// isStdioOnly checks if a provider only supports stdio (can't be configured for remote MCP).
func isStdioOnly(p mcp.SetupProvider) bool {
	return p.ID() == "claude-desktop"
}

// stepDetectTools silently detects installed AI tools.
func stepDetectTools() []mcp.SetupProvider {
	allProviders := mcp.AllSetupProviders()
	var detected []mcp.SetupProvider

	for _, p := range allProviders {
		if p.IsInstalled() && !isStdioOnly(p) {
			detected = append(detected, p)
		}
	}

	return detected
}

// stepSelectTools shows a multi-select checkbox for the user to choose which tools to configure.
func stepSelectTools(detected []mcp.SetupProvider) (*toolSelection, error) {
	// Cache configured state
	configuredMap := make(map[string]bool, len(detected))
	for _, p := range detected {
		configuredMap[p.ID()] = p.IsConfigured()
	}

	// Build options: configured first, then unconfigured
	options := make([]huh.Option[string], 0, len(detected))
	for _, p := range detected {
		if configuredMap[p.ID()] {
			label := p.Name() + " " + dimStyle.Render("(already configured)")
			options = append(options, huh.NewOption(label, p.ID()).Selected(true))
		}
	}
	for _, p := range detected {
		if !configuredMap[p.ID()] {
			options = append(options, huh.NewOption(p.Name(), p.ID()))
		}
	}

	// Pre-populate so TitleFunc has correct data on first render
	var selectedIDs []string
	for _, p := range detected {
		if configuredMap[p.ID()] {
			selectedIDs = append(selectedIDs, p.ID())
		}
	}

	err := huh.NewForm(
		huh.NewGroup(
			huh.NewMultiSelect[string]().
				Title(Question("Select tools to configure") + " " + dimStyle.Render("no changes")).
				TitleFunc(func() string {
					idSet := make(map[string]bool)
					for _, id := range selectedIDs {
						idSet[id] = true
					}
					newCount, removeCount := 0, 0
					for _, p := range detected {
						sel := idSet[p.ID()]
						cfg := configuredMap[p.ID()]
						if sel && !cfg {
							newCount++
						}
						if !sel && cfg {
							removeCount++
						}
					}
					title := Question("Select tools to configure")
					if newCount == 0 && removeCount == 0 {
						return title + " " + dimStyle.Render("no changes")
					}
					parts := []string{}
					if newCount > 0 {
						parts = append(parts, fmt.Sprintf("%d new", newCount))
					}
					if removeCount > 0 {
						parts = append(parts, fmt.Sprintf("%d to remove", removeCount))
					}
					return title + " " + dimStyle.Render(strings.Join(parts, " · "))
				}, &selectedIDs).
				Options(options...).
				Value(&selectedIDs).
				Height(len(detected) + 1),
		),
	).WithTheme(setupTheme()).Run()
	if err != nil {
		return nil, err
	}

	// Build lookup of selected IDs
	idSet := make(map[string]bool, len(selectedIDs))
	for _, id := range selectedIDs {
		idSet[id] = true
	}

	// Categorize based on selection vs configured state
	result := &toolSelection{}
	for _, p := range detected {
		selected := idSet[p.ID()]
		configured := configuredMap[p.ID()]

		switch {
		case selected && !configured:
			result.ToInstall = append(result.ToInstall, p)
		case selected && configured:
			result.Skipped = append(result.Skipped, p)
		case !selected && configured:
			result.ToRemove = append(result.ToRemove, p)
		}
	}

	return result, nil
}

// stepConfigureTools installs/removes MCP config based on user selection.
func stepConfigureTools(cfg *config.Config, selection *toolSelection) []configResult {
	var results []configResult

	for _, p := range selection.ToInstall {
		var installErr error
		_ = spinner.New().
			Title(fmt.Sprintf("Configuring %s...", p.Name())).
			Action(func() {
				installErr = p.Install(cfg, true)
			}).
			Run()
		results = append(results, configResult{Provider: p, Action: actionInstall, Err: installErr})
		if installErr != nil {
			PrintError(fmt.Sprintf("Failed to configure %s: %v", p.Name(), installErr))
		}
	}

	for _, p := range selection.ToRemove {
		var removeErr error
		_ = spinner.New().
			Title(fmt.Sprintf("Removing %s...", p.Name())).
			Action(func() {
				removeErr = p.Remove(true)
			}).
			Run()
		results = append(results, configResult{Provider: p, Action: actionRemove, Err: removeErr})
		if removeErr != nil {
			PrintError(fmt.Sprintf("Failed to remove %s: %v", p.Name(), removeErr))
		}
	}

	for _, p := range selection.Skipped {
		results = append(results, configResult{Provider: p, Action: actionSkip})
	}

	return results
}

// stepShowSummary displays the final results and a try-it-out prompt.
func stepShowSummary(results []configResult) {
	var installed, removed, skipped []configResult
	for _, r := range results {
		if r.Err != nil {
			continue
		}
		switch r.Action {
		case actionInstall:
			installed = append(installed, r)
		case actionRemove:
			removed = append(removed, r)
		case actionSkip:
			skipped = append(skipped, r)
		}
	}

	fmt.Println()

	if len(installed) > 0 {
		fmt.Printf("\U0001f389 %s\n", successStyle.Render(fmt.Sprintf("Configured %d tool(s):", len(installed))))
		for _, r := range installed {
			fmt.Printf("  %s %s\n", successStyle.Render(IconAdd), r.Provider.Name())
		}
		fmt.Println()
	}

	if len(removed) > 0 {
		fmt.Printf("\U0001f5d1\ufe0f  Removed from %d tool(s):\n", len(removed))
		for _, r := range removed {
			fmt.Printf("  %s %s\n", dimStyle.Render(IconRemove), r.Provider.Name())
		}
		fmt.Println()
	}

	if len(installed) == 0 && len(removed) == 0 && len(skipped) > 0 {
		fmt.Printf("\U0001f389 %s\n", successStyle.Render("All tools already configured. No changes needed."))
		fmt.Println()
	}

	if len(installed) > 0 || len(skipped) > 0 {
		fmt.Println("Try it out! Paste this into your agent:")
		fmt.Println()
		PrintBox(
			"Use Dosu to search our team's documentation and answer:",
			"what are the main components of our system?",
		)
		fmt.Println()
	}
}
