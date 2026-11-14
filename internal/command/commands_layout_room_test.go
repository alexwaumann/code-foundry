package command_test

import (
	"errors"
	"strings"
	"testing"

	"connectrpc.com/connect"

	core "github.com/alexwaumann/code-foundry/internal/layout"
	layoutstore "github.com/alexwaumann/code-foundry/internal/store/layout"
)

// A space holds only as many open panes as fit (docs/notes/shell-model.md, "Room for panes";
// docs/notes/shell-25f-sizes.md). The seeded Main space has two panes in a row in the default
// 1180 x 820 area: a third column does not fit, a row under them does.
func TestLayoutVerbsRefuseWithoutRoom(t *testing.T) {
	tests := []struct {
		name string
		cmd  string
		args map[string]string
	}{
		{"a split to the right", "pane.split", map[string]string{"pane": "p-left", "tab": "t-prs", "edge": "right"}},
		{"a tab onto a pane's right edge", "tab.move", map[string]string{"tab": "t-prs", "split": "p-right", "edge": "right"}},
		{"a tab onto the outer left edge", "tab.move", map[string]string{"tab": "t-prs", "outer": "left"}},
		{"a pane moved into the space", "pane.move", map[string]string{"pane": "p-two", "space": "Main"}},
		{"a thread opened on the outer edge", "thread.open", map[string]string{"id": "s-new000000003", "outer": "right"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newLayoutFixture(t)
			rev := f.store.Snapshot().Rev
			_, err := f.run(t, fromCLI, tt.cmd, tt.args)
			if connect.CodeOf(err) != connect.CodeFailedPrecondition {
				t.Fatalf("err = %v; want failed_precondition", err)
			}
			var ce *connect.Error
			if !errors.As(err, &ce) || ce.Message() != core.NoRoom {
				t.Errorf("message %q; want %q", err, core.NoRoom)
			}
			if f.store.Snapshot().Rev != rev {
				t.Error("a refused verb changed the layout")
			}
		})
	}

	t.Run("a split below fits", func(t *testing.T) {
		f := newLayoutFixture(t)
		if _, err := f.run(t, fromCLI, "pane.split", map[string]string{"pane": "p-left", "tab": "t-prs", "edge": "bottom"}); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("collapsing a pane makes room", func(t *testing.T) {
		f := newLayoutFixture(t)
		f.must(t, fromCLI, "pane.collapse", map[string]string{"pane": "p-right", "on": "true"})
		if _, err := f.run(t, fromCLI, "pane.split", map[string]string{"pane": "p-left", "tab": "t-prs", "edge": "right"}); err != nil {
			t.Fatal(err)
		}
	})
}

// tab.reopen brings a closed pane back collapsed when it would not fit open, and says so.
func TestTabReopenCollapsedWithoutRoom(t *testing.T) {
	f := newLayoutFixture(t).wide(t)
	f.must(t, fromCLI, "pane.split", map[string]string{"pane": "p-left", "tab": "t-prs", "edge": "right"})
	st := f.state()
	_, p, _ := st.FindTab("t-prs")
	f.must(t, fromCLI, "pane.close", map[string]string{"pane": p.ID})
	if err := f.store.SetViewport("", layoutstore.Viewport{Width: 1180, Height: 820}); err != nil {
		t.Fatal(err)
	}
	res := f.must(t, fromCLI, "tab.reopen", nil)
	if want := "collapsed: there is no room to open it here"; !strings.Contains(res.Message, want) {
		t.Errorf("message %q; want it to say %q", res.Message, want)
	}
	_, back, _ := f.state().FindTab("t-prs")
	if back == nil || !back.Collapsed {
		t.Errorf("pane %+v; want it back collapsed", back)
	}
}
