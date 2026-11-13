package command

import "context"

// ViewSearch is the ShowView name of search.open: the cross-thread Find dialog
// (docs/notes/search-4-find-dialog.md), an action on per-window GUI state like
// ViewFileFind. Every window opens it over whatever it shows.
const ViewSearch = "search.open"

// searchOpenCommand is search.open. The GUI presents it in the window (keys/bindings.ts):
// the palette's Find dialog over every thread's names and messages (ThreadService.Search),
// whose Enter opens a hit in its thread with the thread's find bar on the same match.
// The CLI's reaches every window through ShowView; agents search with thread.search.
// With an id it opens on that agent search (the sidebar's search row, which runs it
// window-local): the palette and the chord never ask for one.
func (d ViewDeps) searchOpenCommand() Command {
	return Command{
		Name:        "search.open",
		Page:        PageState,
		Title:       "Search Threads",
		Description: "Find threads by name and messages across every thread (archived ones too), with a preview; Enter opens the message in its thread with the find bar on the match.",
		Category:    "View",
		Keybindings: []string{"cmd+shift+f"},
		Args:        []ArgSpec{{Name: "id", Type: String, Positional: true, Description: "An agent search to open on (q-…; search.recent lists them)"}},
		Run: func(_ context.Context, uctx Context, a Args) (Result, error) {
			var params map[string]string
			if id := a.String("id"); id != "" {
				params = map[string]string{"id": id}
			}
			return EmitTo(d.Emitter, showViewIntent(ViewSearch, params)).CLIResult(uctx), nil
		},
	}
}
