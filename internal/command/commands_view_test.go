package command_test

import (
	"context"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

func TestViewCommandsEmitShowView(t *testing.T) {
	tests := []struct {
		command, view string
	}{
		{command: "view.pullrequests", view: command.ViewPullRequests},
		{command: "view.panel.toggle", view: command.ViewPanelToggle},
	}
	for _, tt := range tests {
		t.Run(tt.command, func(t *testing.T) {
			reg := command.NewRegistry()
			emit := &commandtest.Emitter{Delivered: 1}
			if err := command.RegisterView(reg, emit); err != nil {
				t.Fatal(err)
			}
			res, err := reg.Invoke(context.Background(), command.Context{}, tt.command, nil)
			if err != nil {
				t.Fatal(err)
			}
			if res.Message != "" || res.JSON != (command.EmitResult{Delivered: 1}) {
				t.Errorf("result = %+v, want no message and delivered 1", res)
			}
			got := emit.Intents()
			if len(got) != 1 || got[0].GetShowView().GetName() != tt.view {
				t.Errorf("intents = %v, want one ShowView %q", got, tt.view)
			}
		})
	}
}
