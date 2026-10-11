package command_test

import (
	"context"
	"errors"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/store/terminal/termlabel"
)

func TestTerminalNewOwner(t *testing.T) {
	t.Setenv("SHELL", "/bin/fish")
	// A real directory behind a symlink (t.TempDir is under /var, which is /private/var
	// on macOS): repo paths are stored resolved, the CLI sends what the shell sees.
	real := t.TempDir()
	if r, err := filepath.EvalSymlinks(real); err == nil {
		real = r
	}
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	const (
		app  = "/cf-test/src/app"
		feat = "/cf-test/src/app/.claude/worktrees/feat"
	)
	repos := []*v1.Repo{
		{Id: "r1", Path: app, Worktrees: []*v1.Worktree{{RepoId: "r1", Path: app}, {RepoId: "r1", Path: feat}}},
		{Id: "r2", Path: real, Worktrees: []*v1.Worktree{{RepoId: "r2", Path: real}}},
	}
	thread := &v1.Session{RepoId: "r1", WorktreePath: feat}
	tests := []struct {
		name       string
		ctx        command.Context
		args       map[string]string
		sessionErr error
		wantErr    error
		wantMsg    string // substring of the error
		wantCwd    string
		wantLabels map[string]string
		wantArgv   []string
	}{
		{name: "thread in the GUI", ctx: command.Context{ActiveSessionID: "s1", ActiveRepoID: "r1", ActiveWorktreePath: feat},
			wantCwd: feat, wantLabels: termlabel.Shell("s1", "r1", feat)},
		{name: "thread without a worktree in context starts in the thread's worktree", ctx: command.Context{ActiveSessionID: "s1"},
			wantCwd: feat, wantLabels: termlabel.Shell("s1", "r1", feat)},
		{name: "thread from the CLI keeps --cwd", ctx: command.Context{ActiveSessionID: "s1"}, args: map[string]string{"cwd": app + "/docs"},
			wantCwd: app + "/docs", wantLabels: termlabel.Shell("s1", "r1", feat)},
		{name: "thread lookup fails", ctx: command.Context{ActiveSessionID: "s1"},
			sessionErr: connect.NewError(connect.CodeNotFound, errors.New("no such session")), wantMsg: "no such session"},
		{name: "worktree in the GUI", ctx: command.Context{ActiveRepoID: "r1", ActiveWorktreePath: feat, ActiveView: "projects"},
			wantCwd: feat, wantLabels: termlabel.Shell("", "r1", feat)},
		{name: "CLI in a main worktree's subdirectory", args: map[string]string{"cwd": app + "/internal"},
			wantCwd: app + "/internal", wantLabels: termlabel.Shell("", "r1", app)},
		{name: "CLI in a nested worktree: the deepest wins", args: map[string]string{"cwd": feat + "/pkg"},
			wantCwd: feat + "/pkg", wantLabels: termlabel.Shell("", "r1", feat)},
		{name: "CLI at a worktree root", args: map[string]string{"cwd": app},
			wantCwd: app, wantLabels: termlabel.Shell("", "r1", app)},
		{name: "CLI through a symlink", args: map[string]string{"cwd": link},
			wantCwd: link, wantLabels: termlabel.Shell("", "r2", real)},
		{name: "CLI with argv", args: map[string]string{"cwd": app, "argv": "htop -d 5"},
			wantCwd: app, wantLabels: termlabel.Shell("", "r1", app), wantArgv: []string{"htop", "-d", "5"}},
		{name: "a sibling with the same prefix is outside", args: map[string]string{"cwd": "/cf-test/src/apple"},
			wantErr: command.ErrInvalidArgs, wantMsg: "/cf-test/src/apple is not inside a registered project"},
		{name: "outside every project", args: map[string]string{"cwd": "/cf-test/elsewhere"},
			wantErr: command.ErrInvalidArgs, wantMsg: "/cf-test/elsewhere is not inside a registered project"},
		{name: "stale worktree context falls back to containment", ctx: command.Context{ActiveRepoID: "r9", ActiveWorktreePath: feat},
			wantCwd: feat, wantLabels: termlabel.Shell("", "r1", feat)},
		{name: "nothing to own it", wantErr: command.ErrUnavailable},
		{name: "a repo alone is not enough", ctx: command.Context{ActiveRepoID: "r1", ActiveView: "compose"}, wantErr: command.ErrUnavailable},
		{name: "bad argv", args: map[string]string{"cwd": app, "argv": `"oops`}, wantErr: command.ErrInvalidArgs},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			term := &commandtest.Terminal{}
			reg := command.NewRegistry()
			if err := command.RegisterTerminal(reg, command.TerminalDeps{
				Terminal: term,
				Repo:     &commandtest.Repo{Repos: repos},
				Session:  &commandtest.Session{Current: thread, Err: tt.sessionErr},
			}); err != nil {
				t.Fatal(err)
			}
			res, err := reg.Invoke(context.Background(), tt.ctx, "terminal.new", tt.args)
			if tt.wantErr != nil || tt.wantMsg != "" {
				if err == nil || (tt.wantErr != nil && !errors.Is(err, tt.wantErr)) || !strings.Contains(err.Error(), tt.wantMsg) {
					t.Fatalf("err = %v, want %v containing %q", err, tt.wantErr, tt.wantMsg)
				}
				if reqs := term.Requests(); len(reqs) != 0 {
					t.Errorf("terminal backend called: %v", reqs)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			reqs := term.Requests()
			if len(reqs) != 1 {
				t.Fatalf("requests = %v, want one Create", reqs)
			}
			req := reqs[0].(*v1.CreateTerminalRequest)
			wantArgv := tt.wantArgv
			if wantArgv == nil {
				wantArgv = []string{"/bin/fish", "-l"}
			}
			if req.GetCwd() != tt.wantCwd || !maps.Equal(req.GetLabels(), tt.wantLabels) || !slices.Equal(req.GetArgv(), wantArgv) {
				t.Errorf("Create = cwd %q labels %v argv %q; want %q %v %q", req.GetCwd(), req.GetLabels(), req.GetArgv(), tt.wantCwd, tt.wantLabels, wantArgv)
			}
			if res.Message != "created terminal t1" {
				t.Errorf("message = %q", res.Message)
			}
		})
	}
}

