package tui

import (
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/dosu-ai/dosu-cli/internal/config"
)

type LogoutModel struct {
	confirmed bool
	done      bool
}

type LogoutComplete struct{}
type LogoutCanceled struct{}

func NewLogout() LogoutModel {
	return LogoutModel{}
}

func (m LogoutModel) Init() tea.Cmd {
	return nil
}

func (m LogoutModel) Update(msg tea.Msg) (LogoutModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c":
			return m, tea.Quit
		case "esc", "q":
			if !m.confirmed {
				return m, func() tea.Msg { return LogoutCanceled{} }
			}
		case "enter":
			if m.done {
				return m, func() tea.Msg { return LogoutComplete{} }
			}
			if !m.confirmed {
				m.confirmed = true
				cfg, err := config.LoadConfig()
				if err == nil {
					cfg.Clear()
					config.SaveConfig(cfg)
				}
				m.done = true
				return m, nil
			}
		}
	}
	return m, nil
}

func (m LogoutModel) View() string {
	containerStyle := lipgloss.NewStyle().Width(maxWidth - 2)
	titleStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("205"))
	helpStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("245"))
	successStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("10"))
	warningStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("11"))

	var lines []string

	if m.done {
		lines = append(lines,
			titleStyle.Render("Clear Credentials"),
			"",
			successStyle.Render("✓ Credentials cleared successfully!"),
			"",
			helpStyle.Render("Your login tokens and deployment selection have been removed."),
			"",
			helpStyle.Render("Press Enter to continue"),
		)
	} else {
		lines = append(lines,
			titleStyle.Render("Clear Credentials"),
			"",
			warningStyle.Render("This will remove your saved login tokens and deployment selection."),
			"",
			helpStyle.Render("Press Enter to confirm, Esc to cancel"),
		)
	}

	body := containerStyle.Render(strings.Join(lines, "\n"))
	return frameStyle.Render(appStyle.Render(lipgloss.JoinVertical(
		lipgloss.Left,
		headerStyle.Render(logo),
		body,
	)))
}
