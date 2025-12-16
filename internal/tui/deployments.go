package tui

import (
	"fmt"
	"sort"

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

// Column focus state
type columnFocus int

const (
	focusOrgs columnFocus = iota
	focusDeployments
)

// orgGroup holds an organization and its deployments
type orgGroup struct {
	name        string
	deployments []client.Deployment
}

type DeploymentsModel struct {
	loading bool
	spinner spinner.Model
	err     error
	width   int
	height  int

	// Data
	orgs []orgGroup

	// Navigation state
	focus          columnFocus
	selectedOrgIdx int
	selectedDepIdx int
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
		return m, nil

	case deploymentsMsg:
		m.loading = false
		if msg.err != nil {
			m.err = msg.err
			return m, nil
		}

		// Group deployments by organization
		orgMap := make(map[string][]client.Deployment)
		var orgNames []string
		for _, dep := range msg.deployments {
			orgName := dep.OrgName
			if orgName == "" {
				orgName = "Unknown Organization"
			}
			if _, exists := orgMap[orgName]; !exists {
				orgNames = append(orgNames, orgName)
			}
			orgMap[orgName] = append(orgMap[orgName], dep)
		}
		sort.Strings(orgNames)

		// Build org groups
		m.orgs = make([]orgGroup, len(orgNames))
		for i, name := range orgNames {
			m.orgs[i] = orgGroup{
				name:        name,
				deployments: orgMap[name],
			}
		}

		return m, nil

	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c", "q", "esc":
			return m, cancelDeploymentSelection

		case "tab", "right", "l":
			if m.focus == focusOrgs && len(m.orgs) > 0 && len(m.orgs[m.selectedOrgIdx].deployments) > 0 {
				m.focus = focusDeployments
				m.selectedDepIdx = 0
			}
			return m, nil

		case "shift+tab", "left", "h":
			if m.focus == focusDeployments {
				m.focus = focusOrgs
			}
			return m, nil

		case "up", "k":
			if m.focus == focusOrgs {
				if m.selectedOrgIdx > 0 {
					m.selectedOrgIdx--
					m.selectedDepIdx = 0 // Reset deployment selection when org changes
				}
			} else {
				if m.selectedDepIdx > 0 {
					m.selectedDepIdx--
				}
			}
			return m, nil

		case "down", "j":
			if m.focus == focusOrgs {
				if m.selectedOrgIdx < len(m.orgs)-1 {
					m.selectedOrgIdx++
					m.selectedDepIdx = 0 // Reset deployment selection when org changes
				}
			} else {
				if len(m.orgs) > 0 && m.selectedDepIdx < len(m.orgs[m.selectedOrgIdx].deployments)-1 {
					m.selectedDepIdx++
				}
			}
			return m, nil

		case "enter":
			if m.focus == focusDeployments && len(m.orgs) > 0 {
				deps := m.orgs[m.selectedOrgIdx].deployments
				if m.selectedDepIdx < len(deps) {
					dep := deps[m.selectedDepIdx]
					return m, selectDeployment(dep.DeploymentID, dep.Name)
				}
			} else if m.focus == focusOrgs && len(m.orgs) > 0 && len(m.orgs[m.selectedOrgIdx].deployments) > 0 {
				// Allow enter on org to jump to deployments column
				m.focus = focusDeployments
				m.selectedDepIdx = 0
			}
			return m, nil
		}

	case spinner.TickMsg:
		if m.loading {
			var cmd tea.Cmd
			m.spinner, cmd = m.spinner.Update(msg)
			return m, cmd
		}
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

	if len(m.orgs) == 0 {
		content := "\nNo deployments found.\n\nCreate a deployment at https://app.dosu.dev to get started.\n\nPress Esc to go back"
		inner := lipgloss.JoinVertical(
			lipgloss.Left,
			headerStyle.Render(logo),
			content,
		)
		return frameStyle.Render(appStyle.Render(inner))
	}

	// Styles for the two-column view
	columnWidth := (maxWidth - 6) / 2

	// Column header styles
	headerActiveStyle := lipgloss.NewStyle().
		Bold(true).
		Foreground(lipgloss.Color("170")).
		Width(columnWidth).
		Align(lipgloss.Center)

	headerInactiveStyle := lipgloss.NewStyle().
		Bold(true).
		Foreground(lipgloss.Color("245")).
		Width(columnWidth).
		Align(lipgloss.Center)

	// Item styles (consistent with menu.go)
	normalStyle := lipgloss.NewStyle().
		Width(columnWidth).
		PaddingLeft(1)

	selectedStyle := lipgloss.NewStyle().
		Foreground(lipgloss.Color("170")).
		Bold(true).
		Width(columnWidth).
		PaddingLeft(1)

	dimStyle := lipgloss.NewStyle().
		Foreground(lipgloss.Color("245")).
		Width(columnWidth).
		PaddingLeft(1)

	// Build organizations column
	var orgHeader string
	if m.focus == focusOrgs {
		orgHeader = headerActiveStyle.Render("Organizations")
	} else {
		orgHeader = headerInactiveStyle.Render("Organizations")
	}

	var orgItems []string
	for i, org := range m.orgs {
		text := fmt.Sprintf("%s (%d)", org.name, len(org.deployments))
		if i == m.selectedOrgIdx {
			if m.focus == focusOrgs {
				orgItems = append(orgItems, selectedStyle.Render("> "+text))
			} else {
				orgItems = append(orgItems, normalStyle.Render("> "+text))
			}
		} else {
			orgItems = append(orgItems, dimStyle.Render("  "+text))
		}
	}

	// Build deployments column
	var depHeader string
	if m.focus == focusDeployments {
		depHeader = headerActiveStyle.Render("Deployments")
	} else {
		depHeader = headerInactiveStyle.Render("Deployments")
	}

	var depItems []string
	if m.selectedOrgIdx < len(m.orgs) {
		deps := m.orgs[m.selectedOrgIdx].deployments
		for i, dep := range deps {
			if i == m.selectedDepIdx {
				if m.focus == focusDeployments {
					depItems = append(depItems, selectedStyle.Render("> "+dep.Name))
				} else {
					depItems = append(depItems, normalStyle.Render("> "+dep.Name))
				}
			} else {
				depItems = append(depItems, dimStyle.Render("  "+dep.Name))
			}
		}
	}

	// Pad columns to same height
	maxItems := len(orgItems)
	if len(depItems) > maxItems {
		maxItems = len(depItems)
	}
	for len(orgItems) < maxItems {
		orgItems = append(orgItems, normalStyle.Render(""))
	}
	for len(depItems) < maxItems {
		depItems = append(depItems, normalStyle.Render(""))
	}

	// Combine columns
	orgColumn := lipgloss.JoinVertical(lipgloss.Left, append([]string{orgHeader, ""}, orgItems...)...)
	depColumn := lipgloss.JoinVertical(lipgloss.Left, append([]string{depHeader, ""}, depItems...)...)

	separator := lipgloss.NewStyle().
		Foreground(lipgloss.Color("240")).
		Render(" │ ")

	table := lipgloss.JoinHorizontal(lipgloss.Top, orgColumn, separator, depColumn)

	// Instructions
	instruction := lipgloss.NewStyle().Faint(true).Render("←/→ or Tab to switch columns, ↑/↓ to navigate, Enter to select, Esc to go back")

	inner := lipgloss.JoinVertical(
		lipgloss.Left,
		headerStyle.Render(logo),
		"",
		table,
		"",
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
