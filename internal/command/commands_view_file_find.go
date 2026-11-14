package command

import "context"

// ViewFileFind is the ShowView name of file.find: the file finder (Go to File…) over the
// thread on screen. An action on per-window GUI state like ViewThreadInfo: a window that
// shows a thread with a project opens the finder over it, any other ignores it
// (docs/notes/file-finder-2-gui.md).
const ViewFileFind = "file.find"

// canFindFiles is file.find's availability: a thread view whose thread has a project or
// a workspace (the GUI sends the thread's primary project, or its workspace for one that
// runs in the workspace's folder). A thread without a project (cwd ~) has no checkout to
// search, and pages have no thread. The CLI (no view) may always ask; windows decide.
func canFindFiles(c Context) bool {
	if c.ActiveView == "" {
		return true
	}
	return c.ActiveView == "thread" && hasThread(c) && (c.ActiveProjectID != "" || c.ActiveWorkspaceID != "")
}

// fileFindCommand is file.find. The GUI presents it in the window (keys/bindings.ts):
// the palette's file finder, whose Enter opens a File tab beside the thread.
// The CLI's reaches every window through ShowView.
func (d ViewDeps) fileFindCommand() Command {
	return Command{
		Name:        "file.find",
		Page:        PageState,
		Title:       "Go to File…",
		Description: "Find a file in the thread's checkouts by name and open it as a tab beside the thread (⌥⏎ puts it in the prompt as an @ file instead).",
		Category:    "View",
		Keybindings: []string{"cmd+p"},
		When:        canFindFiles,
		WhyUnavailable: func(c Context) string {
			if c.ActiveView == "thread" && hasThread(c) {
				return "the thread has no project"
			}
			return "no thread is on screen"
		},
		Run: func(_ context.Context, uctx Context, _ Args) (Result, error) {
			return EmitTo(d.Emitter, showViewIntent(ViewFileFind, nil)).CLIResult(uctx), nil
		},
	}
}
