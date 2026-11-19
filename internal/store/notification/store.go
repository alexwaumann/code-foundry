package notification

import (
	"cmp"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

// DefaultCheckInterval is how often the store compares show_at and snooze times with the
// wall clock (Tick).
const DefaultCheckInterval = time.Second

// ClosedRetention is how long a dismissed, withdrawn or resolved notification is kept
// after its last change: as long as it is kept, a re-post of its key with the same
// content stays closed. MaxClosed bounds them beyond that, the oldest pruned first.
const (
	ClosedRetention = 30 * 24 * time.Hour
	MaxClosed       = 5000
)

// pruneInterval is how often Tick prunes closed notifications.
const pruneInterval = time.Hour

// Options configures a Manager. DB is required.
type Options struct {
	DB *sql.DB
	// ThreadExists, when set, says whether a thread exists: a post naming one that does
	// not (as the notification's thread or a send action's) is refused with ErrNotFound.
	ThreadExists func(id string) bool
	Bus          *bus.Bus     // default: a private bus
	Log          *slog.Logger // default: slog.Default()
	// Now is the wall clock: timestamps, show_at and snooze. Default time.Now.
	Now func() time.Time
	// CheckInterval is how often the store's loop runs Tick. Default
	// DefaultCheckInterval; negative runs no loop (tests call Tick).
	CheckInterval time.Duration
}

// Manager is the Store backed by SQLite.
type Manager struct {
	opts Options
	log  *slog.Logger
	// mu serializes mutations. Reads use snap.
	mu        sync.Mutex
	byID      map[string]*Notification
	byKey     map[string]string // source + "\x00" + key → id
	version   uint64
	lastPrune time.Time
	snap      atomic.Pointer[Snapshot]

	stop context.CancelFunc
	done chan struct{}
}

var _ Store = (*Manager)(nil)

// New loads the persisted notifications, prunes closed ones past ClosedRetention, runs
// Tick once (a show_at or snooze that passed while the daemon was stopped arrives now)
// and starts the loop that runs Tick every Options.CheckInterval until Close.
func New(ctx context.Context, opts Options) (*Manager, error) {
	if opts.DB == nil {
		return nil, errors.New("notification: Options.DB is required")
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
	if opts.CheckInterval == 0 {
		opts.CheckInterval = DefaultCheckInterval
	}
	rows, err := loadAll(ctx, opts.DB)
	if err != nil {
		return nil, err
	}
	m := &Manager{opts: opts, log: opts.Log, byID: make(map[string]*Notification, len(rows)), byKey: make(map[string]string, len(rows)),
		done: make(chan struct{})}
	for i := range rows {
		n := &rows[i]
		m.byID[n.ID] = n
		m.byKey[keyOf(n.Source, n.Key)] = n.ID
	}
	m.rebuild()
	m.Tick()
	loopCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	m.stop = cancel
	if opts.CheckInterval > 0 {
		go m.loop(loopCtx, opts.CheckInterval)
	} else {
		close(m.done)
	}
	return m, nil
}

// Close stops the loop. The store's methods still work.
func (m *Manager) Close() {
	m.stop()
	<-m.done
}

func (m *Manager) loop(ctx context.Context, every time.Duration) {
	defer close(m.done)
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			m.Tick()
		}
	}
}

// Bus returns the bus events are published on.
func (m *Manager) Bus() *bus.Bus { return m.opts.Bus }

// Snapshot implements Store.
func (m *Manager) Snapshot() *Snapshot { return m.snap.Load() }

func keyOf(source, key string) string { return source + "\x00" + key }

func (m *Manager) now() time.Time { return m.opts.Now().Round(0).Truncate(time.Millisecond) }

// List implements Store.
func (m *Manager) List(closed bool) []Notification {
	out := slices.Clone(m.Snapshot().Notifications)
	if !closed {
		return out
	}
	m.mu.Lock()
	var shut []Notification
	for _, n := range m.byID {
		if n.State != StateActive {
			shut = append(shut, *n)
		}
	}
	m.mu.Unlock()
	slices.SortFunc(shut, func(a, b Notification) int {
		return cmp.Or(b.UpdatedAt.Compare(a.UpdatedAt), cmp.Compare(a.ID, b.ID))
	})
	return append(out, shut...)
}

