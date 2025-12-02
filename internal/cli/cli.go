package cli

import (
	tea "github.com/charmbracelet/bubbletea"
	"github.com/dosu-ai/dosu-cli/internal/tui"
)

// Execute wires the entrypoint for the CLI to the TUI program.
func Execute() (tea.Model, error) {
	p := tea.NewProgram(tui.New())
	return p.Run()
}
