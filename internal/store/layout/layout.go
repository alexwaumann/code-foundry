// Package layout is the layout store: the one writer of the window shell's layout (spaces,
// pane trees, tabs, per-thread state). It loads the layout from SQLite at open, repairing
// what it finds, runs every operation of internal/layout one at a time under one mutex,
// persists the result, publishes an immutable Snapshot and emits one Event per commit with
// the next rev. It never looks at threads or terminals: the daemon's glue turns their
// events into operations.
//
// See docs/ARCHITECTURE.md §14 and docs/notes/shell-3-layout-store.md.
package layout

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"reflect"
	"slices"

	core "github.com/alexwaumann/code-foundry/internal/layout"
)

// ErrClosed is an Apply after Close.
var ErrClosed = errors.New("layout store closed")

// DefaultViewport is the pane area used before any window reports its own.
var DefaultViewport = Viewport{Width: 1180, Height: 820}

// Store is the layout store. *Manager implements it; layouttest.Fake is the in-memory fake.
type Store interface {
	// Snapshot is the layout now. Never mutate it.
	Snapshot() *Snapshot
	// Apply runs op. On an error (see internal/layout's errors) nothing changed. An op
	// that changes nothing is no commit: the rev stays and no event is published. An op
	// that lays panes out and names no pane area gets Viewport (core.WithArea, which sets
	// it on op).
	Apply(ctx context.Context, op core.Op, opts ApplyOptions) (Commit, error)
	// SetViewport records the pane area a window reported (layout pixels).
	SetViewport(clientID string, v Viewport) error
	// Viewport is the pane area the daemon lays out with: the last one a window reported
	// while the daemon runs (kept when the window goes), else DefaultViewport. It is not
	// stored: a restarted daemon lays out in DefaultViewport until a window reports.
	Viewport() Viewport
	// ImportLegacy runs the first-load import (core.ImportLegacy) once in the life of the
	// database: its result and the imported mark are one commit, written in one transaction,
	// even when the layout itself does not change. Once the mark is set it changes nothing
	// and answers Imported false with the layout as it is.
	ImportLegacy(ctx context.Context, in core.LegacyInput, opts ApplyOptions) (ImportCommit, error)
}

// ImportCommit is what an ImportLegacy did.
type ImportCommit struct {
	// Rev is the commit's rev, or the current rev when the import ran before.
	Rev uint64
	// Imported is false when the import ran before: nothing changed.
	Imported bool
	Result   core.LegacyResult
}

// ImportOp is the name an import's Event carries as its Op.
const ImportOp = "import_legacy"

// Snapshot is the layout at one rev. State is shared and must never be mutated.
type Snapshot struct {
	Rev   uint64
	State *core.State
	// LegacyImported: the first-load import ran (ImportLegacy).
	LegacyImported bool
	// Newer lists what in the stored layout a newer build wrote. When it is not empty the
	// store saves nothing, so going back to the newer build finds its layout as it was.
	Newer []string
}

// ApplyOptions are the caller's facts about an Apply.
type ApplyOptions struct {
	// ClientID names the window that asked, carried on the commit's Event.
	ClientID string
	// KeepFocus runs the op without moving the user's focus (core.Options.KeepFocus): a
	// call from inside a thread.
	KeepFocus bool
}

// Commit is what an Apply did.
type Commit struct {
	// Rev is the commit's rev, or the current rev when nothing changed.
	Rev uint64
	// Changed is false for an op that changed nothing.
	Changed bool
	// Result is what the op reported.
	Result core.Result
}

// Viewport is the pane area's size in layout pixels.
type Viewport struct {
	Width, Height float64
}

