package tui

import (
	"github.com/charmbracelet/bubbles/list"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// MenuSelected is emitted to the parent model when an item is chosen.
type MenuSelected struct {
	ID string
}

type MenuModel struct {
	list list.Model
}

func (m MenuModel) Init() tea.Cmd {
	return nil
}

func (m MenuModel) Update(msg tea.Msg) (MenuModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		h, v := appStyle.GetFrameSize()
		headerHeight := lipgloss.Height(headerStyle.Render(logo))
		listHeight := msg.Height - v - headerHeight
		if listHeight < 3 {
			listHeight = 3
		}
		m.list.SetSize(msg.Width-h, listHeight)

	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c", "q":
			return m, tea.Quit
		case "enter":
			i, ok := m.list.SelectedItem().(item)
			if !ok {
				return m, nil
			}
			return m, selectItem(i.id)
		}
	}

	var cmd tea.Cmd
	m.list, cmd = m.list.Update(msg)
	return m, cmd
}

func (m MenuModel) View() string {
	return appStyle.Render(
		lipgloss.JoinVertical(
			lipgloss.Left,
			headerStyle.Render(logo),
			m.list.View(),
		),
	)
}

// NewMenu creates a menu with default items. Parent should handle MenuSelected messages.
func NewMenu() MenuModel {
	items := []list.Item{
		item{id: "setup", title: "Setup", desc: "Configure your environment"},
		item{id: "sync", title: "Sync Documents", desc: "Pull latest files from server"},
		item{id: "status", title: "Check Status", desc: "View system health"},
	}

	delegate := list.NewDefaultDelegate()
	delegate.Styles.NormalTitle = itemStyle
	delegate.Styles.NormalDesc = itemStyle
	delegate.Styles.SelectedTitle = selectedItemStyle
	delegate.Styles.SelectedDesc = selectedItemStyle

	m := list.New(items, delegate, 0, 0)
	m.SetShowTitle(false)
	m.SetFilteringEnabled(false)
	m.DisableQuitKeybindings()

	return MenuModel{list: m}
}

// item implements list.Item and carries an ID for routing.
type item struct {
	id          string
	title, desc string
}

func (i item) Title() string       { return i.title }
func (i item) Description() string { return i.desc }
func (i item) FilterValue() string { return i.title }

func selectItem(id string) tea.Cmd {
	return func() tea.Msg {
		return MenuSelected{ID: id}
	}
}

var (
	appStyle = lipgloss.NewStyle().Margin(1, 2)

	headerStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#7D56F4")).
			Align(lipgloss.Center).
			Bold(true)

	itemStyle = lipgloss.NewStyle().PaddingLeft(2)

	selectedItemStyle = lipgloss.NewStyle().PaddingLeft(2).Foreground(lipgloss.Color("170")).Bold(true)
)

const logo = `
 /$$$$$$$                               
| $$__  $$                              
| $$  \ $$  /$$$$$$   /$$$$$$$ /$$   /$$
| $$  | $$ /$$__  $$ /$$_____/| $$  | $$
| $$  | $$| $$  \ $$|  $$$$$$ | $$  | $$
| $$  | $$| $$  | $$ \____  $$| $$  | $$
| $$$$$$$/|  $$$$$$/ /$$$$$$$/|  $$$$$$/
|_______/  \______/ |_______/  \______/ 
`
