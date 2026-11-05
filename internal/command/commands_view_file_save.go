package command

import "context"

// ViewFileSave is the ShowView name of file.save: save what the focused File tab is
// editing. An action on per-window GUI state like ViewFileFind, and the draft is that
// state: it lives in the window's memory and never reaches the daemon except through
// FilesystemService.WriteFile, so this command takes no contents, in any form. A window
// with no tab editing ignores it (docs/notes/file-edit-2-gui.md).
const ViewFileSave = "file.save"

// fileSaveCommand is file.save. The GUI presents it in the window (keys/bindings.ts); the
// CLI's reaches every window through ShowView. Always available: only a window knows
// whether a tab is editing, and saving nothing does nothing.
func (d ViewDeps) fileSaveCommand() Command {
	return Command{
		Name:        "file.save",
		Title:       "Save File",
		Description: "Save the file being edited in the focused File tab. Does nothing when no tab is editing.",
		Category:    "View",
		Keybindings: []string{"cmd+s"},
		Run: func(_ context.Context, uctx Context, _ Args) (Result, error) {
			return EmitTo(d.Emitter, showViewIntent(ViewFileSave, "", nil)).CLIResult(uctx), nil
		},
	}
}
