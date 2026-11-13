package command_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
)

// thread.move.open is listed for a thread without a project or workspace only, and opens
// the windows' move picker for that thread (ShowView thread.move, its id in params).
func TestThreadMoveOpen(t *testing.T) {
	tests := []struct {
		name string
		ctx  command.Context
		want string // "" for unavailable with why
		why  string
	}{
		{name: "no project thread", ctx: command.Context{ActiveThreadID: "s1", ActiveView: "thread"}, want: "s1"},
		{name: "CLI with a thread", ctx: command.Context{ActiveThreadID: "s2"}, want: "s2"},
		{name: "project thread", ctx: command.Context{ActiveThreadID: "s1", ActiveProjectID: "r1", ActiveWorktreePath: "/wt", ActiveView: "thread"}, why: "the thread has a project already"},
		{name: "workspace folder thread", ctx: command.Context{ActiveThreadID: "s1", ActiveWorkspaceID: "w1", ActiveView: "thread"}, why: "the thread has a project already"},
		{name: "page", ctx: command.Context{ActiveView: "projects"}, why: "no thread is active"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, _, e := newLifecycleRegistry(t)
			_, err := reg.Invoke(context.Background(), tt.ctx, "thread.move.open", nil)
			if tt.want == "" {
				if !errors.Is(err, command.ErrUnavailable) || !strings.Contains(err.Error(), tt.why) {
					t.Fatalf("err = %v, want unavailable with %q", err, tt.why)
				}
				if len(e.Intents()) != 0 {
					t.Errorf("intents = %v, want none", e.Intents())
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			got := e.Intents()
			if len(got) != 1 || got[0].GetShowView().GetName() != command.ViewThreadMove || got[0].GetShowView().GetParams()["id"] != tt.want {
				t.Fatalf("intents = %v, want one ShowView %q for %s", got, command.ViewThreadMove, tt.want)
			}
		})
	}
}
