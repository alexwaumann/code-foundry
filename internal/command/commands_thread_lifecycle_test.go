package command_test

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/model"
)

func newLifecycleRegistry(t *testing.T) (*command.Registry, *commandtest.Thread, *commandtest.Emitter) {
	t.Helper()
	reg := command.NewRegistry()
	b := &commandtest.Thread{}
	e := &commandtest.Emitter{Delivered: 1}
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
		backendErr error
		wantErr    error
		wantCode   connect.Code
		wantMsg    string
		wantReqs   []proto.Message // backend requests in order
		wantIntent *v1.UiIntent
		wantIn     []string // fields expected in the message, in order on one line
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
		{name: "new from repo context", cmd: "thread.new", ctx: command.Context{ActiveRepoID: "r1"},
			wantReqs: []proto.Message{&v1.CreateThreadRequest{RepoId: "r1", PermissionMode: auto}}},
		{name: "new supervised", cmd: "thread.new", args: map[string]string{"repo": "r1", "permission": "supervised"},
			wantReqs: []proto.Message{&v1.CreateThreadRequest{RepoId: "r1", PermissionMode: v1.PermissionMode_PERMISSION_MODE_SUPERVISED}}},
		{name: "new accept edits", cmd: "thread.new", args: map[string]string{"repo": "r1", "permission": "accept-edits"},
			wantReqs: []proto.Message{&v1.CreateThreadRequest{RepoId: "r1", PermissionMode: v1.PermissionMode_PERMISSION_MODE_ACCEPT_EDITS}}},
		{name: "new refuses full access", cmd: "thread.new", args: map[string]string{"repo": "r1", "permission": "bypassPermissions"}, wantErr: command.ErrInvalidArgs},
		{name: "new worktree with base and attachments", cmd: "thread.new", ctx: command.Context{ActiveRepoID: "r1"},
			args:    map[string]string{"new-worktree": "true", "base": "origin/dev", "prompt": "look", "attachments": " /a/1.png, ,/a/2.png "},
			wantMsg: "created thread s1 in /worktrees/s1 (new worktree from origin/dev)",
			wantReqs: []proto.Message{&v1.CreateThreadRequest{RepoId: "r1", InitialPrompt: "look", PermissionMode: auto,
				NewWorktree: &v1.NewWorktree{BaseRef: "origin/dev"}, Attachments: []string{"/a/1.png", "/a/2.png"}}}},
		{name: "new worktree with default base", cmd: "thread.new", args: map[string]string{"repo": "r1", "new-worktree": "true"},
			wantReqs: []proto.Message{&v1.CreateThreadRequest{RepoId: "r1", PermissionMode: auto, NewWorktree: &v1.NewWorktree{}}}},
		{name: "base needs new worktree", cmd: "thread.new", args: map[string]string{"repo": "r1", "base": "main"}, wantErr: command.ErrInvalidArgs},
		{name: "new unavailable in the GUI without a repo or worktree", cmd: "thread.new", ctx: command.Context{ActiveView: "dashboard"}, wantErr: command.ErrUnavailable},
		{name: "new from the CLI needs a target", cmd: "thread.new", wantErr: command.ErrInvalidArgs},
		{name: "new in a workspace", cmd: "thread.new", args: map[string]string{"workspace": "login", "repo": "api"},
			wantMsg:  "created thread s1 in  (workspace login)",
			wantReqs: []proto.Message{&v1.CreateThreadRequest{WorkspaceId: "login", RepoId: "api", PermissionMode: auto}}},
		{name: "new workspace with new worktrees", cmd: "thread.new",
			args:    map[string]string{"new-worktree": "true", "repos": "web, api", "base": "origin/dev", "prompt": "fix login"},
			wantMsg: "created thread s1 in /worktrees/web (workspace w-new) (new worktree from origin/dev)",
			wantReqs: []proto.Message{&v1.CreateThreadRequest{InitialPrompt: "fix login", PermissionMode: auto,
				NewWorkspace: &v1.NewWorkspace{Repos: []string{"web", "api"}, BaseRef: "origin/dev"}}}},
		{name: "repos needs new worktree", cmd: "thread.new", args: map[string]string{"repos": "web,api"}, wantErr: command.ErrInvalidArgs},
		{name: "workspace refuses new worktree", cmd: "thread.new", args: map[string]string{"workspace": "login", "new-worktree": "true"}, wantErr: command.ErrInvalidArgs},
		{name: "new without a project", cmd: "thread.new", args: map[string]string{"no-project": "true", "model": "claude-4.5-haiku[1m]", "prompt": "hi"},
			wantMsg:  "created thread s1 in /home (no project)",
			wantReqs: []proto.Message{&v1.CreateThreadRequest{NoProject: true, Model: "claude-4.5-haiku[1m]", InitialPrompt: "hi", PermissionMode: auto}}, wantIntent: focusIntent("s1")},
		{name: "new without a project from the composer", cmd: "thread.new", ctx: command.Context{ActiveView: "compose"},
			args:     map[string]string{"no-project": "true"},
			wantReqs: []proto.Message{&v1.CreateThreadRequest{NoProject: true, PermissionMode: auto}}},
		{name: "new from the composer still needs a target", cmd: "thread.new", ctx: command.Context{ActiveView: "compose"}, wantErr: command.ErrInvalidArgs},
		{name: "no project refuses repo", cmd: "thread.new", args: map[string]string{"no-project": "true", "repo": "r1"}, wantErr: command.ErrInvalidArgs},
		{name: "no project refuses a repo from context", cmd: "thread.new", ctx: command.Context{ActiveRepoID: "r1"},
			args: map[string]string{"no-project": "true"}, wantErr: command.ErrInvalidArgs},
		{name: "no project refuses worktree", cmd: "thread.new", args: map[string]string{"no-project": "true", "worktree": "/wt"}, wantErr: command.ErrInvalidArgs},
		{name: "no project refuses workspace", cmd: "thread.new", args: map[string]string{"no-project": "true", "workspace": "login"}, wantErr: command.ErrInvalidArgs},
		{name: "no project refuses repos", cmd: "thread.new", args: map[string]string{"no-project": "true", "new-worktree": "true", "repos": "web,api"}, wantErr: command.ErrInvalidArgs},
		{name: "no project refuses new worktree", cmd: "thread.new", args: map[string]string{"no-project": "true", "new-worktree": "true"}, wantErr: command.ErrInvalidArgs},
		{name: "no project refuses base", cmd: "thread.new", args: map[string]string{"no-project": "true", "base": "main"}, wantErr: command.ErrInvalidArgs},
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
		{name: "run in queues a move", cmd: "thread.run-in", ctx: command.Context{ActiveThreadID: "s5"}, args: map[string]string{"repo": "api"},
			wantMsg:  "thread s5 moves to /worktrees/api once it is idle",
			wantReqs: []proto.Message{&v1.RunInThreadRequest{Id: "s5", RepoId: "api"}}},
		{name: "run in a disconnected thread moves it", cmd: "thread.run-in", args: map[string]string{"id": "s5", "worktree": "/wt/api"},
			current: &v1.Thread{State: v1.ThreadState_THREAD_STATE_DISCONNECTED, WorkspaceId: "w-1", Name: "drv"},
			wantMsg: "thread drv (s5) runs in /wt/api", wantReqs: []proto.Message{&v1.RunInThreadRequest{Id: "s5", WorktreePath: "/wt/api"}}},
		{name: "run in needs a member", cmd: "thread.run-in", args: map[string]string{"id": "s5"}, wantErr: command.ErrInvalidArgs},
		{name: "run in unavailable without a thread", cmd: "thread.run-in", args: map[string]string{"repo": "api"}, wantErr: command.ErrUnavailable},
		{name: "run in unavailable in the GUI for a project thread", cmd: "thread.run-in",
			ctx: command.Context{ActiveThreadID: "s5", ActiveView: "thread"}, args: map[string]string{"repo": "api"}, wantErr: command.ErrUnavailable},
		{name: "run in from the GUI for a workspace thread", cmd: "thread.run-in",
			ctx: command.Context{ActiveThreadID: "s5", ActiveView: "thread", ActiveWorkspaceID: "w-1"}, args: map[string]string{"repo": "api"},
			wantReqs: []proto.Message{&v1.RunInThreadRequest{Id: "s5", RepoId: "api"}}},
		{name: "pin toggles an unpinned thread on", cmd: "thread.pin", ctx: command.Context{ActiveThreadID: "s5"},
			wantMsg:  "pinned thread s5",
			wantReqs: []proto.Message{&v1.GetThreadRequest{Id: "s5"}, &v1.PinThreadRequest{Id: "s5", Pinned: true}}},
		{name: "pin toggles a pinned thread off", cmd: "thread.pin", args: map[string]string{"id": "s5"},
			current:  &v1.Thread{Name: "drv", Pinned: true},
			wantMsg:  "unpinned thread drv (s5)",
			wantReqs: []proto.Message{&v1.GetThreadRequest{Id: "s5"}, &v1.PinThreadRequest{Id: "s5"}}},
		{name: "pin explicit", cmd: "thread.pin", args: map[string]string{"id": "s5", "pinned": "true"}, current: &v1.Thread{Pinned: true},
			wantMsg: "pinned thread s5", wantReqs: []proto.Message{&v1.PinThreadRequest{Id: "s5", Pinned: true}}},
		{name: "unpin explicit", cmd: "thread.pin", args: map[string]string{"id": "s5", "pinned": "false"},
			wantMsg: "unpinned thread s5", wantReqs: []proto.Message{&v1.PinThreadRequest{Id: "s5"}}},
		{name: "pin unavailable without a thread", cmd: "thread.pin", wantErr: command.ErrUnavailable},
		{name: "focus", cmd: "thread.focus", ctx: command.Context{ActiveThreadID: "s7"}, wantMsg: "delivered=1", wantIntent: focusIntent("s7")},
		// session.list has no state column (whether Claude runs is the daemon's business);
		// a stopped thread reads like a running one.
		{name: "list", cmd: "thread.list", current: &v1.Thread{Id: "s1", Name: "n", State: v1.ThreadState_THREAD_STATE_DISCONNECTED, DisconnectReason: "idle"},
			wantReqs: []proto.Message{&v1.ListThreadsRequest{}}, wantIn: []string{"s1", "n", "unspecified", "-", "-", "-", "-"}},
		{name: "list shows an interrupted thread's error", cmd: "thread.list",
			current: &v1.Thread{Id: "s1", Name: "n", State: v1.ThreadState_THREAD_STATE_DISCONNECTED, DisconnectReason: "daemon stopped",
				Status: v1.ThreadStatus_THREAD_STATUS_ERROR, StatusReason: "interrupted"},
			wantIn: []string{"s1", "n", "error", "(interrupted)", "interrupted"}},
		{name: "list shows the persisted status of a stopped thread", cmd: "thread.list",
			current: &v1.Thread{Id: "s1", Name: "n", State: v1.ThreadState_THREAD_STATE_DISCONNECTED, DisconnectReason: "daemon restarted",
				Status: v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION, StatusReason: "permission: Do you want to proceed?"},
			wantIn: []string{"s1", "n", "needs_attention", "permission:", "Do", "you", "want", "to", "proceed?"}},
		{name: "list shows the status reason of a running thread", cmd: "thread.list",
			current: &v1.Thread{Id: "s2", Name: "m", State: v1.ThreadState_THREAD_STATE_CONNECTED, Status: v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION, StatusReason: "finished", DisconnectReason: "exited"},
			wantIn:  []string{"s2", "m", "needs_attention", "finished"}},
		{name: "list shows the workspace", cmd: "thread.list",
			current: &v1.Thread{Id: "s3", Name: "w", State: v1.ThreadState_THREAD_STATE_CONNECTED, Status: v1.ThreadStatus_THREAD_STATUS_IDLE,
				StatusReason: "idle", WorkspaceId: "w-1", WorktreePath: "/wt/api"},
			wantIn: []string{"s3", "w", "idle", "idle", "w-1", "-", "-", "/wt/api"}},
		{name: "list shows linked pull requests", cmd: "thread.list",
			current: &v1.Thread{Id: "s4", Name: "p", State: v1.ThreadState_THREAD_STATE_CONNECTED, LinkedPullRequests: []*v1.LinkedPullRequest{
				{Slug: "o/api", Number: 5, Url: "https://github.com/o/api/pull/5"}, {Slug: "o/api", Number: 7, Url: "https://github.com/o/api/pull/7"}}},
			wantIn: []string{"s4", "p", "unspecified", "-", "-", "#5,#7"}},
		{name: "list prefixes linked pull requests of several repositories", cmd: "thread.list",
			current: &v1.Thread{Id: "s4", Name: "p", State: v1.ThreadState_THREAD_STATE_CONNECTED, LinkedPullRequests: []*v1.LinkedPullRequest{
				{Slug: "o/api", Number: 5, Url: "https://github.com/o/api/pull/5"}, {Slug: "o/web", Number: 2, Url: "https://github.com/o/web/pull/2"}}},
			wantIn: []string{"s4", "p", "unspecified", "-", "-", "api#5,web#2"}},
		{name: "list shows a natural name as typed", cmd: "thread.list",
			current: &v1.Thread{Id: "s7", Name: "Fix the login redirect", State: v1.ThreadState_THREAD_STATE_CONNECTED},
			wantIn:  []string{"s7", "Fix", "the", "login", "redirect", "unspecified"}},
		{name: "list shows a dash for an unnamed thread", cmd: "thread.list",
			current: &v1.Thread{Id: "s8", State: v1.ThreadState_THREAD_STATE_CONNECTED},
			wantIn:  []string{"s8", "-", "unspecified"}},
		{name: "list shows an expired cache", cmd: "thread.list",
			current: &v1.Thread{Id: "s6", Name: "r", State: v1.ThreadState_THREAD_STATE_CONNECTED, ContextTokens: 25_700,
				CacheExpiresAt: timestamppb.New(time.Unix(1, 0)), WorktreePath: "/wt/r"},
			wantIn: []string{"s6", "r", "unspecified", "-", "-", "-", "25.7K", "·", "cache", "expired", "/wt/r"}},
		{name: "backend error passes through", cmd: "thread.remove", args: map[string]string{"id": "s5"},
			backendErr: connect.NewError(connect.CodeNotFound, errors.New("nope")), wantCode: connect.CodeNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, b, e := newLifecycleRegistry(t)
			b.Current, b.Err = tt.current, tt.backendErr
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
			if tt.wantIn != nil {
				lines := strings.Split(res.Message, "\n")
				if len(lines) != 2 || !slices.Equal(strings.Fields(lines[1])[:len(tt.wantIn)], tt.wantIn) {
					t.Errorf("list output = %q, want a row starting %v", res.Message, tt.wantIn)
				}
				if h := strings.Fields(lines[0]); !slices.Equal(h, []string{"ID", "NAME", "STATUS", "REASON", "WORKSPACE", "PRS", "CONTEXT", "WORKTREE"}) {
					t.Errorf("list header %q", h)
				}
				for _, word := range []string{"connected", "disconnected", "starting", "closing"} {
					if slices.Contains(strings.Fields(lines[1]), word) {
						t.Errorf("list row says %q: %q", word, lines[1])
					}
				}
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
	// The GUI composer invokes session.new with exactly these args.
	var names []string
	for _, a := range c.Args {
		names = append(names, a.Name)
	}
	for _, want := range []string{"repo", "worktree", "model", "effort", "permission", "new-worktree", "base", "name", "prompt", "attachments", "no-project"} {
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