// Get implements Store.
func (m *Manager) Get(id string) (Notification, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	n, ok := m.byID[id]
	if !ok {
		return Notification{}, fmt.Errorf("%w: notification %s", ErrNotFound, id)
	}
	return *n, nil
}

// rebuild publishes a new snapshot of the active notifications. Callers hold m.mu (or
// own m exclusively).
func (m *Manager) rebuild() *Snapshot {
	snap := &Snapshot{Version: m.version}
	for _, n := range m.byID {
		if n.State != StateActive {
			continue
		}
		snap.Notifications = append(snap.Notifications, *n)
		if n.Shown() && n.TimeSensitive {
			snap.TimeSensitive++
		}
		if n.Shown() && !n.Seen {
			snap.Unseen++
		}
	}
	slices.SortFunc(snap.Notifications, compareActive)
	m.snap.Store(snap)
	return snap
}

// compareActive orders active notifications: shown ones first, time-sensitive first, the
// newest arrival first; then snoozed and scheduled ones by when they come back.
func compareActive(a, b Notification) int {
	as, bs := a.Shown(), b.Shown()
	switch {
	case as && !bs:
		return -1
	case !as && bs:
		return 1
	case as:
		if a.TimeSensitive != b.TimeSensitive {
			if a.TimeSensitive {
				return -1
			}
			return 1
		}
		return cmp.Or(b.ArrivedAt.Compare(a.ArrivedAt), cmp.Compare(a.ID, b.ID))
	}
	return cmp.Or(comesBack(a).Compare(comesBack(b)), cmp.Compare(a.ID, b.ID))
}

// comesBack is when a snoozed or scheduled notification is shown.
func comesBack(n Notification) time.Time {
	if !n.SnoozedUntil.IsZero() {
		return n.SnoozedUntil
	}
	return n.ShowAt
}

// change is one commit's notifications and what happened to each.
type change struct {
	saved   []Notification
	arrived []string
	updated []string
}

// commit persists c's notifications, applies them, publishes the snapshot and a Changed
// event. Callers hold m.mu. Nothing is applied when the write fails.
func (m *Manager) commit(ctx context.Context, c change) error {
	if len(c.saved) == 0 {
		return nil
	}
	if err := save(context.WithoutCancel(ctx), m.opts.DB, c.saved); err != nil {
		return err
	}
	for _, n := range c.saved {
		n := n
		m.byID[n.ID] = &n
		m.byKey[keyOf(n.Source, n.Key)] = n.ID
	}
	m.version++
	snap := m.rebuild()
	bus.Publish[Event](m.opts.Bus, Changed{Snapshot: snap, Arrived: c.arrived, Updated: c.updated})
	return nil
}

// newID is "n-" + 12 hex digits.
func newID() string {
	var b [6]byte
	_, _ = rand.Read(b[:])
	return "n-" + hex.EncodeToString(b[:])
}

// Post implements Store.
func (m *Manager) Post(ctx context.Context, p Post) (PostResult, error) {
	in, err := normalize(p, m.opts.ThreadExists)
	if err != nil {
		return PostResult{}, err
	}
	now := m.now()
	due := in.ShowAt.IsZero() || !in.ShowAt.After(now)
	m.mu.Lock()
	defer m.mu.Unlock()
	old, exists := m.byID[m.byKey[keyOf(in.Source, in.Key)]]
	reopens := !exists || (old.State != StateActive && (old.State == StateWithdrawn || !sameContent(*old, in)))
	if reopens {
		if n := m.activeOf(in.Source); n >= MaxActivePerSource {
			return PostResult{}, fmt.Errorf("%w: %s has %d active notifications; at most %d", ErrFull, in.Source, n, MaxActivePerSource)
		}
	}
	if !exists {
		n := in
		n.ID, n.State, n.CreatedAt, n.UpdatedAt = newID(), StateActive, now, now
		return m.arrive(ctx, n, due, now)
	}
	n := *old
	if sameContent(n, in) && n.State != StateWithdrawn {
		// Shown, snoozed, scheduled, dismissed or resolved with this content already.
		return PostResult{Notification: n, Outcome: OutcomeUnchanged}, nil
	}
	n.Level, n.TimeSensitive, n.Title, n.Body, n.ThreadID, n.Actions, n.ShowAt = in.Level, in.TimeSensitive, in.Title, in.Body,
		in.ThreadID, in.Actions, in.ShowAt
	n.UpdatedAt = now
	switch {
	case n.State != StateActive:
		// Closed (dismissed, resolved, withdrawn): back as a new arrival.
		n.State, n.SnoozedUntil = StateActive, time.Time{}
		return m.arrive(ctx, n, due, now)
	case !n.SnoozedUntil.IsZero():
		// Snoozed: it stays snoozed with the new content; the user asked not to see it yet.
		return m.update(ctx, n, false)
	case n.ArrivedAt.IsZero():
		// Scheduled: it arrives at its new show_at, or now.
		return m.arrive(ctx, n, due, now)
	case !due:
		// Shown, and the source moved its show_at ahead: it leaves the bell until then.
		n.ArrivedAt = time.Time{}
		if err := m.commit(ctx, change{saved: []Notification{n}}); err != nil {
			return PostResult{}, err
		}
		return PostResult{Notification: n, Outcome: OutcomeScheduled}, nil
	}
	return m.update(ctx, n, true)
}

