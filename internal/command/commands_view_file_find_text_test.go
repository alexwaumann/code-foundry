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

// file.find.text is listed where file.find is: a thread view whose thread has a project or a
// workspace, and the CLI; never a thread without a project, the composer or a page.
func TestFileFindTextAvailability(t *testing.T) {
	tests := []struct {
		name string
		ctx  command.Context
		want bool
	}{
		{name: "project thread", ctx: command.Context{ActiveThreadID: "s1", ActiveProjectID: "r1", ActiveWorktreePath: "/wt", ActiveView: "thread"}, want: true},
		{name: "workspace thread in the workspace's folder", ctx: command.Context{ActiveThreadID: "s1", ActiveWorkspaceID: "w1", ActiveWorktreePath: "/Users/me/mono", ActiveView: "thread"}, want: true},
		{name: "thread without a project", ctx: command.Context{ActiveThreadID: "s1", ActiveView: "thread"}, want: false},
		{name: "subagent view", ctx: command.Context{ActiveThreadID: "s1", ActiveProjectID: "r1", ActiveView: command.ViewSubagent}, want: false},
		{name: "composer", ctx: command.Context{ActiveProjectID: "r1", ActiveView: "compose"}, want: false},
		{name: "projects page", ctx: command.Context{ActiveProjectID: "r1", ActiveWorktreePath: "/src", ActiveView: "projects"}, want: false},
		{name: "CLI", ctx: command.Context{}, want: true},
	}
	reg := command.NewRegistry()
	if err := command.RegisterView(reg, command.ViewDeps{Emitter: &commandtest.Emitter{}}); err != nil {
		t.Fatal(err)
	}
	c, ok := reg.Get("file.find.text")
	if !ok {
		t.Fatal("file.find.text not registered")
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := c.Available(tt.ctx); got != tt.want {
				t.Errorf("available = %v, want %v", got, tt.want)
			}
		})
	}
}

// A refused file.find.text says why and shows nothing.
func TestFileFindTextWhyUnavailable(t *testing.T) {
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
			_, err := reg.Invoke(context.Background(), tt.ctx, "file.find.text", nil)
			if !errors.Is(err, command.ErrUnavailable) || !strings.Contains(err.Error(), tt.want) {
				t.Errorf("err = %v, want unavailable with %q", err, tt.want)
			}
			if len(emit.Intents()) != 0 {
				t.Errorf("intents = %v, want none", emit.Intents())
			}
		})
	}
}

// cmd+shift+p, which the command palette gave up: it is no longer reserved, and this
// command is the only one that binds it.
func TestFileFindTextKeybinding(t *testing.T) {
	f := newFixture(t)
	c, ok := f.reg.Get("file.find.text")
	if !ok {
		t.Fatal("file.find.text not registered")
	}
	if !slices.Equal(c.Keybindings, []string{"cmd+shift+p"}) || c.Title != "Search in Files…" || c.Category != "View" || c.NoPalette {
		t.Errorf("file.find.text = %q %q %v nopalette=%v; want Search in Files… View [cmd+shift+p] listed", c.Title, c.Category, c.Keybindings, c.NoPalette)
	}
	if slices.Contains(command.ReservedChords, "cmd+shift+p") {
		t.Error("cmd+shift+p is still reserved for the palette")
	}
	for _, l := range f.reg.List(command.Context{}, true) {
		if l.Command.Name != "file.find.text" && slices.Contains(l.Command.Keybindings, "cmd+shift+p") {
			t.Errorf("%s binds cmd+shift+p too", l.Command.Name)
		}
	}
}
