package command_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
	"github.com/alexwaumann/code-foundry/internal/store/workspace"
	"github.com/alexwaumann/code-foundry/internal/store/workspace/workspacetest"
)

func newWorkspaceRegistry(t *testing.T) (*command.Registry, *workspacetest.Fake) {
	t.Helper()
	b := bus.New()
	fake := workspacetest.New(b)
	fake.Repos = func() *repo.Snapshot {
		return &repo.Snapshot{Repos: []repo.Repo{
			{ID: "web", Name: "web-ui", Worktrees: []repo.Worktree{{RepoID: "web", Path: "/worktrees/web/cf-login", Branch: "cf/login"}}},
			{ID: "api", Name: "api", Worktrees: []repo.Worktree{{RepoID: "api", Path: "/worktrees/api/cf-login", Branch: "cf/login"}}},
		}}
	}
	reg := command.NewRegistry()
	if err := command.RegisterWorkspace(reg, api.NewWorkspace(fake, b)); err != nil {
		t.Fatal(err)
	}
	return reg, fake
}

func TestWorkspaceCommands(t *testing.T) {
	tests := []struct {
		name     string
		cmd      string
		ctx      command.Context
		args     map[string]string
		wantErr  error
		wantMsg  []string // substrings of the message (or error)
		wantCall string   // last fake call
		wantJSON string
	}{
		{
			name: "new with per-repo bases", cmd: "workspace.new",
			args:     map[string]string{"name": "login", "repos": "web, api:origin/dev ,"},
			wantMsg:  []string{"created workspace login (w-2), branch cf/login", "REPO", "web-ui  web  /worktrees/web/cf-login  cf/login"},
			wantCall: "Create login web,api:origin/dev",
			wantJSON: `"branch":"cf/login"`,
		},
		{name: "new without repos", cmd: "workspace.new", args: map[string]string{"name": "x", "repos": " , "}, wantErr: command.ErrInvalidArgs, wantMsg: []string{"at least one"}},
		{name: "new without a name", cmd: "workspace.new", args: map[string]string{"repos": "web"}, wantErr: command.ErrInvalidArgs},
		{
			name: "members by cwd marks the current worktree", cmd: "workspace.members",
			args:     map[string]string{"cwd": "/worktrees/api/cf-login/src"},
			wantMsg:  []string{"workspace base (w-1), branch cf/login", "api     api  /worktrees/api/cf-login  cf/login (current)"},
			wantCall: "Members /worktrees/api/cf-login/src",
			wantJSON: `"current":true`,
		},
		{
			name: "members default to the active worktree", cmd: "workspace.members",
			ctx:      command.Context{ActiveWorktreePath: "/worktrees/web/cf-login"},
			wantMsg:  []string{"web-ui  web  /worktrees/web/cf-login  cf/login (current)"},
			wantCall: "Members /worktrees/web/cf-login",
		},
		{
			name: "members by name", cmd: "workspace.members",
			args:     map[string]string{"workspace": "base"},
			wantMsg:  []string{"/worktrees/web/cf-login  cf/login\napi"},
			wantCall: "Members base",
		},
		{name: "members outside a workspace", cmd: "workspace.members", args: map[string]string{"cwd": "/tmp"}, wantMsg: []string{"/tmp is not inside a workspace worktree"}, wantErr: errAnyCmd},
		{
			name: "add repo from a member's cwd", cmd: "workspace.add-repo",
			args:     map[string]string{"repo": "lib", "cwd": "/worktrees/web/cf-login"},
			wantMsg:  []string{"added lib to workspace base: /worktrees/lib/cf-login on cf/login"},
			wantCall: "AddRepo /worktrees/web/cf-login lib",
		},
		{
			name: "remove repo", cmd: "workspace.remove-repo",
			args:     map[string]string{"repo": "api", "workspace": "base", "force": "true", "delete-branch": "true"},
			wantMsg:  []string{"removed api from workspace base (1 left)"},
			wantCall: "RemoveRepo base api force delete-branch",
		},
		{
			name: "list", cmd: "workspace.list",
			wantMsg: []string{"base (w-1) on cf/login, 2 repositories"},
		},
		{
			name: "remove", cmd: "workspace.remove", args: map[string]string{"workspace": "base"},
			wantMsg: []string{"removed workspace base"}, wantCall: "Remove base",
		},
		{name: "remove needs a workspace", cmd: "workspace.remove", wantErr: command.ErrInvalidArgs},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, fake := newWorkspaceRegistry(t)
			if _, err := fake.Create(context.Background(), wsCreate("base", "web", "api")); err != nil {
				t.Fatal(err)
			}
			res, err := reg.Invoke(context.Background(), tt.ctx, tt.cmd, tt.args, command.Confirmed(true))
			switch {
			case tt.wantErr == errAnyCmd && err == nil:
				t.Fatal("err = nil, want an error")
			case tt.wantErr != errAnyCmd && !errors.Is(err, tt.wantErr):
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			text := res.Message
			if err != nil {
				text = err.Error()
			}
			for _, w := range tt.wantMsg {
				if !strings.Contains(text, w) {
					t.Errorf("message = %q, want it to contain %q", text, w)
				}
			}
			if tt.wantCall != "" {
				calls := fake.Calls()
				if last := calls[len(calls)-1]; !strings.HasPrefix(last, tt.wantCall) && !strings.Contains(strings.Join(calls, "\n"), tt.wantCall) {
					t.Errorf("calls = %q, want %q", calls, tt.wantCall)
				}
			}
			if tt.wantJSON != "" {
				j, jerr := res.EncodeJSON()
				if jerr != nil || !strings.Contains(string(j), tt.wantJSON) {
					t.Errorf("json = %s (%v), want %s", j, jerr, tt.wantJSON)
				}
			}
		})
	}
}

func TestWorkspaceRemovalsNeedConfirmation(t *testing.T) {
	reg, fake := newWorkspaceRegistry(t)
	if _, err := fake.Create(context.Background(), wsCreate("base", "web")); err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		cmd  string
		args map[string]string
		want string
	}{
		{"workspace.remove", map[string]string{"workspace": "base"}, "Remove workspace base? This deletes every member worktree from disk."},
		{"workspace.remove-repo", map[string]string{"repo": "web"}, "Remove repository web from its workspace? This deletes its worktree from disk."},
	} {
		_, err := reg.Invoke(context.Background(), command.Context{}, tt.cmd, tt.args)
		var ce *command.ConfirmError
		if !errors.As(err, &ce) || ce.Message != tt.want {
			t.Errorf("%s: err = %v, want confirmation %q", tt.cmd, err, tt.want)
		}
	}
	if calls := fake.Calls(); len(calls) != 1 {
		t.Errorf("calls = %q", calls)
	}
}

var errAnyCmd = errors.New("any error")

func wsCreate(name string, repos ...string) workspace.CreateOptions {
	o := workspace.CreateOptions{Name: name, Branch: "cf/login"}
	for _, r := range repos {
		o.Members = append(o.Members, workspace.MemberSpec{Repo: r})
	}
	return o
}
