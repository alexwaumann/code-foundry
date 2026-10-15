package command_test

import (
	"cmp"
	"context"
	"errors"
	"strings"
	"testing"

	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

const (
	actApp  = "/cf-test/src/app"
	actFeat = "/cf-test/src/app/.claude/worktrees/feat"
	actLib  = "/cf-test/src/lib"
)

var actionRepos = []*v1.Repo{
	{Id: "r1", Name: "app", Path: actApp, Worktrees: []*v1.Worktree{{RepoId: "r1", Path: actApp}, {RepoId: "r1", Path: actFeat}}},
	{Id: "r2", Name: "lib", Path: actLib, Worktrees: []*v1.Worktree{{RepoId: "r2", Path: actLib}}},
}

func actionRegistry(t *testing.T, act *commandtest.Action, sess *v1.Session) *command.Registry {
	t.Helper()
	reg := command.NewRegistry()
	if err := command.RegisterAction(reg, command.ActionDeps{
		Action:  act,
		Repo:    &commandtest.Repo{Repos: actionRepos},
		Session: &commandtest.Session{Current: cmp.Or(sess, &v1.Session{RepoId: "r1", WorktreePath: actFeat})},
	}); err != nil {
		t.Fatal(err)
	}
	return reg
}

func TestActionRunOwnerAndMode(t *testing.T) {
	gui := func(c command.Context) command.Context { c.ActiveView = "session"; return c }
	tests := []struct {
		name    string
		ctx     command.Context
		args    map[string]string
		session *v1.Session
		wantErr error
		wantMsg string
		want    *v1.RunActionRequest
	}{
		// The same owner terminal.new would pick.
		{name: "a thread (the agent's CODE_FOUNDRY_SESSION) owns it", ctx: command.Context{ActiveSessionID: "s1"},
			args: map[string]string{"action": "test", "here": "/cf-test/elsewhere"},
			want: &v1.RunActionRequest{Action: "test", SessionId: "s1", RepoId: "r1", WorktreePath: actFeat}},
		{name: "a thread in the GUI", ctx: gui(command.Context{ActiveSessionID: "s1", ActiveRepoID: "r1", ActiveWorktreePath: actFeat}),
			args: map[string]string{"action": "test"},
			want: &v1.RunActionRequest{Action: "test", SessionId: "s1", RepoId: "r1", WorktreePath: actFeat}},
		{name: "a worktree in the GUI", ctx: command.Context{ActiveRepoID: "r1", ActiveWorktreePath: actApp, ActiveView: "projects"},
			args: map[string]string{"action": "test"}, want: &v1.RunActionRequest{Action: "test", RepoId: "r1", WorktreePath: actApp}},
		{name: "the CLI's working directory", args: map[string]string{"action": "Lint", "here": actFeat + "/pkg"},
			want: &v1.RunActionRequest{Action: "Lint", RepoId: "r1", WorktreePath: actFeat}},
		{name: "--background", args: map[string]string{"action": "dev", "here": actLib, "background": "true"},
			want: &v1.RunActionRequest{Action: "dev", RepoId: "r2", WorktreePath: actLib, Mode: v1.ActionRunMode_ACTION_RUN_MODE_BACKGROUND}},
		{name: "--terminal", args: map[string]string{"action": "dev", "here": actLib, "terminal": "true"},
			want: &v1.RunActionRequest{Action: "dev", RepoId: "r2", WorktreePath: actLib, Mode: v1.ActionRunMode_ACTION_RUN_MODE_TERMINAL}},
		{name: "--background with --terminal", args: map[string]string{"action": "dev", "here": actLib, "background": "true", "terminal": "true"},
			wantErr: command.ErrInvalidArgs, wantMsg: "exclude each other"},
		{name: "outside every project", args: map[string]string{"action": "dev", "here": "/cf-test/elsewhere"},
			wantErr: command.ErrInvalidArgs, wantMsg: "/cf-test/elsewhere is not inside a registered project"},
		{name: "no owner at all", args: map[string]string{"action": "dev"}, wantErr: command.ErrInvalidArgs, wantMsg: "action.run needs a thread"},
		{name: "the dashboard does not offer it", ctx: command.Context{ActiveView: "dashboard"}, args: map[string]string{"action": "dev"},
			wantErr: command.ErrUnavailable},
		{name: "no action", ctx: command.Context{ActiveSessionID: "s1"}, wantErr: command.ErrInvalidArgs},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			act := &commandtest.Action{}
			reg := actionRegistry(t, act, tt.session)
			res, err := reg.Invoke(context.Background(), tt.ctx, "action.run", tt.args)
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) || !strings.Contains(err.Error(), tt.wantMsg) {
					t.Fatalf("err = %v, want %v containing %q", err, tt.wantErr, tt.wantMsg)
				}
				if len(act.Requests()) != 0 {
					t.Errorf("backend called: %v", act.Requests())
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			reqs := act.Requests()
			if len(reqs) != 1 || !proto.Equal(reqs[0], tt.want) {
				t.Fatalf("requests = %v, want %v", reqs, tt.want)
			}
			if res.ExitCode != 0 || !strings.HasPrefix(res.Message, "started ") {
				t.Errorf("result = %+v", res)
			}
		})
	}
}

