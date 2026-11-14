package command_test

import (
	"context"
	"errors"
	"maps"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

func newTerminalRegistry(t *testing.T, term *commandtest.Terminal, thread *commandtest.Thread) *command.Registry {
	t.Helper()
	if thread == nil {
		thread = &commandtest.Thread{}
	}
	reg := command.NewRegistry()
	if err := command.RegisterTerminal(reg, command.TerminalDeps{
		Terminal: term,
		Project:  &commandtest.Project{},
		Thread:   thread,
		IsShell: func(id string) bool {
			for _, t := range term.Terminals {
				if t.GetId() == id {
					return termlabel.IsPanel(t.GetLabels())
				}
			}
			return false
		},
	}); err != nil {
		t.Fatal(err)
	}
	return reg
}

func creates(reqs []proto.Message) []*v1.CreateTerminalRequest {
	var out []*v1.CreateTerminalRequest
	for _, r := range reqs {
		if c, ok := r.(*v1.CreateTerminalRequest); ok {
			out = append(out, c)
		}
	}
	return out
}

func TestTerminalNewFree(t *testing.T) {
	t.Setenv("SHELL", "/bin/fish")
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name     string
		ctx      command.Context
		args     map[string]string
		wantArgv []string
		wantKeys string
		wantErr  error
	}{
		{name: "from the CLI", wantArgv: []string{"/bin/fish", "-l"}},
		{name: "inside a project or a thread it is still free", ctx: command.Context{ActiveThreadID: "s1", ActiveProjectID: "r1", ActiveWorktreePath: "/w"},
			wantArgv: []string{"/bin/fish", "-l"}},
		{name: "on the Pull Requests page too", ctx: command.Context{ActiveView: "pullrequests"}, wantArgv: []string{"/bin/fish", "-l"}},
		{name: "argv", args: map[string]string{"argv": "htop -d 5"}, wantArgv: []string{"htop", "-d", "5"}},
		{name: "run", args: map[string]string{"run": "ls\n"}, wantArgv: []string{"/bin/fish", "-l"}, wantKeys: "ls\r"},
		{name: "a control character in run", args: map[string]string{"run": "ls\x1b"}, wantErr: command.ErrInvalidArgs},
		{name: "bad argv", args: map[string]string{"argv": `"oops`}, wantErr: command.ErrInvalidArgs},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			term := &commandtest.Terminal{}
			reg := newTerminalRegistry(t, term, nil)
			res, err := reg.Invoke(context.Background(), tt.ctx, "terminal.new-free", tt.args)
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) || len(term.Requests()) != 0 {
					t.Fatalf("err = %v, requests %v; want %v and none", err, term.Requests(), tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			c := creates(term.Requests())
			if len(c) != 1 || c[0].GetCwd() != home || !maps.Equal(c[0].GetLabels(), termlabel.Free()) || !slices.Equal(c[0].GetArgv(), tt.wantArgv) {
				t.Fatalf("Create = %v; want argv %q in %s, free", c, tt.wantArgv, home)
			}
			var keys string
			for _, w := range writesOf(term.Requests()) {
				keys += string(w.GetData())
			}
			if keys != tt.wantKeys {
				t.Errorf("typed %q, want %q", keys, tt.wantKeys)
			}
			if !strings.HasPrefix(res.Message, "created terminal t1 in "+home) {
				t.Errorf("message = %q", res.Message)
			}
		})
	}
	c, _ := reg(t).Get("terminal.new-free")
	if c.NoPalette || len(c.Keybindings) != 0 {
		t.Errorf("terminal.new-free: NoPalette %v keybindings %v; want listed, with no key (cmd+t opens one where no thread is in context)", c.NoPalette, c.Keybindings)
	}
}

func reg(t *testing.T) *command.Registry {
	return newTerminalRegistry(t, &commandtest.Terminal{}, nil)
}

