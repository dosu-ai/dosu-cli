package tui

import (
	"fmt"

	"github.com/charmbracelet/bubbles/list"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/dosu-ai/dosu-cli/internal/client"
	"github.com/dosu-ai/dosu-cli/internal/config"
)

// DeploymentSelected is emitted when a deployment is chosen
type DeploymentSelected struct {
	ID   string
	Name string
}

// DeploymentCanceled is emitted when the user goes back
type DeploymentCanceled struct{}

type deploymentsMsg struct {
	deployments []client.Deployment
	err         error
}

type DeploymentsModel struct {
	loading     bool
	spinner     spinner.Model
	list        list.Model
	deployments []client.Deployment
	err         error
	width       int
	height      int
}

func NewDeploymentsSelector() DeploymentsModel {
	s := spinner.New()
	s.Spinner = spinner.Dot
	s.Style = lipgloss.NewStyle().Foreground(lipgloss.Color("205"))

	return DeploymentsModel{
		loading: true,
		spinner: s,
	}
}

func (m DeploymentsModel) Init() tea.Cmd {
	return tea.Batch(
		m.spinner.Tick,
		fetchDeployments(),
	)
}

func (m DeploymentsModel) Update(msg tea.Msg) (DeploymentsModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		if !m.loading && len(m.deployments) > 0 {
			appH, appV := appStyle.GetFrameSize()
			frameH, frameV := frameStyle.GetFrameSize()
			headerHeight := lipgloss.Height(headerStyle.Render(logo))
			width := msg.Width - appH - frameH
			if width < 10 {
				width = 10
			}
			listHeight := msg.Height - appV - frameV - headerHeight - 2 // -2 for instruction text
			if listHeight < 4 {
				listHeight = 4
			}
			if listHeight > maxListHeight {
				listHeight = maxListHeight
			}
			m.list.SetSize(width, listHeight)
		}
		return m, nil

	case deploymentsMsg:
		m.loading = false
		if msg.err != nil {
			m.err = msg.err
			return m, nil
		}

		m.deployments = msg.deployments
		if len(m.deployments) == 0 {
			return m, nil
		}

		// Create list items
		items := make([]list.Item, len(msg.deployments))
		for i, dep := range msg.deployments {
			items[i] = deploymentItem{
				id:          dep.DeploymentID,
				name:        dep.Name,
				description: dep.Description,
			}
		}

		delegate := list.NewDefaultDelegate()
		delegate.Styles.NormalTitle = itemTitleStyle
		delegate.Styles.NormalDesc = itemDescStyle
		delegate.Styles.SelectedTitle = selectedItemTitleStyle
		delegate.Styles.SelectedDesc = selectedItemDescStyle

		// Use default dimensions if window size not yet received
		width := m.width
		height := m.height
		if width == 0 {
			width = maxWidth - 2 // Account for padding
		}
		if height == 0 {
			height = maxListHeight
		}

		m.list = list.New(items, delegate, width, height)
		m.list.SetShowTitle(false)
		m.list.SetFilteringEnabled(false)
		m.list.DisableQuitKeybindings()
		m.list.SetShowStatusBar(true)
		m.list.SetShowPagination(true)
		m.list.SetShowHelp(true)

		return m, nil

	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c", "q", "esc":
			return m, cancelDeploymentSelection
		case "enter":
			if !m.loading && m.err == nil && len(m.deployments) > 0 {
				i, ok := m.list.SelectedItem().(deploymentItem)
				if !ok {
					return m, nil
				}
				return m, selectDeployment(i.id, i.name)
			}
		}

	case spinner.TickMsg:
		if m.loading {
			var cmd tea.Cmd
			m.spinner, cmd = m.spinner.Update(msg)
			return m, cmd
		}
	}

	// Update list if not loading
	if !m.loading && m.err == nil && len(m.deployments) > 0 {
		var cmd tea.Cmd
		m.list, cmd = m.list.Update(msg)
		return m, cmd
	}

	return m, nil
}

func (m DeploymentsModel) View() string {
	if m.loading {
		content := fmt.Sprintf("\n%s Loading deployments...\n\nPress Esc to go back", m.spinner.View())
		inner := lipgloss.JoinVertical(
			lipgloss.Left,
			headerStyle.Render(logo),
			content,
		)
		return frameStyle.Render(appStyle.Render(inner))
	}

	if m.err != nil {
		errorStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("196"))
		content := fmt.Sprintf("\n%s\n\nPress Esc to go back", errorStyle.Render("Error: "+m.err.Error()))
		inner := lipgloss.JoinVertical(
			lipgloss.Left,
			headerStyle.Render(logo),
			content,
		)
		return frameStyle.Render(appStyle.Render(inner))
	}

	if len(m.deployments) == 0 {
		content := "\nNo deployments found.\n\nCreate a deployment at https://app.dosu.dev to get started.\n\nPress Esc to go back"
		inner := lipgloss.JoinVertical(
			lipgloss.Left,
			headerStyle.Render(logo),
			content,
		)
		return frameStyle.Render(appStyle.Render(inner))
	}

	instruction := lipgloss.NewStyle().Faint(true).Render("Press Enter to select, Esc to go back")
	inner := lipgloss.JoinVertical(
		lipgloss.Left,
		headerStyle.Render(logo),
		m.list.View(),
		instruction,
	)
	return frameStyle.Render(appStyle.Render(inner))
}

func fetchDeployments() tea.Cmd {
	return func() tea.Msg {
		cfg, err := config.LoadConfig()
		if err != nil {
			return deploymentsMsg{err: fmt.Errorf("failed to load config: %w", err)}
		}

		if !cfg.IsAuthenticated() {
			return deploymentsMsg{err: fmt.Errorf("not authenticated")}
		}

		client := client.NewClient(cfg)
		deployments, err := client.GetDeployments()
		if err != nil {
			return deploymentsMsg{err: fmt.Errorf("failed to fetch deployments: %w", err)}
		}

		return deploymentsMsg{deployments: deployments}
	}
}

func selectDeployment(id, name string) tea.Cmd {
	return func() tea.Msg {
		return DeploymentSelected{ID: id, Name: name}
	}
}

func cancelDeploymentSelection() tea.Msg {
	return DeploymentCanceled{}
}

// deploymentItem implements list.Item for deployments
type deploymentItem struct {
	id          string
	name        string
	description string
}

func (i deploymentItem) Title() string       { return i.name }
func (i deploymentItem) Description() string { return i.description }
func (i deploymentItem) FilterValue() string { return i.name }
