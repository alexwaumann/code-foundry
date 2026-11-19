package command

import "context"

// ViewNeedsNext is the ShowView name that opens the Needs you popup of the next thread that
// waits on the user, in the window's Needs you order (Ember first while it waits), wrapping;
// nothing when none waits. An action on per-window GUI state like ViewThreadNext.
const ViewNeedsNext = "needs.next"

// needsNextCommand is thread.needs.next (docs/notes/put-away-chords.md): the popup of the next
// thread that needs the user, on cmd+shift+n. It was a reserved view action on cmd+shift+a
// until cmd+shift+a became thread.archive's; as a command the palette lists it, Keyboard
// Shortcuts shows it, and a user may rebind it. A window presents its own chord, palette row
// and menu item locally (gui/frontend/src/keys/bindings.ts commandPresenters); the CLI's
// reaches every window through ShowView.
func (d ViewDeps) needsNextCommand() Command {
	return Command{
		Name:        "thread.needs.next",
		Page:        PageState,
		Title:       "Next Thread Needing You",
		Description: "Open the Needs you popup of the next thread waiting on you: a question, a permission or a plan to approve.",
		Category:    "View",
		// The user's own attention: an agent has no use for it.
		NoIndex:     true,
		Keybindings: []string{"cmd+shift+n"},
		// cmd+shift+n was free: a user's override already on it keeps it.
		KeybindingsYield: true,
		Run: func(_ context.Context, uctx Context, _ Args) (Result, error) {
			return EmitTo(d.Emitter, showViewIntent(ViewNeedsNext, nil)).CLIResult(uctx), nil
		},
	}
}
