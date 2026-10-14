package session

import (
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

// testClock is a settable wall clock for Options.Now.
type testClock struct {
	mu  sync.Mutex
	now time.Time
}

func newTestClock() *testClock { return &testClock{now: time.Now().Round(0)} }

func (c *testClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *testClock) advance(d time.Duration) time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
	return c.now
}

// opts points the Manager at the clock and checks snoozes every few milliseconds
// (interval, when given).
func (c *testClock) opts(interval ...time.Duration) func(*Options) {
	return func(o *Options) {
		o.Now = c.Now
		o.SnoozeCheckInterval = 5 * time.Millisecond
		if len(interval) > 0 {
			o.SnoozeCheckInterval = interval[0]
		}
	}
}

func TestSnooze(t *testing.T) {
	tests := []struct {
		name string
		// setup returns the thread to snooze.
		setup      func(e *env) Session
		wantReason string // DisconnectReason after the snooze
	}{
		{name: "a connected thread is closed", wantReason: ReasonClosed, setup: func(e *env) Session {
			return e.connected(CreateOptions{Name: "live"})
		}},
		{name: "a pinned connected thread is closed and unpinned", wantReason: ReasonClosed, setup: func(e *env) Session {
			s := e.connected(CreateOptions{Name: "pinned"})
			if _, err := e.m.Pin(e.ctx(), s.ID, true); err != nil {
				e.t.Fatal(err)
			}
			return s
		}},
		{name: "a disconnected thread is not closed again", wantReason: ReasonExited, setup: func(e *env) Session {
			s := e.connected(CreateOptions{Name: "gone"})
			e.exit(s.ID, 0)
			return e.waitFor(s.ID, "exited", func(s Session) bool { return s.State == StateDisconnected })
		}},
		{name: "an archived thread is unarchived", wantReason: ReasonClosed, setup: func(e *env) Session {
			return e.archived()
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			s := tt.setup(e)
			mine, err := e.terms.Create(e.ctx(), terminal.Spec{Argv: []string{"zsh"}, Cwd: e.wt, Labels: termlabel.Shell(s.ID, "r1", e.wt)})
			if err != nil {
				t.Fatal(err)
			}
			other, err := e.terms.Create(e.ctx(), terminal.Spec{Argv: []string{"zsh"}, Cwd: e.wt, Labels: termlabel.Shell("", "r1", e.wt)})
			if err != nil {
				t.Fatal(err)
			}

			until := time.Now().Add(time.Hour)
			got, err := e.m.Snooze(e.ctx(), s.ID, until)
			if err != nil {
				t.Fatal(err)
			}
			if got.State != StateDisconnected || got.DisconnectReason != tt.wantReason || got.Pinned || !got.ArchivedAt.IsZero() {
				t.Errorf("snoozed = state %s reason %q pinned %v archived %v; want disconnected %q, unpinned, not archived",
					got.State, got.DisconnectReason, got.Pinned, got.ArchivedAt, tt.wantReason)
			}
			if got.SnoozedUntil.UnixMilli() != until.UnixMilli() {
				t.Errorf("SnoozedUntil = %v, want %v", got.SnoozedUntil, until)
			}
			if got.Status == StatusNeedsAttention && got.StatusReason == ReasonSnoozeEnded {
				t.Errorf("status = %s %q right after snoozing", got.Status, got.StatusReason)
			}
			if snap, _ := e.m.Snapshot().Session(s.ID); !snap.SnoozedUntil.Equal(got.SnoozedUntil) {
				t.Errorf("snapshot SnoozedUntil = %v, want %v", snap.SnoozedUntil, got.SnoozedUntil)
			}
			if _, err := e.terms.Get(e.ctx(), mine.ID); !errors.Is(err, terminal.ErrNotFound) {
				t.Errorf("the thread's shell after snooze: %v, want gone", err)
			}
			if _, err := e.terms.Get(e.ctx(), other.ID); err != nil {
				t.Errorf("the worktree's shell after snooze: %v, want kept", err)
			}

			// Snoozing again replaces the time, earlier or later.
			sooner := until.Add(-30 * time.Minute)
			again, err := e.m.Snooze(e.ctx(), s.ID, sooner)
			if err != nil || again.SnoozedUntil.UnixMilli() != sooner.UnixMilli() {
				t.Errorf("snooze again = %v, %v; want SnoozedUntil %v", again.SnoozedUntil, err, sooner)
			}

			// Persisted.
			e.restart()
			if got, err := e.m.Get(e.ctx(), s.ID); err != nil || got.SnoozedUntil.UnixMilli() != sooner.UnixMilli() || got.Pinned {
				t.Errorf("after restart = SnoozedUntil %v pinned %v, %v; want %v, unpinned", got.SnoozedUntil, got.Pinned, err, sooner)
			}
		})
	}
}

