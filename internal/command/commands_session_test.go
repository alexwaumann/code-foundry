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
)

func newSessionRegistry(t *testing.T) (*command.Registry, *commandtest.Session, *commandtest.Emitter) {
	t.Helper()
	reg := command.NewRegistry()
	b := &commandtest.Session{}
	e := &commandtest.Emitter{Delivered: 1}
	if err := command.RegisterSession(reg, b, e); err != nil {
		t.Fatal(err)
	}
	return reg, b, e
}

func focusIntent(id string) *v1.UiIntent {
	return &v1.UiIntent{Intent: &v1.UiIntent_FocusSession_{FocusSession: &v1.UiIntent_FocusSession{SessionId: id}}}
}

func TestSessionCommands(t *testing.T) {
	t.Setenv("HOME", "/Users/me")
	auto := v1.PermissionMode_PERMISSION_MODE_AUTO
	disconnected := &v1.Session{State: v1.SessionState_SESSION_STATE_DISCONNECTED}
	tests := []struct {
		name       string
		cmd        string
		ctx        command.Context
		args       map[string]string
		current    *v1.Session
		backendErr error
		wantErr    error
		wantCode   connect.Code
		wantMsg    string
		wantReqs   []proto.Message // backend requests in order
		wantIntent *v1.UiIntent
		wantIn     []string // fields expected in the message, in order on one line
	}{
		{name: "new from worktree context", cmd: "session.new", ctx: command.Context{ActiveWorktreePath: "/wt"},
			args:     map[string]string{"model": "opus", "effort": "high"},
			wantMsg:  "created thread s1 in /wt",
			wantReqs: []proto.Message{&v1.CreateSessionRequest{WorktreePath: "/wt", Model: "opus", Effort: "high", PermissionMode: auto}}, wantIntent: focusIntent("s1")},
		{name: "new with explicit worktree and prompt", cmd: "session.new",
			args:     map[string]string{"worktree": "~/src/app", "name": "fix-it", "prompt": "hello"},
			wantMsg:  "created thread fix-it (s1) in /Users/me/src/app",
			wantReqs: []proto.Message{&v1.CreateSessionRequest{WorktreePath: "/Users/me/src/app", Name: "fix-it", InitialPrompt: "hello", PermissionMode: auto}}},
		{name: "new from repo context", cmd: "session.new", ctx: command.Context{ActiveRepoID: "r1"},
			wantReqs: []proto.Message{&v1.CreateSessionRequest{RepoId: "r1", PermissionMode: auto}}},
		{name: "new supervised", cmd: "session.new", args: map[string]string{"repo": "r1", "permission": "supervised"},
			wantReqs: []proto.Message{&v1.CreateSessionRequest{RepoId: "r1", PermissionMode: v1.PermissionMode_PERMISSION_MODE_SUPERVISED}}},
		{name: "new accept edits", cmd: "session.new", args: map[string]string{"repo": "r1", "permission": "accept-edits"},
			wantReqs: []proto.Message{&v1.CreateSessionRequest{RepoId: "r1", PermissionMode: v1.PermissionMode_PERMISSION_MODE_ACCEPT_EDITS}}},
		{name: "new refuses full access", cmd: "session.new", args: map[string]string{"repo": "r1", "permission": "bypassPermissions"}, wantErr: command.ErrInvalidArgs},
		{name: "new worktree with base and attachments", cmd: "session.new", ctx: command.Context{ActiveRepoID: "r1"},
			args:    map[string]string{"new-worktree": "true", "base": "origin/dev", "prompt": "look", "attachments": " /a/1.png, ,/a/2.png "},
			wantMsg: "created thread s1 in /worktrees/s1 (new worktree from origin/dev)",
			wantReqs: []proto.Message{&v1.CreateSessionRequest{RepoId: "r1", InitialPrompt: "look", PermissionMode: auto,
				NewWorktree: &v1.NewWorktree{BaseRef: "origin/dev"}, Attachments: []string{"/a/1.png", "/a/2.png"}}}},
		{name: "new worktree with default base", cmd: "session.new", args: map[string]string{"repo": "r1", "new-worktree": "true"},
			wantReqs: []proto.Message{&v1.CreateSessionRequest{RepoId: "r1", PermissionMode: auto, NewWorktree: &v1.NewWorktree{}}}},
		{name: "base needs new worktree", cmd: "session.new", args: map[string]string{"repo": "r1", "base": "main"}, wantErr: command.ErrInvalidArgs},
		{name: "new unavailable without context", cmd: "session.new", wantErr: command.ErrUnavailable},
		{name: "new bad effort", cmd: "session.new", args: map[string]string{"worktree": "/wt", "effort": "huge"}, wantErr: command.ErrInvalidArgs},
		{name: "new bad model", cmd: "session.new", args: map[string]string{"worktree": "/wt", "model": "gpt"}, wantErr: command.ErrInvalidArgs},
		{name: "close from context", cmd: "session.close", ctx: command.Context{ActiveSessionID: "s5"},
			wantMsg: "closed thread s5", wantReqs: []proto.Message{&v1.CloseSessionRequest{Id: "s5"}}},
		{name: "close explicit id", cmd: "session.close", args: map[string]string{"id": "s6"},
			wantReqs: []proto.Message{&v1.CloseSessionRequest{Id: "s6"}}},
		{name: "close unavailable", cmd: "session.close", wantErr: command.ErrUnavailable},
		{name: "reconnect disconnected", cmd: "session.reconnect", args: map[string]string{"id": "s5"}, current: disconnected,
			wantMsg:  "reconnecting thread s5",
			wantReqs: []proto.Message{&v1.GetSessionRequest{Id: "s5"}, &v1.ReconnectSessionRequest{Id: "s5"}}},
		{name: "reconnect refused while connected", cmd: "session.reconnect", args: map[string]string{"id": "s5"},
			wantCode: connect.CodeFailedPrecondition, wantReqs: []proto.Message{&v1.GetSessionRequest{Id: "s5"}}},
		{name: "rename", cmd: "session.rename", ctx: command.Context{ActiveSessionID: "s5"}, args: map[string]string{"name": "new"},
			wantMsg: "renamed thread new (s5)", wantReqs: []proto.Message{&v1.RenameSessionRequest{Id: "s5", Name: "new"}}},
		{name: "rename needs a name", cmd: "session.rename", ctx: command.Context{ActiveSessionID: "s5"}, wantErr: command.ErrInvalidArgs},
		{name: "fork", cmd: "session.fork", ctx: command.Context{ActiveSessionID: "s5"},
			wantMsg: "forked s5 into s2", wantReqs: []proto.Message{&v1.ForkSessionRequest{Id: "s5"}}, wantIntent: focusIntent("s2")},
		{name: "remove", cmd: "session.remove", args: map[string]string{"id": "s5"},
			wantMsg: "removed thread s5", wantReqs: []proto.Message{&v1.RemoveSessionRequest{Id: "s5"}}},
		{name: "focus", cmd: "session.focus", ctx: command.Context{ActiveSessionID: "s7"}, wantMsg: "delivered=1", wantIntent: focusIntent("s7")},
		{name: "list", cmd: "session.list", current: &v1.Session{Id: "s1", Name: "n", State: v1.SessionState_SESSION_STATE_DISCONNECTED, DisconnectReason: "closed"},
			wantReqs: []proto.Message{&v1.ListSessionsRequest{}}, wantIn: []string{"s1", "n", "disconnected", "unspecified", "closed"}},
		{name: "list shows the status reason of a live session", cmd: "session.list",
			current: &v1.Session{Id: "s2", Name: "m", State: v1.SessionState_SESSION_STATE_CONNECTED, Status: v1.SessionStatus_SESSION_STATUS_NEEDS_ATTENTION, StatusReason: "finished", DisconnectReason: "exited"},
			wantIn:  []string{"s2", "m", "connected", "needs_attention", "finished"}},
		{name: "backend error passes through", cmd: "session.close", args: map[string]string{"id": "s5"},
			backendErr: connect.NewError(connect.CodeNotFound, errors.New("nope")), wantCode: connect.CodeNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, b, e := newSessionRegistry(t)
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
			}
		})
	}
}

func TestSessionNewKeybindingAndEnums(t *testing.T) {
	reg, _, _ := newSessionRegistry(t)
	c, ok := reg.Get("session.new")
	if !ok || !slices.Contains(c.Keybindings, "cmd+n") || c.Title != "New Thread" {
		t.Fatalf("session.new = %q keybindings %v", c.Title, c.Keybindings)
	}
	// The GUI composer invokes session.new with exactly these args.
	var names []string
	for _, a := range c.Args {
		names = append(names, a.Name)
	}
	for _, want := range []string{"repo", "worktree", "model", "effort", "permission", "new-worktree", "base", "name", "prompt", "attachments"} {
		if !slices.Contains(names, want) {
			t.Errorf("session.new has no %q arg (args %v)", want, names)
		}
	}
	for _, a := range c.Args {
		switch a.Name {
		case "model":
			if !slices.Equal(a.Enum, []string{"fable", "opus", "sonnet", "haiku"}) {
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