func TestActionRunWait(t *testing.T) {
	tests := []struct {
		name     string
		finished *v1.ActionRun
		wantMsg  string
		wantCode int
	}{
		{name: "a background run's output and code",
			finished: &v1.ActionRun{Id: "r1", ActionName: "Test", Mode: v1.ActionRunMode_ACTION_RUN_MODE_BACKGROUND, ExitCode: 3, Output: "--- FAIL\n"},
			wantMsg:  "--- FAIL\nTest exited with code 3 (run r1)", wantCode: 3},
		{name: "success",
			finished: &v1.ActionRun{Id: "r1", ActionName: "Test", Mode: v1.ActionRunMode_ACTION_RUN_MODE_BACKGROUND, Output: "ok\n"},
			wantMsg:  "ok\nTest exited with code 0 (run r1)"},
		{name: "a truncated output says so",
			finished: &v1.ActionRun{Id: "r1", ActionName: "Test", Mode: v1.ActionRunMode_ACTION_RUN_MODE_BACKGROUND, Output: "tail", OutputTruncated: true},
			wantMsg:  "[earlier output dropped; the last 64 KiB follow]\ntail\nTest exited with code 0 (run r1)"},
		{name: "a terminal run reports its code only",
			finished: &v1.ActionRun{Id: "r1", ActionName: "Dev", Mode: v1.ActionRunMode_ACTION_RUN_MODE_TERMINAL, TerminalId: "t4", ExitCode: 130},
			wantMsg:  "Dev exited with code 130 in terminal t4 (run r1)", wantCode: 130},
		{name: "a terminal closed before its exit was seen",
			finished: &v1.ActionRun{Id: "r1", ActionName: "Dev", Mode: v1.ActionRunMode_ACTION_RUN_MODE_TERMINAL, TerminalId: "t4", ExitCode: -1},
			wantMsg:  "terminal t4 was closed before Dev finished (run r1)", wantCode: 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			act := &commandtest.Action{Finished: tt.finished}
			reg := actionRegistry(t, act, nil)
			for _, name := range []string{"action.run", "action.wait"} {
				args := map[string]string{"action": "test", "wait": "true", "background": "true"}
				if name == "action.wait" {
					args = map[string]string{"run": "r1"}
				}
				res, err := reg.Invoke(context.Background(), command.Context{ActiveSessionID: "s1"}, name, args)
				if err != nil {
					t.Fatal(err)
				}
				if res.Message != tt.wantMsg || res.ExitCode != tt.wantCode {
					t.Errorf("%s = %q exit %d, want %q exit %d", name, res.Message, res.ExitCode, tt.wantMsg, tt.wantCode)
				}
			}
			reqs := act.Requests()
			if w, ok := reqs[1].(*v1.WaitActionRunRequest); !ok || w.GetRunId() != "r1" {
				t.Errorf("requests = %v", reqs)
			}
		})
	}
}

func TestActionProject(t *testing.T) {
	gui := func(c command.Context) command.Context { c.ActiveView = "projects"; return c }
	tests := []struct {
		name     string
		ctx      command.Context
		args     map[string]string
		session  *v1.Session
		wantRepo string
		wantErr  error
		wantMsg  string
	}{
		{name: "the thread's project", ctx: command.Context{ActiveSessionID: "s1"}, args: map[string]string{"here": actLib}, wantRepo: "r1"},
		{name: "the GUI's project", ctx: gui(command.Context{ActiveRepoID: "r2"}), wantRepo: "r2"},
		{name: "the GUI's worktree", ctx: gui(command.Context{ActiveWorktreePath: actFeat}), wantRepo: "r1"},
		{name: "the working directory", args: map[string]string{"here": actLib + "/src"}, wantRepo: "r2"},
		{name: "--repo by id", args: map[string]string{"repo": "r2", "here": actApp}, wantRepo: "r2"},
		{name: "--repo by name", args: map[string]string{"repo": "lib"}, wantRepo: "r2"},
		{name: "--repo by path", args: map[string]string{"repo": actFeat + "/x"}, wantRepo: "r1"},
		{name: "--repo unknown", args: map[string]string{"repo": "nope"}, wantErr: command.ErrInvalidArgs, wantMsg: `no project "nope"`},
		{name: "--repo outside every project", args: map[string]string{"repo": "/cf-test/elsewhere"}, wantErr: command.ErrInvalidArgs,
			wantMsg: "not inside a registered project"},
		{name: "a thread without a project", ctx: command.Context{ActiveSessionID: "s1"}, session: &v1.Session{WorktreePath: "/cf-test/home"},
			wantErr: command.ErrInvalidArgs, wantMsg: "has no project"},
		{name: "nothing to go on", wantErr: command.ErrInvalidArgs, wantMsg: "actions belong to a project"},
		{name: "the dashboard", ctx: command.Context{ActiveView: "dashboard"}, wantErr: command.ErrUnavailable},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			act := &commandtest.Action{}
			reg := actionRegistry(t, act, tt.session)
			_, err := reg.Invoke(context.Background(), tt.ctx, "action.list", tt.args)
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) || !strings.Contains(err.Error(), tt.wantMsg) {
					t.Fatalf("err = %v, want %v containing %q", err, tt.wantErr, tt.wantMsg)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			reqs := act.Requests()
			if len(reqs) != 1 || reqs[0].(*v1.ListActionsRequest).GetRepoId() != tt.wantRepo {
				t.Errorf("requests = %v, want List in %s", reqs, tt.wantRepo)
			}
		})
	}
}

