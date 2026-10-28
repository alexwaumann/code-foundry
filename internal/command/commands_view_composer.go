package command

import "context"

// ViewComposerHistory is the ShowView name of composer.history: the "Previous prompts"
// picker. An action on per-window GUI state like ViewBack: a window whose keyboard is in
// a composer opens the picker above it, any other window opens its command palette on
// the prompts list (docs/notes/prompt-history-2-picker.md).
const ViewComposerHistory = "composer.history"

// composerHistoryCommand is composer.history: the prompts the user sent, to pick one
// again. The GUI presents it in the window (keys/bindings.ts); the CLI's reaches every
// window through ShowView. thread.prompts is the CLI's listing.
func (d ViewDeps) composerHistoryCommand() Command {
	return Command{
		Name:        "composer.history",
		Title:       "Previous Prompts",
		Description: "Show the prompts you sent, to put one back in the composer: above the focused composer, else in the command palette.",
		Category:    "View",
		// No default chord: Up in an empty composer opens it; bindable in settings.
		Run: func(_ context.Context, uctx Context, _ Args) (Result, error) {
			return EmitTo(d.Emitter, showViewIntent(ViewComposerHistory, "", nil)).CLIResult(uctx), nil
		},
	}
}