// arrive commits n shown now (due) or scheduled for its show_at. Callers hold m.mu.
func (m *Manager) arrive(ctx context.Context, n Notification, due bool, now time.Time) (PostResult, error) {
	c := change{}
	out := OutcomeScheduled
	n.ArrivedAt = time.Time{}
	if due {
		n.ArrivedAt, n.Seen, out = now, false, OutcomePosted
		c.arrived = []string{n.ID}
	}
	c.saved = []Notification{n}
	if err := m.commit(ctx, c); err != nil {
		return PostResult{}, err
	}
	return PostResult{Notification: n, Outcome: out}, nil
}

// update commits n's new content in place; shown says it is in the bell (Changed.Updated).
// Callers hold m.mu.
func (m *Manager) update(ctx context.Context, n Notification, shown bool) (PostResult, error) {
	c := change{saved: []Notification{n}}
	if shown {
		c.updated = []string{n.ID}
	}
	if err := m.commit(ctx, c); err != nil {
		return PostResult{}, err
	}
	return PostResult{Notification: n, Outcome: OutcomeUpdated}, nil
}

// activeOf counts source's active notifications. Callers hold m.mu.
func (m *Manager) activeOf(source string) int {
	k := 0
	for _, n := range m.byID {
		if n.Source == source && n.State == StateActive {
			k++
		}
	}
	return k
}

// closeAs commits n in state s if it is active; a closed one is returned as it is. Callers
// hold m.mu.
func (m *Manager) closeAs(ctx context.Context, n Notification, s State) (Notification, error) {
	if n.State != StateActive {
		return n, nil
	}
	n.State, n.UpdatedAt = s, m.now()
	if err := m.commit(ctx, change{saved: []Notification{n}}); err != nil {
		return Notification{}, err
	}
	return n, nil
}

// lookup returns a copy of the notification with id. Callers hold m.mu.
func (m *Manager) lookup(id string) (Notification, error) {
	n, ok := m.byID[id]
	if !ok {
		return Notification{}, fmt.Errorf("%w: notification %s", ErrNotFound, id)
	}
	return *n, nil
}

// Withdraw implements Store.
func (m *Manager) Withdraw(ctx context.Context, source, key string) (Notification, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	n, ok := m.byID[m.byKey[keyOf(source, key)]]
	if !ok {
		return Notification{}, fmt.Errorf("%w: %s has no notification with key %q", ErrNotFound, source, key)
	}
	return m.closeAs(ctx, *n, StateWithdrawn)
}

// Dismiss implements Store.
func (m *Manager) Dismiss(ctx context.Context, id string) (Notification, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	n, err := m.lookup(id)
	if err != nil {
		return Notification{}, err
	}
	return m.closeAs(ctx, n, StateDismissed)
}