func TestActionAddEditRemove(t *testing.T) {
	existing := []*v1.Action{
		{Id: "a-1", RepoId: "r1", Name: "Test", Command: "go test ./...", InTerminal: true},
		{Id: "a-2", RepoId: "r2", Name: "Test", Command: "pnpm test"},
	}
	ptr := func(b bool) *bool { return &b }
	str := func(s string) *string { return &s }
	tests := []struct {
		name    string
		cmd     string
		ctx     command.Context
		args    map[string]string
		want    proto.Message // the last request
		wantErr error
		wantMsg string
	}{
		{name: "add with defaults", cmd: "action.add", args: map[string]string{"name": "Lint", "command": "make lint", "here": actApp},
			want: &v1.CreateActionRequest{RepoId: "r1", Name: "Lint", Command: "make lint", Icon: v1.ActionIcon_ACTION_ICON_PLAY, InTerminal: true}},
		{name: "add in the background for new worktrees", cmd: "action.add", ctx: command.Context{ActiveSessionID: "s1"},
			args: map[string]string{"name": "Setup", "command": "pnpm i", "icon": "configure", "in-terminal": "false", "on-worktree-create": "true"},
			want: &v1.CreateActionRequest{RepoId: "r1", Name: "Setup", Command: "pnpm i", Icon: v1.ActionIcon_ACTION_ICON_CONFIGURE, OnWorktreeCreate: true}},
		{name: "add with an unknown icon", cmd: "action.add", args: map[string]string{"name": "X", "command": "x", "icon": "rocket", "here": actApp},
			wantErr: command.ErrInvalidArgs},
		{name: "edit by name in the working directory's project", cmd: "action.edit",
			args: map[string]string{"action": "test", "here": actLib, "command": "pnpm vitest", "in-terminal": "true"},
			want: &v1.UpdateActionRequest{Id: "a-2", Command: str("pnpm vitest"), InTerminal: ptr(true)}},
		{name: "edit by id from anywhere", cmd: "action.edit", args: map[string]string{"action": "a-1", "name": "Unit", "position": "0", "icon": "test"},
			want: &v1.UpdateActionRequest{Id: "a-1", Name: str("Unit"), Position: proto.Int32(0), Icon: v1.ActionIcon_ACTION_ICON_TEST.Enum()}},
		{name: "edit without a change", cmd: "action.edit", args: map[string]string{"action": "a-1"}, wantErr: command.ErrInvalidArgs,
			wantMsg: "nothing to change"},
		{name: "edit a name the project lacks", cmd: "action.edit", args: map[string]string{"action": "deploy", "here": actApp, "name": "x"},
			wantMsg: `no action "deploy"`},
		{name: "remove by name for a thread", cmd: "action.remove", ctx: command.Context{ActiveSessionID: "s1"}, args: map[string]string{"action": "TEST"},
			want: &v1.DeleteActionRequest{Id: "a-1"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			act := &commandtest.Action{Actions: existing}
			reg := actionRegistry(t, act, nil)
			_, err := reg.Invoke(context.Background(), tt.ctx, tt.cmd, tt.args)
			if tt.wantErr != nil || tt.wantMsg != "" {
				if err == nil || tt.wantErr != nil && !errors.Is(err, tt.wantErr) || !strings.Contains(err.Error(), tt.wantMsg) {
					t.Fatalf("err = %v, want %v containing %q", err, tt.wantErr, tt.wantMsg)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			reqs := act.Requests()
			if len(reqs) == 0 || !proto.Equal(reqs[len(reqs)-1], tt.want) {
				t.Errorf("requests = %v, want last %v", reqs, tt.want)
			}
		})
	}
}
