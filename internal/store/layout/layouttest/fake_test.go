package layouttest

import (
	"context"
	"errors"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/bus"
	core "github.com/alexwaumann/code-foundry/internal/layout"
	"github.com/alexwaumann/code-foundry/internal/store/layout"
)

func TestFakeAppliesAndPublishes(t *testing.T) {
	b := bus.New()
	sub := bus.Subscribe[layout.Event](b, 8)
	defer sub.Close()
	f := New(b)
	ctx := context.Background()
	c, err := f.Apply(ctx, &core.NewSpace{Name: "Two"}, layout.ApplyOptions{ClientID: "w"})
	if err != nil || c.Rev != 1 || c.Result.Space != "sp-n1" {
		t.Fatalf("commit %+v, %v; want rev 1 making sp-n1", c, err)
	}
	if ev := <-sub.C(); ev.Rev != 1 || ev.ClientID != "w" || len(ev.Delta.Spaces) != 1 {
		t.Errorf("event %+v", ev)
	}
	if c, err := f.Apply(ctx, &core.SwitchSpace{Space: "sp-main"}, layout.ApplyOptions{}); err != nil || c.Changed {
		t.Errorf("no-op %+v, %v; want unchanged", c, err)
	}
	if _, err := f.Apply(ctx, &core.FocusTab{Tab: "t-x"}, layout.ApplyOptions{}); !errors.Is(err, core.ErrNotFound) {
		t.Errorf("missing tab: %v", err)
	}
	f.Err = errors.New("boom")
	if _, err := f.Apply(ctx, &core.NewSpace{}, layout.ApplyOptions{}); err == nil {
		t.Error("Err not returned")
	}
	if got := f.Ops(); len(got) != 4 || got[0] != "new_space" {
		t.Errorf("ops %v", got)
	}
	if f.Snapshot().Rev != 1 {
		t.Errorf("rev %d", f.Snapshot().Rev)
	}
	if f.Put(core.NewState("sp-x", "X")) != 2 || f.Snapshot().State.Spaces[0].ID != "sp-x" {
		t.Error("Put did not replace the state")
	}
}
