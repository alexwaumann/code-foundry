package command_test

import (
	"errors"
	"strings"
	"testing"

	"connectrpc.com/connect"

	"github.com/alexwaumann/code-foundry/internal/command"
)

// pane.collapse toggles the focused pane, or the named one; --on and --off set it; the last
// open pane of a space is refused; collapsing the focused pane hands the focus on; opening from
// the user takes the focus, from a thread it does not.
func TestPaneCollapse(t *testing.T) {
	collapsed := func(f layoutFixture, pane string) bool {
		_, p := f.state().FindPane(pane)
		return p != nil && p.Collapsed
	}
	t.Run("the app toggles the focused pane, and the focus moves on", func(t *testing.T) {
		f := newLayoutFixture(t)
		f.must(t, fromApp, "pane.collapse", nil)
		if !collapsed(f, "p-left") || f.focus() != "sp-main/p-right/t-diff" {
			t.Fatalf("p-left collapsed %v, focus %s", collapsed(f, "p-left"), f.focus())
		}
		// The last open pane of the space cannot be collapsed.
		_, err := f.run(t, fromApp, "pane.collapse", nil)
		if connect.CodeOf(err) != connect.CodeFailedPrecondition || !strings.Contains(err.Error(), "last open pane") {
			t.Fatalf("err = %v; want the last open pane's refusal", err)
		}
		// Toggled again on the collapsed pane, it opens with the focus.
		f.must(t, fromApp, "pane.collapse", map[string]string{"pane": "p-left"})
		if collapsed(f, "p-left") || f.focus() != "sp-main/p-left/t-a" {
			t.Fatalf("p-left collapsed %v, focus %s", collapsed(f, "p-left"), f.focus())
		}
	})
	t.Run("on and off", func(t *testing.T) {
		f := newLayoutFixture(t)
		res := f.must(t, fromCLI, "pane.collapse", map[string]string{"pane": "p-right", "on": "true"})
		if !collapsed(f, "p-right") || res.Message != "collapsed pane p-right" {
			t.Fatalf("collapsed %v, %q", collapsed(f, "p-right"), res.Message)
		}
		if show := f.must(t, fromCLI, "layout.show", nil).Message; !strings.Contains(show, "pane p-right (collapsed)") {
			t.Errorf("layout show does not mark it:\n%s", show)
		}
		res = f.must(t, fromCLI, "pane.collapse", map[string]string{"pane": "p-right", "on": "true"})
		if !strings.HasSuffix(res.Message, "(nothing changed)") {
			t.Errorf("collapsed again: %q", res.Message)
		}
		f.must(t, fromCLI, "pane.collapse", map[string]string{"pane": "p-right", "off": "true"})
		if collapsed(f, "p-right") || f.focus() != "sp-main/p-right/t-diff" {
			t.Fatalf("collapsed %v, focus %s", collapsed(f, "p-right"), f.focus())
		}
		if _, err := f.run(t, fromCLI, "pane.collapse", map[string]string{"on": "true", "off": "true"}); !errors.Is(err, command.ErrInvalidArgs) {
			t.Errorf("--on --off: %v", err)
		}
		if _, err := f.run(t, fromCLI, "pane.collapse", map[string]string{"pane": "p-nope"}); connect.CodeOf(err) != connect.CodeNotFound {
			t.Errorf("an unknown pane: %v", err)
		}
	})
	t.Run("from a thread it names the pane and keeps the user's focus", func(t *testing.T) {
		f := newLayoutFixture(t)
		if _, err := f.run(t, fromThread, "pane.collapse", nil); !errors.Is(err, command.ErrInvalidArgs) {
			t.Fatalf("no pane from a thread: %v", err)
		}
		f.must(t, fromThread, "pane.collapse", map[string]string{"pane": "p-right"})
		f.must(t, fromThread, "pane.collapse", map[string]string{"pane": "p-right"})
		if collapsed(f, "p-right") || f.focus() != "sp-main/p-left/t-a" {
			t.Fatalf("collapsed %v, focus %s", collapsed(f, "p-right"), f.focus())
		}
	})
}
