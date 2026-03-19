package setup

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/key"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/huh/spinner"
	"github.com/charmbracelet/lipgloss"
	"github.com/dosu-ai/dosu-cli/internal/auth"
	"github.com/dosu-ai/dosu-cli/internal/client"
	"github.com/dosu-ai/dosu-cli/internal/config"
	"github.com/dosu-ai/dosu-cli/internal/mcp"
)

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

// saveConfig is a helper to save config and format error consistently.
func saveConfig(cfg *config.Config) error {
	if err := config.SaveConfig(cfg); err != nil {
		PrintError(fmt.Sprintf("Failed to save config: %v", err))
		return err
	}
	return nil
}

// stepAuthenticate ensures the user is logged in with a valid token.
func stepAuthenticate() (*config.Config, error) {
	cfg, err := config.LoadConfig()
	if err != nil {
		return nil, fmt.Errorf("failed to load config: %w", err)
	}

	if cfg.IsAuthenticated() {
		var valid bool
		_ = spinner.New().
			Title("Verifying session...").
			Action(func() {
				apiClient := client.NewClient(cfg)
				resp, err := apiClient.DoRequestRaw("GET", "/v1/mcp/deployments")
				if err != nil {
					valid = false
					return
				}
				resp.Body.Close()
				if resp.StatusCode == 401 || resp.StatusCode == 403 || resp.StatusCode == 500 {
					if refreshErr := apiClient.RefreshToken(); refreshErr != nil {
						valid = false
						return
					}
					resp2, err2 := apiClient.DoRequestRaw("GET", "/v1/mcp/deployments")
					if err2 != nil {
						valid = false
						return
					}
					resp2.Body.Close()
					valid = resp2.StatusCode == 200
				} else {
					valid = resp.StatusCode == 200
				}
			}).
			Run()

		if valid {
			PrintSuccess("Authenticated")
			return cfg, nil
		}
	}

	// Need login
	fmt.Print("\0337") // save cursor position
	if cfg.IsAuthenticated() {
		PrintWarning("Session expired.")
	}

	fmt.Printf("  Press %s to open browser and log in\n", Info("Enter"))
	fmt.Scanln()

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

	fmt.Print("\0338\033[J")

	cfg.AccessToken = token.AccessToken
	cfg.RefreshToken = token.RefreshToken
	cfg.ExpiresAt = time.Now().Unix() + int64(token.ExpiresIn)

	if err := config.SaveConfig(cfg); err != nil {
		return nil, fmt.Errorf("failed to save config: %w", err)
	}

	PrintSuccess("Authenticated")
	return cfg, nil
}

// stepSelectOrg fetches orgs and lets the user select one.
// Auto-selects if there's only one org.
func stepSelectOrg(apiClient *client.Client) (*client.Org, error) {
	var orgs []client.Org
	var fetchErr error

	err := spinner.New().
		Title("Fetching organizations...").
		Action(func() {
			orgs, fetchErr = apiClient.GetOrgs()
		}).
		Run()
	if err != nil {
		return nil, err
	}
	if fetchErr != nil {
		return nil, fmt.Errorf("failed to fetch orgs: %w", fetchErr)
	}

	if len(orgs) == 0 {
		return nil, fmt.Errorf("no organizations found for your account")
	}

	if len(orgs) == 1 {
		PrintSuccess(fmt.Sprintf("Organization: %s", successStyle.Render(orgs[0].Name)))
		return &orgs[0], nil
	}

	var selected string
	options := make([]huh.Option[string], len(orgs))
	for i, o := range orgs {
		options[i] = huh.NewOption(o.Name, o.OrgID)
	}

	km := huh.NewDefaultKeyMap()
	km.Quit = key.NewBinding(key.WithKeys("ctrl+c", "esc"))

	err = huh.NewForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title(Question("Select an organization")).
				Options(options...).
				Value(&selected),
		),
	).WithKeyMap(km).WithTheme(setupTheme()).Run()
	if err != nil {
		return nil, err
	}

	for i := range orgs {
		if orgs[i].OrgID == selected {
			PrintSuccess(fmt.Sprintf("Organization: %s", successStyle.Render(orgs[i].Name)))
			return &orgs[i], nil
		}
	}

	return nil, fmt.Errorf("selected org not found")
}

// stepResolveDeployment fetches deployments and finds one by ID.
func stepResolveDeployment(apiClient *client.Client, deploymentID string) (*client.Deployment, error) {
	deployments, err := apiClient.GetDeployments()
	if err != nil {
		return nil, err
	}
	for i := range deployments {
		if deployments[i].DeploymentID == deploymentID {
			return &deployments[i], nil
		}
	}
	return nil, fmt.Errorf("deployment %s not found", deploymentID)
}