func TestSnoozeRejectsPastTimes(t *testing.T) {
	clk := newTestClock()
	e := newEnv(t, clk.opts())
	s := e.connected(CreateOptions{Name: "live"})
	for _, until := range []time.Time{clk.Now(), clk.Now().Add(-time.Second), clk.Now().Add(-48 * time.Hour)} {
		if _, err := e.m.Snooze(e.ctx(), s.ID, until); !errors.Is(err, ErrInvalidArgument) {
			t.Errorf("Snooze(%v) = %v, want ErrInvalidArgument", until, err)
		}
	}
	if got, _ := e.m.Get(e.ctx(), s.ID); got.State != StateConnected || !got.SnoozedUntil.IsZero() {
		t.Errorf("after refused snoozes = state %s, SnoozedUntil %v; want connected, not snoozed", got.State, got.SnoozedUntil)
	}
}

func TestSnoozeUnknown(t *testing.T) {
	e := newEnv(t)
	for _, until := range []time.Time{{}, time.Now().Add(time.Hour)} {
		if _, err := e.m.Snooze(e.ctx(), "s-nope", until); !errors.Is(err, ErrNotFound) {
			t.Errorf("Snooze(%v) unknown: %v", until, err)
		}
	}
}

// snoozed returns a disconnected thread snoozed for an hour.
func (e *env) snoozed() Session {
	e.t.Helper()
	s := e.connected(CreateOptions{Name: "snoozed"})
	got, err := e.m.Snooze(e.ctx(), s.ID, e.m.opts.Now().Add(time.Hour))
	if err != nil || got.SnoozedUntil.IsZero() {
		e.t.Fatalf("Snooze = %+v, %v", got, err)
	}
	return got
}

