package command

import (
	"context"
	"fmt"
)

// fileSaveCommand is file.save, cmd+s: save what the focused File tab is editing. Only the
// user's own window does: it presents the command itself (keys/bindings.ts), so Run is
// never reached from a chord or the palette, and whatever does reach Run is someone else
// (the CLI, a thread's model, a page's bridge, a plugin), all refused. A draft is the
// user's to save: a half-typed one must not land on disk because an agent asked, and it
// lives in the window's memory, so nothing here could reach it anyway. For the same reason
// there is no intent and no args (docs/notes/file-edit-2-gui.md). It is registered at all
// for the chord, the palette and the keybindings page.
func (d ViewDeps) fileSaveCommand() Command {
	return Command{
		Name:        "file.save",
		Page:        PageState,
		Title:       "Save File",
		Description: "Save the file being edited in the focused File tab. Only from the window: refused from the CLI.",
		Category:    "View",
		Keybindings: []string{"cmd+s"},
		Run: func(context.Context, Context, Args) (Result, error) {
			return Result{}, fmt.Errorf("file.save: %w: only the user can save a draft, from the window", ErrUnavailable)
		},
	}
}
