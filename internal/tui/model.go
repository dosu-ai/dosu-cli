package tui

import (
	tea "github.com/charmbracelet/bubbletea"
	"github.com/dosu-ai/dosu-cli/internal/config"
)

type screen int

const (
	screenMenu screen = iota
	screenSetup
	screenSync
	screenDeployments
)

// model orchestrates which screen is active.
type model struct {
	screen      screen
	menu        MenuModel
	setup       SetupModel
	deployments DeploymentsModel
}

// New builds the root model.
func New() tea.Model {
	return model{
		screen: screenMenu,
		menu:   NewMenu(),
		setup:  NewSetup(),
	}
}

func (m model) Init() tea.Cmd {
	// Focus is handled inside child models; start with menu visible.
	return nil
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case MenuSelected:
		return m.handleMenuSelected(msg)
	case SetupComplete:
		m.screen = screenMenu
		m.menu.list.Select(1) // keep selection where you want; here arbitrarily on Sync
		return m, nil
	case SetupCanceled:
		m.screen = screenMenu
		return m, nil
	case DeploymentSelected:
		// Save selected deployment to config
		cfg, err := config.LoadConfig()
		if err == nil {
			cfg.DeploymentID = msg.ID
			cfg.DeploymentName = msg.Name
			config.SaveConfig(cfg)
		}
		m.screen = screenMenu
		return m, nil
	case DeploymentCanceled:
		m.screen = screenMenu
		return m, nil
	}

	switch m.screen {
	case screenMenu:
		var cmd tea.Cmd
		m.menu, cmd = m.menu.Update(msg)
		return m, cmd
	case screenSetup:
		var cmd tea.Cmd
		m.setup, cmd = m.setup.Update(msg)
		return m, cmd
	case screenSync:
		// TODO: add sync screen model; for now just go back on Esc handled elsewhere.
	case screenDeployments:
		var cmd tea.Cmd
		m.deployments, cmd = m.deployments.Update(msg)
		return m, cmd
	}

	return m, nil
}

func (m model) handleMenuSelected(msg MenuSelected) (tea.Model, tea.Cmd) {
	switch msg.ID {
	case "setup":
		m.screen = screenSetup
		return m, nil
	case "deployments":
		// Check if authenticated before allowing access
		cfg, err := config.LoadConfig()
		if err != nil || !cfg.IsAuthenticated() {
			// TODO: Show error message to user that they need to authenticate first
			// For now, just stay on menu
			return m, nil
		}
		m.screen = screenDeployments
		m.deployments = NewDeploymentsSelector()
		return m, m.deployments.Init()
	case "sync":
		// TODO: replace with sync screen; for now just show a message or go back.
		return m, nil
	case "status":
		// TODO: add status screen.
		return m, nil
	default:
		return m, nil
	}
}

func (m model) View() string {
	switch m.screen {
	case screenMenu:
		return m.menu.View()
	case screenSetup:
		return m.setup.View()
	case screenSync:
		return "Sync not implemented yet.\n\nPress Esc to go back."
	case screenDeployments:
		return m.deployments.View()
	default:
		return ""
	}
}
