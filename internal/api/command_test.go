package api

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

func TestCommandErrorCodes(t *testing.T) {
	backend := connect.NewError(connect.CodeNotFound, errors.New("no such terminal"))
	tests := []struct {
		name string
		err  error
		want connect.Code
	}{
		{"unknown command", fmt.Errorf("%w %q", command.ErrUnknownCommand, "x.y"), connect.CodeNotFound},
		{"arg error", fmt.Errorf("x.y: %w", command.InvalidArg("a", "bad")), connect.CodeInvalidArgument},
		{"unavailable", fmt.Errorf("x.y: %w", command.ErrUnavailable), connect.CodeFailedPrecondition},
		{"backend connect error keeps its code", fmt.Errorf("wrapped: %w", backend), connect.CodeNotFound},
		{"backend unimplemented", connect.NewError(connect.CodeUnimplemented, errors.New("nope")), connect.CodeUnimplemented},
		{"canceled", context.Canceled, connect.CodeCanceled},
		{"deadline", fmt.Errorf("git: %w", context.DeadlineExceeded), connect.CodeDeadlineExceeded},
		{"other", errors.New("git exploded"), connect.CodeUnknown},
		{"command failed", command.Failed(errors.New("it broke")), connect.CodeFailedPrecondition},
		{"command failed: down", command.Failed(fmt.Errorf("%w: plugin x is disabled", command.ErrUnavailable)), connect.CodeFailedPrecondition},
		{"command failed: bad args", command.Failed(command.InvalidArg("", "no such run")), connect.CodeInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := commandError("x.y", tt.err)
			if got := connect.CodeOf(err); got != tt.want {
				t.Fatalf("code = %v, want %v", got, tt.want)
			}
			var ce *connect.Error
			failed := false
			if errors.As(err, &ce) {
				for _, d := range ce.Details() {
					if m, derr := d.Value(); derr == nil {
						if cf, ok := m.(*v1.CommandFailed); ok && cf.GetCommand() == "x.y" {
							failed = true
						}
					}
				}
			}
			if failed != command.IsFailed(tt.err) {
				t.Errorf("CommandFailed detail = %v, want %v", failed, command.IsFailed(tt.err))
			}
		})
	}
}

