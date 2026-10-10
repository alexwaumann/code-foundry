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
	reg  *command.Registry
	emit *commandtest.Emitter
	term *commandtest.Terminal
	repo *commandtest.Repo
}

func newFixture(t *testing.T) fixture {
	t.Helper()
	f := fixture{
		reg:  command.NewRegistry(),
		emit: &commandtest.Emitter{Delivered: 2},
		term: &commandtest.Terminal{},
		repo: &commandtest.Repo{},
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
		Repo:     f.repo,
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
		"ui.palette.open", "ui.notify", "ui.focus.terminal", "ui.focus.repo",
		"terminal.new", "terminal.kill", "terminal.remove",
		"repo.register", "repo.unregister", "repo.worktree.new", "repo.worktree.remove", "repo.refresh",
		"session.new", "session.list", "session.focus", "session.close", "session.reconnect",
		"session.rename", "session.fork", "session.remove", "session.run-in", "session.pin",
		"git.fetch", "git.pull", "git.push", "pr.create", "pr.open",
		"pr.revert", "pr.merge", "pr.review.request", "pr.refresh", "pr.ask", "pr.explain", "pr.fix.findings",
		"worktree.open.editor", "worktree.reveal", "view.open.url",
		"settings.get", "settings.set", "settings.reset", "settings.path", "settings.reveal",
		"view.settings", "view.help",
		"app.version", "app.update.check", "app.update", "app.relaunch", "daemon.restart",
		"view.pullrequests", "view.projects", "view.panel.toggle", "view.panel.expand",
		"workspace.new", "workspace.list", "workspace.members", "workspace.add-repo", "workspace.remove-repo", "workspace.remove",
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
		{"terminal.new", command.Context{}, true},
		{"terminal.kill", command.Context{}, false},
		{"terminal.kill", command.Context{ActiveTerminalID: "t1"}, true},
		{"terminal.remove", command.Context{ActiveTerminalID: "t1"}, true},
		{"repo.register", command.Context{}, true},
		{"repo.unregister", command.Context{}, false},
		{"repo.unregister", command.Context{ActiveRepoID: "r1"}, true},
		{"repo.worktree.new", command.Context{}, false},
		{"repo.worktree.new", command.Context{ActiveRepoID: "r1"}, true},
		{"repo.worktree.remove", command.Context{ActiveRepoID: "r1"}, false},
		{"repo.worktree.remove", command.Context{ActiveRepoID: "r1", ActiveWorktreePath: "/wt"}, true},
		{"repo.refresh", command.Context{}, true},
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
		wantMsg   string
		wantJSON  string        // substring of EncodeJSON
		wantReq   proto.Message // last backend request or emitted intent
	}{
		{name: "daemon.status", cmd: "daemon.status",
			wantMsg:  "daemon pid 42, version 1.2.3, up 1m30s, home /h",
			wantJSON: `"uptime_seconds":90`},
		{name: "daemon.version", cmd: "daemon.version",
			wantMsg: "code-foundry 1.2.3 (abc) go1.26", wantJSON: `"go_version":"go1.26"`},
		{name: "ui.notify", cmd: "ui.notify", args: map[string]string{"title": "hi", "body": "there", "level": "warning"},
			wantMsg: "delivered=2", wantJSON: `{"delivered":2}`,
			wantReq: &v1.UiIntent{Intent: &v1.UiIntent_Notify_{Notify: &v1.UiIntent_Notify{
				Level: v1.UiIntent_Notify_LEVEL_WARNING, Title: "hi", Body: "there"}}}},
		{name: "ui.notify default level", cmd: "ui.notify", args: map[string]string{"title": "hi"}, wantMsg: "delivered=2",
			wantReq: &v1.UiIntent{Intent: &v1.UiIntent_Notify_{Notify: &v1.UiIntent_Notify{
				Level: v1.UiIntent_Notify_LEVEL_INFO, Title: "hi"}}}},
		{name: "ui.notify missing title", cmd: "ui.notify", wantErr: command.ErrInvalidArgs},
		{name: "ui.palette.open", cmd: "ui.palette.open", args: map[string]string{"query": "term"}, wantMsg: "delivered=2",
			wantReq: &v1.UiIntent{Intent: &v1.UiIntent_OpenPalette_{OpenPalette: &v1.UiIntent_OpenPalette{Query: "term"}}}},
		{name: "ui.focus.terminal from context", cmd: "ui.focus.terminal", ctx: command.Context{ActiveTerminalID: "t9"},
			wantReq: &v1.UiIntent{Intent: &v1.UiIntent_FocusTerminal_{FocusTerminal: &v1.UiIntent_FocusTerminal{TerminalId: "t9"}}}},
		{name: "ui.focus.terminal needs an id", cmd: "ui.focus.terminal", wantErr: command.ErrInvalidArgs},
		{name: "ui.focus.repo", cmd: "ui.focus.repo", args: map[string]string{"repo": "r1", "worktree": "~/wt"},
			wantReq: &v1.UiIntent{Intent: &v1.UiIntent_FocusRepo_{FocusRepo: &v1.UiIntent_FocusRepo{RepoId: "r1", WorktreePath: "/Users/me/wt"}}}},
		{name: "terminal.new defaults", cmd: "terminal.new", wantMsg: "created terminal t1", wantJSON: `"cwd":"/Users/me"`,
			wantReq: &v1.CreateTerminalRequest{Argv: []string{"/bin/fish", "-l"}, Cwd: "/Users/me"}},
		{name: "terminal.new in worktree with argv", cmd: "terminal.new", ctx: command.Context{ActiveWorktreePath: "/wt"},
			args:    map[string]string{"argv": `claude --append-system-prompt "be brief"`},
			wantReq: &v1.CreateTerminalRequest{Argv: []string{"claude", "--append-system-prompt", "be brief"}, Cwd: "/wt"}},
		{name: "terminal.new bad argv", cmd: "terminal.new", args: map[string]string{"argv": `"oops`}, wantErr: command.ErrInvalidArgs},
		{name: "terminal.new relative cwd", cmd: "terminal.new", args: map[string]string{"cwd": "rel"}, wantErr: command.ErrInvalidArgs},
		{name: "terminal.kill", cmd: "terminal.kill", args: map[string]string{"id": "t3"}, wantMsg: "killed terminal t3",
			wantReq: &v1.KillTerminalRequest{Id: "t3"}},
		{name: "terminal.kill backend error passes through", cmd: "terminal.kill", args: map[string]string{"id": "t3"},
			backendEr: notFound, wantErr: notFound},
		{name: "terminal.remove from context", cmd: "terminal.remove", ctx: command.Context{ActiveTerminalID: "t4"},
			wantMsg: "removed terminal t4", wantReq: &v1.RemoveTerminalRequest{Id: "t4"}},
		{name: "repo.register", cmd: "repo.register", args: map[string]string{"path": "~/src/app"},
			wantMsg: "registered repo (r1)", wantJSON: `"path":"/Users/me/src/app"`,
			wantReq: &v1.RegisterRepoRequest{Path: "/Users/me/src/app"}},
		{name: "repo.register missing path", cmd: "repo.register", wantErr: command.ErrInvalidArgs},
		{name: "repo.unregister unavailable", cmd: "repo.unregister", wantErr: command.ErrUnavailable},
		{name: "repo.worktree.new with explicit repo", cmd: "repo.worktree.new", args: map[string]string{"repo": "r2", "branch": "feat", "base": "main"},
			wantMsg: "created worktree /wt/feat on feat",
			wantReq: &v1.CreateWorktreeRequest{RepoId: "r2", Branch: "feat", BaseRef: "main", Fetch: true}},
		{name: "repo.worktree.new from context", cmd: "repo.worktree.new", ctx: command.Context{ActiveRepoID: "r1"}, args: map[string]string{"branch": "x"},
			wantReq: &v1.CreateWorktreeRequest{RepoId: "r1", Branch: "x", Fetch: true}},
		{name: "repo.worktree.new without fetch", cmd: "repo.worktree.new", ctx: command.Context{ActiveRepoID: "r1"},
			args:    map[string]string{"branch": "x", "base": "origin/dev", "fetch": "false"},
			wantReq: &v1.CreateWorktreeRequest{RepoId: "r1", Branch: "x", BaseRef: "origin/dev"}},
		{name: "repo.worktree.new needs a branch", cmd: "repo.worktree.new", ctx: command.Context{ActiveRepoID: "r1"}, wantErr: command.ErrInvalidArgs},
		{name: "repo.worktree.new unavailable", cmd: "repo.worktree.new", args: map[string]string{"branch": "x"}, wantErr: command.ErrUnavailable},
		{name: "repo.worktree.remove", cmd: "repo.worktree.remove", ctx: command.Context{ActiveRepoID: "r1", ActiveWorktreePath: "/wt/x"},
			args: map[string]string{"force": "true"}, wantMsg: "removed worktree /wt/x",
			wantReq: &v1.RemoveWorktreeRequest{RepoId: "r1", Path: "/wt/x", Force: true}},
		{name: "repo.refresh all", cmd: "repo.refresh", wantMsg: "refreshed all repositories", wantReq: &v1.RefreshRepoRequest{}},
		{name: "repo.refresh active", cmd: "repo.refresh", ctx: command.Context{ActiveRepoID: "r1"}, wantMsg: "refreshed r1",
			wantReq: &v1.RefreshRepoRequest{Id: "r1"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture(t)
			f.term.Err, f.repo.Err = tt.backendEr, tt.backendEr
			res, err := f.reg.Invoke(context.Background(), tt.ctx, tt.cmd, tt.args, command.Confirmed(true))
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
					reqs := append(f.term.Requests(), f.repo.Requests()...)
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
}

func TestEncodeJSON(t *testing.T) {
	tests := []struct {
		name string
		in   any
		want string
	}{
		{"nil", nil, ""},
		{"struct", command.EmitResult{Delivered: 1}, `{"delivered":1}`},
		{"proto uses protojson names", &v1.Terminal{Id: "t1", ExitCode: 3}, `{"id":"t1","exitCode":3}`},
	}
	for _, tt := range tests {
		got, err := command.Result{JSON: tt.in}.EncodeJSON()
		if err != nil || strings.ReplaceAll(got, " ", "") != tt.want {
			t.Errorf("%s: got %s, %v; want %s", tt.name, got, err, tt.want)
		}
	}
}
