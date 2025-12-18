package tui

import (
	tea "github.com/charmbracelet/bubbletea"
	"github.com/dosu-ai/dosu-cli/internal/config"
)

type screen int

const (
	screenMenu screen = iota
	screenSetup
	screenDeployments
	screenMCPTools
	screenMCP
)

// model orchestrates which screen is active.
type model struct {
	screen      screen
	menu        MenuModel
	setup       SetupModel
	deployments DeploymentsModel
	mcpTools    MCPToolsModel
	mcp         MCPModel
	mcpRemove   bool // true when removing MCP instead of adding
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
		m.menu = NewMenu() // Refresh menu to update auth state
		m.menu.list.Select(1)
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
		m.menu = NewMenu() // Refresh menu to enable MCP option
		return m, nil
	case DeploymentCanceled:
		m.screen = screenMenu
		return m, nil
	case MCPComplete:
		m.screen = screenMenu
		m.menu = NewMenu()
		return m, nil
	case MCPCanceled:
		m.screen = screenMCPTools
		return m, nil
	case MCPToolSelected:
		m.screen = screenMCP
		m.mcp = NewMCPSetupWithTool(msg.ToolID, msg.ToolName, m.mcpRemove)
		return m, m.mcp.Init()
	case MCPToolsCanceled:
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
	case screenDeployments:
		var cmd tea.Cmd
		m.deployments, cmd = m.deployments.Update(msg)
		return m, cmd
	case screenMCPTools:
		var cmd tea.Cmd
		m.mcpTools, cmd = m.mcpTools.Update(msg)
		return m, cmd
	case screenMCP:
		var cmd tea.Cmd
		m.mcp, cmd = m.mcp.Update(msg)
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
		cfg, err := config.LoadConfig()
		if err != nil || !cfg.IsAuthenticated() {
			return m, nil
		}
		m.screen = screenDeployments
		m.deployments = NewDeploymentsSelector()
		return m, m.deployments.Init()
	case "mcp-add":
		cfg, err := config.LoadConfig()
		if err != nil || !cfg.IsAuthenticated() || cfg.DeploymentID == "" {
			return m, nil
		}
		m.mcpRemove = false
		m.screen = screenMCPTools
		m.mcpTools = NewMCPToolsSelector(false)
		return m, nil
	case "mcp-remove":
		cfg, err := config.LoadConfig()
		if err != nil || !cfg.IsAuthenticated() || cfg.DeploymentID == "" {
			return m, nil
		}
		m.mcpRemove = true
		m.screen = screenMCPTools
		m.mcpTools = NewMCPToolsSelector(true)
		return m, nil
	case "logout":
		cfg, err := config.LoadConfig()
		if err != nil {
			return m, nil
		}
		cfg.Clear()
		config.SaveConfig(cfg)
		m.menu = NewMenu()
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
	case screenDeployments:
		return m.deployments.View()
	case screenMCPTools:
		return m.mcpTools.View()
	case screenMCP:
		return m.mcp.View()
	default:
		return ""
	}
}
