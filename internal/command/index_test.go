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
//   - The user's own moves around the window: the keys (pane.focus.<direction>,
//     pane.move.<direction>, pane.split, tab.next, tab.previous; a model names panes and tabs
//     by id with pane.move and tab.move), full screen (pane.fullscreen: window state),
//     focusing a pane (pane.focus: a model never takes the focus unasked) and reordering the
//     top bar (space.move).
//   - The shell window's terminal keys (terminal.quick, terminal.cycle): the user's view; a
//     model starts shells with terminal.new.
//   - The shell's composer and its drafts (composer.new, composer.draft.*): a model starts
//     threads with thread.new.
//   - The classic names of the view.open.* verbs (view.panel.diff, .file, .gallery, .mcp,
//     .page, .pr): aliases kept for one stable release; the index lists the new names.
//   - The shell window's key between a thread and its diff (view.thread-diff): the user's
//     view; a model opens a diff with view.open.diff.
//   - The user's own: thread.prompts (their prompt history), thread.regenerate-name (agents
//     use thread rename), thread.restart, thread.stop-waiting (agents unsubscribe).
var noIndex = []string{
	"action.last", "composer.draft.clear", "composer.draft.discard", "composer.draft.label", "composer.draft.open",
	"composer.draft.start", "composer.history", "composer.new", "file.export",
	"pane.focus", "pane.focus.down", "pane.focus.left", "pane.focus.right", "pane.focus.up", "pane.fullscreen", "pane.move.down",
	"pane.move.left", "pane.move.right", "pane.move.up", "pane.split", "space.move", "tab.auto-name", "tab.next", "tab.previous", "tab.rename", "tab.reopen",
	"terminal.cycle", "terminal.quick",
	"thread.move.open", "thread.new-like", "thread.placement.check", "thread.prompts",
	"thread.regenerate-name", "thread.restart", "thread.shell.stop", "thread.stop-waiting", "thread.workspace",
	"view.panel.diff", "view.panel.file", "view.panel.gallery", "view.panel.mcp", "view.panel.page", "view.panel.pr",
	"view.thread-diff", "view.thread-info", "worktree.editors",
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
