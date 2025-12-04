package tui

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/dosu-ai/dosu-cli/internal/config"
)

type MCPModel struct {
	status     string
	err        error
	done       bool
	inProgress bool
	command    string
	projectDir string
	global     bool
}

type (
	MCPComplete struct{}
	MCPCanceled struct{}
)

type mcpResultMsg struct {
	err error
}

func NewMCPSetup(global bool) MCPModel {
	cfg, _ := config.LoadConfig()

	// Get current working directory for display
	cwd, _ := os.Getwd()
	projectDir := filepath.Base(cwd)
	if projectDir == "" || projectDir == "." {
		projectDir = cwd
	}

	// Build the command that will be run
	// MCP endpoint is at /v1/mcp (FastMCP handles the path)
	url := fmt.Sprintf("%s/v1/mcp", config.GetBackendURL())
	scope := ""
	if global {
		scope = "--scope user "
	}
	command := fmt.Sprintf("claude mcp add --transport http %sdosu %s --header \"Authorization: Bearer %s\" --header \"X-Deployment-ID: %s\"",
		scope, url, cfg.AccessToken, cfg.DeploymentID)

	return MCPModel{
		command:    command,
		projectDir: projectDir,
		global:     global,
	}
}

func (m MCPModel) Init() tea.Cmd {
	return nil
}

func (m MCPModel) Update(msg tea.Msg) (MCPModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c":
			return m, tea.Quit
		case "esc", "q":
			if !m.inProgress {
				return m, func() tea.Msg { return MCPCanceled{} }
			}
		case "enter":
			if m.done {
				return m, func() tea.Msg { return MCPComplete{} }
			}
			if !m.inProgress {
				m.inProgress = true
				m.status = "Adding MCP server to Claude Code..."
				return m, runMCPCommand(m.global)
			}
		}

	case mcpResultMsg:
		m.inProgress = false
		if msg.err != nil {
			m.err = msg.err
			m.status = ""
			m.done = false
		} else {
			m.err = nil
			m.status = "Successfully added Dosu MCP to Claude Code!"
			m.done = true
		}
		return m, nil
	}

	return m, nil
}

func runMCPCommand(global bool) tea.Cmd {
	return func() tea.Msg {
		cfg, err := config.LoadConfig()
		if err != nil {
			return mcpResultMsg{err: fmt.Errorf("failed to load config: %w", err)}
		}

		url := fmt.Sprintf("%s/v1/mcp", config.GetBackendURL())

		args := []string{"mcp", "add", "--transport", "http"}
		if global {
			args = append(args, "--scope", "user")
		}
		args = append(args,
			"dosu",
			url,
			"--header", fmt.Sprintf("Authorization: Bearer %s", cfg.AccessToken),
			"--header", fmt.Sprintf("X-Deployment-ID: %s", cfg.DeploymentID),
		)

		cmd := exec.Command("claude", args...)

		output, err := cmd.CombinedOutput()
		if err != nil {
			return mcpResultMsg{err: fmt.Errorf("%w: %s", err, string(output))}
		}

		return mcpResultMsg{err: nil}
	}
}

func (m MCPModel) View() string {
	containerStyle := lipgloss.NewStyle().Width(maxWidth - 2)
	titleStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("205"))
	subtitleStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("63"))
	helpStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("245"))
	statusStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("11"))
	errStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("9"))
	successStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("10"))

	var lines []string

	projectStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("170"))

	if m.global {
		lines = append(lines,
			titleStyle.Render("Dosu CLI: Add Globally"),
			subtitleStyle.Render("Install Dosu MCP for all projects"),
			"",
		)
	} else {
		lines = append(lines,
			titleStyle.Render("Dosu CLI: Add to Project"),
			subtitleStyle.Render("Install Dosu MCP for this project only"),
			"",
			fmt.Sprintf("Project: %s", projectStyle.Render(m.projectDir)),
			"",
		)
	}

	if m.done {
		successMsg := "Start Claude Code in this project to use the Dosu MCP."
		if m.global {
			successMsg = "Start Claude Code in any project to use the Dosu MCP."
		}
		lines = append(lines,
			successStyle.Render("✓ "+m.status),
			"",
			helpStyle.Render(successMsg),
			"",
			helpStyle.Render("Press Enter to continue"),
		)
	} else if m.inProgress {
		lines = append(lines,
			statusStyle.Render(m.status),
			"",
			helpStyle.Render("Please wait..."),
		)
	} else {
		if m.global {
			lines = append(lines,
				helpStyle.Render("The MCP server will be available in all projects"),
				helpStyle.Render("when running Claude Code."),
				"",
				helpStyle.Render("Press Enter to install, Esc to go back"),
			)
		} else {
			lines = append(lines,
				helpStyle.Render("The MCP server will only be available when running"),
				helpStyle.Render("Claude Code from this project directory."),
				"",
				helpStyle.Render("Press Enter to install, Esc to go back"),
			)
		}
	}

	if m.err != nil {
		lines = append(lines, "", errStyle.Render("Error: "+m.err.Error()))
	}

	body := containerStyle.Render(strings.Join(lines, "\n"))
	return frameStyle.Render(appStyle.Render(body))
}
