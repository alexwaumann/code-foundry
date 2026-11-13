package command_test

import (
	"slices"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
)

// noPalette is every command the GUI palette does not list (Command.NoPalette). Adding
// a verb here is a decision, by one of three tests:
//   - a query whose only output is a text toast (listings, thread.get, settings.get):
//     the GUI shows the same thing in a panel or page;
//   - a verb for the model or the CLI to drive the app (ui.notify, thread.respond,
//     thread.subscribe, view.panel.file) or Ember's task board (ember.*);
//   - a verb whose required arg is an opaque id the palette can only take as typed text
//     (a plugin or skill name, a repo slug and PR number, an action id) while a page
//     offers the action on the right row.
//
// Kept listed on purpose: anything with a presenter, a chord, an enum pick list or no
// prompt at all, and a required id that defaults from the context (thread.fork,
// terminal.kill run in one Enter on the active one). thread.interrupt stays for the
// keyboard; thread.budget is an Ember and agent knob, so it is out.
var noPalette = []string{
	"action.edit", "action.last", "action.list", "action.remove", "action.run", "action.runs", "action.stop",
	"action.wait", "app.version", "composer.stage", "daemon.capabilities", "daemon.status", "daemon.version",
	"dictation.hold", "dictation.start", "dictation.status", "dictation.stop",
	"ember.board", "ember.disable", "ember.enable", "ember.remember", "ember.reseed",
	"ember.status", "ember.task.add", "ember.task.cancel", "ember.task.done", "ember.task.list",
	"ember.task.show", "ember.task.start", "ember.task.update", "file.export", "memory.add", "memory.remove",
	"memory.show", "plugin.act", "plugin.browse", "plugin.dev", "plugin.disable", "plugin.enable",
	"plugin.env", "plugin.install", "plugin.list", "plugin.logs", "plugin.new", "plugin.restart",
	"plugin.secrets.delete", "plugin.secrets.list", "plugin.surface", "plugin.terminals",
	"plugin.threads", "plugin.uninstall", "plugin.wakes", "pr.ask", "pr.auto-merge", "pr.checkbox", "pr.checks", "pr.comment", "pr.draft",
	"pr.explain", "pr.fix.findings", "pr.merge", "pr.ready", "pr.refresh", "pr.revert", "pr.review",
	"pr.review.request", "pr.task", "project.branch.delete", "project.list", "settings.get", "settings.path",
	"search.agent", "search.find", "search.forget", "search.get", "search.open-hit", "search.promote", "search.recent", "search.report",
	"search.seen", "search.stop", "settings.reset", "settings.set", "skill.browse", "skill.disable", "skill.enable",
	"skill.install", "skill.remove", "skill.setup", "skill.uninstall", "terminal.list",
	"theme.check", "theme.list", "theme.restore", "theme.save", "theme.show", "thread.agent.open",
	"thread.agents", "thread.ask", "thread.budget", "thread.checkouts", "thread.commands", "thread.flag.clear",
	"thread.flags", "thread.focus", "thread.get", "thread.info", "thread.items", "thread.label", "thread.list",
	"thread.mcp", "thread.mcp-reconnect", "thread.move", "thread.placement.check", "thread.pr.link", "thread.project.add", "thread.project.remove", "thread.prompts", "thread.search", "thread.read", "thread.report", "thread.reports",
	"thread.reseed", "thread.respond", "thread.send", "thread.setup.cancel", "thread.setup.discard", "thread.setup.retry", "thread.shell.stop", "thread.subscribe", "thread.subscriptions",
	"thread.unsubscribe", "thread.wait", "thread.workspace", "ui.focus.project",
	"ui.focus.terminal", "ui.notify", "ui.palette.open", "ui.presence", "usage.show",
	"view.inline", "view.open.diff", "view.open.file", "view.open.gallery", "view.open.page", "view.open.pr", "view.open.url",
	"view.panel.diff", "view.panel.file", "view.panel.gallery", "view.panel.mcp", "view.panel.page", "view.panel.pr",
	"workspace.add-project", "workspace.list", "workspace.remove", "workspace.remove-project",
	"workspace.open.editor", "workspace.set-primary", "worktree.editors",
	"layout.show", "pane.focus", "pane.move", "pane.resize", "space.list", "space.move", "tab.focus", "tab.list", "tab.move", "thread.open",
	"composer.draft.clear", "composer.draft.discard", "composer.draft.label", "composer.draft.open", "composer.draft.start", "composer.new",
}

// Every registered command is classified on purpose: the unlisted ones are exactly the
// list above, so marking a verb, or forgetting to unmark one, fails here.
func TestNoPaletteCommandsAreTheList(t *testing.T) {
	f := newFixture(t)
	var got []string
	for _, l := range f.reg.List(command.Context{}, true) {
		if l.NoPalette {
			got = append(got, l.Name)
		}
	}
	slices.Sort(got)
	want := slices.Clone(noPalette)
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Fatalf("NoPalette commands:\n got %q\nwant %q", got, want)
	}
}