func TestTerminalNewQuick(t *testing.T) {
	t.Setenv("SHELL", "/bin/fish")
	const feat = "/cf-test/src/app/.claude/worktrees/feat"
	thread := &v1.Thread{Id: "s1", ProjectId: "r1", WorktreePath: feat}
	quickOf := func(id, thread string, state v1.TerminalState) *v1.Terminal {
		return &v1.Terminal{Id: id, State: state, Labels: termlabel.QuickShell(thread, "r1", feat)}
	}
	running, exited := v1.TerminalState_TERMINAL_STATE_RUNNING, v1.TerminalState_TERMINAL_STATE_EXITED
	tests := []struct {
		name       string
		ctx        command.Context
		args       map[string]string
		terminals  []*v1.Terminal
		wantCreate bool
		wantMsg    string
		wantKeys   string
		wantErr    error
	}{
		{name: "the first one is created", ctx: command.Context{ActiveThreadID: "s1"}, wantCreate: true,
			wantMsg: "created thread s1's quick terminal t1"},
		{name: "a running one is returned", ctx: command.Context{ActiveThreadID: "s1"}, terminals: []*v1.Terminal{quickOf("t-q", "s1", running)},
			wantMsg: "thread s1's quick terminal is t-q"},
		{name: "--run types into the running one", ctx: command.Context{ActiveThreadID: "s1"}, args: map[string]string{"run": "ls"},
			terminals: []*v1.Terminal{quickOf("t-q", "s1", running)}, wantMsg: "thread s1's quick terminal is t-q; ran the command in it", wantKeys: "ls\r"},
		{name: "an exited one does not count", ctx: command.Context{ActiveThreadID: "s1"}, terminals: []*v1.Terminal{quickOf("t-q", "s1", exited)},
			wantCreate: true, wantMsg: "created thread s1's quick terminal t1"},
		{name: "another thread's does not count", ctx: command.Context{ActiveThreadID: "s1"}, terminals: []*v1.Terminal{quickOf("t-q", "s2", running)},
			wantCreate: true, wantMsg: "created thread s1's quick terminal t1"},
		{name: "an ordinary shell of the thread does not count", ctx: command.Context{ActiveThreadID: "s1"},
			terminals:  []*v1.Terminal{{Id: "t-s", State: running, Labels: termlabel.Shell("s1", "r1", feat)}},
			wantCreate: true, wantMsg: "created thread s1's quick terminal t1"},
		{name: "without a thread", args: map[string]string{"here": feat}, wantErr: command.ErrInvalidArgs},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			term := &commandtest.Terminal{Terminals: tt.terminals}
			reg := newTerminalRegistry(t, term, &commandtest.Thread{Current: thread})
			args := map[string]string{"quick": "true"}
			maps.Copy(args, tt.args)
			res, err := reg.Invoke(context.Background(), tt.ctx, "terminal.new", args)
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) || len(creates(term.Requests())) != 0 {
					t.Fatalf("err = %v, creates %v; want %v and none", err, creates(term.Requests()), tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			c := creates(term.Requests())
			if tt.wantCreate != (len(c) == 1) || len(c) > 1 {
				t.Fatalf("creates = %v, want one: %v", c, tt.wantCreate)
			}
			if tt.wantCreate && (c[0].GetCwd() != feat || !maps.Equal(c[0].GetLabels(), termlabel.QuickShell("s1", "r1", feat))) {
				t.Errorf("Create = %v", c[0])
			}
			if res.Message != tt.wantMsg {
				t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
			}
			var keys string
			for _, w := range writesOf(term.Requests()) {
				keys += string(w.GetData())
			}
			if keys != tt.wantKeys {
				t.Errorf("typed %q, want %q", keys, tt.wantKeys)
			}
		})
	}
}

// listing is a fake terminal backend whose List shows what Create made, so two
// concurrent terminal.new --quick calls can see each other's.
type listing struct {
	*commandtest.Terminal
	mu   sync.Mutex
	made []*v1.Terminal
}

func (l *listing) Create(ctx context.Context, r *connect.Request[v1.CreateTerminalRequest]) (*connect.Response[v1.CreateTerminalResponse], error) {
	res, err := l.Terminal.Create(ctx, r)
	if err == nil {
		l.mu.Lock()
		t := res.Msg.GetTerminal()
		t.Id = "t" + string(rune('a'+len(l.made)))
		l.made = append(l.made, t)
		l.mu.Unlock()
	}
	return res, err
}