// stepSelectDeployment lets the user select an existing deployment.
// Auto-selects if there's only one.
func stepSelectDeployment(apiClient *client.Client, org *client.Org) (*client.Deployment, error) {
	var allDeployments []client.Deployment
	var fetchErr error

	err := spinner.New().
		Title("Fetching deployments...").
		Action(func() {
			allDeployments, fetchErr = apiClient.GetDeployments()
		}).
		Run()
	if err != nil {
		return nil, err
	}
	if fetchErr != nil {
		return nil, fmt.Errorf("failed to fetch deployments: %w", fetchErr)
	}

	// Filter by selected org
	var deployments []client.Deployment
	for _, d := range allDeployments {
		if d.OrgID == org.OrgID {
			deployments = append(deployments, d)
		}
	}

	if len(deployments) == 0 {
		return nil, fmt.Errorf("no MCP deployments found for %s. Create one at %s", org.Name, config.GetWebAppURL())
	}

	if len(deployments) == 1 {
		PrintSuccess(fmt.Sprintf("Using deployment: %s", successStyle.Render(deployments[0].Name)))
		return &deployments[0], nil
	}

	// Multiple deployments — let user pick
	items := buildDeploymentItems(deployments)
	selector := newDeploymentSelect(items)
	result, err := tea.NewProgram(selector).Run()
	if err != nil {
		return nil, err
	}

	model := result.(deploymentSelect)
	if model.Aborted() {
		return nil, huh.ErrUserAborted
	}

	selected := model.Selected()
	for i := range deployments {
		if deployments[i].DeploymentID == selected {
			PrintSuccess(fmt.Sprintf("Using deployment: %s", successStyle.Render(deployments[i].Name)))
			return &deployments[i], nil
		}
	}

	return nil, fmt.Errorf("selected deployment not found")
}

// stepMintAPIKey creates a new API key or reuses an existing one.
func stepMintAPIKey(apiClient *client.Client, cfg *config.Config) (string, error) {
	// Reuse existing key if valid against current backend
	if cfg.APIKey != "" {
		if apiClient.ValidateAPIKey(cfg.APIKey, cfg.DeploymentID) {
			PrintSuccess("API key: " + dimStyle.Render("using existing"))
			return cfg.APIKey, nil
		}
		PrintWarning("Existing API key is invalid, creating a new one...")
	}

	var apiKeyResp *client.APIKeyResponse
	var mintErr error

	err := spinner.New().
		Title("Creating API key...").
		Action(func() {
			apiKeyResp, mintErr = apiClient.CreateAPIKey(cfg.DeploymentID, "dosu-cli")
		}).
		Run()
	if err != nil {
		return "", err
	}
	if mintErr != nil {
		return "", fmt.Errorf("failed to create API key: %w", mintErr)
	}

	PrintSuccess("API key created")
	return apiKeyResp.APIKey, nil
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
	configuredMap := make(map[string]bool, len(detected))
	for _, p := range detected {
		configuredMap[p.ID()] = p.IsConfigured()
	}

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

	idSet := make(map[string]bool, len(selectedIDs))
	for _, id := range selectedIDs {
		idSet[id] = true
	}

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
			fmt.Printf("    %s\n", dimStyle.Render(r.Provider.GlobalConfigPath()))
		}
		fmt.Println()
	}

	if len(skipped) > 0 && len(installed) > 0 {
		for _, r := range skipped {
			fmt.Printf("  %s %s\n", dimStyle.Render("~"), r.Provider.Name()+" "+dimStyle.Render("(already configured)"))
			fmt.Printf("    %s\n", dimStyle.Render(r.Provider.GlobalConfigPath()))
		}
		fmt.Println()
	}

	if len(removed) > 0 {
		fmt.Printf("\U0001f5d1\ufe0f  Removed from %d tool(s):\n", len(removed))
		for _, r := range removed {
			fmt.Printf("  %s %s\n", dimStyle.Render(IconRemove), r.Provider.Name())
			fmt.Printf("    %s\n", dimStyle.Render(r.Provider.GlobalConfigPath()))
		}
		fmt.Println()
	}

	if len(installed) == 0 && len(removed) == 0 && len(skipped) > 0 {
		fmt.Printf("\U0001f389 %s\n", successStyle.Render("All tools already configured. No changes needed."))
		for _, r := range skipped {
			fmt.Printf("  %s %s\n", dimStyle.Render("~"), r.Provider.Name()+" "+dimStyle.Render("(already configured)"))
			fmt.Printf("    %s\n", dimStyle.Render(r.Provider.GlobalConfigPath()))
		}
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
