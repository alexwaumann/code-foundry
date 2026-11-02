package command_test

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

// file.find is listed (and its chord fires) on a thread view whose thread has a project or
// a workspace; never for a thread without a project, nor on a page.
func TestFileFindAvailability(t *testing.T) {
	tests := []struct {
		name string
		ctx  command.Context
		want bool
	}{
		{name: "project thread", ctx: command.Context{ActiveThreadID: "s1", ActiveProjectID: "r1", ActiveWorktreePath: "/wt", ActiveView: "thread"}, want: true},
		{name: "workspace thread", ctx: command.Context{ActiveThreadID: "s1", ActiveProjectID: "r1", ActiveWorkspaceID: "w1", ActiveWorktreePath: "/wt", ActiveView: "thread"}, want: true},
		{name: "workspace thread in the workspace's folder", ctx: command.Context{ActiveThreadID: "s1", ActiveWorkspaceID: "w1", ActiveWorktreePath: "/Users/me/mono", ActiveView: "thread"}, want: true},
		{name: "thread without a project", ctx: command.Context{ActiveThreadID: "s1", ActiveView: "thread"}, want: false},
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
	c, ok := reg.Get("file.find")
	if !ok {
		t.Fatal("file.find not registered")
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := c.Available(tt.ctx); got != tt.want {
				t.Errorf("available = %v, want %v", got, tt.want)
			}
		})
	}
}

// A refused file.find says why: no project, or no thread.
func TestFileFindWhyUnavailable(t *testing.T) {
	tests := []struct {
		name string
		ctx  command.Context
		want string
	}{
		{name: "thread without a project", ctx: command.Context{ActiveThreadID: "s1", ActiveView: "thread"}, want: "the thread has no project"},
		{name: "page", ctx: command.Context{ActiveView: "projects"}, want: "no thread is on screen"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg := command.NewRegistry()
			emit := &commandtest.Emitter{Delivered: 1, OpenWindows: 1}
			if err := command.RegisterView(reg, command.ViewDeps{Emitter: emit}); err != nil {
				t.Fatal(err)
			}
			_, err := reg.Invoke(context.Background(), tt.ctx, "file.find", nil)
			if !errors.Is(err, command.ErrUnavailable) || !strings.Contains(err.Error(), tt.want) {
				t.Errorf("err = %v, want unavailable with %q", err, tt.want)
			}
			if len(emit.Intents()) != 0 {
				t.Errorf("intents = %v, want none", emit.Intents())
			}
		})
	}
}

// cmd+p, like an editor's quick open, in the palette under View.
func TestFileFindKeybinding(t *testing.T) {
	f := newFixture(t)
	c, ok := f.reg.Get("file.find")
	if !ok {
		t.Fatal("file.find not registered")
	}
	if !slices.Equal(c.Keybindings, []string{"cmd+p"}) || c.Title != "Go to File…" || c.Category != "View" || c.NoPalette {
		t.Errorf("file.find = %q %q %v nopalette=%v; want Go to File… View [cmd+p] listed", c.Title, c.Category, c.Keybindings, c.NoPalette)
	}
}
