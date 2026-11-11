package command_test

import (
	"slices"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
)

// noIndex is every command the agents' command index leaves out by mark (Command.NoIndex):
// a control of the GUI, or the user's own, that a model has no use for or has a better verb
// for. Adding a verb here is a decision: the default is to be listed.
//
//   - The thread info card and its menus: action.last, thread.placement.check,
//     thread.shell.stop, view.thread-info, worktree.editors.
//   - GUI pickers, where agents call the verb behind them: composer.history, thread.move.open
//     (thread.move), thread.new-like (thread new --like), thread.workspace (workspace new).
//   - The user's own: thread.prompts (their prompt history), thread.regenerate-name (agents
//     use thread rename), thread.restart, thread.stop-waiting (agents unsubscribe).
var noIndex = []string{
	"action.last", "composer.history", "file.export", "thread.move.open", "thread.new-like", "thread.placement.check", "thread.prompts",
	"thread.regenerate-name", "thread.restart", "thread.shell.stop", "thread.stop-waiting", "thread.workspace",
	"view.thread-info", "worktree.editors",
}

func TestNoIndexCommandsAreTheList(t *testing.T) {
	f := newFixture(t)
	var got []string
	for _, l := range f.reg.List(command.Context{}, true) {
		if l.NoIndex {
			got = append(got, l.Name)
		}
	}
	slices.Sort(got)
	if !slices.Equal(got, noIndex) {
		t.Fatalf("NoIndex commands:\n got %q\nwant %q", got, noIndex)
	}
}
