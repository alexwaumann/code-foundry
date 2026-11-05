package command_test

import (
	"context"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

// file.save is on cmd+s and never asks for anything: a draft may be a secret, so it has no
// arg to carry one, and it is available everywhere (only a window knows what is editing).
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

// What reaches the window is the view's name and nothing else, whatever the caller passed.
func TestFileSaveIntentCarriesNoContents(t *testing.T) {
	reg := command.NewRegistry()
	emit := &commandtest.Emitter{Delivered: 1, OpenWindows: 1}
	if err := command.RegisterView(reg, command.ViewDeps{Emitter: emit}); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.Invoke(context.Background(), command.Context{}, "file.save", nil); err != nil {
		t.Fatal(err)
	}
	intents := emit.Intents()
	if len(intents) != 1 {
		t.Fatalf("intents = %d, want 1", len(intents))
	}
	show := intents[0].GetShowView()
	if show.GetName() != command.ViewFileSave {
		t.Errorf("view = %q, want %q", show.GetName(), command.ViewFileSave)
	}
	if len(show.GetParams()) != 0 || show.GetThreadId() != "" {
		t.Errorf("show view carries more than its name: %v", show)
	}
}
