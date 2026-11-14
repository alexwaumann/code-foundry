package command

import "context"

// The ShowView names of the in-thread find (docs/notes/search-2-thread-find.md): an action
// on per-window GUI state like ViewFileFind. thread.find opens the find bar over the
// thread on screen (or focuses it and selects its query); thread.find.next and
// thread.find.previous make the next or previous match current, opening the bar when it
// is closed. A window that shows no thread ignores them.
const (
	ViewThreadFind         = "thread.find"
	ViewThreadFindNext     = "thread.find.next"
	ViewThreadFindPrevious = "thread.find.previous"
)

// canFindInThread is the find verbs' availability: a thread on screen. The CLI (no view)
// may always ask; windows decide.
func canFindInThread(c Context) bool {
	if c.ActiveView == "" {
		return true
	}
	return c.ActiveView == "thread" && hasThread(c)
}

// threadFindCommands are thread.find, thread.find.next and thread.find.previous. The GUI
// presents them in the window (keys/bindings.ts): the find bar at the top of the thread's
// right column, which searches the conversation's messages, Claude's text and answered
// questions. The CLI's reach every window through ShowView.
func (d ViewDeps) threadFindCommands() []Command {
	cmd := func(name, view, title, desc, chord string) Command {
		return Command{
			Name:        name,
			Page:        PageState,
			Title:       title,
			Description: desc,
			Category:    "View",
			Keybindings: []string{chord},
			When:        canFindInThread,
			WhyUnavailable: func(Context) string {
				return "no thread is on screen"
			},
			Run: func(_ context.Context, uctx Context, _ Args) (Result, error) {
				return EmitTo(d.Emitter, showViewIntent(view, nil)).CLIResult(uctx), nil
			},
		}
	}
	return []Command{
		cmd("thread.find", ViewThreadFind, "Find in Thread",
			"Find text in the thread's conversation: your messages, Claude's text and answered questions (case-sensitive once the query has a capital letter).", "cmd+f"),
		cmd("thread.find.next", ViewThreadFindNext, "Find Next",
			"Go to the next match of the thread's find bar (opens the bar when it is closed).", "cmd+g"),
		cmd("thread.find.previous", ViewThreadFindPrevious, "Find Previous",
			"Go to the previous match of the thread's find bar (opens the bar when it is closed).", "cmd+shift+g"),
	}
}