func TestUnsnooze(t *testing.T) {
	tests := []struct {
		name string
		// act unsnoozes thread id one way and returns the thread afterwards.
		act          func(e *env, id string) Session
		wantState    State
		wantArchived bool
	}{
		{name: "snooze with no time only clears it", wantState: StateDisconnected, act: func(e *env, id string) Session {
			s, err := e.m.Snooze(e.ctx(), id, time.Time{})
			if err != nil {
				e.t.Fatal(err)
			}
			return s
		}},
		{name: "reconnect", wantState: StateConnected, act: func(e *env, id string) Session {
			if _, err := e.m.Reconnect(e.ctx(), id); err != nil {
				e.t.Fatal(err)
			}
			return e.waitFor(id, "connected", func(s Session) bool { return s.State == StateConnected })
		}},
		{name: "pin", wantState: StateDisconnected, act: func(e *env, id string) Session {
			s, err := e.m.Pin(e.ctx(), id, true)
			if err != nil || !s.Pinned {
				e.t.Fatalf("Pin = %+v, %v", s, err)
			}
			return s
		}},
		{name: "archive", wantState: StateDisconnected, wantArchived: true, act: func(e *env, id string) Session {
			s, err := e.m.Archive(e.ctx(), id, true)
			if err != nil {
				e.t.Fatal(err)
			}
			return s
		}},
		{name: "send", wantState: StateConnected, act: func(e *env, id string) Session {
			// Snooze only commits on a disconnected thread; a live snoozed one is what
			// a send would meet after a race, so mark it by hand.
			if _, err := e.m.Reconnect(e.ctx(), id); err != nil {
				e.t.Fatal(err)
			}
			e.waitFor(id, "connected", func(s Session) bool { return s.State == StateConnected && s.Status != StatusUnknown })
			e.m.mu.Lock()
			e.m.recs[id].s.SnoozedUntil = time.Now().Add(time.Hour)
			e.m.mu.Unlock()
			if _, err := e.m.Send(e.ctx(), id, Message{Text: "again"}); err != nil {
				e.t.Fatal(err)
			}
			return e.waitFor(id, "unsnoozed", func(s Session) bool { return s.SnoozedUntil.IsZero() })
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			s := e.snoozed()
			got := tt.act(e, s.ID)
			if !got.SnoozedUntil.IsZero() || got.State != tt.wantState || got.ArchivedAt.IsZero() == tt.wantArchived {
				t.Errorf("after %s: SnoozedUntil %v state %s archived %v; want unsnoozed, %s, archived %v",
					tt.name, got.SnoozedUntil, got.State, got.ArchivedAt, tt.wantState, tt.wantArchived)
			}
			if got.StatusReason == ReasonSnoozeEnded {
				t.Errorf("after %s: status %s %q; unsnoozing must not ask for attention", tt.name, got.Status, got.StatusReason)
			}
			// Persisted: a restart still has it unsnoozed.
			e.restart()
			if got, err := e.m.Get(e.ctx(), s.ID); err != nil || !got.SnoozedUntil.IsZero() {
				t.Errorf("after restart = %v, %v; want unsnoozed", got.SnoozedUntil, err)
			}
		})
	}
}

func TestSnoozeKeptBy(t *testing.T) {
	tests := []struct {
		name string
		act  func(e *env, id string) (Session, error)
	}{
		{name: "unpin", act: func(e *env, id string) (Session, error) { return e.m.Pin(e.ctx(), id, false) }},
		{name: "unarchive", act: func(e *env, id string) (Session, error) { return e.m.Archive(e.ctx(), id, false) }},
		{name: "rename", act: func(e *env, id string) (Session, error) { return e.m.Rename(e.ctx(), id, "renamed") }},
		{name: "close", act: func(e *env, id string) (Session, error) {
			if err := e.m.Close(e.ctx(), id); err != nil {
				return Session{}, err
			}
			return e.m.Get(e.ctx(), id)
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			s := e.snoozed()
			got, err := tt.act(e, s.ID)
			if err != nil || !got.SnoozedUntil.Equal(s.SnoozedUntil) {
				t.Errorf("%s = %v, %v; want still snoozed until %v", tt.name, got.SnoozedUntil, err, s.SnoozedUntil)
			}
		})
	}
}

// waitEvent waits for an Updated of id that satisfies cond.
func (e *env) waitEvent(sub *bus.Subscription[Event], id, what string, cond func(Session) bool) Session {
	e.t.Helper()
	timeout := time.After(5 * time.Second)
	for {
		select {
		case ev := <-sub.C():
			if u, ok := ev.(Updated); ok && u.Session.ID == id && cond(u.Session) {
				return u.Session
			}
		case <-timeout:
			e.t.Fatalf("timed out waiting for the %s event", what)
			return Session{}
		}
	}
}