func (l *listing) List(context.Context, *connect.Request[v1.ListTerminalsRequest]) (*connect.Response[v1.ListTerminalsResponse], error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return connect.NewResponse(&v1.ListTerminalsResponse{Terminals: slices.Clone(l.made)}), nil
}

func TestTerminalNewQuickIsOnePerThread(t *testing.T) {
	t.Setenv("SHELL", "/bin/fish")
	term := &listing{Terminal: &commandtest.Terminal{}}
	reg := command.NewRegistry()
	if err := command.RegisterTerminal(reg, command.TerminalDeps{
		Terminal: term, Project: &commandtest.Project{},
		Thread: &commandtest.Thread{Current: &v1.Thread{Id: "s1", ProjectId: "r1", WorktreePath: "/w"}},
	}); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			if _, err := reg.Invoke(context.Background(), command.Context{ActiveThreadID: "s1"}, "terminal.new", map[string]string{"quick": "true"}); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	if n := len(creates(term.Requests())); n != 1 {
		t.Errorf("%d quick terminals created, want 1", n)
	}
}

func TestTerminalReset(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	const (
		feat  = "/cf-test/src/app/.claude/worktrees/feat"
		moved = "/cf-test/src/app/.claude/worktrees/moved"
	)
	thread := &v1.Thread{Id: "s1", ProjectId: "r1", WorktreePath: feat}
	shell := func(labels map[string]string) []*v1.Terminal {
		return []*v1.Terminal{{Id: "t-old", Argv: []string{"/bin/zsh", "-l"}, Cwd: "/elsewhere", LiveCwd: "/elsewhere/sub", Cols: 120, Rows: 40,
			State: v1.TerminalState_TERMINAL_STATE_RUNNING, Labels: labels}}
	}
	withReplaces := func(l map[string]string) map[string]string {
		l = maps.Clone(l)
		l[termlabel.Replaces] = "t-old"
		return l
	}
	tests := []struct {
		name       string
		terminals  []*v1.Terminal
		thread     *v1.Thread
		threadErr  error
		closeErr   error
		wantCwd    string
		wantLabels map[string]string
		wantCode   connect.Code
		wantMsg    string
	}{
		{name: "a thread's shell starts in the thread's checkout", terminals: shell(termlabel.Shell("s1", "r1", feat)),
			wantCwd: feat, wantLabels: withReplaces(termlabel.Shell("s1", "r1", feat))},
		{name: "a quick terminal stays the quick terminal", terminals: shell(termlabel.QuickShell("s1", "r1", feat)),
			wantCwd: feat, wantLabels: withReplaces(termlabel.QuickShell("s1", "r1", feat))},
		{name: "a thread that moved: its checkout now", terminals: shell(termlabel.Shell("s1", "r1", feat)),
			thread: &v1.Thread{Id: "s1", ProjectId: "r2", WorktreePath: moved}, wantCwd: moved, wantLabels: withReplaces(termlabel.Shell("s1", "r2", moved))},
		{name: "a reset shell resets again, replacing only the last", terminals: shell(withReplaces(termlabel.Shell("s1", "r1", feat))),
			wantCwd: feat, wantLabels: withReplaces(termlabel.Shell("s1", "r1", feat))},
		{name: "a worktree's shell starts in the worktree", terminals: shell(termlabel.Shell("", "r1", feat)),
			wantCwd: feat, wantLabels: withReplaces(termlabel.Shell("", "r1", feat))},
		{name: "a free shell starts in the home directory", terminals: shell(termlabel.Free()),
			wantCwd: home, wantLabels: withReplaces(termlabel.Free())},
		{name: "the old one already went", terminals: shell(termlabel.Free()), closeErr: connect.NewError(connect.CodeNotFound, errors.New("gone")),
			wantCwd: home, wantLabels: withReplaces(termlabel.Free())},
		{name: "closing the old one fails", terminals: shell(termlabel.Free()), closeErr: connect.NewError(connect.CodeInternal, errors.New("stuck")),
			wantCwd: home, wantLabels: withReplaces(termlabel.Free()), wantCode: connect.CodeInternal, wantMsg: "but could not close t-old"},
		{name: "a thread still being set up", terminals: shell(termlabel.Shell("s1", "r1", feat)), thread: &v1.Thread{Id: "s1"},
			wantCode: connect.CodeFailedPrecondition, wantMsg: "has no checkout yet"},
		{name: "the thread lookup fails", terminals: shell(termlabel.Shell("s1", "r1", feat)), threadErr: connect.NewError(connect.CodeNotFound, errors.New("no thread")),
			wantCode: connect.CodeNotFound},
		{name: "an action run is not a shell", terminals: shell(termlabel.ActionTerminal("s1", "r1", feat, "a", "Test", "run")),
			wantCode: connect.CodeFailedPrecondition, wantMsg: "is not a shell"},
		{name: "an unknown terminal", wantCode: connect.CodeNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			term := &closeErrTerminal{Terminal: &commandtest.Terminal{Terminals: tt.terminals}, closeErr: tt.closeErr}
			th := tt.thread
			if th == nil {
				th = thread
			}
			reg := command.NewRegistry()
			if err := command.RegisterTerminal(reg, command.TerminalDeps{Terminal: term, Project: &commandtest.Project{},
				Thread: &commandtest.Thread{Current: th, Err: tt.threadErr}}); err != nil {
				t.Fatal(err)
			}
			res, err := reg.Invoke(context.Background(), command.Context{}, "terminal.reset", map[string]string{"id": "t-old"})
			c := creates(term.Requests())
			if tt.wantCwd != "" {
				if len(c) != 1 || c[0].GetCwd() != tt.wantCwd || !maps.Equal(c[0].GetLabels(), tt.wantLabels) ||
					!slices.Equal(c[0].GetArgv(), []string{"/bin/zsh", "-l"}) || c[0].GetCols() != 120 || c[0].GetRows() != 40 {
					t.Fatalf("Create = %v; want the old argv and size in %s with %v", c, tt.wantCwd, tt.wantLabels)
				}
				if !slices.ContainsFunc(term.Requests(), func(m proto.Message) bool {
					cl, ok := m.(*v1.CloseTerminalRequest)
					return ok && cl.GetId() == "t-old"
				}) {
					t.Errorf("the old terminal was not closed: %v", term.Requests())
				}
			} else if len(c) != 0 {
				t.Errorf("created %v", c)
			}
			if tt.wantCode != 0 {
				if connect.CodeOf(err) != tt.wantCode || !strings.Contains(err.Error(), tt.wantMsg) {
					t.Fatalf("err = %v, want %v containing %q", err, tt.wantCode, tt.wantMsg)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if res.Message != "reset terminal t-old: t1 starts in "+tt.wantCwd {
				t.Errorf("message = %q", res.Message)
			}
		})
	}
}

// closeErrTerminal is a terminal backend whose Close alone fails with closeErr.
type closeErrTerminal struct {
	*commandtest.Terminal
	closeErr error
}

func (c *closeErrTerminal) Close(ctx context.Context, r *connect.Request[v1.CloseTerminalRequest]) (*connect.Response[v1.CloseTerminalResponse], error) {
	res, _ := c.Terminal.Close(ctx, r)
	if c.closeErr != nil {
		return nil, c.closeErr
	}
	return res, nil
}

func TestTerminalRerun(t *testing.T) {
	running, exited := v1.TerminalState_TERMINAL_STATE_RUNNING, v1.TerminalState_TERMINAL_STATE_EXITED
	shell := func(state v1.TerminalState, fg, last string) []*v1.Terminal {
		return []*v1.Terminal{{Id: "t-sh", State: state, Foreground: fg, LastCommand: last, Labels: termlabel.Shell("s1", "r1", "/w")}}
	}
	tests := []struct {
		name      string
		terminals []*v1.Terminal
		args      map[string]string
		wantKeys  string
		wantCode  connect.Code
		wantErr   error
		wantMsg   string
	}{
		{name: "the last command", terminals: shell(running, "", "make test"), wantKeys: "make test\r"},
		{name: "a quoted command line", terminals: shell(running, "", `git log '--format=%h %s'`), wantKeys: `git log '--format=%h %s'` + "\r"},
		{name: "--command instead", terminals: shell(running, "", ""), args: map[string]string{"command": "npm run dev"}, wantKeys: "npm run dev\r"},
		{name: "--command wins over the last command", terminals: shell(running, "", "ls"), args: map[string]string{"command": "pwd"}, wantKeys: "pwd\r"},
		{name: "a free shell", terminals: []*v1.Terminal{{Id: "t-sh", State: running, LastCommand: "top", Labels: termlabel.Free()}}, wantKeys: "top\r"},
		{name: "something runs", terminals: shell(running, "sleep 5", "ls"), wantCode: connect.CodeFailedPrecondition, wantMsg: "is running sleep 5"},
		{name: "no last command", terminals: shell(running, "", ""), wantCode: connect.CodeFailedPrecondition, wantMsg: "has no last command"},
		{name: "a cut command", terminals: shell(running, "", "echo aaaa…"), wantCode: connect.CodeFailedPrecondition, wantMsg: "too long"},
		{name: "an exited shell", terminals: shell(exited, "", "ls"), wantCode: connect.CodeFailedPrecondition, wantMsg: "has exited"},
		{name: "a control character", terminals: shell(running, "", ""), args: map[string]string{"command": "ls\x1b"}, wantErr: command.ErrInvalidArgs},
		{name: "not a shell", terminals: []*v1.Terminal{{Id: "t-sh", State: running, LastCommand: "ls", Labels: termlabel.PluginTerminal("p", "x")}},
			wantErr: command.ErrUnavailable, wantMsg: "terminal t-sh is not a shell"},
		{name: "unknown", wantErr: command.ErrUnavailable, wantMsg: "no terminal t-sh"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			term := &commandtest.Terminal{Terminals: tt.terminals}
			reg := newTerminalRegistry(t, term, nil)
			args := map[string]string{"id": "t-sh"}
			maps.Copy(args, tt.args)
			res, err := reg.Invoke(context.Background(), command.Context{}, "terminal.rerun", args)
			var keys string
			for _, w := range writesOf(term.Requests()) {
				keys += string(w.GetData())
			}
			if keys != tt.wantKeys {
				t.Errorf("typed %q, want %q", keys, tt.wantKeys)
			}
			switch {
			case tt.wantErr != nil:
				if !errors.Is(err, tt.wantErr) || !strings.Contains(err.Error(), tt.wantMsg) {
					t.Fatalf("err = %v, want %v containing %q", err, tt.wantErr, tt.wantMsg)
				}
			case tt.wantCode != 0:
				if connect.CodeOf(err) != tt.wantCode || !strings.Contains(err.Error(), tt.wantMsg) {
					t.Fatalf("err = %v, want %v containing %q", err, tt.wantCode, tt.wantMsg)
				}
			case err != nil:
				t.Fatal(err)
			case !strings.HasPrefix(res.Message, "ran "):
				t.Errorf("message = %q", res.Message)
			}
		})
	}
}

