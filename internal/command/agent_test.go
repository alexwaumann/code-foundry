package command_test

import (
	"context"
	"slices"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// agentSafe is every verb that changes something and that a thread's agent in auto mode
// runs without the user being asked (Command.AgentSafe), beside the read-only ones.
// Adding a verb here is a decision: it must not have Confirm, define what gets run, change
// configuration, fetch or run third-party code, write outside this machine, or widen what
// any thread may do. docs/notes/auto-approve-verbs.md has the reasons, and the verbs that
// were close and still ask.
var agentSafe = []string{
	"action.run", "action.stop",
	"composer.stage",
	"ember.task.add", "ember.task.cancel", "ember.task.done", "ember.task.start", "ember.task.update",
	"file.find",
	"git.fetch",
	"pr.open", "pr.refresh",
	"project.refresh", "project.worktree.new",
	"search.open",
	"settings.reveal",
	"terminal.new",
	"thread.agent.open", "thread.agent.up", "thread.find", "thread.find.next", "thread.find.previous", "thread.focus",
	"thread.fork", "thread.interrupt", "thread.label", "thread.mcp", "thread.new", "thread.new-like", "thread.next",
	"thread.pin", "thread.pr.link", "thread.previous", "thread.regenerate-name", "thread.rename", "thread.report",
	"thread.send", "thread.shell.stop", "thread.subscribe", "thread.unsubscribe",
	"ui.focus.project", "ui.focus.terminal", "ui.notify", "ui.palette.open",
	"view.back", "view.bottom.toggle", "view.forward", "view.help", "view.inline", "view.panel.diff", "view.panel.expand",
	"view.panel.file", "view.panel.mcp", "view.panel.new-tab", "view.panel.page", "view.panel.pr", "view.panel.split",
	"view.panel.toggle", "view.projects", "view.pullrequests", "view.settings", "view.thread-info", "view.usage",
	"workspace.reveal", "worktree.reveal",
}

// agentAsks are the flags that make an otherwise approved verb ask, with the values that
// still do not (ArgSpec.AgentOK).
var agentAsks = map[string][]string{
	"terminal.new --argv":          nil,
	"terminal.new --run":           nil,
	"thread.new --no-project":      nil,
	"thread.new --permission":      {"supervised", "auto"},
	"thread.new-like --permission": {"supervised", "auto"},
}

// Every verb is classified on purpose: the approved ones are exactly the lists here and
// in readonly_test.go, so marking a verb, or registering a new one, fails here.
func TestAgentSafeCommandsAreTheList(t *testing.T) {
	f := newFixture(t)
	var got []string
	asks := map[string][]string{}
	for _, l := range f.reg.List(command.Context{}, true) {
		if l.AgentSafe {
			got = append(got, l.Name)
		}
		for _, a := range l.Args {
			if a.AgentAsk {
				asks[l.Name+" --"+a.Name] = a.AgentOK
			}
		}
	}
	slices.Sort(got)
	if want := slices.Sorted(slices.Values(agentSafe)); !slices.Equal(got, want) {
		t.Errorf("agent-safe commands:\n got  %v\n want %v", got, want)
	}
	for k, want := range agentAsks {
		if v, ok := asks[k]; !ok || !slices.Equal(v, want) {
			t.Errorf("%s: AgentOK %v (set: %v), want %v", k, v, ok, want)
		}
	}
	for k := range asks {
		if _, ok := agentAsks[k]; !ok {
			t.Errorf("%s is AgentAsk but not in the list", k)
		}
	}
}

// Whatever is marked, these ask.
func TestAgentApprovedNeverCovers(t *testing.T) {
	f := newFixture(t)
	mustAsk := []string{
		"action.add", "action.edit", "action.remove",
		"app.relaunch", "app.update", "app.update.check",
		"dictation.download", "dictation.start", "dictation.toggle",
		"ember.disable", "ember.enable", "ember.remember", "ember.reseed",
		"git.pull", "git.push",
		"memory.add", "memory.remove",
		"notifications.test",
		"plugin.browse", "plugin.disable", "plugin.reload", "plugin.restart", "plugin.surface", "plugin.update",
		"pr.ask", "pr.comment", "pr.create", "pr.draft", "pr.explain", "pr.fix.findings", "pr.ready", "pr.review",
		"pr.review.request", "pr.task",
		"project.add", "project.add-workspace", "project.clone", "project.create", "project.git.init",
		"project.github.publish", "project.rename",
		"search.agent", "search.report",
		"settings.reset", "settings.set",
		"skill.browse", "skill.enable", "skill.install", "skill.refresh", "skill.setup", "skill.update",
		"terminal.close", "terminal.remove",
		"theme.ask", "theme.duplicate", "theme.reset", "theme.restore", "theme.save", "theme.set-dark",
		"theme.set-light", "theme.set-scheme",
		"thread.budget", "thread.flag.clear", "thread.mcp-reconnect", "thread.move", "thread.project.add", "thread.reseed",
		"thread.respond", "thread.run-in", "thread.set-effort", "thread.set-mode", "thread.set-model", "thread.workspace",
		"view.open.url",
		"workspace.add-project", "workspace.new", "workspace.open.editor", "workspace.rename", "workspace.set-primary",
		"workspace.set-root",
		"worktree.open.editor",
	}
	for _, name := range mustAsk {
		c, ok := f.reg.Get(name)
		if !ok {
			t.Errorf("%s not registered", name)
			continue
		}
		if c.AgentApproved() {
			t.Errorf("%s is approved for agents", name)
		}
	}
	for _, l := range f.reg.List(command.Context{}, true) {
		if l.Confirm != "" && l.AgentApproved() {
			t.Errorf("%s has Confirm and is approved for agents", l.Name)
		}
	}
}

// The protocol verbs are answered in every mode, so each must be approved.
func TestProtocolVerbsAreApproved(t *testing.T) {
	f := newFixture(t)
	for _, v := range thread.ProtocolVerbs {
		c, ok := f.reg.Get(v)
		if !ok || !c.AgentApproved() {
			t.Errorf("%s: registered %v, approved %v", v, ok, c.AgentApproved())
		}
	}
}

func TestApprovedVerb(t *testing.T) {
	f := newFixture(t)
	const cli = "/Users/me/.code-foundry/app/code-foundry"
	tests := []struct {
		line string
		want string // "": asks
	}{
		// Approved, each by the verb the CLI resolves it to.
		{"code-foundry thread list", "thread.list"},
		{"code-foundry thread.list", "thread.list"},
		{"  code-foundry   thread   list  ", "thread.list"},
		{"code-foundry thread list --json", "thread.list"},
		{"code-foundry thread list --status busy --limit 3", "thread.list"},
		{"code-foundry thread new --help", "thread.new"},
		{"code-foundry project list", "project.list"},
		{"code-foundry plugin secrets list x", "plugin.secrets.list"},
		{"code-foundry action run build", "action.run"},
		{"code-foundry action run build --wait", "action.run"},
		{"code-foundry action run 'build and test' --here /tmp/x", "action.run"},
		{`code-foundry action run "build and test"`, "action.run"},
		{"code-foundry action.run build", "action.run"},
		{"code-foundry usage", "usage.show"}, // no such command: domain.show
		{"code-foundry thread send --id s-1 'do this; then $(that)'", "thread.send"},
		{"code-foundry thread send --id s-1 --text=hello", "thread.send"},
		{"code-foundry thread send --id s-1 'one\ntwo'", "thread.send"},
		{"code-foundry thread wait s-1 --for 30s", "thread.wait"},
		{"code-foundry thread report done 'all fine'", "thread.report"},
		{"code-foundry thread new --project r1 --new-worktree --prompt 'fix it'", "thread.new"},
		{"code-foundry thread new --permission auto --prompt hi", "thread.new"},
		{"code-foundry thread new --permission=supervised --prompt hi", "thread.new"},
		{"code-foundry thread new-like --permission supervised", "thread.new-like"},
		{"code-foundry thread fork --id s-1", "thread.fork"},
		{"code-foundry terminal new", "terminal.new"},
		{"code-foundry terminal new --cwd /tmp/x", "terminal.new"},
		{"code-foundry view panel file /tmp/x --line 3", "view.panel.file"},
		{"code-foundry ui notify --title hi", "ui.notify"},
		{cli + " thread list", "thread.list"},
		// Local verbs.
		{"code-foundry guide", "guide"},
		{"code-foundry guide action", "guide"},
		{"code-foundry help thread new", "help"},
		{"code-foundry commands", "commands"},
		{"code-foundry version", "version"},
		{"code-foundry status", "status"},
		{"code-foundry events --source thread --json", "events"},
		{"code-foundry daemon status", "daemon.status"}, // a word after it: a registry verb

		// Another executable, or not the CLI as such.
		{"", ""},
		{"code-foundry", ""},
		{"ls", ""},
		{"rm -rf ~", ""},
		{"sh -c 'code-foundry thread list'", ""},
		{"bash -c 'code-foundry thread list'", ""},
		{"env code-foundry thread list", ""},
		{"exec code-foundry thread list", ""},
		{"command code-foundry thread list", ""},
		{"nohup code-foundry thread list", ""},
		{"time code-foundry thread list", ""},
		{"xargs code-foundry thread list", ""},
		{"echo code-foundry thread list", ""},
		{"FOO=bar code-foundry thread list", ""},
		{"PATH=/tmp code-foundry thread list", ""},
		{"./code-foundry thread list", ""},
		{"bin/code-foundry thread list", ""},
		{"/tmp/code-foundry thread list", ""},
		{"/usr/local/bin/code-foundry thread list", ""},
		{"code-foundry2 thread list", ""},
		{"CODE-FOUNDRY thread list", ""},
		{"'code-foundry' thread list", ""},
		{"code-'foundry' thread list", ""},
		{`"code-foundry" thread list`, ""},
		{"'" + cli + "' thread list", ""},
		// Anything but one simple command.
		{"code-foundry thread list; rm -rf ~", ""},
		{"code-foundry thread list;rm -rf ~", ""},
		{"code-foundry thread list && x", ""},
		{"code-foundry thread list || x", ""},
		{"code-foundry thread list | x", ""},
		{"code-foundry thread list & x", ""},
		{"code-foundry thread list &", ""},
		{"code-foundry thread list > /tmp/x", ""},
		{"code-foundry thread list 2>&1", ""},
		{"code-foundry thread list < /tmp/x", ""},
		{"code-foundry thread list $(x)", ""},
		{"code-foundry thread list `x`", ""},
		{"code-foundry thread list $HOME", ""},
		{"code-foundry thread list # --yes", ""},
		{"code-foundry thread list *", ""},
		{"code-foundry thread list ~/x", ""},
		{"code-foundry thread list {a,b}", ""},
		{"(code-foundry thread list)", ""},
		{"{ code-foundry thread list; }", ""},
		{"code-foundry action run x\nrm y", ""},
		{"code-foundry action run x\n", ""},
		{"code-foundry action run x\r\nrm y", ""},
		{"code-foundry action run x \\\nrm y", ""},
		{`code-foundry action run "$(x)"`, ""},
		{`code-foundry action run "a; b"`, ""},
		{`code-foundry action run "a`, ""},
		{"code-foundry action run 'a", ""},
		{`code-foundry action run a\ b`, ""},
		{"code-foundry action run $'a'", ""},
		{"code-foundry action run a\x00b", ""},
		{"code-foundry action run <<EOF\nx\nEOF", ""},
		// Verb words spelled with quotes: not how a verb is written.
		{"code-foundry 'thread' list", ""},
		{"code-foundry thread 'list'", ""},
		{`code-foundry "thread" list`, ""},
		{"code-foundry thr'ead' list", ""},
		{"code-foundry 'thread list'", ""},
		{"code-foundry 'guide'", ""},
		{"code-foundry '' thread list", ""},
		// Unknown verbs, and flags where a verb goes.
		{"code-foundry nope", ""},
		{"code-foundry thread", ""},
		{"code-foundry thread nope", ""},
		{"code-foundry --version", ""},
		{"code-foundry -v", ""},
		{"code-foundry --help", ""},
		{"code-foundry -h thread list", ""},
		{"code-foundry --update", ""},
		{"code-foundry --context-thread s-1 thread list", ""},
		{"code-foundry thread --json list", ""},
		// Local verbs that do something.
		{"code-foundry daemon", ""},
		{"code-foundry daemon --dev", ""},
		{"code-foundry daemon --json thread.list", ""},
		{"code-foundry gui", ""},
		{"code-foundry update", ""},
		{"code-foundry update --force", ""},
		{"code-foundry update --version v1", ""},
		// Verbs that ask.
		{"code-foundry action add x --command y", ""},
		{"code-foundry action edit x --command y", ""},
		{"code-foundry action remove x", ""},
		{"code-foundry settings set a b", ""},
		{"code-foundry thread respond allow --id s-1 --request r", ""},
		{"code-foundry thread set-mode auto", ""},
		{"code-foundry plugin install x", ""},
		{"code-foundry skill install x", ""},
		{"code-foundry plugin secrets delete x y", ""},
		{"code-foundry git push", ""},
		{"code-foundry pr merge a/b 1", ""},
		{"code-foundry thread remove s-1", ""},
		{"code-foundry thread archive s-1", ""},
		{"code-foundry view open url --url http://x", ""},
		// --yes on anything, however it is written.
		{"code-foundry thread list --yes", ""},
		{"code-foundry thread list -yes", ""},
		{"code-foundry thread list --yes=true", ""},
		{"code-foundry thread list '--yes'", ""},
		{"code-foundry thread list --y'es'", ""},
		{"code-foundry thread list -- --yes", ""},
		{"code-foundry guide --yes", ""},
		{"code-foundry help --yes", ""},
		// Forms that widen an approved verb.
		{"code-foundry terminal new --argv 'rm -rf ~'", ""},
		{"code-foundry terminal new --argv='rm -rf ~'", ""},
		{"code-foundry terminal new -argv x", ""},
		{"code-foundry terminal new --cwd /tmp --run 'rm -rf ~'", ""},
		{"code-foundry terminal new '--run=rm -rf ~'", ""},
		{"code-foundry thread new --permission accept-edits", ""},
		{"code-foundry thread new --permission=accept-edits", ""},
		{"code-foundry thread new --permission bypass", ""},
		{"code-foundry thread new --permission", ""},
		{"code-foundry thread new --permission --no-project", ""},
		{"code-foundry thread new --name --permission accept-edits", ""},
		{"code-foundry thread new --no-project --prompt hi", ""},
		{"code-foundry thread new --no-project=true", ""},
		{"code-foundry thread new-like --permission accept-edits", ""},
		// The CLI reads a file or stdin into the value.
		{"code-foundry thread send --id s-1 --text @/etc/passwd", ""},
		{"code-foundry thread send --id s-1 --text=@/etc/passwd", ""},
		{"code-foundry thread send --id s-1 @/etc/passwd", ""},
		{"code-foundry thread send --id s-1 '@/etc/passwd'", ""},
		{"code-foundry thread send --id s-1 --text -", ""},
		{"code-foundry thread send --id s-1 --text=-", ""},
		{"code-foundry thread report done x --data @y", ""},
		// A flag the verb does not have, and the context flags.
		{"code-foundry thread list --nope", ""},
		{"code-foundry thread list --context-thread s-1", ""},
		{"code-foundry action run x --context-worktree /tmp", ""},
		{"code-foundry thread list -- -x", ""},
		{"code-foundry thread budget --usd -1", ""},
	}
	for _, tc := range tests {
		t.Run(tc.line, func(t *testing.T) {
			if got := f.reg.ApprovedVerb(tc.line, cli); got != tc.want {
				t.Errorf("ApprovedVerb(%q) = %q, want %q", tc.line, got, tc.want)
			}
		})
	}
	t.Run("a relative cli path is no path", func(t *testing.T) {
		if got := f.reg.ApprovedVerb("bin/code-foundry thread list", "bin/code-foundry"); got != "" {
			t.Errorf("approved %q", got)
		}
	})
	t.Run("no cli path", func(t *testing.T) {
		if got := f.reg.ApprovedVerb(" thread list", ""); got != "" {
			t.Errorf("approved %q", got)
		}
	})
}

// A registry with no verbs yet (a thread can start before the daemon registers them)
// approves nothing.
func TestApprovedVerbEmptyRegistry(t *testing.T) {
	if got := command.NewRegistry().ApprovedVerb("code-foundry thread list", ""); got != "" {
		t.Errorf("approved %q", got)
	}
}

// The longest prefix wins, as in the CLI: a verb under an approved one is its own verb.
func TestApprovedVerbLongestPrefix(t *testing.T) {
	reg := command.NewRegistry()
	run := func(name string, safe bool) command.Command {
		return command.Command{Name: name, Title: name, Category: "T", AgentSafe: safe, Run: noRun}
	}
	if err := reg.RegisterAll(run("a.run", true), run("a.run.all", false)); err != nil {
		t.Fatal(err)
	}
	if got := reg.ApprovedVerb("code-foundry a run x", ""); got != "a.run" {
		t.Errorf("a run x = %q", got)
	}
	if got := reg.ApprovedVerb("code-foundry a run all", ""); got != "" {
		t.Errorf("a run all = %q", got)
	}
}

func TestAgentMarkersValidate(t *testing.T) {
	ask := command.ArgSpec{Name: "x", Type: command.String, AgentAsk: true}
	tests := []struct {
		name string
		mod  func(*command.Command)
		want string
	}{
		{"confirm", func(c *command.Command) { c.AgentSafe, c.Confirm = true, "sure?" }, "AgentSafe"},
		{"read-only", func(c *command.Command) { c.AgentSafe, c.ReadOnly = true, true }, "AgentSafe"},
		{"positional", func(c *command.Command) {
			a := ask
			a.Positional = true
			c.AgentSafe, c.Args = true, []command.ArgSpec{a}
		}, "AgentAsk"},
		{"on a verb that asks", func(c *command.Command) { c.Args = []command.ArgSpec{ask} }, "AgentAsk"},
		{"values alone", func(c *command.Command) {
			c.AgentSafe, c.Args = true, []command.ArgSpec{{Name: "x", Type: command.String, AgentOK: []string{"a"}}}
		}, "AgentOK"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c := command.Command{Name: "a.b", Title: "A", Category: "T", Run: noRun}
			tc.mod(&c)
			err := command.NewRegistry().Register(c)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Errorf("Register: %v, want an error about %s", err, tc.want)
			}
		})
	}
}

