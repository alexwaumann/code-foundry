package command

import "context"

// ViewThreadInfo is the ShowView name of view.thread-info: it shows or hides the thread
// info card, the column beside a thread's conversation and composer (its place, git
// state, pull requests, lineage, MCP servers, context and usage;
// docs/notes/thread-info-card.md). An action on per-window GUI state like ViewBack: each
// window keeps its own toggle, for every thread it shows.
const ViewThreadInfo = "thread-info"

// threadInfoCommand is view.thread-info. The GUI presents it in the window
// (keys/bindings.ts); the CLI's reaches every window through ShowView.
func (d ViewDeps) threadInfoCommand() Command {
	return Command{
		Name:        "view.thread-info",
		Title:       "Toggle Thread Info",
		Description: "Show or hide the thread info card beside a thread's conversation: its checkout, branch and pull requests, git state, shells, related threads and agents, MCP servers, context and usage.",
		Category:    "View",
		Keybindings: []string{"cmd+shift+i"},
		Run: func(_ context.Context, uctx Context, _ Args) (Result, error) {
			return EmitTo(d.Emitter, showViewIntent(ViewThreadInfo, "", nil)).CLIResult(uctx), nil
		},
	}
}
