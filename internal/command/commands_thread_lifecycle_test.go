package command_test

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/model"
)

func newLifecycleRegistry(t *testing.T) (*command.Registry, *commandtest.Thread, *commandtest.Emitter) {
	t.Helper()
	reg := command.NewRegistry()
	b := &commandtest.Thread{}
	e := &commandtest.Emitter{Delivered: 1, OpenWindows: 1}
	if err := command.RegisterThreadLifecycle(reg, b, e); err != nil {
		t.Fatal(err)
	}
	return reg, b, e
}

func focusIntent(id string) *v1.UiIntent {
	return &v1.UiIntent{Intent: &v1.UiIntent_FocusThread_{FocusThread: &v1.UiIntent_FocusThread{ThreadId: id}}}
}

func TestThreadLifecycleCommands(t *testing.T) {
	t.Setenv("HOME", "/Users/me")
	auto := v1.PermissionMode_PERMISSION_MODE_AUTO
	disconnected := &v1.Thread{State: v1.ThreadState_THREAD_STATE_DISCONNECTED}
	tests := []struct {
		name       string
		cmd        string
		ctx        command.Context
		args       map[string]string
		current    *v1.Thread
		placement  *v1.CreateThreadResponse // Create's placement fields
		backendErr error
		wantErr    error
		wantCode   connect.Code
		wantMsg    string
		wantReqs   []proto.Message // backend requests in order
		wantIntent *v1.UiIntent
	}{
		{name: "new from worktree context", cmd: "thread.new", ctx: command.Context{ActiveWorktreePath: "/wt"},
			args:     map[string]string{"model": "claude-opus-4-8[1m]", "effort": "high"},
			wantMsg:  "created thread s1 in /wt",
			wantReqs: []proto.Message{&v1.CreateThreadRequest{WorktreePath: "/wt", Model: "claude-opus-4-8[1m]", Effort: "high", PermissionMode: auto}}, wantIntent: focusIntent("s1")},
		{name: "new with explicit worktree and prompt", cmd: "thread.new",
			args:     map[string]string{"worktree": "~/src/app", "name": "fix-it", "prompt": "hello"},
			wantMsg:  "created thread fix-it (s1) in /Users/me/src/app",
			wantReqs: []proto.Message{&v1.CreateThreadRequest{WorktreePath: "/Users/me/src/app", Name: "fix-it", InitialPrompt: "hello", PermissionMode: auto}}},
		{name: "new with the composer's prompt", cmd: "thread.new", ctx: command.Context{ActiveWorktreePath: "/wt"},
			args:     map[string]string{"prompt": "/tdd go", "composer-prompt": "[/tdd](cf-skill://~/tdd) go"},
			wantMsg:  "created thread s1 in /wt",
			wantReqs: []proto.Message{&v1.CreateThreadRequest{WorktreePath: "/wt", InitialPrompt: "/tdd go", ComposerPrompt: "[/tdd](cf-skill://~/tdd) go", PermissionMode: auto}}, wantIntent: focusIntent("s1")},
		{name: "new refuses render (every thread is rendered)", cmd: "thread.new", ctx: command.Context{ActiveWorktreePath: "/wt"},
			args: map[string]string{"render": "rendered"}, wantErr: command.ErrInvalidArgs},
		{name: "new from project context", cmd: "thread.new", ctx: command.Context{ActiveProjectID: "r1"},
			wantReqs: []proto.Message{&v1.CreateThreadRequest{ProjectId: "r1", PermissionMode: auto}}},
		{name: "new supervised", cmd: "thread.new", args: map[string]string{"project": "r1", "permission": "supervised"},
			wantReqs: []proto.Message{&v1.CreateThreadRequest{ProjectId: "r1", PermissionMode: v1.PermissionMode_PERMISSION_MODE_SUPERVISED}}},
		{name: "new accept edits", cmd: "thread.new", args: map[string]string{"project": "r1", "permission": "accept-edits"},
			wantReqs: []proto.Message{&v1.CreateThreadRequest{ProjectId: "r1", PermissionMode: v1.PermissionMode_PERMISSION_MODE_ACCEPT_EDITS}}},
		{name: "new refuses full access", cmd: "thread.new", args: map[string]string{"project": "r1", "permission": "bypassPermissions"}, wantErr: command.ErrInvalidArgs},
		{name: "new worktree with base and attachments", cmd: "thread.new", ctx: command.Context{ActiveProjectID: "r1"},
			args:    map[string]string{"new-worktree": "true", "base": "origin/dev", "prompt": "look", "attachments": " /a/1.png, ,/a/2.png "},
			wantMsg: "created thread s1 in /worktrees/s1 (new worktree from origin/dev)",
			wantReqs: []proto.Message{&v1.CreateThreadRequest{ProjectId: "r1", InitialPrompt: "look", PermissionMode: auto,
				NewWorktree: &v1.NewWorktree{BaseRef: "origin/dev"}, Attachments: []string{"/a/1.png", "/a/2.png"}}}},
		{name: "new worktree with default base", cmd: "thread.new", args: map[string]string{"project": "r1", "new-worktree": "true"},
			wantReqs: []proto.Message{&v1.CreateThreadRequest{ProjectId: "r1", PermissionMode: auto, NewWorktree: &v1.NewWorktree{}}}},
		{name: "base needs new worktree", cmd: "thread.new", args: map[string]string{"project": "r1", "base": "main"}, wantErr: command.ErrInvalidArgs},
		// --base-from-origin overrides projects.base_from_origin for this worktree; unset
		// leaves the field nil so the setting decides (docs/notes/thread-new-base-origin.md).
		{name: "new worktree from a local branch, not origin's", cmd: "thread.new",
			args: map[string]string{"project": "r1", "new-worktree": "true", "base": "feat/lead", "base-from-origin": "no"},
			wantReqs: []proto.Message{&v1.CreateThreadRequest{ProjectId: "r1", PermissionMode: auto,
				NewWorktree: &v1.NewWorktree{BaseRef: "feat/lead", BaseFromOrigin: new(false)}}}},
		{name: "new worktree from origin's copy", cmd: "thread.new",
			args: map[string]string{"project": "r1", "new-worktree": "true", "base": "main", "base-from-origin": "yes"},
			wantReqs: []proto.Message{&v1.CreateThreadRequest{ProjectId: "r1", PermissionMode: auto,
				NewWorktree: &v1.NewWorktree{BaseRef: "main", BaseFromOrigin: new(true)}}}},
		{name: "new worktrees in several projects from local branches", cmd: "thread.new",
			args: map[string]string{"new-worktree": "true", "projects": "web,api", "base-from-origin": "no"},
			wantReqs: []proto.Message{&v1.CreateThreadRequest{PermissionMode: auto, ProjectIds: []string{"web", "api"},
				NewWorktree: &v1.NewWorktree{BaseFromOrigin: new(false)}}}},
		{name: "base-from-origin needs new worktree", cmd: "thread.new", args: map[string]string{"project": "r1", "base-from-origin": "no"}, wantErr: command.ErrInvalidArgs},
		{name: "base-from-origin takes yes or no", cmd: "thread.new",
			args: map[string]string{"project": "r1", "new-worktree": "true", "base-from-origin": "true"}, wantErr: command.ErrInvalidArgs},
		{name: "no project refuses base-from-origin", cmd: "thread.new", args: map[string]string{"no-project": "true", "base-from-origin": "yes"}, wantErr: command.ErrInvalidArgs},
		{name: "new worktree with a branch", cmd: "thread.new", args: map[string]string{"project": "r1", "new-worktree": "true", "branch": "feat/x"},
			wantReqs: []proto.Message{&v1.CreateThreadRequest{ProjectId: "r1", PermissionMode: auto, NewWorktree: &v1.NewWorktree{Branch: "feat/x"}}}},
		{name: "branch needs new worktree", cmd: "thread.new", args: map[string]string{"project": "r1", "branch": "x"}, wantErr: command.ErrInvalidArgs},
		{name: "new worktrees in several projects with a branch slug", cmd: "thread.new", args: map[string]string{"new-worktree": "true", "projects": "web,api", "branch": "add-filter"},
			wantReqs: []proto.Message{&v1.CreateThreadRequest{PermissionMode: auto, ProjectIds: []string{"web", "api"}, NewWorktree: &v1.NewWorktree{Branch: "add-filter"}}}},
		{name: "new unavailable in the GUI without a project or worktree", cmd: "thread.new", ctx: command.Context{ActiveView: "dashboard"}, wantErr: command.ErrUnavailable},
		{name: "new from the CLI needs a target", cmd: "thread.new", wantErr: command.ErrInvalidArgs},
		// From a thread (its CLI, or a page it shows) with no placement: where that thread runs.
		{name: "new from a thread runs where it does, like it", cmd: "thread.new", ctx: command.Context{ActiveThreadID: "s5"},
			args: map[string]string{"prompt": "go"}, current: &v1.Thread{ProjectId: "r1", WorktreePath: "/wt/r1"},
			wantReqs: []proto.Message{&v1.GetThreadRequest{Id: "s5"},
				&v1.CreateThreadRequest{LikeThreadId: "s5", InitialPrompt: "go", PermissionMode: auto}},
			wantIntent: focusIntent("s1")},
		{name: "new from a workspace thread is like it (its workspace too)", cmd: "thread.new", ctx: command.Context{ActiveThreadID: "s5"},
			current: &v1.Thread{ProjectId: "api", WorktreePath: "/wt/api", WorkspaceId: "w-1"},
			wantReqs: []proto.Message{&v1.GetThreadRequest{Id: "s5"},
				&v1.CreateThreadRequest{LikeThreadId: "s5", PermissionMode: auto}}},
		{name: "new from a no-project thread has no project", cmd: "thread.new", ctx: command.Context{ActiveThreadID: "s5"},
			current:  &v1.Thread{WorktreePath: "/Users/me"},
			wantReqs: []proto.Message{&v1.GetThreadRequest{Id: "s5"}, &v1.CreateThreadRequest{NoProject: true, PermissionMode: auto}}},
		{name: "new from a no-project thread refuses a new worktree", cmd: "thread.new", ctx: command.Context{ActiveThreadID: "s5"},
			args: map[string]string{"new-worktree": "true"}, current: &v1.Thread{WorktreePath: "/Users/me"}, wantErr: command.ErrInvalidArgs},
		{name: "new from a thread with a project names it", cmd: "thread.new", ctx: command.Context{ActiveThreadID: "s5"},
			args: map[string]string{"project": "r2"}, current: &v1.Thread{ProjectId: "r1", WorktreePath: "/wt/r1"},
			wantReqs: []proto.Message{&v1.CreateThreadRequest{ProjectId: "r2", PermissionMode: auto}}},
		{name: "new in a workspace", cmd: "thread.new", args: map[string]string{"workspace": "login", "project": "api"},
			wantMsg:  "created thread s1 in  (workspace login)",
			wantReqs: []proto.Message{&v1.CreateThreadRequest{WorkspaceId: "login", ProjectId: "api", PermissionMode: auto}}},
		{name: "new worktrees with the workspace's folder as the primary: no base", cmd: "thread.new",
			args:      map[string]string{"workspace": "login", "project": "workspace", "new-worktree": "true", "branch": "feat/x"},
			placement: &v1.CreateThreadResponse{}, // the daemon makes no worktree for a folder primary
			wantMsg:   "created thread s1 in /worktrees/s1 (workspace login) (worktrees on feat/x)",
			wantReqs: []proto.Message{&v1.CreateThreadRequest{WorkspaceId: "login", ProjectId: "workspace", PermissionMode: auto,
				NewWorktree: &v1.NewWorktree{Branch: "feat/x"}}}},
		{name: "new worktrees in several projects", cmd: "thread.new",
			args:    map[string]string{"new-worktree": "true", "projects": "web, api", "base": "origin/dev", "prompt": "fix login"},
			wantMsg: "created thread s1 in /worktrees/s1 (2 projects: api, web; thread checkouts lists them) (new worktree from origin/dev)",
			wantReqs: []proto.Message{&v1.CreateThreadRequest{InitialPrompt: "fix login", PermissionMode: auto, ProjectIds: []string{"web", "api"},
				NewWorktree: &v1.NewWorktree{BaseRef: "origin/dev"}}}},
		{name: "several projects in their checkouts", cmd: "thread.new", args: map[string]string{"projects": "web,api", "project": "api"},
			wantMsg:  "created thread s1 in  (2 projects: api, web; thread checkouts lists them)",
			wantReqs: []proto.Message{&v1.CreateThreadRequest{PermissionMode: auto, ProjectId: "api", ProjectIds: []string{"web", "api"}}}},
		{name: "like another thread, on a new branch", cmd: "thread.new", args: map[string]string{"like": "s-0", "new-branch": "true"},
			wantReqs: []proto.Message{&v1.CreateThreadRequest{PermissionMode: auto, LikeThreadId: "s-0", NewBranch: true, NewWorktree: &v1.NewWorktree{}}}},
		{name: "new-worktree=false is checkout mode", cmd: "thread.new", args: map[string]string{"project": "web", "new-worktree": "false"},
			wantReqs: []proto.Message{&v1.CreateThreadRequest{PermissionMode: auto, ProjectId: "web", CheckoutMode: true}}},
		{name: "new-branch refuses new-worktree=false", cmd: "thread.new", args: map[string]string{"like": "s-0", "new-branch": "true", "new-worktree": "false"}, wantErr: command.ErrInvalidArgs},
		{name: "workspace with projects", cmd: "thread.new", args: map[string]string{"workspace": "login", "projects": "web"},
			wantReqs: []proto.Message{&v1.CreateThreadRequest{WorkspaceId: "login", ProjectIds: []string{"web"}, PermissionMode: auto}}},
		{name: "workspace in new worktrees", cmd: "thread.new", args: map[string]string{"workspace": "login", "new-worktree": "true"},
			wantReqs: []proto.Message{&v1.CreateThreadRequest{WorkspaceId: "login", NewWorktree: &v1.NewWorktree{}, PermissionMode: auto}}},
		{name: "new without a project", cmd: "thread.new", args: map[string]string{"no-project": "true", "model": "claude-4.5-haiku[1m]", "prompt": "hi"},
			wantMsg:  "created thread s1 in /home (no project)",
			wantReqs: []proto.Message{&v1.CreateThreadRequest{NoProject: true, Model: "claude-4.5-haiku[1m]", InitialPrompt: "hi", PermissionMode: auto}}, wantIntent: focusIntent("s1")},
		{name: "new without a project from the composer", cmd: "thread.new", ctx: command.Context{ActiveView: "compose"},
			args:     map[string]string{"no-project": "true"},
			wantReqs: []proto.Message{&v1.CreateThreadRequest{NoProject: true, PermissionMode: auto}}},
		{name: "new from the composer still needs a target", cmd: "thread.new", ctx: command.Context{ActiveView: "compose"}, wantErr: command.ErrInvalidArgs},
		{name: "no project refuses project", cmd: "thread.new", args: map[string]string{"no-project": "true", "project": "r1"}, wantErr: command.ErrInvalidArgs},
		{name: "no project refuses a project from context", cmd: "thread.new", ctx: command.Context{ActiveProjectID: "r1"},
			args: map[string]string{"no-project": "true"}, wantErr: command.ErrInvalidArgs},
		{name: "no project refuses worktree", cmd: "thread.new", args: map[string]string{"no-project": "true", "worktree": "/wt"}, wantErr: command.ErrInvalidArgs},
		{name: "no project refuses workspace", cmd: "thread.new", args: map[string]string{"no-project": "true", "workspace": "login"}, wantErr: command.ErrInvalidArgs},
		{name: "no project refuses projects", cmd: "thread.new", args: map[string]string{"no-project": "true", "new-worktree": "true", "projects": "web,api"}, wantErr: command.ErrInvalidArgs},
		{name: "no project refuses new worktree", cmd: "thread.new", args: map[string]string{"no-project": "true", "new-worktree": "true"}, wantErr: command.ErrInvalidArgs},
		{name: "no project refuses base", cmd: "thread.new", args: map[string]string{"no-project": "true", "base": "main"}, wantErr: command.ErrInvalidArgs},
		{name: "no project refuses branch", cmd: "thread.new", args: map[string]string{"no-project": "true", "branch": "x"}, wantErr: command.ErrInvalidArgs},
		{name: "no project false still needs a target", cmd: "thread.new", args: map[string]string{"no-project": "false"}, wantErr: command.ErrInvalidArgs},
		{name: "new bad effort", cmd: "thread.new", args: map[string]string{"worktree": "/wt", "effort": "huge"}, wantErr: command.ErrInvalidArgs},
		{name: "new bad model", cmd: "thread.new", args: map[string]string{"worktree": "/wt", "model": "gpt"}, wantErr: command.ErrInvalidArgs},
		{name: "new pinned model", cmd: "thread.new", args: map[string]string{"worktree": "/wt", "model": "claude-opus-4-8[1m]"},
			wantMsg:  "created thread s1 in /wt",
			wantReqs: []proto.Message{&v1.CreateThreadRequest{WorktreePath: "/wt", Model: "claude-opus-4-8[1m]", PermissionMode: auto}}, wantIntent: focusIntent("s1")},
		{name: "new model outside the registry", cmd: "thread.new", args: map[string]string{"worktree": "/wt", "model": "claude-opus-5-5"}, wantErr: command.ErrInvalidArgs},
		// Gone (docs/notes/thread-lifecycle.md): a message starts a thread, the daemon
		// stops idle ones.
		{name: "no close", cmd: "thread.close", args: map[string]string{"id": "s5"}, wantErr: command.ErrUnknownCommand},
		{name: "no reconnect", cmd: "thread.reconnect", args: map[string]string{"id": "s5"}, current: disconnected, wantErr: command.ErrUnknownCommand},
		{name: "rename", cmd: "thread.rename", ctx: command.Context{ActiveThreadID: "s5"}, args: map[string]string{"name": "new"},
			wantMsg: "renamed thread new (s5)", wantReqs: []proto.Message{&v1.RenameThreadRequest{Id: "s5", Name: "new"}}},
		{name: "rename needs a name", cmd: "thread.rename", ctx: command.Context{ActiveThreadID: "s5"}, wantErr: command.ErrInvalidArgs},
		{name: "fork", cmd: "thread.fork", ctx: command.Context{ActiveThreadID: "s5"},
			wantMsg: "forked s5 into s2", wantReqs: []proto.Message{&v1.ForkThreadRequest{Id: "s5"}}, wantIntent: focusIntent("s2")},
		{name: "remove", cmd: "thread.remove", args: map[string]string{"id": "s5"},
			wantMsg: "removed thread s5", wantReqs: []proto.Message{&v1.RemoveThreadRequest{Id: "s5"}}},
		{name: "run in queues a move", cmd: "thread.run-in", ctx: command.Context{ActiveThreadID: "s5"}, args: map[string]string{"project": "api"},
			wantMsg:  "thread s5 moves to /worktrees/api once it is idle",
			wantReqs: []proto.Message{&v1.RunInThreadRequest{Id: "s5", ProjectId: "api"}}},
		{name: "run in a disconnected thread moves it", cmd: "thread.run-in", args: map[string]string{"id": "s5", "worktree": "/wt/api"},
			current: &v1.Thread{State: v1.ThreadState_THREAD_STATE_DISCONNECTED, WorkspaceId: "w-1", Name: "drv"},
			wantMsg: "thread drv (s5) runs in /wt/api", wantReqs: []proto.Message{&v1.RunInThreadRequest{Id: "s5", WorktreePath: "/wt/api"}}},
		{name: "run in needs a member", cmd: "thread.run-in", args: map[string]string{"id": "s5"}, wantErr: command.ErrInvalidArgs},
		{name: "run in unavailable without a thread", cmd: "thread.run-in", ctx: command.Context{ActiveView: "dashboard"}, args: map[string]string{"project": "api"}, wantErr: command.ErrUnavailable},
		{name: "run in from the GUI for a workspace thread", cmd: "thread.run-in",
			ctx: command.Context{ActiveThreadID: "s5", ActiveView: "thread", ActiveWorkspaceID: "w-1"}, args: map[string]string{"project": "api"},
			current:  &v1.Thread{ProjectId: "web", ProjectIds: []string{"web"}, WorkspaceId: "w-1"},
			wantReqs: []proto.Message{&v1.GetThreadRequest{Id: "s5"}, &v1.RunInThreadRequest{Id: "s5", ProjectId: "api"}}},
		// Nowhere else to run (fuzz D finding 10): the GUI is not offered it; the CLI is, and the daemon says why.
		{name: "run in from the GUI: one project, no workspace", cmd: "thread.run-in",
			ctx: command.Context{ActiveThreadID: "s5", ActiveView: "thread"}, args: map[string]string{"project": "api"},
			current: &v1.Thread{ProjectId: "web", ProjectIds: []string{"web"}}, wantErr: command.ErrUnavailable},
		{name: "run in from the GUI: a workspace without projects, in its folder", cmd: "thread.run-in",
			ctx: command.Context{ActiveThreadID: "s5", ActiveView: "thread", ActiveWorkspaceID: "w-1"}, args: map[string]string{"project": "workspace"},
			current: &v1.Thread{WorkspaceId: "w-1"}, wantErr: command.ErrUnavailable},
		{name: "run in from the GUI: two projects", cmd: "thread.run-in",
			ctx: command.Context{ActiveThreadID: "s5", ActiveView: "thread"}, args: map[string]string{"project": "api"},
			current:  &v1.Thread{ProjectId: "web", ProjectIds: []string{"api", "web"}},
			wantReqs: []proto.Message{&v1.GetThreadRequest{Id: "s5"}, &v1.RunInThreadRequest{Id: "s5", ProjectId: "api"}}},
		{name: "pin toggles an unpinned thread on", cmd: "thread.pin", ctx: command.Context{ActiveThreadID: "s5"},
			wantMsg:  "pinned thread s5",
			wantReqs: []proto.Message{&v1.GetThreadRequest{Id: "s5"}, &v1.PinThreadRequest{Id: "s5", Pinned: true}}},
		{name: "pin toggles a pinned thread off", cmd: "thread.pin", args: map[string]string{"id": "s5"},
			current:  &v1.Thread{Name: "drv", Pinned: true},
			wantMsg:  "unpinned thread drv (s5)",
			wantReqs: []proto.Message{&v1.GetThreadRequest{Id: "s5"}, &v1.PinThreadRequest{Id: "s5"}}},
		// The summary says what placement did with the primary (fuzz finding A7).
		{name: "like: a worktree another thread has", cmd: "thread.new", args: map[string]string{"like": "s-0", "project": "web", "worktree": "/wt/web"},
			placement: &v1.CreateThreadResponse{ExistingWorktree: true, SharedWith: "race-a (s-0)"},
			wantMsg:   "created thread s1 in /wt/web (worktree /wt/web, shared with race-a (s-0))"},
		{name: "a new worktree of a branch origin has", cmd: "thread.new", args: map[string]string{"project": "api", "new-worktree": "true", "branch": "feat/ro"},
			placement: &v1.CreateThreadResponse{MadeWorktree: true},
			wantMsg:   "created thread s1 in /worktrees/s1 (new worktree on existing branch feat/ro)"},
		{name: "like: a worktree nobody else has", cmd: "thread.new", args: map[string]string{"like": "s-0", "project": "web", "worktree": "/wt/web"},
			placement: &v1.CreateThreadResponse{ExistingWorktree: true}, wantMsg: "created thread s1 in /wt/web (existing worktree)"},
		{name: "like narrowed to a folder: no worktrees", cmd: "thread.new", args: map[string]string{"like": "s-0", "projects": "notes"},
			placement: &v1.CreateThreadResponse{WorktreeModeDropped: true},
			wantMsg:   "created thread s1 in  (no worktrees: none of its projects has git, so it runs in their folders)"},
		{name: "like a thread without a project", cmd: "thread.new", args: map[string]string{"like": "s-0"}, wantMsg: "created thread s1 in  (no project)"},
		{name: "projects: a path ref after a comma is expanded", cmd: "thread.new", args: map[string]string{"projects": "web,~/src/api"},
			wantReqs: []proto.Message{&v1.CreateThreadRequest{PermissionMode: auto, ProjectIds: []string{"web", "/Users/me/src/api"}}}},
		// --created-by= opts out of the thread this runs in, its placement too (fuzz finding A8).
		{name: "created-by empty opts out of the caller's placement", cmd: "thread.new", ctx: command.Context{ActiveThreadID: "s5"},
			args: map[string]string{"created-by": ""}, current: &v1.Thread{ProjectId: "r1", WorktreePath: "/wt/r1"},
			wantErr: command.ErrInvalidArgs, wantReqs: []proto.Message{}},
		{name: "created-by empty with a project", cmd: "thread.new", ctx: command.Context{ActiveThreadID: "s5"},
			args:     map[string]string{"created-by": "", "project": "r1"},
			wantReqs: []proto.Message{&v1.CreateThreadRequest{ProjectId: "r1", PermissionMode: auto}}},
		{name: "pin explicit", cmd: "thread.pin", args: map[string]string{"id": "s5", "pinned": "true"}, current: &v1.Thread{Pinned: true},
			wantMsg: "pinned thread s5", wantReqs: []proto.Message{&v1.PinThreadRequest{Id: "s5", Pinned: true}}},
		{name: "unpin explicit", cmd: "thread.pin", args: map[string]string{"id": "s5", "pinned": "false"},
			wantMsg: "unpinned thread s5", wantReqs: []proto.Message{&v1.PinThreadRequest{Id: "s5"}}},
		{name: "pin unavailable without a thread", cmd: "thread.pin", ctx: command.Context{ActiveView: "dashboard"}, wantErr: command.ErrUnavailable},
		{name: "pin from the CLI without a thread", cmd: "thread.pin", wantErr: command.ErrInvalidArgs},
		{name: "focus", cmd: "thread.focus", ctx: command.Context{ActiveThreadID: "s7"}, wantMsg: "windows=1", wantIntent: focusIntent("s7")},
		{name: "backend error passes through", cmd: "thread.remove", args: map[string]string{"id": "s5"},
			backendErr: connect.NewError(connect.CodeNotFound, errors.New("nope")), wantCode: connect.CodeNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, b, e := newLifecycleRegistry(t)
			b.Current, b.Err = tt.current, tt.backendErr
			b.Placement = tt.placement
			res, err := reg.Invoke(context.Background(), tt.ctx, tt.cmd, tt.args, command.Confirmed(true))
			switch {
			case tt.wantCode != 0:
				if connect.CodeOf(err) != tt.wantCode {
					t.Fatalf("err = %v, want code %v", err, tt.wantCode)
				}
			case !errors.Is(err, tt.wantErr):
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if tt.wantMsg != "" && res.Message != tt.wantMsg {
				t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
			}
			if tt.wantReqs != nil {
				got := b.Requests()
				if !slices.EqualFunc(got, tt.wantReqs, proto.Equal) {
					t.Errorf("requests = %v, want %v", got, tt.wantReqs)
				}
			}
			if tt.wantIntent != nil {
				in := e.Intents()
				if len(in) != 1 || !proto.Equal(in[0], tt.wantIntent) {
					t.Errorf("intents = %v, want %v", in, tt.wantIntent)
				}
			}
		})
	}
}

