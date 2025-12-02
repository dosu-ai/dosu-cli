package tui

import (
	"errors"
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type screen int

const (
	screenMenu screen = iota
	screenSetup
	screenSync
)

var menuItems = []string{
	"Setup (authenticate)",
	"Sync",
}

// model holds all UI state for the small menu + setup flow.
type model struct {
	screen    screen
	menuIndex int

	token  textinput.Model
	status string
	err    error

	style styles
}

type styles struct {
	container     lipgloss.Style
	title         lipgloss.Style
	subtitle      lipgloss.Style
	menu          lipgloss.Style
	menuSelected  lipgloss.Style
	help          lipgloss.Style
	status        lipgloss.Style
	err           lipgloss.Style
	sectionHeader lipgloss.Style
}

// New sets up the initial TUI model.
func New() tea.Model {
	ti := textinput.New()
	ti.Placeholder = "Paste your MCP auth token"
	ti.Prompt = "Token: "
	ti.EchoMode = textinput.EchoPassword
	ti.EchoCharacter = '•'
	ti.CharLimit = 256
	ti.Width = 48

	return model{
		screen: screenMenu,
		token:  ti,
		style:  defaultStyles(),
	}
}

func defaultStyles() styles {
	return styles{
		container: lipgloss.NewStyle().Padding(1, 2).Width(64),
		title:     lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("205")),
		subtitle:  lipgloss.NewStyle().Foreground(lipgloss.Color("63")),
		menu:      lipgloss.NewStyle(),
		menuSelected: lipgloss.NewStyle().
			Foreground(lipgloss.Color("212")).
			Bold(true),
		help:          lipgloss.NewStyle().Foreground(lipgloss.Color("245")),
		status:        lipgloss.NewStyle().Foreground(lipgloss.Color("10")),
		err:           lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("9")),
		sectionHeader: lipgloss.NewStyle().Bold(true),
	}
}

func (m model) Init() tea.Cmd {
	return textinput.Blink
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch m.screen {
		case screenMenu:
			return m.handleMenuKey(msg)
		case screenSetup:
			return m.handleSetupKey(msg)
		case screenSync:
			return m.handleSyncKey(msg)
		}
	}

	// Keep the token input responsive only on the setup screen.
	if m.screen == screenSetup {
		var cmd tea.Cmd
		m.token, cmd = m.token.Update(msg)
		return m, cmd
	}

	return m, nil
}

func (m model) handleMenuKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "ctrl+c", "q", "esc":
		return m, tea.Quit
	case "up", "k":
		if m.menuIndex > 0 {
			m.menuIndex--
		}
	case "down", "j":
		if m.menuIndex < len(menuItems)-1 {
			m.menuIndex++
		}
	case "1", "2":
		i := int(msg.String()[0] - '1')
		if i >= 0 && i < len(menuItems) {
			return m.selectMenu(i)
		}
	case "enter":
		return m.selectMenu(m.menuIndex)
	}
	return m, nil
}

func (m model) handleSetupKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "ctrl+c":
		return m, tea.Quit
	case "esc":
		m.screen = screenMenu
		m.token.Blur()
		return m, nil
	case "enter":
		token := strings.TrimSpace(m.token.Value())
		if token == "" {
			m.err = errors.New("token is required")
			m.status = ""
			return m, nil
		}

		m.err = nil
		m.status = "Token captured (wire your MCP auth call here)."
		m.token.Blur()
		m.screen = screenMenu
		// TODO: call auth, persist token under XDG config, then maybe route to next screen.
		return m, nil
	}

	var cmd tea.Cmd
	m.token, cmd = m.token.Update(msg)
	return m, cmd
}

func (m model) handleSyncKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "ctrl+c":
		return m, tea.Quit
	case "esc", "b":
		m.screen = screenMenu
		return m, nil
	}
	return m, nil
}

func (m model) selectMenu(i int) (tea.Model, tea.Cmd) {
	switch i {
	case 0: // Setup
		m.screen = screenSetup
		m.status = ""
		m.err = nil
		m.token.Focus()
	case 1: // Sync
		m.screen = screenSync
		m.status = "Sync not implemented yet."
		m.err = nil
	}
	return m, nil
}

func (m model) View() string {
	switch m.screen {
	case screenMenu:
		return m.viewMenu()
	case screenSetup:
		return m.viewSetup()
	case screenSync:
		return m.viewSync()
	default:
		return ""
	}
}

func (m model) viewMenu() string {
	var lines []string
	lines = append(lines,
		m.style.title.Render("Dosu CLI"),
		m.style.subtitle.Render("Choose an option"),
	)

	for i, item := range menuItems {
		line := fmt.Sprintf("%d. %s", i+1, item)
		if i == m.menuIndex {
			lines = append(lines, m.style.menuSelected.Render(line))
		} else {
			lines = append(lines, m.style.menu.Render(line))
		}
	}

	lines = append(lines,
		"",
		m.style.help.Render("Use ↑/↓ or 1/2, Enter to select, q/esc to quit"),
		renderStatus(m.status, m.style),
		renderErr(m.err, m.style),
	)

	return m.style.container.Render(strings.Join(lines, "\n"))
}

func (m model) viewSetup() string {
	var lines []string
	lines = append(lines,
		m.style.title.Render("Dosu CLI"),
		m.style.subtitle.Render("Setup: authenticate with your MCP server"),
		"",
		m.style.sectionHeader.Render("Token"),
		m.token.View(),
		"",
		m.style.help.Render("Enter to submit, Esc to go back, Ctrl+C to quit"),
		renderStatus(m.status, m.style),
		renderErr(m.err, m.style),
	)

	return m.style.container.Render(strings.Join(lines, "\n"))
}

func (m model) viewSync() string {
	var lines []string
	lines = append(lines,
		m.style.title.Render("Dosu CLI"),
		m.style.subtitle.Render("Sync (stub)"),
		"",
		m.style.help.Render("Press Esc/b to go back, Ctrl+C to quit"),
		renderStatus(m.status, m.style),
		renderErr(m.err, m.style),
	)

	return m.style.container.Render(strings.Join(lines, "\n"))
}

func renderStatus(status string, s styles) string {
	if status == "" {
		return ""
	}
	return s.status.Render(status)
}

func renderErr(err error, s styles) string {
	if err == nil {
		return ""
	}
	return s.err.Render(err.Error())
}
