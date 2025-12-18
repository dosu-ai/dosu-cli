package tui

import (
	"github.com/charmbracelet/bubbles/list"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/dosu-ai/dosu-cli/internal/mcp"
)

type MCPToolSelected struct {
	ToolID   string
	ToolName string
}

type MCPToolsCanceled struct{}

type MCPToolsModel struct {
	list     list.Model
	isRemove bool
}

type toolItem struct {
	id   string
	name string
	desc string
}

func (i toolItem) Title() string       { return i.name }
func (i toolItem) Description() string { return i.desc }
func (i toolItem) FilterValue() string { return i.name }

func NewMCPToolsSelector(isRemove bool) MCPToolsModel {
	var items []list.Item
	for _, p := range mcp.AllProviders() {
		scope := "local + global"
		if !p.SupportsLocal() {
			scope = "global only"
		}
		action := "Add"
		if isRemove {
			action = "Remove"
		}
		items = append(items, toolItem{
			id:   p.ID(),
			name: p.Name(),
			desc: action + " Dosu MCP to " + p.Name() + " (" + scope + ")",
		})
	}

	delegate := list.NewDefaultDelegate()
	delegate.Styles.NormalTitle = itemTitleStyle
	delegate.Styles.NormalDesc = itemDescStyle
	delegate.Styles.SelectedTitle = selectedItemTitleStyle
	delegate.Styles.SelectedDesc = selectedItemDescStyle

	m := list.New(items, delegate, maxWidth-4, len(items)*3+4)
	m.SetShowTitle(false)
	m.SetFilteringEnabled(false)
	m.DisableQuitKeybindings()
	m.SetShowStatusBar(false)
	m.SetShowPagination(false)
	m.SetShowHelp(true)

	return MCPToolsModel{list: m, isRemove: isRemove}
}

func (m MCPToolsModel) Init() tea.Cmd {
	return nil
}

func (m MCPToolsModel) Update(msg tea.Msg) (MCPToolsModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		appH, appV := appStyle.GetFrameSize()
		frameH, frameV := frameStyle.GetFrameSize()
		headerHeight := lipgloss.Height(headerStyle.Render(logo))
		width := msg.Width - appH - frameH
		if width < 10 {
			width = 10
		}
		listHeight := msg.Height - appV - frameV - headerHeight - 4 // Extra for title
		if listHeight < 4 {
			listHeight = 4
		}
		if listHeight > maxListHeight {
			listHeight = maxListHeight
		}
		m.list.SetSize(width, listHeight)

	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c":
			return m, tea.Quit
		case "q", "esc":
			return m, cancelToolSelection
		case "enter":
			i, ok := m.list.SelectedItem().(toolItem)
			if ok {
				return m, selectTool(i.id, i.name)
			}
		}
	}

	var cmd tea.Cmd
	m.list, cmd = m.list.Update(msg)
	return m, cmd
}

func (m MCPToolsModel) View() string {
	titleStyle := lipgloss.NewStyle().
		Bold(true).
		Foreground(lipgloss.Color("170")).
		MarginBottom(1)

	title := "Add Dosu MCP"
	if m.isRemove {
		title = "Remove Dosu MCP"
	}

	inner := lipgloss.JoinVertical(
		lipgloss.Left,
		headerStyle.Render(logo),
		titleStyle.Render(title),
		m.list.View(),
	)
	return frameStyle.Render(appStyle.Render(inner))
}

func selectTool(id, name string) tea.Cmd {
	return func() tea.Msg {
		return MCPToolSelected{ToolID: id, ToolName: name}
	}
}

func cancelToolSelection() tea.Msg {
	return MCPToolsCanceled{}
}
