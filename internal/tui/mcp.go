package tui

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/dosu-ai/dosu-cli/internal/config"
	"github.com/dosu-ai/dosu-cli/internal/mcp"
)

type MCPModel struct {
	toolID     string
	toolName   string
	status     string
	err        error
	done       bool
	inProgress bool
	projectDir string
	global     bool
	isRemove   bool

	scopeChosen    bool
	supportsLocal  bool
	scopeSelection int
}

type (
	MCPComplete struct{}
	MCPCanceled struct{}
)

type mcpResultMsg struct {
	err error
}

func NewMCPSetupWithTool(toolID, toolName string, isRemove bool) MCPModel {
	cwd, _ := os.Getwd()
	projectDir := filepath.Base(cwd)
	if projectDir == "" || projectDir == "." {
		projectDir = cwd
	}

	provider, _ := mcp.GetProvider(toolID)
	supportsLocal := provider != nil && provider.SupportsLocal()
	scopeChosen := !supportsLocal

	return MCPModel{
		toolID:        toolID,
		toolName:      toolName,
		projectDir:    projectDir,
		supportsLocal: supportsLocal,
		scopeChosen:   scopeChosen,
		global:        !supportsLocal,
		isRemove:      isRemove,
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

		case "up", "k":
			if !m.scopeChosen && m.supportsLocal {
				m.scopeSelection = 0
			}
			return m, nil

		case "down", "j":
			if !m.scopeChosen && m.supportsLocal {
				m.scopeSelection = 1
			}
			return m, nil

		case "enter":
			if m.done {
				return m, func() tea.Msg { return MCPComplete{} }
			}
			if !m.scopeChosen {
				m.scopeChosen = true
				m.global = m.scopeSelection == 1
				return m, nil
			}
			if !m.inProgress {
				m.inProgress = true
				if m.isRemove {
					m.status = fmt.Sprintf("Removing MCP server from %s...", m.toolName)
					return m, runMCPRemove(m.toolID, m.global)
				}
				m.status = fmt.Sprintf("Adding MCP server to %s...", m.toolName)
				return m, runMCPInstall(m.toolID, m.global)
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
			if m.isRemove {
				m.status = fmt.Sprintf("Successfully removed Dosu MCP from %s!", m.toolName)
			} else {
				m.status = fmt.Sprintf("Successfully added Dosu MCP to %s!", m.toolName)
			}
			m.done = true
		}
		return m, nil
	}

	return m, nil
}

func runMCPInstall(toolID string, global bool) tea.Cmd {
	return func() tea.Msg {
		cfg, err := config.LoadConfig()
		if err != nil {
			return mcpResultMsg{err: fmt.Errorf("failed to load config: %w", err)}
		}

		provider, err := mcp.GetProvider(toolID)
		if err != nil {
			return mcpResultMsg{err: fmt.Errorf("unknown tool: %s", toolID)}
		}

		err = provider.Install(cfg, global)
		return mcpResultMsg{err: err}
	}
}

func runMCPRemove(toolID string, global bool) tea.Cmd {
	return func() tea.Msg {
		provider, err := mcp.GetProvider(toolID)
		if err != nil {
			return mcpResultMsg{err: fmt.Errorf("unknown tool: %s", toolID)}
		}

		err = provider.Remove(global)
		return mcpResultMsg{err: err}
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
	selectedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("170")).Bold(true)
	normalStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("245"))

	var lines []string

	action := "Add"
	if m.isRemove {
		action = "Remove"
	}

	if !m.scopeChosen {
		subtitle := "Choose installation scope"
		if m.isRemove {
			subtitle = "Choose removal scope"
		}
		lines = append(lines,
			titleStyle.Render(fmt.Sprintf("%s Dosu MCP: %s", action, m.toolName)),
			subtitleStyle.Render(subtitle),
			"",
		)

		localText := fmt.Sprintf("%s to Project (%s)", action, m.projectDir)
		if m.scopeSelection == 0 {
			lines = append(lines, selectedStyle.Render("> "+localText))
		} else {
			lines = append(lines, normalStyle.Render("  "+localText))
		}

		globalText := fmt.Sprintf("%s Globally (all projects)", action)
		if m.scopeSelection == 1 {
			lines = append(lines, selectedStyle.Render("> "+globalText))
		} else {
			lines = append(lines, normalStyle.Render("  "+globalText))
		}

		lines = append(lines,
			"",
			helpStyle.Render("↑/↓ to select, Enter to confirm, Esc to go back"),
		)

		body := containerStyle.Render(strings.Join(lines, "\n"))
		return frameStyle.Render(appStyle.Render(lipgloss.JoinVertical(
			lipgloss.Left,
			headerStyle.Render(logo),
			body,
		)))
	}

	projectStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("170"))

	if m.global {
		subtitle := "Install Dosu MCP for all projects"
		if m.isRemove {
			subtitle = "Remove Dosu MCP from all projects"
		}
		lines = append(lines,
			titleStyle.Render(fmt.Sprintf("%s %s: Global", action, m.toolName)),
			subtitleStyle.Render(subtitle),
			"",
		)
	} else {
		subtitle := fmt.Sprintf("Install Dosu MCP for %s", m.projectDir)
		if m.isRemove {
			subtitle = fmt.Sprintf("Remove Dosu MCP from %s", m.projectDir)
		}
		lines = append(lines,
			titleStyle.Render(fmt.Sprintf("%s %s: Project", action, m.toolName)),
			subtitleStyle.Render(subtitle),
			"",
			fmt.Sprintf("Project: %s", projectStyle.Render(m.projectDir)),
			"",
		)
	}

	if m.done {
		lines = append(lines, successStyle.Render("✓ "+m.status), "")

		if !m.isRemove {
			successMsg := fmt.Sprintf("Start %s in %s to use the Dosu MCP.", m.toolName, m.projectDir)
			if m.global {
				successMsg = fmt.Sprintf("Start %s in any project to use the Dosu MCP.", m.toolName)
			}
			lines = append(lines, helpStyle.Render(successMsg), "")
		}

		lines = append(lines, helpStyle.Render("Press Enter to continue"))
	} else if m.inProgress {
		lines = append(lines,
			statusStyle.Render(m.status),
			"",
			helpStyle.Render("Please wait..."),
		)
	} else {
		buttonText := "Press Enter to install, Esc to go back"
		if m.isRemove {
			buttonText = "Press Enter to remove, Esc to go back"
		}

		if m.global {
			desc := "The MCP server will be available in all projects"
			if m.isRemove {
				desc = "The MCP server will be removed from all projects"
			}
			lines = append(lines,
				helpStyle.Render(desc),
				helpStyle.Render(fmt.Sprintf("when running %s.", m.toolName)),
				"",
				helpStyle.Render(buttonText),
			)
		} else {
			desc := fmt.Sprintf("The MCP server will only be available in %s", m.projectDir)
			if m.isRemove {
				desc = fmt.Sprintf("The MCP server will be removed from %s", m.projectDir)
			}
			lines = append(lines,
				helpStyle.Render(desc),
				helpStyle.Render(fmt.Sprintf("when running %s.", m.toolName)),
				"",
				helpStyle.Render(buttonText),
			)
		}
	}

	if m.err != nil {
		lines = append(lines, "", errStyle.Render("Error: "+m.err.Error()))
	}

	body := containerStyle.Render(strings.Join(lines, "\n"))
	return frameStyle.Render(appStyle.Render(lipgloss.JoinVertical(
		lipgloss.Left,
		headerStyle.Render(logo),
		body,
	)))
}
