package tui

import (
	"github.com/charmbracelet/bubbles/list"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/dosu-ai/dosu-cli/internal/config"
)

// MenuSelected is emitted to the parent model when an item is chosen.
type MenuSelected struct {
	ID string
}

type MenuModel struct {
	list            list.Model
	isAuthenticated bool
}

const maxListHeight = 20

func (m MenuModel) Init() tea.Cmd {
	return nil
}

func (m MenuModel) Update(msg tea.Msg) (MenuModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		appH, appV := appStyle.GetFrameSize()
		frameH, frameV := frameStyle.GetFrameSize()
		headerHeight := lipgloss.Height(headerStyle.Render(logo))
		width := msg.Width - appH - frameH
		if width < 10 {
			width = 10
		}
		listHeight := msg.Height - appV - frameV - headerHeight
		if listHeight < 4 {
			listHeight = 4
		}
		if listHeight > maxListHeight {
			listHeight = maxListHeight
		}
		m.list.SetSize(width, listHeight)

	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c", "q":
			return m, tea.Quit
		case "enter":
			i, ok := m.list.SelectedItem().(item)
			if !ok {
				return m, nil
			}
			// Don't allow selecting disabled items
			if i.disabled {
				return m, nil
			}
			return m, selectItem(i.id)
		case "up", "k":
			startIdx := m.list.Index()
			m.list.CursorUp()
			for {
				i, ok := m.list.SelectedItem().(item)
				if !ok || !i.disabled {
					break
				}
				if m.list.Index() == 0 {
					m.list.Select(startIdx)
					break
				}
				m.list.CursorUp()
			}
			return m, nil
		case "down", "j":
			startIdx := m.list.Index()
			m.list.CursorDown()
			for {
				i, ok := m.list.SelectedItem().(item)
				if !ok || !i.disabled {
					break
				}
				if m.list.Index() == len(m.list.Items())-1 {
					m.list.Select(startIdx)
					break
				}
				m.list.CursorDown()
			}
			return m, nil
		}
	}

	var cmd tea.Cmd
	m.list, cmd = m.list.Update(msg)
	return m, cmd
}

func (m MenuModel) View() string {
	inner := lipgloss.JoinVertical(
		lipgloss.Left,
		headerStyle.Render(logo),
		m.list.View(),
	)
	return frameStyle.Render(appStyle.Render(inner))
}

// NewMenu creates a menu with default items. Parent should handle MenuSelected messages.
func NewMenu() MenuModel {
	// Check if user is authenticated and has a deployment selected
	cfg, err := config.LoadConfig()
	isAuthenticated := err == nil && cfg.IsAuthenticated()
	hasDeployment := isAuthenticated && cfg.DeploymentID != ""

	// Build menu items - some are disabled based on state
	deploymentDesc := "Select active deployment"
	if !isAuthenticated {
		deploymentDesc = "Authenticate first to select deployment"
	}

	mcpAddDesc := "Add Dosu MCP to AI tools"
	mcpRemoveDesc := "Remove Dosu MCP from AI tools"
	if !isAuthenticated {
		mcpAddDesc = "Authenticate to the Dosu-CLI first"
		mcpRemoveDesc = "Authenticate to the Dosu-CLI first"
	} else if !hasDeployment {
		mcpAddDesc = "Select a deployment first"
		mcpRemoveDesc = "Select a deployment first"
	}

	authDesc := "Authenticate with Dosu"
	if isAuthenticated {
		authDesc = "Re-authenticate with Dosu"
	}

	items := []list.Item{
		item{id: "setup", title: "Authenticate", desc: authDesc},
		item{id: "deployments", title: "Choose Deployment", desc: deploymentDesc, disabled: !isAuthenticated},
		item{id: "mcp-add", title: "Add MCP", desc: mcpAddDesc, disabled: !hasDeployment},
		item{id: "mcp-remove", title: "Remove MCP", desc: mcpRemoveDesc, disabled: !hasDeployment},
		item{id: "logout", title: "Clear Credentials", desc: "Remove saved login credentials", disabled: !isAuthenticated},
	}

	delegate := list.NewDefaultDelegate()
	delegate.Styles.NormalTitle = itemTitleStyle
	delegate.Styles.NormalDesc = itemDescStyle
	delegate.Styles.SelectedTitle = selectedItemTitleStyle
	delegate.Styles.SelectedDesc = selectedItemDescStyle

	// Height needs to accommodate items + help text (about 2 extra lines)
	m := list.New(items, delegate, maxWidth-4, len(items)*3+4)
	m.SetShowTitle(false)
	m.SetFilteringEnabled(false)
	m.DisableQuitKeybindings()
	m.SetShowStatusBar(false)
	m.SetShowPagination(false)
	m.SetShowHelp(true)

	return MenuModel{list: m, isAuthenticated: isAuthenticated}
}

// item implements list.Item and carries an ID for routing.
type item struct {
	id          string
	title, desc string
	disabled    bool
}

func (i item) Title() string {
	if i.disabled {
		return disabledItemTitleStyle.Render(i.title)
	}
	return i.title
}

func (i item) Description() string {
	if i.disabled {
		return disabledItemDescStyle.Render(i.desc)
	}
	return i.desc
}

func (i item) FilterValue() string { return i.title }

func selectItem(id string) tea.Cmd {
	return func() tea.Msg {
		return MenuSelected{ID: id}
	}
}

const maxWidth = 79

var (
	appStyle   = lipgloss.NewStyle().Margin(0, 1)
	frameStyle = lipgloss.NewStyle().
			Padding(0, 1).
			Width(maxWidth)

	headerStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#7D56F4")).
			Align(lipgloss.Center).
			Bold(true).
			Width(maxWidth - 2) // Account for padding

	// Title styles - bold to stand out
	itemTitleStyle         = lipgloss.NewStyle().PaddingLeft(2).Bold(true)
	selectedItemTitleStyle = lipgloss.NewStyle().PaddingLeft(2).Foreground(lipgloss.Color("170")).Bold(true)

	// Description styles - dimmed to differentiate from title
	itemDescStyle         = lipgloss.NewStyle().PaddingLeft(2).Foreground(lipgloss.Color("245"))
	selectedItemDescStyle = lipgloss.NewStyle().PaddingLeft(2).Foreground(lipgloss.Color("170"))

	// Disabled styles - greyed out
	disabledItemTitleStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("240"))
	disabledItemDescStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("240")).Italic(true)
)

const logo = `
 /$$$$$$$                               
| $$__  $$                              
| $$  \ $$  /$$$$$$   /$$$$$$$ /$$   /$$
| $$  | $$ /$$__  $$ /$$_____/| $$  | $$
| $$  | $$| $$  \ $$|  $$$$$$ | $$  | $$
| $$  | $$| $$  | $$ \____  $$| $$  | $$
| $$$$$$$/|  $$$$$$/ /$$$$$$$/|  $$$$$$/
|_______/  \______/ |_______/  \______/ 
`
