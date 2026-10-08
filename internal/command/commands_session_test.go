package command_test

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/awaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/awaumann/code-foundry/internal/command"
	"github.com/awaumann/code-foundry/internal/command/commandtest"
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
			wantMsg:  "created session s1 in /wt",
			wantReqs: []proto.Message{&v1.CreateSessionRequest{WorktreePath: "/wt", Model: "opus", Effort: "high"}}, wantIntent: focusIntent("s1")},
		{name: "new with explicit worktree and prompt", cmd: "session.new",
			args:     map[string]string{"worktree": "~/src/app", "name": "fix-it", "prompt": "hello"},
			wantMsg:  "created session fix-it (s1) in /Users/me/src/app",
			wantReqs: []proto.Message{&v1.CreateSessionRequest{WorktreePath: "/Users/me/src/app", Name: "fix-it", InitialPrompt: "hello"}}},
		{name: "new from repo context", cmd: "session.new", ctx: command.Context{ActiveRepoID: "r1"},
			wantReqs: []proto.Message{&v1.CreateSessionRequest{RepoId: "r1"}}},
		{name: "new unavailable without context", cmd: "session.new", wantErr: command.ErrUnavailable},
		{name: "new bad effort", cmd: "session.new", args: map[string]string{"worktree": "/wt", "effort": "huge"}, wantErr: command.ErrInvalidArgs},
		{name: "new bad model", cmd: "session.new", args: map[string]string{"worktree": "/wt", "model": "gpt"}, wantErr: command.ErrInvalidArgs},
		{name: "close from context", cmd: "session.close", ctx: command.Context{ActiveSessionID: "s5"},
			wantMsg: "closed session s5", wantReqs: []proto.Message{&v1.CloseSessionRequest{Id: "s5"}}},
		{name: "close explicit id", cmd: "session.close", args: map[string]string{"id": "s6"},
			wantReqs: []proto.Message{&v1.CloseSessionRequest{Id: "s6"}}},
		{name: "close unavailable", cmd: "session.close", wantErr: command.ErrUnavailable},
		{name: "reconnect disconnected", cmd: "session.reconnect", args: map[string]string{"id": "s5"}, current: disconnected,
			wantMsg:  "reconnecting session s5",
			wantReqs: []proto.Message{&v1.GetSessionRequest{Id: "s5"}, &v1.ReconnectSessionRequest{Id: "s5"}}},
		{name: "reconnect refused while connected", cmd: "session.reconnect", args: map[string]string{"id": "s5"},
			wantCode: connect.CodeFailedPrecondition, wantReqs: []proto.Message{&v1.GetSessionRequest{Id: "s5"}}},
		{name: "rename", cmd: "session.rename", ctx: command.Context{ActiveSessionID: "s5"}, args: map[string]string{"name": "new"},
			wantMsg: "renamed session new (s5)", wantReqs: []proto.Message{&v1.RenameSessionRequest{Id: "s5", Name: "new"}}},
		{name: "rename needs a name", cmd: "session.rename", ctx: command.Context{ActiveSessionID: "s5"}, wantErr: command.ErrInvalidArgs},
		{name: "fork", cmd: "session.fork", ctx: command.Context{ActiveSessionID: "s5"},
			wantMsg: "forked s5 into s2", wantReqs: []proto.Message{&v1.ForkSessionRequest{Id: "s5"}}, wantIntent: focusIntent("s2")},
		{name: "remove", cmd: "session.remove", args: map[string]string{"id": "s5"},
			wantMsg: "removed session s5", wantReqs: []proto.Message{&v1.RemoveSessionRequest{Id: "s5"}}},
		{name: "focus", cmd: "session.focus", ctx: command.Context{ActiveSessionID: "s7"}, wantMsg: "delivered=1", wantIntent: focusIntent("s7")},
		{name: "list", cmd: "session.list", current: &v1.Session{Id: "s1", Name: "n", State: v1.SessionState_SESSION_STATE_DISCONNECTED, DisconnectReason: "closed"},
			wantReqs: []proto.Message{&v1.ListSessionsRequest{}}, wantIn: []string{"s1", "n", "disconnected", "unspecified", "closed"}},
		{name: "list shows the status reason of a live session", cmd: "session.list",
			current: &v1.Session{Id: "s2", Name: "m", State: v1.SessionState_SESSION_STATE_CONNECTED, Status: v1.SessionStatus_SESSION_STATUS_NEEDS_ATTENTION, StatusReason: "finished", DisconnectReason: "exited"},
			wantIn: []string{"s2", "m", "connected", "needs_attention", "finished"}},
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
	if !ok || !slices.Contains(c.Keybindings, "cmd+n") {
		t.Fatalf("session.new keybindings = %v", c.Keybindings)
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
		}
	}
}