func newTestRegistry(t *testing.T) *command.Registry {
	t.Helper()
	r := command.NewRegistry()
	err := r.RegisterAll(
		command.Command{
			Name: "terminal.kill", Title: "Kill Terminal", Category: "Terminal", Keybindings: []string{"cmd+shift+w"},
			Args: []command.ArgSpec{
				{Name: "id", Type: command.String, Required: true, Context: command.ContextTerminal, Description: "Terminal id"},
				{Name: "signal", Type: command.Enum, Enum: []string{"hup", "kill"}, Default: "hup"},
			},
			When: func(c command.Context) bool { return c.ActiveTerminalID != "" },
			Run: func(_ context.Context, _ command.Context, a command.Args) (command.Result, error) {
				return command.Result{Message: "killed " + a.String("id"), JSON: map[string]string{"id": a.String("id")}}, nil
			},
		},
		command.Command{
			Name: "fake.register", Title: "Fake Register", Category: "Fake", ReadOnly: true,
			Args: []command.ArgSpec{{Name: "path", Type: command.Path, Required: true},
				{Name: "project", Type: command.String, Context: command.ContextProject, Description: "Project (default: all)"}},
			Run: func(context.Context, command.Context, command.Args) (command.Result, error) {
				return command.Result{}, nil
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestCommandList(t *testing.T) {
	h := NewCommand(newTestRegistry(t))
	ctx := context.Background()

	res, err := h.List(ctx, connect.NewRequest(&v1.ListCommandsRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	if n := len(res.Msg.GetCommands()); n != 1 || res.Msg.GetCommands()[0].GetName() != "fake.register" {
		t.Fatalf("available commands = %v, want only fake.register", res.Msg.GetCommands())
	}

	res, err = h.List(ctx, connect.NewRequest(&v1.ListCommandsRequest{
		Context:            &v1.UiContext{ActiveTerminalId: "t1"},
		IncludeUnavailable: true,
	}))
	if err != nil {
		t.Fatal(err)
	}
	cmds := res.Msg.GetCommands()
	if len(cmds) != 2 || cmds[0].GetName() != "fake.register" || cmds[1].GetName() != "terminal.kill" {
		t.Fatalf("commands = %v, want fake.register, terminal.kill", cmds)
	}
	kill := cmds[1]
	if !cmds[0].GetReadOnly() || kill.GetReadOnly() {
		t.Errorf("read_only: fake.register %v, terminal.kill %v; want true, false", cmds[0].GetReadOnly(), kill.GetReadOnly())
	}
	if !kill.GetAvailable() || kill.GetCategory() != "Terminal" || kill.GetKeybindings()[0] != "cmd+shift+w" {
		t.Fatalf("terminal.kill = %v", kill)
	}
	id, sig := kill.GetArgs()[0], kill.GetArgs()[1]
	if id.GetRequired() || id.GetDescription() != "Terminal id (default: the active terminal)" || id.GetType() != v1.ArgType_ARG_TYPE_STRING || !id.GetContextBound() {
		t.Errorf("context-bound arg = %v, want not required with default note", id)
	}
	if sig.GetType() != v1.ArgType_ARG_TYPE_ENUM || len(sig.GetEnumValues()) != 2 || sig.GetDefaultValue() != "hup" {
		t.Errorf("enum arg = %v", sig)
	}
	if p := cmds[0].GetArgs()[0]; !p.GetRequired() || p.GetType() != v1.ArgType_ARG_TYPE_PATH {
		t.Errorf("path arg = %v, want required path", p)
	}
	// A description with its own default is not given the context's as well.
	if p := cmds[0].GetArgs()[1]; p.GetDescription() != "Project (default: all)" {
		t.Errorf("description = %q, want its own default only", p.GetDescription())
	}
}

func TestCommandInvoke(t *testing.T) {
	h := NewCommand(newTestRegistry(t))
	tests := []struct {
		name     string
		req      *v1.InvokeCommandRequest
		wantCode connect.Code // 0 = success
		wantMsg  string
		wantJSON string
	}{
		{"ok", &v1.InvokeCommandRequest{Name: "terminal.kill", Context: &v1.UiContext{ActiveTerminalId: "t1"}},
			0, "killed t1", `{"id":"t1"}`},
		{"explicit arg", &v1.InvokeCommandRequest{Name: "terminal.kill", Args: map[string]string{"id": "t2"}},
			0, "killed t2", `{"id":"t2"}`},
		{"no json", &v1.InvokeCommandRequest{Name: "fake.register", Args: map[string]string{"path": "/r"}}, 0, "", ""},
		{"unknown", &v1.InvokeCommandRequest{Name: "nope.nope"}, connect.CodeNotFound, "", ""},
		{"unavailable", &v1.InvokeCommandRequest{Name: "terminal.kill", Context: &v1.UiContext{ActiveView: "pullrequests"}}, connect.CodeFailedPrecondition, "", ""},
		{"missing context arg from the CLI", &v1.InvokeCommandRequest{Name: "terminal.kill"}, connect.CodeInvalidArgument, "", ""},
		{"missing arg", &v1.InvokeCommandRequest{Name: "fake.register"}, connect.CodeInvalidArgument, "", ""},
		{"bad arg", &v1.InvokeCommandRequest{Name: "fake.register", Args: map[string]string{"path": "rel"}}, connect.CodeInvalidArgument, "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res, err := h.Invoke(context.Background(), connect.NewRequest(tt.req))
			if tt.wantCode != 0 {
				if connect.CodeOf(err) != tt.wantCode {
					t.Fatalf("err = %v, want code %v", err, tt.wantCode)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if res.Msg.GetMessage() != tt.wantMsg || res.Msg.GetResultJson() != tt.wantJSON {
				t.Fatalf("response = %v, want message %q json %q", res.Msg, tt.wantMsg, tt.wantJSON)
			}
		})
	}
}
