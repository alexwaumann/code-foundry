package command_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/all"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/version"
)

type fixture struct {
	reg     *command.Registry
	emit    *commandtest.Emitter
	term    *commandtest.Terminal
	project *commandtest.Project
}

func newFixture(t *testing.T) fixture {
	t.Helper()
	f := fixture{
		reg:     command.NewRegistry(),
		emit:    &commandtest.Emitter{Delivered: 3, OpenWindows: 2},
		term:    &commandtest.Terminal{Terminals: []*v1.Terminal{{Id: "t9"}}},
		project: &commandtest.Project{},
	}
	start := time.Unix(1000, 0)
	err := all.Register(f.reg, all.Deps{
		Daemon: command.DaemonInfo{
			PID: 42, Version: version.Info{Version: "1.2.3", Commit: "abc", GoVersion: "go1.26"},
			Started: start, Home: "/h", Socket: "/h/daemon.sock",
			Now: func() time.Time { return start.Add(90 * time.Second) },
		},
		Emitter:  f.emit,
		Terminal: f.term,
		Project:  f.project,
		// "plain" (at /plain) is a project without git.
		NotGit: func(c command.Context) bool { return c.ActiveProjectID == "plain" || c.ActiveWorktreePath == "/plain" },
	})
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func TestAllRegistersEveryDomain(t *testing.T) {
	f := newFixture(t)
	want := []string{
		"daemon.status", "daemon.version",
		"ui.palette.open", "ui.notify", "ui.focus.terminal", "ui.focus.project", "ui.presence",
		"terminal.new", "terminal.list", "terminal.close", "terminal.kill", "terminal.remove",
		"project.list", "project.unregister", "project.worktree.new", "project.worktree.remove", "project.worktree.cleanup", "project.refresh", "project.git.init",
		"project.branch.delete",
		"project.add", "project.add-workspace", "project.clone", "project.create", "project.github.publish", "project.delete",
		"thread.new", "thread.list", "thread.reports", "thread.focus",
		"thread.rename", "thread.fork", "thread.remove", "thread.run-in", "thread.checkouts", "thread.prompts", "thread.pin", "thread.archive", "thread.snooze",
		"thread.get", "thread.label", "thread.report", "thread.budget", "thread.flags", "thread.flag.clear", "thread.restart", "thread.sidebar", "thread.new-like", "thread.workspace",
		"thread.send", "thread.respond", "thread.interrupt", "thread.items", "thread.read", "thread.set-model", "thread.set-mode", "thread.set-effort", "thread.wait", "thread.reseed",
		"thread.subscribe", "thread.unsubscribe", "thread.subscriptions",
		"thread.mcp", "thread.mcp-reconnect", "view.panel.mcp", "thread.commands", "thread.agents", "view.panel.agents", "thread.agent.open", "thread.agent.up",
		"git.fetch", "git.pull", "git.push", "pr.create", "pr.open",
		"pr.revert", "pr.merge", "pr.review.request", "pr.refresh", "pr.review", "pr.comment", "pr.ask", "pr.explain", "pr.fix.findings",
		"worktree.open.editor", "worktree.reveal", "view.open.url",
		"settings.get", "settings.set", "settings.reset", "settings.path", "settings.reveal",
		"view.settings", "view.help", "notifications.test", "theme.list", "theme.set-dark", "theme.set-light", "theme.pick", "theme.edit", "theme.show", "theme.save", "theme.duplicate", "theme.delete", "theme.ask", "theme.check", "theme.set-scheme", "theme.restore",
		"app.version", "app.update.check", "app.update", "app.relaunch", "app.restart", "daemon.restart",
		"view.dashboard", "view.usage", "usage.show", "view.pullrequests", "view.projects", "view.panel.toggle", "view.bottom.toggle", "view.panel.expand", "view.panel.new-tab", "view.panel.split", "view.back", "view.forward", "thread.previous", "thread.next", "view.panel.linked-prs", "view.panel.usage", "view.panel.threads", "view.panel.worktree",
		"view.panel.file", "view.panel.diff", "view.panel.pr", "view.inline",
		"workspace.new", "workspace.list", "workspace.add-project", "workspace.remove-project", "workspace.rename", "workspace.set-primary", "workspace.set-root", "workspace.remove", "workspace.reveal",
		"action.list", "action.add", "action.edit", "action.remove", "action.run", "action.wait", "action.stop", "action.runs",
		"plugin.list", "plugin.enable", "plugin.disable", "plugin.restart", "plugin.reload", "plugin.logs", "plugin.dev",
		"plugin.secrets.list", "plugin.secrets.delete", "plugin.env", "plugin.surface", "plugin.act", "pr.checks",
		"plugin.threads", "plugin.terminals", "plugin.wakes",
		"plugin.browse", "plugin.install", "plugin.update", "plugin.uninstall",
		"skill.browse", "skill.install", "skill.enable", "skill.disable", "skill.update", "skill.uninstall", "skill.remove", "skill.setup", "skill.refresh",
		"ember.status", "ember.board", "ember.remember", "ember.reseed", "ember.enable", "ember.disable", "ember.task.add", "ember.task.update", "ember.task.done", "ember.task.start", "ember.task.cancel", "ember.task.list", "ember.task.show",
		"memory.show", "memory.add", "memory.remove", "memory.clear",
		"daemon.capabilities",
	}
	for _, n := range want {
		if _, ok := f.reg.Get(n); !ok {
			t.Errorf("%s not registered", n)
		}
	}
	if got := len(f.reg.List(command.Context{}, true)); got != len(want) {
		t.Errorf("registered %d commands, want %d", got, len(want))
	}
	// Registering twice into one registry must fail rather than silently overwrite.
	if err := all.Register(f.reg, all.Deps{Emitter: f.emit}); !errors.Is(err, command.ErrDuplicate) {
		t.Errorf("second Register err = %v, want ErrDuplicate", err)
	}
	if err := all.Register(command.NewRegistry(), all.Deps{}); err == nil {
		t.Error("Register without an Emitter should fail")
	}
}

func TestAvailability(t *testing.T) {
	f := newFixture(t)
	tests := []struct {
		cmd  string
		ctx  command.Context
		want bool
	}{
		{"daemon.status", command.Context{}, true},
		{"ui.focus.terminal", command.Context{}, true},
		{"ui.notify", command.Context{}, true},
		{"usage.show", command.Context{}, true},
		{"usage.show", command.Context{ActiveView: "thread"}, false},
		{"view.usage", command.Context{ActiveView: "thread"}, true},
		{"terminal.new", command.Context{}, true}, // the CLI (no view): owner from --cwd
		{"terminal.new", command.Context{ActiveView: "dashboard"}, false},
		{"terminal.new", command.Context{ActiveView: "pullrequests"}, false},
		{"terminal.new", command.Context{ActiveThreadID: "s1"}, true},
		{"terminal.close", command.Context{}, false},
		{"terminal.close", command.Context{ActiveTerminalID: "t1"}, true},
		{"terminal.kill", command.Context{}, false},
		{"terminal.kill", command.Context{ActiveTerminalID: "t1"}, true},
		{"terminal.remove", command.Context{ActiveTerminalID: "t1"}, true},
		{"project.add", command.Context{}, true},
		{"project.unregister", command.Context{}, false},
		{"project.unregister", command.Context{ActiveProjectID: "r1"}, true},
		{"project.worktree.new", command.Context{}, false},
		{"project.worktree.new", command.Context{ActiveProjectID: "r1"}, true},
		{"project.worktree.remove", command.Context{ActiveProjectID: "r1"}, false},
		{"project.worktree.remove", command.Context{ActiveProjectID: "r1", ActiveWorktreePath: "/wt"}, true},
		{"project.worktree.remove", command.Context{ActiveWorktreePath: "/wt"}, true}, // the path names the project
		{"project.refresh", command.Context{}, true},
		// A project without git: its one checkout, no worktrees, Initialize Git.
		{"project.worktree.new", command.Context{ActiveProjectID: "plain"}, false},
		{"project.worktree.remove", command.Context{ActiveProjectID: "plain", ActiveWorktreePath: "/plain"}, false},
		{"project.git.init", command.Context{}, false},
		{"project.git.init", command.Context{ActiveProjectID: "r1"}, false},
		{"project.git.init", command.Context{ActiveProjectID: "plain"}, true},
		{"project.git.init", command.Context{ActiveProjectID: "plain", ActiveWorktreePath: "/plain"}, true},
		{"project.unregister", command.Context{ActiveProjectID: "plain"}, true},
		{"project.refresh", command.Context{ActiveProjectID: "plain"}, true},
		{"git.fetch", command.Context{ActiveProjectID: "plain", ActiveWorktreePath: "/plain"}, false},
		{"git.push", command.Context{ActiveProjectID: "plain", ActiveWorktreePath: "/plain"}, false},
		{"pr.create", command.Context{ActiveProjectID: "plain", ActiveWorktreePath: "/plain"}, false},
		{"worktree.reveal", command.Context{ActiveProjectID: "plain", ActiveWorktreePath: "/plain"}, true},
		{"worktree.open.editor", command.Context{ActiveProjectID: "plain", ActiveWorktreePath: "/plain"}, true},
		{"thread.new", command.Context{ActiveProjectID: "plain", ActiveWorktreePath: "/plain"}, true},
		// The composer may target no project at all (thread.new --no-project).
		{"thread.new", command.Context{ActiveView: "compose"}, true},
		{"thread.new", command.Context{ActiveView: "prs"}, false},
		{"terminal.new", command.Context{ActiveProjectID: "plain", ActiveWorktreePath: "/plain"}, true},
	}
	for _, tt := range tests {
		c, _ := f.reg.Get(tt.cmd)
		if got := c.Available(tt.ctx); got != tt.want {
			t.Errorf("%s available in %+v = %v, want %v", tt.cmd, tt.ctx, got, tt.want)
		}
	}
}

func TestBuiltinCommands(t *testing.T) {
	t.Setenv("HOME", "/Users/me")
	t.Setenv("SHELL", "/bin/fish")
	notFound := connect.NewError(connect.CodeNotFound, errors.New("no such terminal"))
	tests := []struct {
		name      string
		cmd       string
		ctx       command.Context
		args      map[string]string
		backendEr error
		wantErr   error
		wantCode  connect.Code
		wantMsg   string
		wantJSON  string        // substring of EncodeJSON
		wantReq   proto.Message // last backend request or emitted intent
	}{
		{name: "daemon.status", cmd: "daemon.status",
			wantMsg:  "daemon pid 42, version 1.2.3, up 1m30s, home /h",
			wantJSON: `"uptime_seconds":90`},
		{name: "daemon.version", cmd: "daemon.version",
			wantMsg: "code-foundry 1.2.3 (abc) go1.26", wantJSON: `"go_version":"go1.26","source_url":"https://github.com/alexwaumann/code-foundry"}`},
		{name: "ui.notify", cmd: "ui.notify", args: map[string]string{"title": "hi", "body": "there", "level": "warning"},
			wantMsg: "windows=2", wantJSON: `{"windows":2,"receivers":3}`,
			wantReq: &v1.UiIntent{Intent: &v1.UiIntent_Notify_{Notify: &v1.UiIntent_Notify{
				Level: v1.UiIntent_Notify_LEVEL_WARNING, Title: "hi", Body: "there"}}}},
		{name: "ui.notify default level", cmd: "ui.notify", args: map[string]string{"title": "hi"}, wantMsg: "windows=2",
			wantReq: &v1.UiIntent{Intent: &v1.UiIntent_Notify_{Notify: &v1.UiIntent_Notify{
				Level: v1.UiIntent_Notify_LEVEL_INFO, Title: "hi"}}}},
		{name: "ui.notify missing title", cmd: "ui.notify", wantErr: command.ErrInvalidArgs},
		{name: "ui.palette.open", cmd: "ui.palette.open", args: map[string]string{"query": "term"}, wantMsg: "windows=2",
			wantReq: &v1.UiIntent{Intent: &v1.UiIntent_OpenPalette_{OpenPalette: &v1.UiIntent_OpenPalette{Query: "term"}}}},
		{name: "ui.focus.terminal from context", cmd: "ui.focus.terminal", ctx: command.Context{ActiveTerminalID: "t9"},
			wantReq: &v1.UiIntent{Intent: &v1.UiIntent_FocusTerminal_{FocusTerminal: &v1.UiIntent_FocusTerminal{TerminalId: "t9"}}}},
		{name: "ui.focus.terminal needs an id", cmd: "ui.focus.terminal", wantErr: command.ErrInvalidArgs},
		// A short id passes resolution through; it is not delivered as if it named one.
		{name: "ui.focus.terminal of no terminal", cmd: "ui.focus.terminal", args: map[string]string{"id": "x"}, wantCode: connect.CodeNotFound},
		{name: "ui.focus.project", cmd: "ui.focus.project", args: map[string]string{"project": "r1", "worktree": "~/wt"},
			wantReq: &v1.UiIntent{Intent: &v1.UiIntent_FocusProject_{FocusProject: &v1.UiIntent_FocusProject{ProjectId: "r1", WorktreePath: "/Users/me/wt"}}}},
		// terminal.new's owners and defaults: commands_terminal_test.go.
		{name: "terminal.new relative cwd", cmd: "terminal.new", args: map[string]string{"cwd": "rel"}, wantErr: command.ErrInvalidArgs},
		{name: "terminal.kill", cmd: "terminal.kill", args: map[string]string{"id": "t3"}, wantMsg: "killed terminal t3",
			wantReq: &v1.KillTerminalRequest{Id: "t3"}},
		{name: "terminal.kill backend error passes through", cmd: "terminal.kill", args: map[string]string{"id": "t3"},
			backendEr: notFound, wantErr: notFound},
		{name: "terminal.remove from context", cmd: "terminal.remove", ctx: command.Context{ActiveTerminalID: "t4"},
			wantMsg: "removed terminal t4", wantReq: &v1.RemoveTerminalRequest{Id: "t4"}},
		{name: "project.add with a folder registers it", cmd: "project.add", args: map[string]string{"path": "~/src/app"},
			wantMsg: "registered repo (r1)", wantJSON: `"path":"/Users/me/src/app"`,
			wantReq: &v1.RegisterProjectRequest{Path: "/Users/me/src/app"}},
		{name: "project.add without a folder prints the hint", cmd: "project.add", wantMsg: command.AddProjectHint},
		{name: "project.list without projects", cmd: "project.list", wantMsg: "no projects", wantReq: &v1.ListProjectsRequest{}},
		{name: "project.unregister without a project", cmd: "project.unregister", wantErr: command.ErrInvalidArgs},
		{name: "project.worktree.new with explicit project", cmd: "project.worktree.new", args: map[string]string{"project": "r2", "branch": "feat", "base": "main"},
			wantMsg: "created worktree /wt/feat on feat",
			wantReq: &v1.CreateWorktreeRequest{ProjectId: "r2", Branch: "feat", BaseRef: "main", Fetch: true}},
		{name: "project.worktree.new from context", cmd: "project.worktree.new", ctx: command.Context{ActiveProjectID: "r1"}, args: map[string]string{"branch": "x"},
			wantReq: &v1.CreateWorktreeRequest{ProjectId: "r1", Branch: "x", Fetch: true}},
		{name: "project.worktree.new without fetch", cmd: "project.worktree.new", ctx: command.Context{ActiveProjectID: "r1"},
			args:    map[string]string{"branch": "x", "base": "origin/dev", "fetch": "false"},
			wantReq: &v1.CreateWorktreeRequest{ProjectId: "r1", Branch: "x", BaseRef: "origin/dev"}},
		{name: "project.worktree.new from a local branch", cmd: "project.worktree.new", ctx: command.Context{ActiveProjectID: "r1"},
			args:    map[string]string{"branch": "x", "base": "feat/lead", "base-from-origin": "no"},
			wantReq: &v1.CreateWorktreeRequest{ProjectId: "r1", Branch: "x", BaseRef: "feat/lead", Fetch: true, BaseFromOrigin: new(false)}},
		{name: "project.worktree.new from origin's copy", cmd: "project.worktree.new", ctx: command.Context{ActiveProjectID: "r1"},
			args:    map[string]string{"branch": "x", "base": "main", "base-from-origin": "yes"},
			wantReq: &v1.CreateWorktreeRequest{ProjectId: "r1", Branch: "x", BaseRef: "main", Fetch: true, BaseFromOrigin: new(true)}},
		{name: "project.worktree.new base-from-origin takes yes or no", cmd: "project.worktree.new", ctx: command.Context{ActiveProjectID: "r1"},
			args: map[string]string{"branch": "x", "base-from-origin": "off"}, wantErr: command.ErrInvalidArgs},
		{name: "project.worktree.new needs a branch", cmd: "project.worktree.new", ctx: command.Context{ActiveProjectID: "r1"}, wantErr: command.ErrInvalidArgs},
		{name: "project.worktree.new without a project", cmd: "project.worktree.new", args: map[string]string{"branch": "x"}, wantErr: command.ErrInvalidArgs},
		{name: "project.worktree.remove", cmd: "project.worktree.remove", ctx: command.Context{ActiveProjectID: "r1", ActiveWorktreePath: "/wt/x"},
			args: map[string]string{"force": "true"}, wantMsg: "removed worktree /wt/x",
			wantReq: &v1.RemoveWorktreeRequest{ProjectId: "r1", Path: "/wt/x", Force: true}},
		{name: "project.refresh all", cmd: "project.refresh", wantMsg: "refreshed all projects", wantReq: &v1.RefreshProjectRequest{}},
		{name: "project.refresh active", cmd: "project.refresh", ctx: command.Context{ActiveProjectID: "r1"}, wantMsg: "refreshed r1",
			wantReq: &v1.RefreshProjectRequest{Id: "r1"}},
		{name: "project.git.init from context", cmd: "project.git.init", ctx: command.Context{ActiveProjectID: "plain"},
			wantMsg: "initialized git in notes on main", wantJSON: `"git":true`, wantReq: &v1.InitGitRequest{Id: "plain"}},
		{name: "project.git.init with an explicit project", cmd: "project.git.init", args: map[string]string{"project": "plain"},
			wantReq: &v1.InitGitRequest{Id: "plain"}},
		{name: "project.git.init in a git project", cmd: "project.git.init", ctx: command.Context{ActiveProjectID: "r1"}, wantErr: command.ErrUnavailable},
		{name: "project.worktree.new in a project without git", cmd: "project.worktree.new", ctx: command.Context{ActiveProjectID: "plain"},
			args: map[string]string{"branch": "x"}, wantErr: command.ErrUnavailable},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture(t)
			f.term.Err, f.project.Err = tt.backendEr, tt.backendEr
			res, err := f.reg.Invoke(context.Background(), tt.ctx, tt.cmd, tt.args, command.Confirmed(true))
			if tt.wantCode != 0 {
				if connect.CodeOf(err) != tt.wantCode {
					t.Fatalf("err = %v, want code %v", err, tt.wantCode)
				}
				return
			}
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if err != nil {
				return
			}
			if tt.wantMsg != "" && res.Message != tt.wantMsg {
				t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
			}
			js, err := res.EncodeJSON()
			if err != nil || !strings.Contains(js, tt.wantJSON) {
				t.Errorf("json = %s (err %v), want containing %s", js, err, tt.wantJSON)
			}
			if tt.wantReq != nil {
				var last proto.Message
				if strings.HasPrefix(tt.cmd, "ui.") {
					if in := f.emit.Intents(); len(in) > 0 {
						last = in[len(in)-1]
					}
				} else {
					reqs := append(f.term.Requests(), f.project.Requests()...)
					if len(reqs) > 0 {
						last = reqs[len(reqs)-1]
					}
				}
				if !proto.Equal(last, tt.wantReq) {
					t.Errorf("request = %v, want %v", last, tt.wantReq)
				}
			}
		})
	}
}