func TestSnoozeWakes(t *testing.T) {
	clk := newTestClock()
	e := newEnv(t, clk.opts())
	s := e.snoozed()
	keep := e.connected(CreateOptions{Name: "other"})
	later, err := e.m.Snooze(e.ctx(), keep.ID, clk.Now().Add(3*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	sub := bus.Subscribe[Event](e.bus, 256)
	defer sub.Close()

	// A minute early: still snoozed after several checks.
	clk.advance(59 * time.Minute)
	time.Sleep(50 * time.Millisecond)
	if got, _ := e.m.Get(e.ctx(), s.ID); got.SnoozedUntil.IsZero() {
		t.Fatalf("woke a minute early: %+v", got)
	}

	woke := clk.advance(time.Minute + 10*time.Second)
	ev := e.waitEvent(sub, s.ID, "wake", func(s Session) bool { return s.SnoozedUntil.IsZero() })
	if ev.Status != StatusNeedsAttention || ev.StatusReason != ReasonSnoozeEnded || !ev.StatusChangedAt.Equal(woke) ||
		ev.State != StateDisconnected {
		t.Errorf("woken = %s %s %q at %v; want disconnected, needs attention %q at %v",
			ev.State, ev.Status, ev.StatusReason, ev.StatusChangedAt, ReasonSnoozeEnded, woke)
	}
	if got, _ := e.m.Get(e.ctx(), keep.ID); !got.SnoozedUntil.Equal(later.SnoozedUntil) || got.StatusReason == ReasonSnoozeEnded {
		t.Errorf("the other thread = %v %q; want still snoozed until %v", got.SnoozedUntil, got.StatusReason, later.SnoozedUntil)
	}

	// Persisted (the restart's clock has not moved, so nothing else wakes).
	e.restart(clk.opts())
	got, err := e.m.Get(e.ctx(), s.ID)
	if err != nil || !got.SnoozedUntil.IsZero() || got.Status != StatusNeedsAttention || got.StatusReason != ReasonSnoozeEnded ||
		got.StatusChangedAt.UnixMilli() != woke.UnixMilli() {
		t.Errorf("after restart = %+v, %v; want woken at %v", got, err, woke)
	}

	// Snoozed again and woken again without a reconnect: the attention is stamped anew.
	if _, err := e.m.Snooze(e.ctx(), s.ID, clk.Now().Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	again := clk.advance(2 * time.Minute)
	ev = e.waitEvent(sub, s.ID, "second wake", func(s Session) bool { return s.SnoozedUntil.IsZero() })
	if !ev.StatusChangedAt.Equal(again) || ev.StatusReason != ReasonSnoozeEnded {
		t.Errorf("second wake = %q at %v, want %q at %v", ev.StatusReason, ev.StatusChangedAt, ReasonSnoozeEnded, again)
	}

	// A reconnect clears the attention like a finished turn's on a disconnected thread.
	if _, err := e.m.Reconnect(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	got = e.waitFor(s.ID, "connected", func(s Session) bool { return s.State == StateConnected && s.Status != StatusUnknown })
	if got.StatusReason == ReasonSnoozeEnded {
		t.Errorf("after reconnect = %s %q; want the new process's status", got.Status, got.StatusReason)
	}
}

func TestSnoozeWakesAtStartup(t *testing.T) {
	clk := newTestClock()
	e := newEnv(t, clk.opts(time.Hour)) // no tick during the test: only the startup check
	s := e.snoozed()
	e.restart(clk.opts(time.Hour))
	if got, _ := e.m.Get(e.ctx(), s.ID); got.SnoozedUntil.IsZero() {
		t.Fatalf("woke at a restart before its time: %+v", got)
	}

	// The daemon was stopped (or the Mac asleep) past the snooze's end.
	ctx := e.ctx()
	if err := e.m.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	woke := clk.advance(26 * time.Hour)
	e.open(clk.opts(time.Hour))
	got, err := e.m.Get(e.ctx(), s.ID)
	if err != nil || !got.SnoozedUntil.IsZero() || got.Status != StatusNeedsAttention || got.StatusReason != ReasonSnoozeEnded ||
		!got.StatusChangedAt.Equal(woke) || got.State != StateDisconnected {
		t.Errorf("after the startup check = %+v, %v; want disconnected, woken at %v", got, err, woke)
	}
}
