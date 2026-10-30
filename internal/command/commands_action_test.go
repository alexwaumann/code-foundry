package command_test

import (
	"cmp"
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

const (
	actApp  = "/cf-test/src/app"
	actFeat = "/cf-test/src/app/.claude/worktrees/feat"
	actLib  = "/cf-test/src/lib"
)

var actionProjects = []*v1.Project{
	{Id: "r1", Name: "app", Path: actApp, Worktrees: []*v1.Worktree{{ProjectId: "r1", Path: actApp}, {ProjectId: "r1", Path: actFeat}}},
	{Id: "r2", Name: "lib", Path: actLib, Worktrees: []*v1.Worktree{{ProjectId: "r2", Path: actLib}}},
}

func actionRegistry(t *testing.T, act *commandtest.Action, th *v1.Thread) *command.Registry {
	t.Helper()
	reg := command.NewRegistry()
	if err := command.RegisterAction(reg, command.ActionDeps{
		Action:  act,
		Project: &commandtest.Project{Projects: actionProjects},
		Thread:  &commandtest.Thread{Current: cmp.Or(th, &v1.Thread{ProjectId: "r1", WorktreePath: actFeat})},
	}); err != nil {
		t.Fatal(err)
	}
	return reg
}

func TestActionRunOwnerAndMode(t *testing.T) {
	gui := func(c command.Context) command.Context { c.ActiveView = "thread"; return c }
	tests := []struct {
		name    string
		ctx     command.Context
		args    map[string]string
		thread  *v1.Thread
		wantErr error
		wantMsg string
		want    *v1.RunActionRequest
	}{
		// The same owner terminal.new would pick.
		{name: "a thread (the agent's CODE_FOUNDRY_THREAD) owns it", ctx: command.Context{ActiveThreadID: "s1"},
			args: map[string]string{"action": "test", "here": "/cf-test/elsewhere"},
			want: &v1.RunActionRequest{Action: "test", ThreadId: "s1", WorktreePath: actFeat}},
		{name: "a thread in the GUI", ctx: gui(command.Context{ActiveThreadID: "s1", ActiveProjectID: "r1", ActiveWorktreePath: actFeat}),
			args: map[string]string{"action": "test"},
			want: &v1.RunActionRequest{Action: "test", ThreadId: "s1", WorktreePath: actFeat}},
		{name: "a worktree in the GUI", ctx: command.Context{ActiveProjectID: "r1", ActiveWorktreePath: actApp, ActiveView: "projects"},
			args: map[string]string{"action": "test"}, want: &v1.RunActionRequest{Action: "test", ProjectId: "r1", WorktreePath: actApp}},
		{name: "the CLI's working directory", args: map[string]string{"action": "Lint", "here": actFeat + "/pkg"},
			want: &v1.RunActionRequest{Action: "Lint", ProjectId: "r1", WorktreePath: actFeat}},
		{name: "--background", args: map[string]string{"action": "dev", "here": actLib, "background": "true"},
			want: &v1.RunActionRequest{Action: "dev", ProjectId: "r2", WorktreePath: actLib, Mode: v1.ActionRunMode_ACTION_RUN_MODE_BACKGROUND}},
		{name: "--terminal", args: map[string]string{"action": "dev", "here": actLib, "terminal": "true"},
			want: &v1.RunActionRequest{Action: "dev", ProjectId: "r2", WorktreePath: actLib, Mode: v1.ActionRunMode_ACTION_RUN_MODE_TERMINAL}},
		{name: "--background with --terminal", args: map[string]string{"action": "dev", "here": actLib, "background": "true", "terminal": "true"},
			wantErr: command.ErrInvalidArgs, wantMsg: "exclude each other"},
		{name: "outside every project", args: map[string]string{"action": "dev", "here": "/cf-test/elsewhere"},
			wantErr: command.ErrInvalidArgs, wantMsg: "/cf-test/elsewhere is not inside a registered project"},
		{name: "no owner at all", args: map[string]string{"action": "dev"}, wantErr: command.ErrInvalidArgs, wantMsg: "action.run needs a thread"},
		{name: "the Pull Requests page does not offer it", ctx: command.Context{ActiveView: "pullrequests"}, args: map[string]string{"action": "dev"},
			wantErr: command.ErrUnavailable},
		{name: "no action", ctx: command.Context{ActiveThreadID: "s1"}, wantErr: command.ErrInvalidArgs},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			act := &commandtest.Action{}
			reg := actionRegistry(t, act, tt.thread)
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
				res, err := reg.Invoke(context.Background(), command.Context{ActiveThreadID: "s1"}, name, args)
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

// A caller that goes away while action.run --wait waits stops the background run it
// started; a terminal run, on screen, stays.
func TestActionRunWaitInterrupted(t *testing.T) {
	for _, tt := range []struct {
		name     string
		mode     string
		wantStop bool
	}{{"background", "background", true}, {"terminal", "terminal", false}} {
		t.Run(tt.name, func(t *testing.T) {
			act := &commandtest.Action{WaitBlocks: true}
			reg := actionRegistry(t, act, nil)
			ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
			defer cancel()
			_, err := reg.Invoke(ctx, command.Context{ActiveThreadID: "s1"}, "action.run", map[string]string{"action": "test", "wait": "true", tt.mode: "true"})
			if !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("err = %v, want the deadline", err)
			}
			var stops []*v1.StopActionRunRequest
			for _, m := range act.Requests() {
				if s, ok := m.(*v1.StopActionRunRequest); ok {
					stops = append(stops, s)
				}
			}
			if tt.wantStop != (len(stops) == 1 && stops[0].GetRunId() == "r1") || len(stops) > 1 {
				t.Errorf("stop requests = %v, want a stop: %v", stops, tt.wantStop)
			}
		})
	}
	// action.wait on a run someone else started does not stop it.
	act := &commandtest.Action{WaitBlocks: true}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := actionRegistry(t, act, nil).Invoke(ctx, command.Context{}, "action.wait", map[string]string{"run": "r1"}); err == nil {
		t.Fatal("action.wait returned without its run")
	}
	for _, m := range act.Requests() {
		if _, ok := m.(*v1.StopActionRunRequest); ok {
			t.Errorf("action.wait stopped the run")
		}
	}
}

func TestActionStop(t *testing.T) {
	act := &commandtest.Action{}
	reg := actionRegistry(t, act, nil)
	res, err := reg.Invoke(context.Background(), command.Context{}, "action.stop", map[string]string{"run": "r1"})
	if err != nil || res.Message != "stopping Test (run r1)" {
		t.Fatalf("action.stop = %+v, %v", res, err)
	}
	act.Stopped = &v1.ActionRun{Id: "r1", ActionName: "Test", State: v1.ActionRunState_ACTION_RUN_STATE_EXITED, ExitCode: 2}
	res, err = reg.Invoke(context.Background(), command.Context{}, "action.stop", map[string]string{"run": "r1"})
	if err != nil || res.Message != "Test had finished already, with code 2 (run r1)" {
		t.Fatalf("action.stop on a finished run = %+v, %v", res, err)
	}
}

func TestActionProject(t *testing.T) {
	gui := func(c command.Context) command.Context { c.ActiveView = "projects"; return c }
	tests := []struct {
		name        string
		ctx         command.Context
		args        map[string]string
		thread      *v1.Thread
		wantProject string
		wantErr     error
		wantMsg     string
	}{
		{name: "the thread's project", ctx: command.Context{ActiveThreadID: "s1"}, args: map[string]string{"here": actLib}, wantProject: "r1"},
		{name: "the GUI's project", ctx: gui(command.Context{ActiveProjectID: "r2"}), wantProject: "r2"},
		{name: "the GUI's worktree", ctx: gui(command.Context{ActiveWorktreePath: actFeat}), wantProject: "r1"},
		{name: "the working directory", args: map[string]string{"here": actLib + "/src"}, wantProject: "r2"},
		{name: "--project by id", args: map[string]string{"project": "r2", "here": actApp}, wantProject: "r2"},
		{name: "--project by name", args: map[string]string{"project": "lib"}, wantProject: "r2"},
		{name: "--project by path", args: map[string]string{"project": actFeat + "/x"}, wantProject: "r1"},
		{name: "--project unknown", args: map[string]string{"project": "nope"}, wantErr: command.ErrInvalidArgs, wantMsg: `no project "nope"`},
		{name: "--project outside every project", args: map[string]string{"project": "/cf-test/elsewhere"}, wantErr: command.ErrInvalidArgs,
			wantMsg: "not inside a registered project"},
		{name: "a thread without a project", ctx: command.Context{ActiveThreadID: "s1"}, thread: &v1.Thread{WorktreePath: "/cf-test/home"},
			wantErr: command.ErrInvalidArgs, wantMsg: "has no project"},
		{name: "nothing to go on", wantErr: command.ErrInvalidArgs, wantMsg: "actions belong to a project"},
		{name: "the Pull Requests page", ctx: command.Context{ActiveView: "pullrequests"}, wantErr: command.ErrUnavailable},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			act := &commandtest.Action{}
			reg := actionRegistry(t, act, tt.thread)
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
			if len(reqs) != 2 || reqs[0].(*v1.ListActionsRequest).GetProjectId() != tt.wantProject {
				t.Fatalf("requests = %v, want List in %s", reqs, tt.wantProject)
			}
			if lr := reqs[1].(*v1.LastActionRunRequest); lr.GetProjectId() != tt.wantProject || lr.GetThreadId() != tt.ctx.ActiveThreadID {
				t.Errorf("LastRun = %v, want %s for thread %q", lr, tt.wantProject, tt.ctx.ActiveThreadID)
			}
		})
	}
}

