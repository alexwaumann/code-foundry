package command

import "context"

// ViewThreadMove is the ShowView name of thread.move.open: the move picker under a thread's
// header crumb, for a thread without a project (docs/notes/move-no-project-2-gui.md). Its
// params carry the thread's id ("id"). Like ViewProjectAdd an action on the window, not a
// page: the window selects the thread when it does not show it, then opens the picker,
// whose Move invokes thread.move.
const ViewThreadMove = "thread.move"

// canOpenMove is thread.move.open's availability: a thread without a project or a
// workspace, the one thread.move takes. The GUI sends no project and no workspace for a
// No project thread (an archived or resident one is refused by thread.move; the GUI does
// not offer the picker for them).
func canOpenMove(c Context) bool {
	return hasThread(c) && c.ActiveProjectID == "" && c.ActiveWorkspaceID == ""
}

// threadMoveOpen is thread.move.open, the palette's way to thread.move (which needs a place
// and is NoPalette). The GUI presents it in the window (keys/bindings.ts); the CLI's reaches
// every window through ShowView.
func threadMoveOpen(e Emitter, idArg ArgSpec) Command {
	return Command{
		Name:         "thread.move.open",
		Page:         PageState,
		NoIndex:      true,
		Title:        "Move Thread to a Project or Workspace…",
		Description:  "Open the move picker for a thread without a project: pick a project or workspace, where it works there, then Move (thread.move).",
		Category:     "Thread",
		NoKeybinding: true,
		Args:         []ArgSpec{idArg},
		When:         canOpenMove,
		WhyUnavailable: func(c Context) string {
			if hasThread(c) {
				return "the thread has a project already"
			}
			return "no thread is active"
		},
		Run: func(_ context.Context, uctx Context, a Args) (Result, error) {
			return EmitTo(e, showViewIntent(ViewThreadMove, map[string]string{"id": a.String("id")})).CLIResult(uctx), nil
		},
	}
}
