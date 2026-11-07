package command_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

func browserRegistry(t *testing.T, on bool) (*command.Registry, *commandtest.Emitter, []command.Command) {
	t.Helper()
	reg := command.NewRegistry()
	emit := &commandtest.Emitter{}
	cmds := command.BrowserCommands(&commandtest.Thread{}, emit)
	if err := reg.Toggle(on, cmds...); err != nil {
		t.Fatal(err)
	}
	return reg, emit, cmds
}

func TestBrowserCommandsExistOnlyWhileOn(t *testing.T) {
	reg, _, cmds := browserRegistry(t, false)
	if got := reg.List(command.Context{}, true); len(got) != 0 {
		t.Fatalf("off, the registry lists %d commands", len(got))
	}
	if _, err := reg.Invoke(context.Background(), command.Context{}, "view.panel.browser", nil); !errors.Is(err, command.ErrUnknownCommand) {
		t.Fatalf("off: %v", err)
	}
	if err := reg.Toggle(true, cmds...); err != nil {
		t.Fatal(err)
	}
	if err := reg.Toggle(true, cmds...); err != nil {
		t.Fatalf("on twice: %v", err)
	}
	if _, ok := reg.Get("view.panel.browser"); !ok {
		t.Fatal("on, the verb is missing")
	}
	if err := reg.Toggle(false, cmds...); err != nil {
		t.Fatal(err)
	}
	if got := reg.List(command.Context{}, true); len(got) != 0 {
		t.Fatalf("off again, the registry lists %d commands", len(got))
	}
}

func TestViewPanelBrowserShowsAnAddressAndNothingElse(t *testing.T) {
	reg, emit, _ := browserRegistry(t, true)
	uctx := command.Context{ActiveThreadID: "s1", ActiveView: "thread"}
	if _, err := reg.Invoke(context.Background(), uctx, "view.panel.browser", map[string]string{"url": "example.com/a"}); err != nil {
		t.Fatal(err)
	}
	got := emit.Intents()
	if len(got) != 1 || got[0].GetShowView().GetName() != command.ViewPanelBrowser {
		t.Fatalf("intents = %v", got)
	}
	if u := got[0].GetShowView().GetParams()["url"]; u != "https://example.com/a" {
		t.Fatalf("url %q", u)
	}
}

func TestViewPanelBrowserGoesToTheCallersThread(t *testing.T) {
	reg, emit, _ := browserRegistry(t, true)
	_, err := reg.Invoke(context.Background(), command.Context{ActiveThreadID: "s1"}, "view.panel.browser", map[string]string{"url": "https://example.com", "thread": "s1"})
	if err != nil {
		t.Fatal(err)
	}
	sv := emit.Intents()[0].GetShowView()
	if sv.GetThreadId() != "s1" || sv.GetParams()["url"] != "https://example.com" {
		t.Fatalf("show view = %v", sv)
	}
}

func TestViewPanelBrowserRefusesEveryOtherScheme(t *testing.T) {
	for _, u := range []string{"file:///etc/hosts", "chrome://settings", "devtools://x", "javascript:alert(1)", "data:text/html,x"} {
		reg, emit, _ := browserRegistry(t, true)
		_, err := reg.Invoke(context.Background(), command.Context{ActiveView: "thread"}, "view.panel.browser", map[string]string{"url": u})
		if err == nil {
			t.Fatalf("%s passed", u)
		}
		if strings.Contains(err.Error(), u) {
			t.Fatalf("the refusal quotes the address: %v", err)
		}
		if got := emit.Intents(); len(got) != 0 {
			t.Fatalf("%s reached a window: %v", u, got)
		}
	}
}

func TestBrowserControlsAreTheWindowsOnly(t *testing.T) {
	reg, emit, _ := browserRegistry(t, true)
	for _, name := range []string{"browser.back", "browser.forward", "browser.reload", "browser.relaunch"} {
		for _, uctx := range []command.Context{{}, {ActiveView: "thread", ActiveThreadID: "s1"}} {
			if _, err := reg.Invoke(context.Background(), uctx, name, nil); !errors.Is(err, command.ErrUnavailable) {
				t.Fatalf("%s: %v", name, err)
			}
		}
	}
	if got := emit.Intents(); len(got) != 0 {
		t.Fatalf("intents = %v", got)
	}
}

func TestBrowserCommandsStayOutOfTheAgentIndex(t *testing.T) {
	_, _, cmds := browserRegistry(t, true)
	for _, c := range cmds {
		if !c.NoIndex {
			t.Errorf("%s is indexed: skill text must not change for an experiment", c.Name)
		}
	}
}
