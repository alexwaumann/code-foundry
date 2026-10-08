package api

import (
	"context"
	"errors"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

func TestCommandInvokeConfirm(t *testing.T) {
	r := command.NewRegistry()
	ran := 0
	if err := r.Register(command.Command{
		Name: "session.remove", Title: "Remove Session", Category: "Session",
		Args:    []command.ArgSpec{{Name: "id", Type: command.String, Required: true, Context: command.ContextSession, Positional: true}},
		Confirm: "Remove session {id}?",
		Run: func(context.Context, command.Context, command.Args) (command.Result, error) {
			ran++
			return command.Result{Message: "removed"}, nil
		},
	}); err != nil {
		t.Fatal(err)
	}
	h := NewCommand(r)
	ctx := context.Background()

	list, err := h.List(ctx, connect.NewRequest(&v1.ListCommandsRequest{IncludeUnavailable: true}))
	if err != nil {
		t.Fatal(err)
	}
	c := list.Msg.GetCommands()[0]
	if !c.GetRequiresConfirmation() || !c.GetArgs()[0].GetPositional() {
		t.Fatalf("listed = %v, want requires_confirmation and a positional arg", c)
	}

	_, err = h.Invoke(ctx, connect.NewRequest(&v1.InvokeCommandRequest{Name: "session.remove", Args: map[string]string{"id": "s1"}}))
	var ce *connect.Error
	if !errors.As(err, &ce) || ce.Code() != connect.CodeFailedPrecondition {
		t.Fatalf("err = %v, want FailedPrecondition", err)
	}
	var got *v1.ConfirmationRequired
	for _, d := range ce.Details() {
		if m, derr := d.Value(); derr == nil {
			if cr, ok := m.(*v1.ConfirmationRequired); ok {
				got = cr
			}
		}
	}
	if got == nil || got.GetMessage() != "Remove session s1?" || got.GetCommand() != "session.remove" || got.GetTitle() != "Remove Session" {
		t.Fatalf("detail = %v", got)
	}
	if ran != 0 {
		t.Fatal("ran without confirmation")
	}

	res, err := h.Invoke(ctx, connect.NewRequest(&v1.InvokeCommandRequest{
		Name: "session.remove", Args: map[string]string{"id": "s1"}, Confirmed: true,
	}))
	if err != nil || res.Msg.GetMessage() != "removed" || ran != 1 {
		t.Fatalf("confirmed invoke = %v, %v (ran %d)", res, err, ran)
	}
}