func TestTerminalShellWindowAvailability(t *testing.T) {
	term := &commandtest.Terminal{Terminals: []*v1.Terminal{
		{Id: "t-shell", Labels: termlabel.Free()},
		{Id: "t-plugin", Labels: termlabel.PluginTerminal("p", "x")},
	}}
	reg := newTerminalRegistry(t, term, nil)
	tests := []struct {
		cmd  string
		ctx  command.Context
		want bool
	}{
		{"terminal.new-free", command.Context{}, true},
		{"terminal.new-free", command.Context{ActiveView: "pullrequests"}, true},
		{"terminal.reset", command.Context{}, false},
		{"terminal.reset", command.Context{ActiveTerminalID: "t-shell"}, true},
		{"terminal.reset", command.Context{ActiveTerminalID: "t-plugin"}, false},
		{"terminal.rerun", command.Context{ActiveTerminalID: "t-shell"}, true},
		{"terminal.rerun", command.Context{ActiveTerminalID: "t-plugin"}, false},
	}
	for _, tt := range tests {
		c, ok := reg.Get(tt.cmd)
		if !ok {
			t.Fatalf("%s not registered", tt.cmd)
		}
		if got := c.Available(tt.ctx); got != tt.want {
			t.Errorf("%s available in %+v = %v, want %v", tt.cmd, tt.ctx, got, tt.want)
		}
	}
}
