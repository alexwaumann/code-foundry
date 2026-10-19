package command_test

import (
	"context"
	"slices"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
)

// thread.interrupt passes --by, which the CLI fills from $CODE_FOUNDRY_THREAD inside a
// thread (the stopped thread's resume note names it); the GUI's interrupts and a plain
// shell's have none: the user's (docs/notes/orch-child-context.md).
func TestThreadInterruptBy(t *testing.T) {
	tests := []struct {
		name string
		ctx  command.Context
		args map[string]string
		want string
	}{
		{"cli inside a thread", command.Context{ActiveThreadID: "s9"}, map[string]string{"id": "s1", "by": "s9"}, "Interrupt s1 by s9"},
		{"cli in a plain shell", command.Context{}, map[string]string{"id": "s1"}, "Interrupt s1"},
		{"gui", command.Context{ActiveThreadID: "s1", ActiveView: "thread"}, map[string]string{"id": "s1"}, "Interrupt s1"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, fake := newThreadRegistry(t)
			if _, err := reg.Invoke(context.Background(), tt.ctx, "thread.interrupt", tt.args); err != nil {
				t.Fatal(err)
			}
			if calls := fake.Calls(); !slices.Contains(calls, tt.want) {
				t.Errorf("calls = %q, want %q", calls, tt.want)
			}
		})
	}
}
