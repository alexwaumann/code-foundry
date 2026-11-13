package layout

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	core "github.com/alexwaumann/code-foundry/internal/layout"
)

// FirstSpaceName is the name of the space a new database starts with (internal/layout's
// Sanitize gives a state with no space one of that name).
const FirstSpaceName = "Main"

// Options configures a Manager. DB is required.
type Options struct {
	DB  *sql.DB
	Bus *bus.Bus     // default: a private bus
	Log *slog.Logger // default: slog.Default()
	Now func() time.Time
	// IDs makes new ids; default core.RandomIDs.
	IDs core.IDs
	// FocusDelay is how long a focus-only change waits before it is written (structural
	// changes are written at once, with any focus change still waiting). Default 1s.
	FocusDelay time.Duration
	// SmartSwap reports the setting layout.smart_swap, read at every op; nil: on.
	SmartSwap func() bool
}

// Manager is the Store backed by SQLite.
type Manager struct {
	opts Options
	log  *slog.Logger

	// mu serialises Apply, the focus write and Close. Reads use snap.
	mu    sync.Mutex
	state *core.State
	rev   uint64
	// imported is the import mark (metaLegacyImport): "" until ImportLegacy ran.
	imported string
	// windowTabs are, until the import, the thread tabs a window's command opened
	// (window.go, core.TrackWindowTabs).
	windowTabs []string
	// disk is the state the tables hold (at diskRev); nil: they must be rewritten whole.
	disk    *core.State
	diskRev uint64
	// timer writes a waiting focus-only change; nil when none waits.
	timer  *time.Timer
	closed bool

	vps Viewports

	snap atomic.Pointer[Snapshot]
}

var _ Store = (*Manager)(nil)

// New loads the layout. Every document is repaired into normal form (a corrupt one is
// dropped to an empty one) and the repairs are logged; a new database gets one space,
// FirstSpaceName. Only a database error fails.
func New(ctx context.Context, opts Options) (*Manager, error) {
	if opts.DB == nil {
		return nil, errors.New("layout: Options.DB is required")
	}
	if opts.Bus == nil {
		opts.Bus = bus.New()
	}
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.IDs == nil {
		opts.IDs = core.RandomIDs()
	}
	if opts.FocusDelay <= 0 {
		opts.FocusDelay = time.Second
	}
	m := &Manager{opts: opts, log: opts.Log}
	got, err := load(ctx, opts.DB)
	if err != nil {
		return nil, err
	}
	st := got.state
	repairs := append(got.repairs, core.Sanitize(st, opts.IDs)...)
	if err := core.Check(st); err != nil {
		// Sanitize always ends in normal form; this is a bug, never a reason not to start.
		m.log.Error("layout: repaired layout is not in normal form; starting over with one space", "err", err)
		st = core.NewState(opts.IDs.NewID("sp-"), FirstSpaceName)
		repairs = append(repairs, "started over")
	}
	if got.fresh {
		m.log.Info("layout: first space", "space", st.Spaces[0].ID)
	} else if len(repairs) > 0 {
		m.log.Warn("layout: repaired the stored layout", "repairs", repairs)
	}
	m.state, m.rev, m.imported, m.windowTabs = st, got.rev, got.imported, got.windowTabs
	if m.imported != "" {
		m.windowTabs = nil
	}
	if got.fresh || len(repairs) > 0 {
		if err := save(ctx, opts.DB, nil, st, m.rev, m.marks(), opts.Now()); err != nil {
			return nil, err
		}
	}
	m.disk, m.diskRev = st, m.rev
	m.snap.Store(m.snapshot())
	return m, nil
}

// Bus returns the bus events are published on.
func (m *Manager) Bus() *bus.Bus { return m.opts.Bus }

// Snapshot implements Store.
func (m *Manager) Snapshot() *Snapshot { return m.snap.Load() }

// Apply implements Store. The op runs on the current state; a structural change is
// written before it is published, a focus-only one within FocusDelay.
func (m *Manager) Apply(ctx context.Context, op core.Op, opts ApplyOptions) (Commit, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Commit{}, ErrClosed
	}
	prev := m.state
	vp := m.Viewport()
	core.WithArea(op, vp.Width, vp.Height)
	next, res, err := core.ApplyWith(prev, op, m.opts.IDs, core.Options{KeepFocus: opts.KeepFocus, NoSmartSwap: m.opts.SmartSwap != nil && !m.opts.SmartSwap()})
	if err != nil {
		return Commit{}, err
	}
	marked := m.windowTabs
	if m.imported == "" {
		marked = core.TrackWindowTabs(m.windowTabs, prev, next, res, IsWindowCall(ctx))
	}
	if Unchanged(prev, next) {
		if !slices.Equal(marked, m.windowTabs) {
			// Someone else acted on a tab a window opened: it is arranged now, and kept.
			m.windowTabs = marked
			if err := m.flushMarks(context.WithoutCancel(ctx)); err != nil {
				return Commit{}, err
			}
		}
		return Commit{Rev: m.rev, Result: res}, nil
	}
	m.windowTabs = marked
	rev := m.rev + 1
	if FocusOnly(prev, next) {
		m.later()
	} else {
		if err := save(context.WithoutCancel(ctx), m.opts.DB, m.disk, next, rev, m.marks(), m.opts.Now()); err != nil {
			return Commit{}, err
		}
		m.disk, m.diskRev = next, rev
		m.stopTimer()
	}
	m.state, m.rev = next, rev
	m.snap.Store(m.snapshot())
	m.publish(prev, opts.ClientID, op.OpName(), res)
	return Commit{Rev: rev, Changed: true, Result: res}, nil
}

