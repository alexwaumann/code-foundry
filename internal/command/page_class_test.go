package command_test

import (
	"slices"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
)

// Every command is one of four things to a page (docs/notes/page-verb-gate.md). Adding a
// verb to a list is a decision, as it is for readOnly (readonly_test.go): a verb on no list
// fails here, and it asks a page until it is classified, because PageRuns is the zero value.

// pageRuns runs a program, installs or runs code, or writes outside the app's state: a page
// asks first. Some ask anyway, through Confirm.
var pageRuns = []string{
	"action.add", "action.edit", "action.run", "app.restart", "daemon.restart", "dictation.start",
	"file.export", "git.fetch", "git.pull", "git.push", "plugin.dev", "plugin.enable", "plugin.install", "plugin.new",
	"plugin.secrets.delete", "plugin.uninstall", "plugin.update", "pr.auto-merge", "pr.checkbox",
	"pr.comment", "pr.create", "pr.merge", "pr.revert", "pr.review", "pr.review.request",
	"project.add-workspace", "project.branch.delete", "project.clone", "project.delete", "project.git.init",
	"project.github.publish", "project.worktree.cleanup", "project.worktree.new",
	"project.worktree.remove", "skill.disable", "skill.enable", "skill.install", "skill.remove",
	"skill.setup", "skill.uninstall", "skill.update", "terminal.rerun", "thread.setup.retry", "workspace.open.editor",
	"worktree.open.editor",
}

// pageDrives drives a Claude thread: a page runs it as the CLI in its thread would.
var pageDrives = []string{
	"ember.remember", "ember.reseed", "ember.task.add", "ember.task.start", "ember.task.update",
	"memory.add", "pr.ask", "pr.explain", "pr.fix.findings", "pr.task", "search.agent", "theme.ask",
	"thread.ask", "thread.compact", "thread.interrupt", "thread.mcp", "thread.mcp-reconnect", "thread.move",
	"thread.new", "thread.new-like", "thread.project.add", "thread.project.remove", "thread.reseed",
	"thread.respond", "thread.restart", "thread.run-in", "thread.send", "thread.set-effort",
	"thread.set-mode", "thread.set-model", "thread.stop-waiting", "thread.subscribe",
	"thread.workspace",
}

