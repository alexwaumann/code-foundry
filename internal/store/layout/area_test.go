package layout

import (
	"context"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/db/dbtest"
	core "github.com/alexwaumann/code-foundry/internal/layout"
)

// An op that lays panes out gets the viewport when it names no area of its own: the default
// before any window reported one, then the last report. One that names its area keeps it.
func TestApplyMeasuresInTheViewport(t *testing.T) {
	m := open(t, dbtest.Open(t), nil, nil)
	first := &core.OpenThread{Thread: "s-1", Focus: true}
	apply(t, m, first)
	if first.W != DefaultViewport.Width || first.H != DefaultViewport.Height {
		t.Errorf("before a report: %gx%g", first.W, first.H)
	}
	if err := m.SetViewport("w", Viewport{900, 600}); err != nil {
		t.Fatal(err)
	}
	reported := &core.CloseThread{Thread: "s-1"}
	apply(t, m, reported)
	if reported.W != 900 || reported.H != 600 {
		t.Errorf("after a report: %gx%g", reported.W, reported.H)
	}
	own := &core.OpenThread{Thread: "s-1", W: 2000, H: 1000}
	apply(t, m, own)
	if own.W != 2000 || own.H != 1000 {
		t.Errorf("an op's own area: %gx%g", own.W, own.H)
	}
}

// KeepFocus opens a tab without moving the user's focus.
func TestApplyKeepFocus(t *testing.T) {
	m := open(t, dbtest.Open(t), nil, nil)
	apply(t, m, &core.AddTab{Tab: &core.Tab{Kind: "prs"}, Focus: true})
	before := m.Snapshot().State.Spaces[0]
	c, err := m.Apply(context.Background(), &core.SplitPane{Pane: before.Focus, Edge: core.Right, Tab: file("/x"), Focus: true}, ApplyOptions{KeepFocus: true})
	if err != nil {
		t.Fatal(err)
	}
	after := m.Snapshot().State.Spaces[0]
	if after.Focus != before.Focus || c.Result.Pane == before.Focus {
		t.Errorf("focus %s, was %s; new pane %s", after.Focus, before.Focus, c.Result.Pane)
	}
}