// ImportLegacy implements Store.
func (m *Manager) ImportLegacy(ctx context.Context, in core.LegacyInput, opts ApplyOptions) (ImportCommit, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return ImportCommit{}, ErrClosed
	}
	if m.imported != "" {
		return ImportCommit{Rev: m.rev}, nil
	}
	prev := m.state
	in.WindowTabs = slices.Clone(m.windowTabs)
	next, res, err := core.ImportLegacy(prev, in, m.opts.IDs)
	if err != nil {
		return ImportCommit{}, err
	}
	rev := m.rev + 1
	imported := fmt.Sprintf("done:%d", m.opts.Now().UnixMilli())
	if err := save(context.WithoutCancel(ctx), m.opts.DB, m.disk, next, rev, marks{imported: imported}, m.opts.Now()); err != nil {
		return ImportCommit{}, err
	}
	m.stopTimer()
	m.disk, m.diskRev = next, rev
	m.state, m.rev, m.imported, m.windowTabs = next, rev, imported, nil
	m.snap.Store(m.snapshot())
	m.publish(prev, opts.ClientID, ImportOp, core.Result{})
	return ImportCommit{Rev: rev, Imported: true, Result: res}, nil
}

// snapshot is the state now as a Snapshot. Callers hold m.mu (or own m, in New).
func (m *Manager) snapshot() *Snapshot {
	return &Snapshot{Rev: m.rev, State: m.state, LegacyImported: m.imported != ""}
}

// publish announces the commit that took prev to the state now. Callers hold m.mu.
func (m *Manager) publish(prev *core.State, client, op string, res core.Result) {
	d := Diff(prev, m.state)
	d.LegacyImported = m.imported != ""
	bus.Publish(m.opts.Bus, Event{Rev: m.rev, ClientID: client, Delta: d, Op: op, Result: res})
}

// later makes sure a write of the state is coming. Callers hold m.mu.
func (m *Manager) later() {
	if m.timer == nil {
		m.timer = time.AfterFunc(m.opts.FocusDelay, m.flushLater)
	}
}

func (m *Manager) stopTimer() {
	if m.timer != nil {
		m.timer.Stop()
		m.timer = nil
	}
}

func (m *Manager) flushLater() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.timer = nil
	if m.closed {
		return
	}
	if err := m.flush(context.Background()); err != nil {
		m.log.Warn("layout: writing focus", "err", err)
	}
}

// flush writes the state when the tables are behind it. Callers hold m.mu.
func (m *Manager) flush(ctx context.Context) error {
	if m.disk == m.state && m.diskRev == m.rev {
		return nil
	}
	return m.flushMarks(ctx)
}

// flushMarks writes the state and the import's marks. Callers hold m.mu.
func (m *Manager) flushMarks(ctx context.Context) error {
	if err := save(ctx, m.opts.DB, m.disk, m.state, m.rev, m.marks(), m.opts.Now()); err != nil {
		return err
	}
	m.disk, m.diskRev = m.state, m.rev
	return nil
}

// marks are the import's keys as they are now. Callers hold m.mu.
func (m *Manager) marks() marks { return marks{imported: m.imported, windowTabs: m.windowTabs} }

// Close writes a focus change still waiting and refuses later Applies.
func (m *Manager) Close(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil
	}
	m.closed = true
	m.stopTimer()
	if err := m.flush(ctx); err != nil {
		return fmt.Errorf("layout: close: %w", err)
	}
	return nil
}

// SetViewport implements Store.
func (m *Manager) SetViewport(clientID string, v Viewport) error {
	return m.vps.Set(clientID, v)
}

// SetWindowVisible sets how the store tells whether a window (by client id) is visible:
// the newest report of a visible window is the viewport (Viewports).
func (m *Manager) SetWindowVisible(f func(clientID string) bool) { m.vps.SetVisible(f) }

// Viewport implements Store.
func (m *Manager) Viewport() Viewport {
	return m.vps.Current()
}