// Snooze implements Store.
func (m *Manager) Snooze(ctx context.Context, id string, until time.Time) (Notification, error) {
	now := m.now()
	until = until.Round(0).Truncate(time.Millisecond)
	if !until.After(now) {
		return Notification{}, fmt.Errorf("%w: snooze until %s is not in the future", ErrInvalidArgument, until.Format(time.RFC3339))
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	n, err := m.lookup(id)
	if err != nil {
		return Notification{}, err
	}
	switch n.Status() {
	case StatusShown, StatusSnoozed:
	case StatusScheduled:
		return Notification{}, fmt.Errorf("%w: notification %s is not shown before %s", ErrFailedPrecondition, id, n.ShowAt.Format(time.RFC3339))
	default:
		return Notification{}, fmt.Errorf("%w: notification %s was %s", ErrFailedPrecondition, id, n.State)
	}
	n.SnoozedUntil, n.UpdatedAt = until, now
	if err := m.commit(ctx, change{saved: []Notification{n}}); err != nil {
		return Notification{}, err
	}
	return n, nil
}

// Clear implements Store.
func (m *Manager) Clear(ctx context.Context) (int, error) {
	now := m.now()
	m.mu.Lock()
	defer m.mu.Unlock()
	var c change
	for _, n := range m.byID {
		if n.Shown() {
			d := *n
			d.State, d.UpdatedAt = StateDismissed, now
			c.saved = append(c.saved, d)
		}
	}
	if err := m.commit(ctx, c); err != nil {
		return 0, err
	}
	return len(c.saved), nil
}

// Act implements Store.
func (m *Manager) Act(ctx context.Context, id string, index int, run func(context.Context, Notification, Action) error) (Notification, Action, error) {
	n, err := m.actOn(ctx, id, index)
	if err != nil {
		return n, Action{}, err
	}
	a := n.Actions[index]
	if err := run(ctx, n, a); err != nil {
		return n, a, err
	}
	if !a.Resolves {
		return n, a, nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	cur, err := m.lookup(id)
	if err != nil {
		return n, a, err
	}
	// The action ran: resolve what it was run on, not new content the source posted
	// meanwhile (that one the user has not seen act on).
	if !sameContent(cur, n) {
		return cur, a, nil
	}
	n, err = m.closeAs(ctx, cur, StateResolved)
	return n, a, err
}

// actOn returns the active notification id whose action index Act runs, marked seen (the
// user acted on it, so they saw it; marked before the run, which may fail).
func (m *Manager) actOn(ctx context.Context, id string, index int) (Notification, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	n, err := m.lookup(id)
	if err != nil {
		return Notification{}, err
	}
	if n.State != StateActive {
		return n, fmt.Errorf("%w: notification %s was %s", ErrFailedPrecondition, id, n.State)
	}
	if index < 0 || index >= len(n.Actions) {
		if len(n.Actions) == 0 {
			return n, fmt.Errorf("%w: notification %s has no actions", ErrInvalidArgument, id)
		}
		return n, fmt.Errorf("%w: notification %s has %d actions; no action %d", ErrInvalidArgument, id, len(n.Actions), index+1)
	}
	if n.Seen {
		return n, nil
	}
	n.Seen = true
	if err := m.commit(ctx, change{saved: []Notification{n}}); err != nil {
		return n, err
	}
	return n, nil
}

// See implements Store. Seen is not a change to the notification: UpdatedAt stays.
func (m *Manager) See(ctx context.Context, id string) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var c change
	if id != "" {
		n, err := m.lookup(id)
		if err != nil {
			return 0, err
		}
		if n.State == StateActive && !n.Seen {
			n.Seen = true
			c.saved = append(c.saved, n)
		}
	} else {
		for _, n := range m.byID {
			if n.Shown() && !n.Seen {
				s := *n
				s.Seen = true
				c.saved = append(c.saved, s)
			}
		}
	}
	if err := m.commit(ctx, c); err != nil {
		return 0, err
	}
	return len(c.saved), nil
}

// ThreadGone implements Store.
func (m *Manager) ThreadGone(ctx context.Context, id string) (int, error) {
	if id == "" {
		return 0, nil
	}
	return m.withdrawThreads(ctx, func(t string) bool { return t == id })
}

// WithdrawMissingThreads withdraws every active notification naming a thread that exists
// says is gone: the daemon's sweep, for a removal whose event the bus dropped.
func (m *Manager) WithdrawMissingThreads(ctx context.Context, exists func(string) bool) (int, error) {
	return m.withdrawThreads(ctx, func(t string) bool { return !exists(t) })
}

func (m *Manager) withdrawThreads(ctx context.Context, gone func(string) bool) (int, error) {
	now := m.now()
	m.mu.Lock()
	defer m.mu.Unlock()
	var c change
	for _, n := range m.byID {
		if n.State == StateActive && n.ThreadID != "" && gone(n.ThreadID) {
			w := *n
			w.State, w.UpdatedAt = StateWithdrawn, now
			c.saved = append(c.saved, w)
		}
	}
	if err := m.commit(ctx, c); err != nil {
		return 0, err
	}
	for _, n := range c.saved {
		m.log.Info("notification withdrawn: its thread is gone", "notification", n.ID, "thread", n.ThreadID)
	}
	return len(c.saved), nil
}

// Tick shows every notification whose show_at or snooze has come, compared with
// Options.Now (wall clock: Go's monotonic clock stops while the Mac sleeps, so a timer
// would fire late by the time slept), and prunes closed notifications once an hour. The
// store's loop runs it every Options.CheckInterval; New runs it once.
func (m *Manager) Tick() {
	now := m.now()
	m.mu.Lock()
	defer m.mu.Unlock()
	var c change
	for _, n := range m.byID {
		if n.State != StateActive {
			continue
		}
		switch {
		case !n.SnoozedUntil.IsZero():
			if n.SnoozedUntil.After(now) {
				continue
			}
		case n.ArrivedAt.IsZero():
			if n.ShowAt.After(now) {
				continue
			}
		default:
			continue
		}
		a := *n
		a.SnoozedUntil, a.ArrivedAt, a.UpdatedAt, a.Seen = time.Time{}, now, now, false
		c.saved = append(c.saved, a)
		c.arrived = append(c.arrived, a.ID)
	}
	slices.Sort(c.arrived)
	if err := m.commit(context.Background(), c); err != nil {
		m.log.Warn("notifications due now not shown; trying again", "err", err)
	}
	if now.Sub(m.lastPrune) >= pruneInterval {
		m.lastPrune = now
		m.prune(now)
	}
}

// prune forgets closed notifications past ClosedRetention, and the oldest past
// MaxClosed. Callers hold m.mu.
func (m *Manager) prune(now time.Time) {
	var shut []*Notification
	for _, n := range m.byID {
		if n.State != StateActive {
			shut = append(shut, n)
		}
	}
	slices.SortFunc(shut, func(a, b *Notification) int { return b.UpdatedAt.Compare(a.UpdatedAt) })
	var ids []string
	for i, n := range shut {
		if i >= MaxClosed || now.Sub(n.UpdatedAt) > ClosedRetention {
			ids = append(ids, n.ID)
		}
	}
	if len(ids) == 0 {
		return
	}
	if err := remove(context.Background(), m.opts.DB, ids); err != nil {
		m.log.Warn("closed notifications not pruned", "err", err)
		return
	}
	for _, id := range ids {
		n := m.byID[id]
		delete(m.byKey, keyOf(n.Source, n.Key))
		delete(m.byID, id)
	}
	m.log.Info("pruned closed notifications", "count", len(ids))
}

// Check reports whether Post would take p's content (the same checks, the thread's
// existence included), without posting: a plugin's notification attached to a wake fire
// is refused before the wake goes. ErrFull is not checked.
func (m *Manager) Check(p Post) error {
	_, err := normalize(p, m.opts.ThreadExists)
	return err
}

// WithdrawSource withdraws every active notification of source (a plugin was disabled
// or removed) and returns how many.
func (m *Manager) WithdrawSource(ctx context.Context, source string) (int, error) {
	now := m.now()
	m.mu.Lock()
	defer m.mu.Unlock()
	var c change
	for _, n := range m.byID {
		if n.State == StateActive && n.Source == source {
			w := *n
			w.State, w.UpdatedAt = StateWithdrawn, now
			c.saved = append(c.saved, w)
		}
	}
	if err := m.commit(ctx, c); err != nil {
		return 0, err
	}
	return len(c.saved), nil
}

// Sources names every source with an active notification, sorted.
func (m *Manager) Sources() []string {
	var out []string
	for _, n := range m.Snapshot().Notifications {
		if !slices.Contains(out, n.Source) {
			out = append(out, n.Source)
		}
	}
	slices.Sort(out)
	return out
}

// Active returns source's active notification with key.
func (m *Manager) Active(source, key string) (Notification, bool) {
	for _, n := range m.Snapshot().Notifications {
		if n.Source == source && n.Key == key {
			return n, true
		}
	}
	return Notification{}, false
}