// A thread-starting verb with focus=false (what a page's bridge sends unless the page
// asks) moves no window; the default still does (the cases above).
func TestThreadCreatedNoFocus(t *testing.T) {
	for _, tt := range []struct {
		cmd  string
		ctx  command.Context
		args map[string]string
	}{
		{"thread.new", command.Context{ActiveThreadID: "s5"}, map[string]string{"project": "r1", "focus": "false"}},
		{"thread.fork", command.Context{ActiveThreadID: "s5"}, map[string]string{"focus": "false"}},
	} {
		t.Run(tt.cmd, func(t *testing.T) {
			reg, _, e := newLifecycleRegistry(t)
			if _, err := reg.Invoke(context.Background(), tt.ctx, tt.cmd, tt.args); err != nil {
				t.Fatal(err)
			}
			if in := e.Intents(); len(in) != 0 {
				t.Errorf("intents = %v, want none", in)
			}
		})
	}
}

func TestThreadNewKeybindingAndEnums(t *testing.T) {
	reg, _, _ := newLifecycleRegistry(t)
	c, ok := reg.Get("thread.new")
	if !ok || !slices.Contains(c.Keybindings, "cmd+n") || c.Title != "New Thread" {
		t.Fatalf("thread.new = %q keybindings %v", c.Title, c.Keybindings)
	}
	// The GUI composer invokes thread.new with exactly these args.
	var names []string
	for _, a := range c.Args {
		names = append(names, a.Name)
	}
	for _, want := range []string{"project", "worktree", "model", "effort", "permission", "new-worktree", "base", "branch", "name", "prompt", "attachments", "no-project"} {
		if !slices.Contains(names, want) {
			t.Errorf("thread.new has no %q arg (args %v)", want, names)
		}
	}
	for _, a := range c.Args {
		switch a.Name {
		case "model":
			if !slices.Equal(a.Enum, model.Values()) || !strings.Contains(a.Description, "1M context suffix") {
				t.Errorf("model enum = %v", a.Enum)
			}
		case "effort":
			if !slices.Equal(a.Enum, []string{"low", "medium", "high", "xhigh", "max"}) {
				t.Errorf("effort enum = %v", a.Enum)
			}
		case "permission":
			if !slices.Equal(a.Enum, []string{"supervised", "accept-edits", "auto"}) || a.Default != "auto" {
				t.Errorf("permission = %v default %q", a.Enum, a.Default)
			}
		}
	}
}

// thread.focus only emits an intent, so it looks the id up first: a short or mistyped
// one (which resolution passes through) is not found, not "delivered".
func TestThreadFocusUnknown(t *testing.T) {
	reg, _ := newBulkRegistry(t, idle("s-aaaa11112222", "one"))
	for _, tt := range []struct {
		id       string
		wantCode connect.Code
	}{{"x", connect.CodeNotFound}, {"s-ffff00000000", connect.CodeNotFound}, {"1111", connect.CodeNotFound}, {"2222", 0}} {
		res, err := reg.Invoke(context.Background(), command.Context{}, "thread.focus", map[string]string{"id": tt.id})
		if connect.CodeOf(err) != tt.wantCode && !(tt.wantCode == 0 && err == nil) {
			t.Errorf("focus %s: err %v, want code %v", tt.id, err, tt.wantCode)
		}
		if tt.wantCode == 0 && res.Message != "windows=1" {
			t.Errorf("focus %s: %q", tt.id, res.Message)
		}
	}
}
