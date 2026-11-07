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

// A page in the app can aim a browser that may be signed in as the user only with the user's yes;
// showing the tab, or a thread's CLI aiming it, asks nothing (docs/notes/page-verb-gate.md).
func TestAPageAimingTheBrowserAsksTheUser(t *testing.T) {
	page := command.Context{ActiveThreadID: "s1", Origin: command.OriginPage}
	for _, tc := range []struct {
		name string
		uctx command.Context
		args map[string]string
		asks bool
	}{
		{"a page with an address", page, map[string]string{"url": "https://bank.example"}, true},
		{"a page showing the tab", page, nil, false},
		{"an unknown caller with an address", command.Context{ActiveThreadID: "s1", Origin: command.OriginUnknown}, map[string]string{"url": "https://bank.example"}, true},
		{"a thread's CLI with an address", command.Context{ActiveThreadID: "s1", Origin: command.OriginCLI}, map[string]string{"url": "https://bank.example"}, false},
		{"the app with an address", command.Context{ActiveView: "thread", ActiveThreadID: "s1"}, map[string]string{"url": "https://bank.example"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reg, emit, _ := browserRegistry(t, true)
			_, err := reg.Invoke(context.Background(), tc.uctx, "view.panel.browser", tc.args)
			var ce *command.ConfirmError
			if asked := errors.As(err, &ce); asked != tc.asks {
				t.Fatalf("asked = %v, want %v (err %v)", asked, tc.asks, err)
			}
			if tc.asks && len(emit.Intents()) != 0 {
				t.Fatalf("reached a window before the answer: %v", emit.Intents())
			}
			if !tc.asks && err != nil {
				t.Fatal(err)
			}
		})
	}
	// The controls refuse a page as they refuse everyone, after asking: they fail closed.
	reg, _, _ := browserRegistry(t, true)
	var ce *command.ConfirmError
	if _, err := reg.Invoke(context.Background(), page, "browser.reload", nil); !errors.As(err, &ce) {
		t.Fatalf("a page's browser.reload: %v", err)
	}
}
