package command_test

import (
	"context"
	"testing"

	"github.com/awaumann/code-foundry/internal/command"
	"github.com/awaumann/code-foundry/internal/command/commandtest"
)

func TestViewPullRequestsEmitsShowView(t *testing.T) {
	reg := command.NewRegistry()
	emit := &commandtest.Emitter{Delivered: 1}
	if err := command.RegisterView(reg, emit); err != nil {
		t.Fatal(err)
	}
	res, err := reg.Invoke(context.Background(), command.Context{}, "view.pullrequests", nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.Message != "" || res.JSON != (command.EmitResult{Delivered: 1}) {
		t.Errorf("result = %+v, want no message and delivered 1", res)
	}
	got := emit.Intents()
	if len(got) != 1 || got[0].GetShowView().GetName() != command.ViewPullRequests {
		t.Errorf("intents = %v, want one ShowView %q", got, command.ViewPullRequests)
	}
}
