package command

import "context"

// The ShowView names of the terminal's find (docs/notes/terminal-find.md): an action on
// per-window GUI state like ViewThreadFind. terminal.find opens the find bar over the
// terminal with the keyboard, or over the terminal on screen when none has it (or focuses
// the bar and selects its query); terminal.find.next and terminal.find.previous make the
// next or previous match current, opening the bar when it is closed. A window with no
// terminal on screen ignores them.
const (
	ViewTerminalFind         = "terminal.find"
	ViewTerminalFindNext     = "terminal.find.next"
	ViewTerminalFindPrevious = "terminal.find.previous"
)

// SharedChords maps a command to the one whose default chord it shares: the chord runs the
// key while the keyboard is in its place (a terminal for terminal.*, a File tab for
// file.search*), and the value everywhere else. The GUI decides at the key press from where
// the keyboard is (scopedCommand in gui/frontend/src/keys/bindings.ts), so a stale command
// list, or a terminal the daemon's context does not know (a plugin's node), still gets its
// own. No other two commands may share a chord (TestKeybindingsAreUniqueAndNotReserved).
var SharedChords = map[string]string{
	"terminal.find":          "thread.find",
	"terminal.find.next":     "thread.find.next",
	"terminal.find.previous": "thread.find.previous",
	"file.search":            "thread.find",
	"file.search.next":       "thread.find.next",
	"file.search.previous":   "thread.find.previous",
}

// canFindInTerminal is the find verbs' availability: a terminal with the keyboard, which
// is what the palette needs to list them (the chords do not wait for it). The CLI (no
// view) may always ask; windows decide.
func canFindInTerminal(c Context) bool {
	return c.ActiveView == "" || hasTerminal(c)
}

// terminalFindCommands are terminal.find, terminal.find.next and terminal.find.previous.
// The GUI presents them in the window (keys/bindings.ts): the find bar at the top right of
// the terminal, which searches its scrollback (only the screen in the alternate screen).
// The CLI's reach every window through ShowView.
func (d ViewDeps) terminalFindCommands() []Command {
	cmd := func(name, view, title, desc, chord string) Command {
		return Command{
			Name:        name,
			Page:        PageState,
			Title:       title,
			Description: desc,
			Category:    "View",
			Keybindings: []string{chord},
			When:        canFindInTerminal,
			WhyUnavailable: func(Context) string {
				return "no terminal has the keyboard"
			},
			Run: func(_ context.Context, uctx Context, _ Args) (Result, error) {
				return EmitTo(d.Emitter, showViewIntent(view, nil)).CLIResult(uctx), nil
			},
		}
	}
	return []Command{
		cmd("terminal.find", ViewTerminalFind, "Find in Terminal",
			"Find text in the terminal's scrollback, or only its screen under a full-screen program like vim (case-sensitive once the query has a capital letter).", "cmd+f"),
		cmd("terminal.find.next", ViewTerminalFindNext, "Find Next in Terminal",
			"Go to the next match of the terminal's find bar (opens the bar when it is closed).", "cmd+g"),
		cmd("terminal.find.previous", ViewTerminalFindPrevious, "Find Previous in Terminal",
			"Go to the previous match of the terminal's find bar (opens the bar when it is closed).", "cmd+shift+g"),
	}
}