// pageState is the app's own state: a page runs it freely, or with its own Confirm.
// settings.set, settings.reset, ember.enable and dictation.download ask a page in Run
// (pageAsks); plugin.act asks for an event, and a button's command is its own class.
// pr.ready and pr.draft write to GitHub, but they are reversible and run nothing.
var pageState = []string{
	"action.remove", "action.stop", "app.relaunch", "app.update", "app.update.check",
	"composer.history", "composer.stage", "dictation.allow", "dictation.download",
	"dictation.download.cancel", "dictation.hold", "dictation.remove", "dictation.stop",
	"dictation.toggle", "ember.disable", "ember.enable", "ember.task.cancel", "ember.task.done",
	"file.find", "file.save", "file.search", "file.search.next", "file.search.previous", "memory.clear", "memory.remove", "notifications.test",
	"plugin.act", "plugin.browse", "plugin.disable", "plugin.reload", "plugin.restart",
	"plugin.surface", "pr.draft", "pr.open", "pr.ready", "pr.refresh", "project.add",
	"project.create", "project.refresh", "project.rename", "project.unregister", "search.clear",
	"search.find", "search.forget", "search.open", "search.open-hit", "search.promote",
	"search.report", "search.seen", "search.stop", "settings.reset", "settings.reveal",
	"settings.set", "skill.browse", "skill.refresh", "terminal.close", "terminal.cycle", "terminal.find",
	"terminal.find.next", "terminal.find.previous", "terminal.kill", "terminal.new", "terminal.new-free",
	"terminal.quick", "terminal.remove", "terminal.reset", "theme.delete", "theme.duplicate", "theme.edit", "theme.pick", "theme.reset",
	"theme.restore", "theme.save", "theme.set-dark", "theme.set-light", "theme.set-scheme",
	"thread.agent.open", "thread.agent.up", "thread.archive", "thread.budget", "thread.find",
	"thread.find.next", "thread.find.previous", "thread.flag.clear", "thread.focus", "thread.fork",
	"thread.label", "thread.move.open", "thread.next", "thread.pin", "thread.pr.link",
	"thread.previous", "thread.regenerate-name", "thread.remove", "thread.rename", "thread.report",
	"thread.setup.cancel", "thread.setup.discard", "thread.shell.stop", "thread.snooze",
	"thread.unsubscribe", "ui.focus.project", "ui.focus.terminal", "ui.notify", "ui.palette.open",
	"view.back", "view.forward", "view.help", "view.inline", "view.open.diff",
	"view.open.file", "view.open.gallery", "view.open.mcp", "view.open.page", "view.open.pr", "view.open.url",
	"view.panel.diff", "view.panel.file", "view.panel.gallery", "view.panel.mcp",
	"view.panel.page", "view.panel.pr",
	"view.projects", "view.pullrequests", "view.settings", "view.thread-diff", "view.thread-info", "view.usage",
	"workspace.add-project", "workspace.new", "workspace.remove", "workspace.remove-project",
	"workspace.rename", "workspace.reveal", "workspace.set-primary", "workspace.set-root",
	"worktree.reveal",
	"pane.close", "pane.collapse", "pane.focus", "pane.focus.left", "pane.fullscreen", "pane.focus.down", "pane.focus.up", "pane.focus.right", "pane.move", "pane.move.left", "pane.move.down", "pane.move.up", "pane.move.right",
	"pane.resize", "pane.split", "space.move", "space.new", "space.remove", "space.rename", "space.switch", "tab.close", "tab.focus", "tab.move", "tab.reopen", "tab.rename", "tab.auto-name", "tab.next", "tab.previous",
	"thread.close", "thread.info", "thread.open", "thread.space.move",
	"composer.draft.clear", "composer.draft.discard", "composer.draft.label", "composer.draft.open", "composer.draft.start", "composer.new",
}

// pageAskFlags are the flags that make a pageState verb ask a page.
var pageAskFlags = map[string][]string{
	"project.add":       {"path"},
	"terminal.new":      {"argv", "run"},
	"terminal.new-free": {"argv", "run"},
}

func TestEveryCommandHasAPageClass(t *testing.T) {
	f := newFixture(t)
	class := map[string]command.PageClass{}
	for list, c := range map[*[]string]command.PageClass{&pageRuns: command.PageRuns, &pageDrives: command.PageDrives, &pageState: command.PageState} {
		for _, name := range *list {
			if _, twice := class[name]; twice {
				t.Errorf("%s is on two lists", name)
			}
			class[name] = c
		}
	}
	seen := map[string]bool{}
	flags := map[string][]string{}
	for _, l := range f.reg.List(command.Context{}, true) {
		seen[l.Name] = true
		c, _ := f.reg.Get(l.Name)
		for _, a := range c.Args {
			if a.PageAsks {
				flags[l.Name] = append(flags[l.Name], a.Name)
			}
		}
		want, listed := class[l.Name]
		switch {
		case c.ReadOnly:
			if listed {
				t.Errorf("%s is read-only and on a page list", l.Name)
			}
		case !listed:
			t.Errorf("%s has no page class: add it to pageRuns, pageDrives or pageState", l.Name)
		case c.Page != want:
			t.Errorf("%s: Page = %d, the list says %d", l.Name, c.Page, want)
		}
	}
	for name := range class {
		if !seen[name] {
			t.Errorf("%s is listed and not registered", name)
		}
	}
	for name, want := range pageAskFlags {
		if !slices.Equal(flags[name], want) {
			t.Errorf("%s: flags that ask a page = %v, want %v", name, flags[name], want)
		}
	}
	for name := range flags {
		if _, ok := pageAskFlags[name]; !ok {
			t.Errorf("%s has flags that ask a page: add it to pageAskFlags", name)
		}
	}
}
