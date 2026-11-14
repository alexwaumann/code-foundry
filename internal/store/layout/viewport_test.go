package layout

import (
	"errors"
	"testing"

	core "github.com/alexwaumann/code-foundry/internal/layout"
)

// The viewport is the newest report of a visible window, else the newest report of any,
// else the default.
func TestViewports(t *testing.T) {
	var v Viewports
	if got := v.Current(); got != DefaultViewport {
		t.Fatalf("no report: %+v", got)
	}
	if err := v.Set("a", Viewport{0, 1}); !errors.Is(err, core.ErrInvalidArgument) {
		t.Fatalf("bad viewport: %v", err)
	}
	visible := map[string]bool{}
	v.SetVisible(func(id string) bool { return visible[id] })
	must := func(id string, vp Viewport) {
		t.Helper()
		if err := v.Set(id, vp); err != nil {
			t.Fatal(err)
		}
	}
	must("a", Viewport{1000, 700})
	must("b", Viewport{1600, 900})
	if got := v.Current(); got != (Viewport{1600, 900}) {
		t.Errorf("none visible, newest wins: %+v", got)
	}
	visible["a"] = true
	if got := v.Current(); got != (Viewport{1000, 700}) {
		t.Errorf("a visible: %+v", got)
	}
	visible["b"] = true
	if got := v.Current(); got != (Viewport{1600, 900}) {
		t.Errorf("both visible, newest wins: %+v", got)
	}
	must("", Viewport{500, 500}) // a window with no client id: never known to be visible
	if got := v.Current(); got != (Viewport{1600, 900}) {
		t.Errorf("anonymous report over visible ones: %+v", got)
	}
	visible["a"], visible["b"] = false, false
	if got := v.Current(); got != (Viewport{500, 500}) {
		t.Errorf("none visible again: %+v", got)
	}
	for i := range 2 * maxViewports {
		must(string(rune('A'+i)), Viewport{float64(100 + i), 100})
	}
	if n := len(v.by); n != maxViewports {
		t.Errorf("kept %d reports", n)
	}
}
