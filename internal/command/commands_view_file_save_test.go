package command_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

// file.save is on cmd+s and never asks for anything: a draft may be a secret, so it has no
// arg to carry one. It lists everywhere, since the window decides and the chord needs it.
func TestFileSaveTakesNothing(t *testing.T) {
	reg := command.NewRegistry()
	if err := command.RegisterView(reg, command.ViewDeps{Emitter: &commandtest.Emitter{}}); err != nil {
		t.Fatal(err)
	}
	c, ok := reg.Get("file.save")
	if !ok {
		t.Fatal("file.save not registered")
	}
	if len(c.Args) != 0 {
		t.Errorf("args = %v, want none", c.Args)
	}
	if len(c.Keybindings) != 1 || c.Keybindings[0] != "cmd+s" {
		t.Errorf("keybindings = %v, want cmd+s", c.Keybindings)
	}
	if c.ReadOnly {
		t.Error("file.save writes a file: it is not read-only")
	}
	if c.NoPalette {
		t.Error("file.save has a chord and no prompt: the palette lists it")
	}
	for _, ctx := range []command.Context{{}, {ActiveView: "projects"}, {ActiveThreadID: "s1", ActiveView: "thread"}} {
		if !c.Available(ctx) {
			t.Errorf("unavailable in %+v", ctx)
		}
	}
}

// Whoever invokes it through the daemon is not the user's chord (the window presents that
// itself): the CLI, a thread's model, a page's bridge, a plugin. Each is refused, says why,
// and nothing reaches any window. A context cannot talk its way past this: a page and a
// plugin send a window's view.
func TestFileSaveRefusesEveryCaller(t *testing.T) {
	tests := []struct {
		name string
		ctx  command.Context
	}{
		{name: "CLI", ctx: command.Context{}},
		{name: "a thread's model (the CLI with --context-thread)", ctx: command.Context{ActiveThreadID: "s1"}},
		{name: "CLI naming a worktree", ctx: command.Context{ActiveProjectID: "r1", ActiveWorktreePath: "/wt"}},
		{name: "a page's bridge, as its thread", ctx: command.Context{ActiveThreadID: "s1", ActiveProjectID: "r1", ActiveWorktreePath: "/wt", ActiveView: "thread"}},
		{name: "a page's bridge, on a page", ctx: command.Context{ActiveView: "projects"}},
		{name: "a plugin", ctx: command.Context{ActiveThreadID: "s1", ActiveView: "thread"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg := command.NewRegistry()
			emit := &commandtest.Emitter{Delivered: 1, OpenWindows: 1}
			if err := command.RegisterView(reg, command.ViewDeps{Emitter: emit}); err != nil {
				t.Fatal(err)
			}
			_, err := reg.Invoke(context.Background(), tt.ctx, "file.save", nil)
			if !errors.Is(err, command.ErrUnavailable) {
				t.Fatalf("err = %v, want ErrUnavailable", err)
			}
			if !strings.Contains(err.Error(), "only the user can save a draft") {
				t.Errorf("err = %v, want the reason", err)
			}
			if got := emit.Intents(); len(got) != 0 {
				t.Errorf("intents = %v, want none", got)
			}
		})
	}
}
