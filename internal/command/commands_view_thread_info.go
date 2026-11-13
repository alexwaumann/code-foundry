package command

import "context"

// ViewThreadInfo is the ShowView name of view.thread-info: it shows or hides the focused
// thread's info card, the column beside a thread's conversation and composer (its place, git
// state, pull requests, lineage, MCP servers, context and usage;
// docs/notes/thread-info-card.md). The window decides: with room for the card it keeps the
// choice with the thread (thread.info, per thread in the layout); without, it shows the card
// as a temporary overlay (docs/notes/shell-25a-test-feedback.md).
const ViewThreadInfo = "thread-info"

// threadInfoCommand is view.thread-info. The GUI presents it in the window
// (keys/bindings.ts); the CLI's reaches every window through ShowView.
func (d ViewDeps) threadInfoCommand() Command {
	return Command{
		Name:        "view.thread-info",
		Page:        PageState,
		NoIndex:     true,
		Title:       "Toggle Thread Info",
		Description: "Show or hide the focused thread's info card beside its conversation: its checkout, branch and pull requests, git state, shells, related threads and agents, MCP servers, context and usage. Each thread keeps its own choice (thread.info).",
		Category:    "View",
		Keybindings: []string{"cmd+shift+i"},
		Run: func(_ context.Context, uctx Context, _ Args) (Result, error) {
			return EmitTo(d.Emitter, showViewIntent(ViewThreadInfo, nil)).CLIResult(uctx), nil
		},
	}
}