// Event is one commit, published on the bus.
type Event struct {
	Rev      uint64
	ClientID string
	Delta    Delta
	// Op is the name of the op that made the commit, and Result what it reported: the
	// daemon's glue ends the terminals of the tabs it closed and starts the fresh shells it
	// restored (docs/notes/shell-6-lifecycle.md). Neither reaches a client.
	Op     string
	Result core.Result
	// State is the whole state after the commit (Go only): a subscriber that missed events
	// compares it with a later snapshot to see what changed in between.
	State *core.State
}

// Delta is what one commit changed: whole spaces and whole thread records. Order,
// CurrentSpace and DefaultSpace are always set. Never mutate it: its spaces and thread
// states are shared with the snapshot.
type Delta struct {
	// Spaces are the new or changed spaces, in order.
	Spaces        []*core.Space
	RemovedSpaces []string
	// Order is every space id in order.
	Order        []string
	CurrentSpace string
	DefaultSpace string
	// Threads are the new or changed thread records, by thread id.
	Threads []ThreadEntry
	// RemovedThreads are threads whose record went, sorted.
	RemovedThreads []string
	// LegacyImported is the snapshot's, always set.
	LegacyImported bool
}

// ThreadEntry is one thread's record.
type ThreadEntry struct {
	ID    string
	State *core.ThreadState
}

// Diff is the delta from prev to next. Spaces and thread records that are not deeply
// equal in the two are carried whole.
func Diff(prev, next *core.State) Delta {
	d := Delta{CurrentSpace: next.CurrentSpace, DefaultSpace: next.DefaultSpace}
	for _, sp := range next.Spaces {
		d.Order = append(d.Order, sp.ID)
		if !reflect.DeepEqual(prev.Space(sp.ID), sp) {
			d.Spaces = append(d.Spaces, sp)
		}
	}
	for _, sp := range prev.Spaces {
		if next.Space(sp.ID) == nil {
			d.RemovedSpaces = append(d.RemovedSpaces, sp.ID)
		}
	}
	for _, id := range slices.Sorted(maps.Keys(next.Threads)) {
		if ts := next.Threads[id]; !reflect.DeepEqual(prev.Threads[id], ts) {
			d.Threads = append(d.Threads, ThreadEntry{ID: id, State: ts})
		}
	}
	for _, id := range slices.Sorted(maps.Keys(prev.Threads)) {
		if _, ok := next.Threads[id]; !ok {
			d.RemovedThreads = append(d.RemovedThreads, id)
		}
	}
	return d
}

// FocusOnly reports whether prev and next differ only in focus: the current space, each
// space's focused pane and MRU, and each pane's active tab. The store writes such a change
// through at most once a second (docs/notes/shell-3-layout-store.md).
func FocusOnly(prev, next *core.State) bool {
	return reflect.DeepEqual(withoutFocus(prev), withoutFocus(next))
}

func withoutFocus(st *core.State) *core.State {
	c := st.Clone()
	c.CurrentSpace = ""
	for _, sp := range c.Spaces {
		sp.Focus, sp.MRU = "", nil
		for _, p := range core.Panes(sp.Root) {
			p.Active = ""
		}
	}
	return c
}

// Unchanged reports whether next is the same layout as prev: no commit.
func Unchanged(prev, next *core.State) bool {
	return prev.CurrentSpace == next.CurrentSpace && prev.DefaultSpace == next.DefaultSpace &&
		slices.EqualFunc(prev.Spaces, next.Spaces, func(a, b *core.Space) bool { return reflect.DeepEqual(a, b) }) &&
		maps.EqualFunc(prev.Threads, next.Threads, func(a, b *core.ThreadState) bool { return reflect.DeepEqual(a, b) })
}

// CheckViewport refuses a size the daemon cannot lay out in (ErrInvalidArgument).
func CheckViewport(v Viewport) error {
	ok := func(x float64) bool { return x > 0 && x < 1e6 }
	if !ok(v.Width) || !ok(v.Height) {
		return fmt.Errorf("viewport %gx%g: %w", v.Width, v.Height, core.ErrInvalidArgument)
	}
	return nil
}
