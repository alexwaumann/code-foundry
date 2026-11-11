package command_test

import (
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

// The File tab's find verbs: listed on a thread view (the only one with a side panel), not
// in a subagent view, on a page or in the composer; always for the CLI. They share
// thread.find's chords, and stay in the palette under View.
func TestFileSearchCommands(t *testing.T) {
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
		{name: "CLI", ctx: command.Context{}, want: true},
	}
	reg := command.NewRegistry()
	em := &commandtest.Emitter{}
	if err := command.RegisterView(reg, command.ViewDeps{Emitter: em}); err != nil {
		t.Fatal(err)
	}
	for name, shared := range map[string]string{"file.search": "thread.find", "file.search.next": "thread.find.next", "file.search.previous": "thread.find.previous"} {
		c, ok := reg.Get(name)
		if !ok {
			t.Fatalf("%s not registered", name)
		}
		other, _ := reg.Get(shared)
		if command.SharedChords[name] != shared || len(c.Keybindings) != 1 || c.Keybindings[0] != other.Keybindings[0] || c.NoPalette || c.Category != "View" {
			t.Errorf("%s = %v shared=%q nopalette=%v %q; want %s's chord, listed under View", name, c.Keybindings, command.SharedChords[name], c.NoPalette, c.Category, shared)
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
