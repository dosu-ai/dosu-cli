package setup

import (
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/dosu-ai/dosu-cli/internal/client"
)

type dselectItem struct {
	Label string
	Value string
}

type deploymentSelect struct {
	items   []dselectItem
	cursor  int
	done    bool
	aborted bool
}

func newDeploymentSelect(items []dselectItem) deploymentSelect {
	return deploymentSelect{items: items}
}

func (m deploymentSelect) Init() tea.Cmd { return nil }

func (m deploymentSelect) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c", "esc":
			m.aborted = true
			return m, tea.Quit
		case "enter":
			m.done = true
			return m, tea.Quit
		case "up", "k":
			if m.cursor > 0 {
				m.cursor--
			}
		case "down", "j":
			if m.cursor < len(m.items)-1 {
				m.cursor++
			}
		}
	}
	return m, nil
}

func (m deploymentSelect) View() string {
	if m.done || m.aborted {
		return ""
	}

	var b strings.Builder
	b.WriteString(Question("Select a deployment"))
	b.WriteString("\n")

	selectorStyle := lipgloss.NewStyle().Foreground(accentColor)
	selectedStyle := lipgloss.NewStyle().Foreground(accentColor)

	for i, item := range m.items {
		if i == m.cursor {
			b.WriteString(selectorStyle.Render("> "))
			b.WriteString(selectedStyle.Render(item.Label))
		} else {
			b.WriteString("  ")
			b.WriteString(item.Label)
		}
		b.WriteString("\n")
	}

	return b.String()
}

func (m deploymentSelect) Selected() string {
	if m.aborted || m.cursor >= len(m.items) {
		return ""
	}
	return m.items[m.cursor].Value
}

func (m deploymentSelect) Aborted() bool {
	return m.aborted
}

// buildDeploymentItems creates the item list for the deployment selector.
func buildDeploymentItems(deployments []client.Deployment) []dselectItem {
	var items []dselectItem
	for _, d := range deployments {
		items = append(items, dselectItem{
			Label: d.Name,
			Value: d.DeploymentID,
		})
	}
	return items
}
