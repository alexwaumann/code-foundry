package command_test

import (
	"slices"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
)

// readOnly is every command that only reads (Command.ReadOnly): a page's bridge runs these
// without a user gesture (docs/notes/bridge-1-daemon.md). Adding a verb here is a
// decision: it must create, change, send, run, open or write nothing and move no window.
// A refresh (project.refresh, pr.refresh, app.update.check, skill.refresh) is not here:
// it makes the daemon do work. A new verb is a change until it is added.
var readOnly = []string{
	"action.list", "action.runs", "action.wait",
	"app.version",
	"daemon.capabilities", "daemon.status", "daemon.version",
	"ember.board", "ember.status", "ember.task.list", "ember.task.show",
	"memory.show",
	"plugin.browse", "plugin.env", "plugin.list", "plugin.logs", "plugin.secrets.list", "plugin.terminals", "plugin.threads", "plugin.wakes",
	"pr.checks",
	"project.list",
	"settings.get", "settings.path",
	"skill.browse",
	"terminal.list",
	"theme.check", "theme.list", "theme.show",
	"thread.agents", "thread.checkouts", "thread.commands", "thread.flags", "thread.get", "thread.items", "thread.list", "thread.mcp", "thread.read",
	"thread.reports", "thread.subscriptions", "thread.wait",
	"ui.presence",
	"usage.show",
	"workspace.list",
}

// Every registered command is classified on purpose: the read-only ones are exactly the
// list above, so marking a verb, or forgetting to unmark one, fails here.
func TestReadOnlyCommandsAreTheList(t *testing.T) {
	f := newFixture(t)
	var got []string
	for _, l := range f.reg.List(command.Context{}, true) {
		if l.ReadOnly {
			got = append(got, l.Name)
		}
	}
	slices.Sort(got)
	want := slices.Sorted(slices.Values(readOnly))
	for _, n := range want {
		if _, ok := f.reg.Get(n); !ok {
			t.Errorf("%s is listed read-only but not registered", n)
		}
	}
	if !slices.Equal(got, want) {
		t.Errorf("read-only commands:\n got  %v\n want %v", got, want)
	}
}

func TestReadOnlyMarker(t *testing.T) {
	f := newFixture(t)
	tests := []struct {
		name string
		want bool
	}{
		{"thread.get", true},
		{"thread.items", true},
		{"thread.wait", true},
		{"pr.checks", true},
		{"settings.get", true},
		{"daemon.capabilities", true},
		{"ui.presence", true},
		{"ember.board", true},
		// Sends, runs, creates, changes.
		{"thread.send", false},
		{"thread.new", false},
		{"thread.respond", false},
		{"action.run", false},
		{"terminal.new", false},
		{"settings.set", false},
		{"memory.add", false},
		{"theme.save", false},
		{"pr.merge", false},
		{"ember.task.add", false},
		// Refreshes make the daemon work.
		{"project.refresh", false},
		{"pr.refresh", false},
		{"app.update.check", false},
		// They move the user's screen.
		{"view.inline", false},
		{"view.panel.file", false},
		{"view.dashboard", false},
		{"thread.focus", false},
		{"ui.notify", false},
		{"ui.palette.open", false},
		{"worktree.reveal", false},
		{"view.open.url", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c, ok := f.reg.Get(tc.name)
			if !ok {
				t.Fatalf("%s not registered", tc.name)
			}
			if c.ReadOnly != tc.want {
				t.Errorf("ReadOnly = %v, want %v", c.ReadOnly, tc.want)
			}
		})
	}
}

// A page's bridge invokes with the context the CLI inside the page's thread sends: the
// thread and no view (UiContext.active_view's comment). What that thread's agent can run,
// its page can: verbs that take a thread or work from the CLI are available there.
func TestPageContextIsTheThreadsCLI(t *testing.T) {
	f := newFixture(t)
	page := command.Context{ActiveThreadID: "s1"}
	tests := []struct {
		name string
		want bool
	}{
		{"thread.get", true},
		{"thread.send", true},
		{"thread.archive", true},
		{"view.inline", true},
		{"view.panel.file", true},
		{"terminal.new", true},
		{"action.run", true},
		{"thread.new", true},
		{"thread.agent.up", true},
		// As for the CLI, a verb on a worktree or terminal needs one named in its args
		// (Invoke overlays a context-bound arg before When), not the thread alone.
		{"git.push", false},
		{"terminal.kill", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c, ok := f.reg.Get(tc.name)
			if !ok {
				t.Fatalf("%s not registered", tc.name)
			}
			if got := c.Available(page); got != tc.want {
				t.Errorf("available in a page of thread s1 = %v, want %v", got, tc.want)
			}
		})
	}
}