func TestBusEmitter(t *testing.T) {
	b := bus.New()
	e := command.BusEmitter{Bus: b}
	intent := &v1.UiIntent{Intent: &v1.UiIntent_OpenPalette_{OpenPalette: &v1.UiIntent_OpenPalette{}}}
	if n := e.Emit(intent); n != 0 {
		t.Fatalf("delivered %d with no watchers", n)
	}
	sub := bus.Subscribe[command.IntentEvent](b, 1)
	defer sub.Close()
	if n := e.Emit(intent); n != 1 {
		t.Fatalf("delivered %d, want 1", n)
	}
	if got := <-sub.C(); got.Intent != intent {
		t.Fatal("watcher got a different intent")
	}
	// A bus subscription is no window: windows come from CountWindows (none without it).
	if n := e.Windows(); n != 0 {
		t.Errorf("windows = %d without CountWindows, want 0", n)
	}
	if n := (command.BusEmitter{Bus: b, CountWindows: func() int { return 3 }}).Windows(); n != 3 {
		t.Errorf("windows = %d, want 3", n)
	}
}

func TestEncodeJSON(t *testing.T) {
	tests := []struct {
		name string
		in   any
		want string
	}{
		{"nil", nil, ""},
		{"struct", command.EmitResult{Windows: 1, Receivers: 2}, `{"windows":1,"receivers":2}`},
		{"proto uses protojson names", &v1.Terminal{Id: "t1", ExitCode: 3}, `{"id":"t1","exitCode":3}`},
	}
	for _, tt := range tests {
		got, err := command.Result{JSON: tt.in}.EncodeJSON()
		if err != nil || strings.ReplaceAll(got, " ", "") != tt.want {
			t.Errorf("%s: got %s, %v; want %s", tt.name, got, err, tt.want)
		}
	}
}
