// Package notificationtest gives tests of code that consumes notifications (commands, API
// handlers, daemon glue) the real notification store over a fresh database, with a clock
// the test moves and no loop: the test runs the timers with Tick.
package notificationtest

import (
	"context"
	"database/sql"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/db/dbtest"
	"github.com/alexwaumann/code-foundry/internal/store/notification"
)

// T0 is the clock's start: 2026-11-16 09:00 UTC.
var T0 = time.Date(2026, 11, 16, 9, 0, 0, 0, time.UTC)

// Clock is a wall clock a test moves.
type Clock struct {
	mu  sync.Mutex
	now time.Time
}

// NewClock returns a clock at t.
func NewClock(t time.Time) *Clock { return &Clock{now: t} }

// Now returns the clock's time.
func (c *Clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

// Advance moves the clock by d.
func (c *Clock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

// Store is a notification store under test.
type Store struct {
	*notification.Manager
	Clock *Clock
	DB    *sql.DB
	Bus   *bus.Bus
	opts  notification.Options
}

// Options adjusts New. Zero values are fine.
type Options struct {
	// Threads, when set, are the threads that exist (Options.ThreadExists); nil knows
	// every thread.
	Threads []string
	Bus     *bus.Bus
}

// New opens a store on a fresh database with a Clock at T0. It is closed when the test
// ends.
func New(t testing.TB, o Options) *Store {
	t.Helper()
	if o.Bus == nil {
		o.Bus = bus.New()
	}
	s := &Store{Clock: NewClock(T0), DB: dbtest.Open(t), Bus: o.Bus}
	s.opts = notification.Options{DB: s.DB, Bus: o.Bus, Log: slog.New(slog.DiscardHandler), Now: s.Clock.Now, CheckInterval: -1}
	if o.Threads != nil {
		known := map[string]bool{}
		for _, id := range o.Threads {
			known[id] = true
		}
		s.opts.ThreadExists = func(id string) bool { return known[id] }
	}
	s.open(t)
	return s
}

// Reopen opens the store again on the same database and clock: a daemon restart.
func (s *Store) Reopen(t testing.TB) {
	t.Helper()
	s.Close()
	s.open(t)
}

func (s *Store) open(t testing.TB) {
	t.Helper()
	m, err := notification.New(context.Background(), s.opts)
	if err != nil {
		t.Fatal(err)
	}
	s.Manager = m
	t.Cleanup(m.Close)
}
