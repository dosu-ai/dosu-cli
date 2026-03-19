package setup

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

const (
	IconSuccess  = "\u2714" // ✔
	IconError    = "\u2716" // ✖
	IconWarning  = "\u26A0" // ⚠
	IconQuestion = "?"
	IconAdd      = "+"
	IconRemove   = "-"
	IconCursor   = "\u276F" // ❯
)

var (
	accentColor  = lipgloss.Color("#A8EA6B")
	successStyle = lipgloss.NewStyle().Foreground(accentColor)
	errorStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("9"))
	warningStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("11"))
	infoStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("14"))
	dimStyle     = lipgloss.NewStyle().Foreground(lipgloss.Color("245"))
	boldStyle    = lipgloss.NewStyle().Bold(true)
)

func Success(msg string) string {
	return successStyle.Render(IconSuccess) + " " + msg
}

func Error(msg string) string {
	return errorStyle.Render(IconError) + " " + msg
}

func Warning(msg string) string {
	return warningStyle.Render(IconWarning) + " " + msg
}

func Question(msg string) string {
	return warningStyle.Render(IconQuestion) + " " + msg
}

func Dim(msg string) string {
	return dimStyle.Render(msg)
}

func Bold(msg string) string {
	return boldStyle.Render(msg)
}

func Info(msg string) string {
	return infoStyle.Render(msg)
}

// PrintSuccess prints a green success line.
func PrintSuccess(msg string) {
	fmt.Println(Success(msg))
}

// PrintError prints a red error line.
func PrintError(msg string) {
	fmt.Println(Error(msg))
}

// PrintWarning prints a yellow warning line.
func PrintWarning(msg string) {
	fmt.Println(Warning(msg))
}

// PrintBox prints text wrapped in dashed lines for easy copy-paste.
func PrintBox(lines ...string) {
	maxLen := 0
	for _, l := range lines {
		if len(l) > maxLen {
			maxLen = len(l)
		}
	}
	border := dimStyle.Render(strings.Repeat("-", maxLen))
	fmt.Println(border)
	for _, l := range lines {
		fmt.Println(infoStyle.Render(l))
	}
	fmt.Println(border)
}
