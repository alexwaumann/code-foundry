package command

import "context"

// The ShowView names of the find in a File tab (docs/notes/file-find-in-file.md): an action
// on per-window GUI state like ViewTerminalFind. file.search opens the find bar of the File
// tab with the keyboard, or of the File tab on screen when none has it (or focuses the bar
// and selects its query); file.search.next and file.search.previous make the next or
// previous match current, opening the bar when it is closed. A window with no searchable
// File tab on screen ignores them. Not file.find: that is Go to File (cmd+p).
const (
	ViewFileSearch         = "file.search"
	ViewFileSearchNext     = "file.search.next"
	ViewFileSearchPrevious = "file.search.previous"
)

// canSearchFile is the verbs' availability: a thread view, whose File tabs are linked
// to it. The GUI's palette further lists them only while a File tab it can search
// is on screen (keys/bindings.ts inPalette), as it does for file.save. The CLI (no view)
// may always ask; windows decide.
func canSearchFile(c Context) bool {
	return c.ActiveView == "" || (c.ActiveView == "thread" && hasThread(c))
}

// fileSearchCommands are file.search, file.search.next and file.search.previous. Their
// chords are thread.find's (SharedChords): the GUI runs them while the keyboard is in a
// File tab (its code, editor or find bar), and the thread's everywhere else. The bar sits
// under the tab's header and searches the file's text in view and edit mode alike, and a
// markdown file's rendered text in Rendered. The CLI's reach every window through ShowView.
func (d ViewDeps) fileSearchCommands() []Command {
	cmd := func(name, view, title, desc, chord string) Command {
		return Command{
			Name:        name,
			Page:        PageState,
			Title:       title,
			Description: desc,
			Category:    "View",
			Keybindings: []string{chord},
			When:        canSearchFile,
			WhyUnavailable: func(Context) string {
				return "no thread is on screen"
			},
			Run: func(_ context.Context, uctx Context, _ Args) (Result, error) {
				return EmitTo(d.Emitter, showViewIntent(view, nil)).CLIResult(uctx), nil
			},
		}
	}
	return []Command{
		cmd("file.search", ViewFileSearch, "Find in File",
			"Find in the File tab. Searches the file a File tab shows, viewed or edited, or a markdown file as rendered; case-sensitive once the query has a capital letter.", "cmd+f"),
		cmd("file.search.next", ViewFileSearchNext, "Find Next in File",
			"Next match in the File tab. Opens the File tab's find bar when it is closed.", "cmd+g"),
		cmd("file.search.previous", ViewFileSearchPrevious, "Find Previous in File",
			"Previous match in the File tab. Opens the File tab's find bar when it is closed.", "cmd+shift+g"),
	}
}
