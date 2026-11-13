// Package layouttest provides an in-memory layout.Store for tests of code that reads or
// changes the layout (API handlers, commands, daemon glue). It runs the real operations of
// internal/layout with the test case ids (core.SeqIDs: "p-n1", "t-n1", ...) and publishes
// the same events as the real store, with nothing persisted and no write throttle.
package layouttest

import (
	"context"
	"slices"
	"sync"

	"github.com/alexwaumann/code-foundry/internal/bus"
	core "github.com/alexwaumann/code-foundry/internal/layout"
	"github.com/alexwaumann/code-foundry/internal/store/layout"
)

// Fake implements layout.Store.
type Fake struct {
	bus *bus.Bus
	// Err, when set, is returned by every Apply and SetViewport.
	Err error

	mu       sync.Mutex
	ids      core.SeqIDs
	snap     *layout.Snapshot
	imported bool
	// windowTabs: as the Manager's (layout.FromWindow).
	windowTabs []string
	ops        []string
	vp         layout.Viewport
	vpSet      bool
}

var _ layout.Store = (*Fake)(nil)

// New returns a fake with one empty space "sp-main" called "Main", publishing on b (a
// private bus if nil).
func New(b *bus.Bus) *Fake {
	if b == nil {
		b = bus.New()
	}
	return &Fake{bus: b, snap: &layout.Snapshot{State: core.NewState("sp-main", layout.FirstSpaceName)}}
}

// Bus returns the bus the fake publishes on.
func (f *Fake) Bus() *bus.Bus { return f.bus }

// Put replaces the whole state (it must be in normal form, as a JSON test case's) and
// publishes it as one commit.
func (f *Fake) Put(st *core.State) uint64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.commit(st, "", "", core.Result{})
}

// Ops lists the names of the ops applied so far, failed ones too.
func (f *Fake) Ops() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.ops)
}

// Snapshot implements layout.Store.
func (f *Fake) Snapshot() *layout.Snapshot {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.snap
}

// Apply implements layout.Store.
func (f *Fake) Apply(ctx context.Context, op core.Op, opts layout.ApplyOptions) (layout.Commit, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ops = append(f.ops, op.OpName())
	if f.Err != nil {
		return layout.Commit{}, f.Err
	}
	vp := f.viewport()
	core.WithArea(op, vp.Width, vp.Height)
	next, res, err := core.ApplyWith(f.snap.State, op, &f.ids, core.Options{KeepFocus: opts.KeepFocus})
	if err != nil {
		return layout.Commit{}, err
	}
	if !f.imported {
		f.windowTabs = core.TrackWindowTabs(f.windowTabs, f.snap.State, next, res, layout.IsWindowCall(ctx))
	}
	if layout.Unchanged(f.snap.State, next) {
		return layout.Commit{Rev: f.snap.Rev, Result: res}, nil
	}
	return layout.Commit{Rev: f.commit(next, opts.ClientID, op.OpName(), res), Changed: true, Result: res}, nil
}

// ImportLegacy implements layout.Store.
func (f *Fake) ImportLegacy(_ context.Context, in core.LegacyInput, opts layout.ApplyOptions) (layout.ImportCommit, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ops = append(f.ops, layout.ImportOp)
	if f.Err != nil {
		return layout.ImportCommit{}, f.Err
	}
	if f.imported {
		return layout.ImportCommit{Rev: f.snap.Rev}, nil
	}
	in.WindowTabs = f.windowTabs
	next, res, err := core.ImportLegacy(f.snap.State, in, &f.ids)
	if err != nil {
		return layout.ImportCommit{}, err
	}
	f.imported, f.windowTabs = true, nil
	return layout.ImportCommit{Rev: f.commit(next, opts.ClientID, layout.ImportOp, core.Result{}), Imported: true, Result: res}, nil
}

// commit swaps in next and publishes it. Callers hold f.mu.
func (f *Fake) commit(next *core.State, client, op string, res core.Result) uint64 {
	prev := f.snap
	rev := prev.Rev + 1
	f.snap = &layout.Snapshot{Rev: rev, State: next, LegacyImported: f.imported}
	d := layout.Diff(prev.State, next)
	d.LegacyImported = f.imported
	bus.Publish(f.bus, layout.Event{Rev: rev, ClientID: client, Delta: d, Op: op, Result: res, State: next})
	return rev
}

// SetViewport implements layout.Store.
func (f *Fake) SetViewport(_ string, v layout.Viewport) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.Err != nil {
		return f.Err
	}
	if err := layout.CheckViewport(v); err != nil {
		return err
	}
	f.vp, f.vpSet = v, true
	return nil
}

// Viewport implements layout.Store.
func (f *Fake) Viewport() layout.Viewport {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.viewport()
}

// viewport is Viewport; callers hold f.mu.
func (f *Fake) viewport() layout.Viewport {
	if !f.vpSet {
		return layout.DefaultViewport
	}
	return f.vp
}
