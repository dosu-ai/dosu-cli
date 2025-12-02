package tui

import (
	"errors"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// SetupModel owns the auth form. It emits SetupComplete or SetupCanceled messages.
type SetupModel struct {
	input  textinput.Model
	status string
	err    error
	style  setupStyles
}

type (
	SetupComplete struct{}
	SetupCanceled struct{}
)

type setupStyles struct {
	container     lipgloss.Style
	title         lipgloss.Style
	subtitle      lipgloss.Style
	sectionHeader lipgloss.Style
	help          lipgloss.Style
	status        lipgloss.Style
	err           lipgloss.Style
}

func NewSetup() SetupModel {
	ti := textinput.New()
	ti.Placeholder = "Paste your MCP auth token"
	ti.Prompt = "Token: "
	ti.EchoMode = textinput.EchoPassword
	ti.EchoCharacter = '•'
	ti.CharLimit = 256
	ti.Width = 48
	ti.Focus()

	return SetupModel{
		input: ti,
		style: defaultSetupStyles(),
	}
}

func defaultSetupStyles() setupStyles {
	return setupStyles{
		container:     lipgloss.NewStyle().Width(64),
		title:         lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("205")),
		subtitle:      lipgloss.NewStyle().Foreground(lipgloss.Color("63")),
		sectionHeader: lipgloss.NewStyle().Bold(true),
		help:          lipgloss.NewStyle().Foreground(lipgloss.Color("245")),
		status:        lipgloss.NewStyle().Foreground(lipgloss.Color("10")),
		err:           lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("9")),
	}
}

func (m SetupModel) Init() tea.Cmd {
	return textinput.Blink
}

func (m SetupModel) Update(msg tea.Msg) (SetupModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c":
			return m, tea.Quit
		case "esc":
			return m, func() tea.Msg { return SetupCanceled{} }
		case "enter":
			token := strings.TrimSpace(m.input.Value())
			if token == "" {
				m.err = errors.New("token is required")
				m.status = ""
				return m, nil
			}

			// TODO: call MCP auth, persist token under XDG config, set status on success.
			m.err = nil
			m.status = "Token captured (wire auth call here)."
			return m, func() tea.Msg { return SetupComplete{} }
		}
	}

	var cmd tea.Cmd
	m.input, cmd = m.input.Update(msg)
	return m, cmd
}

func (m SetupModel) View() string {
	var lines []string
	lines = append(lines,
		m.style.title.Render("Dosu CLI"),
		m.style.subtitle.Render("Setup: authenticate with your MCP server"),
		"",
		m.style.sectionHeader.Render("Token"),
		m.input.View(),
		"",
		m.style.help.Render("Enter to submit, Esc to go back, Ctrl+C to quit"),
		m.style.status.Render(m.status),
		renderSetupErr(m.err, m.style),
	)

	body := m.style.container.Render(strings.Join(lines, "\n"))
	return frameStyle.Render(body)
}

func renderSetupErr(err error, s setupStyles) string {
	if err == nil {
		return ""
	}
	return s.err.Render(err.Error())
}
