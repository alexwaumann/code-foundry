package command_test

import (
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

// The find verbs are listed (and their chords fire) on a thread view, with or without a
// project; not in a subagent view, on a page or in the composer.
func TestThreadFindAvailability(t *testing.T) {
	tests := []struct {
		name string
		ctx  command.Context
		want bool
	}{
		{name: "project thread", ctx: command.Context{ActiveThreadID: "s1", ActiveProjectID: "r1", ActiveWorktreePath: "/wt", ActiveView: "thread"}, want: true},
		{name: "thread without a project", ctx: command.Context{ActiveThreadID: "s1", ActiveView: "thread"}, want: true},
		{name: "subagent view", ctx: command.Context{ActiveThreadID: "s1", ActiveProjectID: "r1", ActiveView: command.ViewSubagent}, want: false},
		{name: "composer", ctx: command.Context{ActiveProjectID: "r1", ActiveView: "compose"}, want: false},
		{name: "projects page", ctx: command.Context{ActiveProjectID: "r1", ActiveWorktreePath: "/src", ActiveView: "projects"}, want: false},
		{name: "pull requests page", ctx: command.Context{ActiveView: "pullrequests"}, want: false},
		{name: "CLI", ctx: command.Context{}, want: true},
	}
	reg := command.NewRegistry()
	if err := command.RegisterView(reg, command.ViewDeps{Emitter: &commandtest.Emitter{}}); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"thread.find", "thread.find.next", "thread.find.previous"} {
		c, ok := reg.Get(name)
		if !ok {
			t.Fatalf("%s not registered", name)
		}
		for _, tt := range tests {
			t.Run(name+"/"+tt.name, func(t *testing.T) {
				if got := c.Available(tt.ctx); got != tt.want {
					t.Errorf("available = %v, want %v", got, tt.want)
				}
			})
		}
	}
}

// Each verb keeps its default chord and stays in the palette.
func TestThreadFindChords(t *testing.T) {
	reg := command.NewRegistry()
	if err := command.RegisterView(reg, command.ViewDeps{Emitter: &commandtest.Emitter{}}); err != nil {
		t.Fatal(err)
	}
	for name, chord := range map[string]string{"thread.find": "cmd+f", "thread.find.next": "cmd+g", "thread.find.previous": "cmd+shift+g"} {
		c, ok := reg.Get(name)
		if !ok {
			t.Fatalf("%s not registered", name)
		}
		if len(c.Keybindings) != 1 || c.Keybindings[0] != chord || c.NoPalette || c.Category != "View" {
			t.Errorf("%s = %v nopalette=%v %q; want [%s] listed under View", name, c.Keybindings, c.NoPalette, c.Category, chord)
		}
	}
}