// Whatever it is given, the matcher returns, and it never approves past the tokenizer.
func FuzzApprovedVerb(f *testing.F) {
	reg := newFuzzRegistry(f)
	for _, s := range []string{"code-foundry thread list", "code-foundry a.b --x=1 'y'", "code-foundry --", "code-foundry - -", "code-foundry a b --=", "code-foundry = ="} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, line string) {
		if v := reg.ApprovedVerb(line, "/x/code-foundry"); v != "" && strings.ContainsAny(line, "\x00") {
			t.Fatalf("approved %q for %q", v, line)
		}
	})
}

func noRun(context.Context, command.Context, command.Args) (command.Result, error) {
	return command.Result{}, nil
}

func newFuzzRegistry(f *testing.F) *command.Registry {
	f.Helper()
	reg := command.NewRegistry()
	err := reg.RegisterAll(
		command.Command{Name: "a.b", Title: "A", Category: "T", AgentSafe: true, Run: noRun,
			Args: []command.ArgSpec{{Name: "x", Type: command.String, AgentAsk: true, AgentOK: []string{"1"}}}},
		command.Command{Name: "thread.list", Title: "L", Category: "T", ReadOnly: true, Run: noRun},
	)
	if err != nil {
		f.Fatal(err)
	}
	return reg
}
