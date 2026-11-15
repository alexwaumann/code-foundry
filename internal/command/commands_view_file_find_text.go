package command

import "context"

// ViewFileFindText is the ShowView name of file.find.text: the file finder in its Text mode
// (Search in Files…) over the thread on screen. Like file.find, a window that shows a thread
// with a project opens it, any other ignores it (docs/notes/file-search-5-text-mode.md).
const ViewFileFindText = "file.find.text"

// fileFindTextCommand is file.find.text: the finder's Text mode, the lines of the thread's
// files that contain the typed text. The same availability as file.find (canFindFiles).
// cmd+shift+p, which the command palette gave up (cmd+k stays its chord).
func (d ViewDeps) fileFindTextCommand() Command {
	return Command{
		Name:        "file.find.text",
		Page:        PageState,
		Title:       "Search in Files…",
		Description: "Search the text of the thread's checkouts' files and open a match as a tab beside the thread at its line (⌘⏎ puts the file and line in the prompt as an @ file instead).",
		Category:    "View",
		Keybindings: []string{"cmd+shift+p"},
		When:        canFindFiles,
		WhyUnavailable: func(c Context) string {
			if c.ActiveView == "thread" && hasThread(c) {
				return "the thread has no project"
			}
			return "no thread is on screen"
		},
		Run: func(_ context.Context, uctx Context, _ Args) (Result, error) {
			return EmitTo(d.Emitter, showViewIntent(ViewFileFindText, nil)).CLIResult(uctx), nil
		},
	}
}