func TestActionAddEditRemove(t *testing.T) {
	existing := []*v1.Action{
		{Id: "a-1", ProjectId: "r1", Name: "Test", Command: "go test ./...", InTerminal: true},
		{Id: "a-2", ProjectId: "r2", Name: "Test", Command: "pnpm test"},
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
			want: &v1.CreateActionRequest{ProjectId: "r1", Name: "Lint", Command: "make lint", Icon: v1.ActionIcon_ACTION_ICON_PLAY, InTerminal: true}},
		{name: "add in the background for new worktrees", cmd: "action.add", ctx: command.Context{ActiveThreadID: "s1"},
			args: map[string]string{"name": "Setup", "command": "pnpm i", "icon": "configure", "in-terminal": "false", "on-worktree-create": "true"},
			want: &v1.CreateActionRequest{ProjectId: "r1", Name: "Setup", Command: "pnpm i", Icon: v1.ActionIcon_ACTION_ICON_CONFIGURE, OnWorktreeCreate: true}},
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
		{name: "remove by name for a thread", cmd: "action.remove", ctx: command.Context{ActiveThreadID: "s1"}, args: map[string]string{"action": "TEST"},
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

// action.list shows when each action last ran and the action a thread's card offers;
// action.last is that pick alone.
func TestActionLastRun(t *testing.T) {
	ago := func(d time.Duration) *timestamppb.Timestamp { return timestamppb.New(time.Now().Add(-d)) }
	acts := []*v1.Action{
		{Id: "a-1", ProjectId: "r1", Name: "Test", Command: "go test ./...", InTerminal: true},
		{Id: "a-2", ProjectId: "r1", Name: "Build", Command: "make"},
		{Id: "a-3", ProjectId: "r1", Name: "Lint", Command: "golangci-lint run"},
	}
	last := []*v1.ActionRunRecord{
		{RunId: "r-2", ActionId: "a-2", ProjectId: "r1", ThreadId: "s1", StartedAt: ago(3 * time.Minute)},
		{RunId: "r-1", ActionId: "a-1", ProjectId: "r1", ThreadId: "s9", StartedAt: ago(2 * time.Hour)},
		{RunId: "r-3", ActionId: "a-3", ProjectId: "r1", StartedAt: ago(5 * time.Hour)},
	}
	tests := []struct {
		name string
		cmd  string
		ctx  command.Context
		args map[string]string
		pick *v1.LastActionRunResponse
		want []string
		req  *v1.LastActionRunRequest
	}{
		{name: "list in a thread", cmd: "action.list", ctx: command.Context{ActiveThreadID: "s1"},
			pick: &v1.LastActionRunResponse{Source: v1.ActionPickSource_ACTION_PICK_SOURCE_THREAD, Action: acts[1], Last: last[0]},
			want: []string{"LAST RUN", "3 min ago, here", "2 h ago, thread s9", "5 h ago, worktree",
				"to run again for thread s1: Build (a-2), ran last in this thread, 3 min ago"},
			req: &v1.LastActionRunRequest{ProjectId: "r1", ThreadId: "s1"}},
		{name: "last for another thread", cmd: "action.last", ctx: command.Context{ActiveProjectID: "r1", ActiveView: "projects"}, args: map[string]string{"thread": "s2"},
			pick: &v1.LastActionRunResponse{Source: v1.ActionPickSource_ACTION_PICK_SOURCE_PROJECT, Action: acts[1], Last: last[0]},
			want: []string{"to run again for thread s2: Build (a-2), ran last in this project, 3 min ago"},
			req:  &v1.LastActionRunRequest{ProjectId: "r1", ThreadId: "s2"}},
		{name: "last with nothing run", cmd: "action.last", ctx: command.Context{ActiveProjectID: "r1", ActiveView: "projects"},
			want: []string{"to run again for the project: Test (a-1), the project's first action; none has run yet"},
			req:  &v1.LastActionRunRequest{ProjectId: "r1"}},
		{name: "last without actions", cmd: "action.last", ctx: command.Context{ActiveProjectID: "r2", ActiveView: "projects"},
			want: []string{"no actions in this project"}, req: &v1.LastActionRunRequest{ProjectId: "r2"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			act := &commandtest.Action{Actions: acts, LastRuns: last, Pick: tt.pick}
			res, err := actionRegistry(t, act, nil).Invoke(context.Background(), tt.ctx, tt.cmd, tt.args)
			if err != nil {
				t.Fatal(err)
			}
			for _, w := range tt.want {
				if !strings.Contains(res.Message, w) {
					t.Errorf("message lacks %q:\n%s", w, res.Message)
				}
			}
			reqs := act.Requests()
			if got := reqs[len(reqs)-1]; !proto.Equal(got, tt.req) {
				t.Errorf("LastRun request = %v, want %v", got, tt.req)
			}
		})
	}
}
