package command

import (
	"context"
	"fmt"
	"strings"

	core "github.com/alexwaumann/code-foundry/internal/layout"
)

// ThreadsOpenAsPreview is layout.threads-open-as.preview's answer: what switching the setting
// layout.threads_open_as to To would close and move (core.Conformed), read only.
type ThreadsOpenAsPreview struct {
	To string `json:"to"`
	core.Conformed
}

// threadsOpenAsCommand is layout.threads-open-as.preview: the count the GUI's confirm dialog
// shows before `settings.set layout.threads_open_as …` converts the layout
// (docs/notes/threads-open-as-1-rules.md).
func (l layout) threadsOpenAsCommand() Command {
	return Command{
		Name: "layout.threads-open-as.preview", Title: "Preview Threads Open As", Category: layoutCategory,
		Description: "Say what switching the setting layout.threads_open_as to --to would change, without changing anything: the thread " +
			"tabs and composers it would close (closed threads stay in the sidebar; their linked tabs are remembered and their terminals " +
			"keep running), the thread panes that would close with them, the other tabs it would move out of a thread's pane, and the " +
			"spaces affected. Switching to tabs changes nothing. The switch itself is settings.set layout.threads_open_as <value>.",
		Args: []ArgSpec{
			{Name: "to", Type: Enum, Enum: []string{string(core.ModeTabs), string(core.ModePanes), string(core.ModeSingle)}, Required: true, Positional: true,
				Description: "The value to switch to"},
		},
		// The GUI's switch dialog reads it; agents switch with settings.set (NoIndex: not in
		// the agents' guide, still in `code-foundry commands` and help).
		ReadOnly: true, NoPalette: true, NoKeybinding: true, NoIndex: true, Page: PageState,
		Run: func(_ context.Context, _ Context, a Args) (Result, error) {
			snap, err := l.state()
			if err != nil {
				return Result{}, err
			}
			mode, err := core.ParseMode(a.String("to"))
			if err != nil {
				return Result{}, InvalidArg("to", "%s", err)
			}
			vp := l.store.Viewport()
			c, err := core.ConformPreview(snap.State, mode, vp.Width, vp.Height)
			if err != nil {
				return Result{}, layoutErr(err)
			}
			return Result{Message: previewWords(mode, c), JSON: ThreadsOpenAsPreview{To: string(mode), Conformed: c}}, nil
		},
	}
}

// previewWords says a preview in a line.
func previewWords(mode core.Mode, c core.Conformed) string {
	var parts []string
	if c.ThreadTabs > 0 {
		parts = append(parts, "close "+plural(c.ThreadTabs, "thread tab"))
	}
	if c.Composers > 0 {
		parts = append(parts, "close "+plural(c.Composers, "composer tab"))
	}
	if c.Panes > 0 {
		parts = append(parts, "close "+plural(c.Panes, "thread pane"))
	}
	if c.Moved > 0 {
		parts = append(parts, "move "+plural(c.Moved, "tab")+" out of thread panes")
	}
	if len(parts) == 0 {
		return fmt.Sprintf("switching threads open as to %s changes nothing", mode)
	}
	return fmt.Sprintf("switching threads open as to %s would %s, in %s", mode, strings.Join(parts, ", "), plural(c.Spaces, "space"))
}
