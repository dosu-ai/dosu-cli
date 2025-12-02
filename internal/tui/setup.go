package tui

import (
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/dosu-ai/dosu-cli/internal/auth"
	"github.com/dosu-ai/dosu-cli/internal/config"
)

// SetupModel owns the auth form. It emits SetupComplete or SetupCanceled messages.
type SetupModel struct {
	status     string
	err        error
	authDone   bool
	style      setupStyles
	inProgress bool
}

type (
	SetupComplete struct{}
	SetupCanceled struct{}
)

// oauthResultMsg is sent when the OAuth flow completes (success or failure)
type oauthResultMsg struct {
	token *auth.TokenResponse
	err   error
}

type setupStyles struct {
	container     lipgloss.Style
	title         lipgloss.Style
	subtitle      lipgloss.Style
	sectionHeader lipgloss.Style
	help          lipgloss.Style
	status        lipgloss.Style
	err           lipgloss.Style
	success       lipgloss.Style
}

func NewSetup() SetupModel {
	return SetupModel{
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
		status:        lipgloss.NewStyle().Foreground(lipgloss.Color("11")),
		err:           lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("9")),
		success:       lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("10")),
	}
}

func (m SetupModel) Init() tea.Cmd {
	return nil
}

func (m SetupModel) Update(msg tea.Msg) (SetupModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c":
			return m, tea.Quit
		case "esc":
			if !m.inProgress {
				return m, func() tea.Msg { return SetupCanceled{} }
			}
		case "enter":
			if m.authDone {
				// Auth completed, move to next screen
				return m, func() tea.Msg { return SetupComplete{} }
			}
			if !m.inProgress {
				// Start OAuth flow
				m.inProgress = true
				m.status = "Opening browser..."
				return m, startOAuthCmd()
			}
		}

	case oauthResultMsg:
		m.inProgress = false
		if msg.err != nil {
			// Auth failed
			m.err = msg.err
			m.status = ""
			m.authDone = false
		} else {
			// Auth succeeded
			m.err = nil
			m.status = "Authentication successful!"
			m.authDone = true
		}
		return m, nil
	}

	return m, nil
}

// startOAuthCmd runs the OAuth flow in a goroutine and returns the result
func startOAuthCmd() tea.Cmd {
	return func() tea.Msg {
		// Load existing config
		cfg, err := config.LoadConfig()
		if err != nil {
			return oauthResultMsg{err: fmt.Errorf("failed to load config: %w", err)}
		}

		// Start OAuth flow (this will open the browser)
		token, err := auth.StartOAuthFlow()
		if err != nil {
			return oauthResultMsg{err: err}
		}

		// Save token to config
		cfg.AccessToken = token.AccessToken
		cfg.RefreshToken = token.RefreshToken
		cfg.ExpiresAt = time.Now().Unix() + int64(token.ExpiresIn)

		if err := config.SaveConfig(cfg); err != nil {
			return oauthResultMsg{err: fmt.Errorf("failed to save config: %w", err)}
		}

		return oauthResultMsg{token: token}
	}
}

func (m SetupModel) View() string {
	var lines []string

	// Title and subtitle
	lines = append(lines,
		m.style.title.Render("Dosu CLI"),
		m.style.subtitle.Render("Setup: authenticate with Dosu"),
		"",
	)

	if m.authDone {
		// Success state
		lines = append(lines,
			m.style.success.Render("✓ "+m.status),
			"",
			m.style.help.Render("Press Enter to continue"),
		)
	} else if m.inProgress {
		// In progress state
		lines = append(lines,
			m.style.sectionHeader.Render("Authenticating..."),
			"",
			m.style.status.Render(m.status),
			"",
			"A browser window should open to app.dosu.dev",
			"Log in with your GitHub, Google, or Azure account",
			"",
			m.style.help.Render("Waiting for authentication..."),
		)
	} else {
		// Initial state
		lines = append(lines,
			m.style.sectionHeader.Render("Browser-based Authentication"),
			"",
			"Press Enter to authenticate with Dosu",
			"This will open your default browser",
			"",
			m.style.help.Render("Enter to start, Esc to go back, Ctrl+C to quit"),
		)
	}

	// Show error if any
	if m.err != nil {
		lines = append(lines, "", m.style.err.Render("Error: "+m.err.Error()))
	}

	body := m.style.container.Render(strings.Join(lines, "\n"))
	return frameStyle.Render(body)
}
