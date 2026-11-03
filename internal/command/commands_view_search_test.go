package command_test

import (
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

// search.open works from anywhere: every view, with or without a thread, and the CLI. It
// keeps cmd+shift+f and stays in the palette under View.
func TestSearchOpen(t *testing.T) {
	reg := command.NewRegistry()
	if err := command.RegisterView(reg, command.ViewDeps{Emitter: &commandtest.Emitter{}}); err != nil {
		t.Fatal(err)
	}
	c, ok := reg.Get("search.open")
	if !ok {
		t.Fatal("search.open not registered")
	}
	if len(c.Keybindings) != 1 || c.Keybindings[0] != "cmd+shift+f" || c.NoPalette || c.Category != "View" || c.Title != "Search Threads" {
		t.Errorf("search.open = %v nopalette=%v %q %q; want [cmd+shift+f] listed under View as Search Threads", c.Keybindings, c.NoPalette, c.Category, c.Title)
	}
	tests := []struct {
		name string
		ctx  command.Context
	}{
		{name: "thread", ctx: command.Context{ActiveThreadID: "s1", ActiveProjectID: "r1", ActiveView: "thread"}},
		{name: "thread without a project", ctx: command.Context{ActiveThreadID: "s1", ActiveView: "thread"}},
		{name: "subagent view", ctx: command.Context{ActiveThreadID: "s1", ActiveView: command.ViewSubagent}},
		{name: "composer", ctx: command.Context{ActiveView: "compose"}},
		{name: "projects page", ctx: command.Context{ActiveView: "projects"}},
		{name: "pull requests page", ctx: command.Context{ActiveView: "pullrequests"}},
		{name: "CLI", ctx: command.Context{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if !c.Available(tt.ctx) {
				t.Errorf("unavailable in %+v", tt.ctx)
			}
		})
	}
}
