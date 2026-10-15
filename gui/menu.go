package main

import (
	"github.com/wailsapp/wails/v3/pkg/application"
)

// EventRunCommand is emitted to the frontend by app menu items that run something in the
// window: the data is a registry command name (session.new, view.settings, ...) or the
// name of a GUI view action (menuViewActions in gui/frontend/src/keys/menu.ts). The page
// starts it exactly as the palette would, so the menu adds no user action of its own
// (docs/notes/onboarding-1-entry-points.md).
const EventRunCommand = "app:run-command"

// reportIssueURL is opened in the browser by Help > Report an Issue….
const reportIssueURL = "https://github.com/alexwaumann/code-foundry/issues/new"

// menuCommand is a menu item that runs command in the window.
type menuCommand struct {
	label   string
	command string
}

// No item here has a key equivalent. Every chord these commands have belongs to the page
// (keybindings the user can rebind, or GUI view actions), and a native key equivalent
// fires whenever the page leaves the key unhandled, e.g. while a text field has focus or
// after the user rebound the command (see appMenu). So the menu shows no chords; the
// palette and the Keyboard Shortcuts overlay list them.

// settingsItem follows Check for Updates… in the Code Foundry menu.
var settingsItem = menuCommand{"Settings…", "view.settings"}

// threadMenu is the Thread menu, one slice per separated group.
var threadMenu = [][]menuCommand{
	{{"New Thread", "session.new"}, {"Add Project…", "repo.add"}},
	{{"Rename Thread", "session.rename"}, {"Fork Thread", "session.fork"}, {"Snooze…", "session.snooze"}, {"Archive", "session.archive"}},
	{{"Next Needing Attention", "attention.next"}},
}

// helpMenu is the Help menu's command items, one slice per separated group. Report an
// Issue… (a URL, not a command) follows them below a separator. The first two open the
// help overlay on its Guide and Keyboard shortcuts tabs: GUI view actions, not view.help
// (a toggle), so picking one while the overlay shows switches its tab.
var helpMenu = [][]menuCommand{
	{{"Getting Started", "help.guide"}, {"Keyboard Shortcuts and Help", "help.shortcuts"}},
	{{"Open Command Palette", "ui.palette.open"}},
}

// addCommandGroups adds groups to m with a separator between them; a click calls run
// with the item's command.
func addCommandGroups(m *application.Menu, groups [][]menuCommand, run func(command string)) {
	for i, g := range groups {
		if i > 0 {
			m.AddSeparator()
		}
		for _, c := range g {
			m.Add(c.label).OnClick(func(*application.Context) { run(c.command) })
		}
	}
}

// runInWindow returns a func that asks the current window's page to run a command
// (EventRunCommand). With no window open it does nothing.
func runInWindow(app *application.App) func(command string) {
	return func(command string) {
		w := app.Window.Current()
		if w == nil {
			return
		}
		w.EmitEvent(EventRunCommand, command)
	}
}