func TestTerminalClose(t *testing.T) {
	tests := []struct {
		name    string
		ctx     command.Context
		args    map[string]string
		backend error
		wantErr error
		wantID  string
	}{
		{name: "from context", ctx: command.Context{ActiveTerminalID: "t4"}, wantID: "t4"},
		{name: "explicit id", args: map[string]string{"id": "t5"}, wantID: "t5"},
		{name: "no terminal", wantErr: command.ErrUnavailable},
		{name: "backend error passes through", args: map[string]string{"id": "t6"},
			backend: connect.NewError(connect.CodeNotFound, errors.New("no such terminal")), wantID: "t6"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			term := &commandtest.Terminal{Err: tt.backend}
			reg := command.NewRegistry()
			if err := command.RegisterTerminal(reg, command.TerminalDeps{Terminal: term}); err != nil {
				t.Fatal(err)
			}
			res, err := reg.Invoke(context.Background(), tt.ctx, "terminal.close", tt.args)
			switch {
			case tt.wantErr != nil:
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
				return
			case tt.backend != nil:
				if !errors.Is(err, tt.backend) {
					t.Fatalf("err = %v, want %v", err, tt.backend)
				}
			case err != nil:
				t.Fatal(err)
			case res.Message != "closed terminal "+tt.wantID:
				t.Errorf("message = %q", res.Message)
			}
			reqs := term.Requests()
			if len(reqs) != 1 || reqs[0].(*v1.CloseTerminalRequest).GetId() != tt.wantID {
				t.Errorf("requests = %v, want Close %s", reqs, tt.wantID)
			}
		})
	}
	reg := command.NewRegistry()
	if err := command.RegisterTerminal(reg, command.TerminalDeps{Terminal: &commandtest.Terminal{}}); err != nil {
		t.Fatal(err)
	}
	if c, _ := reg.Get("terminal.close"); c.Confirm != "" || c.Title != "Close Terminal" || c.Category != "Terminal" {
		t.Errorf("terminal.close = %+v, want title Close Terminal, category Terminal, no confirmation", c)
	}
}
