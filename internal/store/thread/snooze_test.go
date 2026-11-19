package thread

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

// A snooze only hides the thread (docs/notes/snooze-without-teardown.md): its process, its
// shells and its pin stay as they are; an archived thread is unarchived.
func TestSnooze(t *testing.T) {
	tests := []struct {
		name      string
		setup     func(e *env) Thread
		wantState State
		pinned    bool
	}{
		{name: "a connected thread runs on", wantState: StateConnected, setup: func(e *env) Thread {
			return e.connected(CreateOptions{Name: "live"})
		}},
		{name: "a pinned connected thread runs on and stays pinned", wantState: StateConnected, pinned: true, setup: func(e *env) Thread {
			s := e.connected(CreateOptions{Name: "pinned"})
			if _, err := e.m.Pin(e.ctx(), s.ID, true); err != nil {
				e.t.Fatal(err)
			}
			return s
		}},
		{name: "a stopped thread stays stopped", wantState: StateDisconnected, setup: func(e *env) Thread {
			return e.stopped("gone")
		}},
		{name: "an archived thread is unarchived", wantState: StateDisconnected, setup: func(e *env) Thread {
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
			var pid int
			if tt.wantState == StateConnected {
				pid = e.pid(s.ID)
			}

			until := time.Now().Add(time.Hour)
			got, err := e.m.Snooze(e.ctx(), s.ID, until)
			if err != nil {
				t.Fatal(err)
			}
			if got.State != tt.wantState || got.Pinned != tt.pinned || !got.ArchivedAt.IsZero() {
				t.Errorf("snoozed = state %s pinned %v archived %v; want %s, pinned %v, not archived",
					got.State, got.Pinned, got.ArchivedAt, tt.wantState, tt.pinned)
			}
			if pid != 0 && e.pid(s.ID) != pid {
				t.Error("the snooze replaced the thread's process")
			}
			if got.SnoozedUntil.UnixMilli() != until.UnixMilli() {
				t.Errorf("SnoozedUntil = %v, want %v", got.SnoozedUntil, until)
			}
			if got.Status == StatusNeedsAttention && got.StatusReason == ReasonSnoozeEnded {
				t.Errorf("status = %s %q right after snoozing", got.Status, got.StatusReason)
			}
			if snap, _ := e.m.Snapshot().Thread(s.ID); !snap.SnoozedUntil.Equal(got.SnoozedUntil) {
				t.Errorf("snapshot SnoozedUntil = %v, want %v", snap.SnoozedUntil, got.SnoozedUntil)
			}
			if term, err := e.terms.Get(e.ctx(), mine.ID); err != nil || term.State != terminal.StateRunning {
				t.Errorf("the thread's shell after snooze: %+v, %v; want it running", term, err)
			}

			// Snoozing again replaces the time, earlier or later.
			sooner := until.Add(-30 * time.Minute)
			again, err := e.m.Snooze(e.ctx(), s.ID, sooner)
			if err != nil || again.SnoozedUntil.UnixMilli() != sooner.UnixMilli() {
				t.Errorf("snooze again = %v, %v; want SnoozedUntil %v", again.SnoozedUntil, err, sooner)
			}

			// Persisted.
			e.restart()
			if got, err := e.m.Get(e.ctx(), s.ID); err != nil || got.SnoozedUntil.UnixMilli() != sooner.UnixMilli() || got.Pinned != tt.pinned {
				t.Errorf("after restart = SnoozedUntil %v pinned %v, %v; want %v, pinned %v", got.SnoozedUntil, got.Pinned, err, sooner, tt.pinned)
			}
		})
	}
}

// Undoing a snooze (the user's thread.snooze --clear right after it, the Undo toast's call)
// leaves the thread as it was before the snooze: the same process, mid-turn or at its
// prompt, the same status and pending request, its pin, its shell running. A snooze in
// either form, a running thread at its prompt, mid-turn and a stopped one.
func TestSnoozeUndo(t *testing.T) {
	snooze := func(e *env, id string) (Thread, error) { return e.m.Snooze(e.ctx(), id, time.Now().Add(time.Hour)) }
	save := func(e *env, id string) (Thread, error) { return e.m.SaveForLater(e.ctx(), id) }
	for _, form := range []struct {
		name string
		do   func(e *env, id string) (Thread, error)
	}{{"snooze", snooze}, {"save", save}} {
		for _, tc := range []struct {
			name  string
			setup func(t *testing.T) (*env, Thread)
		}{
			{"at its prompt", func(t *testing.T) (*env, Thread) { return idleSetup.start(t) }},
			{"mid-turn, asking", func(t *testing.T) (*env, Thread) { return permissionSetup.start(t) }},
			{"working", func(t *testing.T) (*env, Thread) { return busySetup.start(t) }},
			{"stopped", func(t *testing.T) (*env, Thread) {
				e, s := idleSetup.start(t)
				if err := e.m.Close(e.ctx(), s.ID); err != nil {
					t.Fatal(err)
				}
				return e, e.waitFor(s.ID, "stopped", func(s Thread) bool { return s.State == StateDisconnected })
			}},
		} {
			t.Run(form.name+"/"+tc.name, func(t *testing.T) {
				e, s := tc.setup(t)
				if _, err := e.m.Pin(e.ctx(), s.ID, true); err != nil {
					t.Fatal(err)
				}
				shell, err := e.terms.Create(e.ctx(), terminal.Spec{Argv: []string{"zsh"}, Cwd: e.wt, Labels: termlabel.Shell(s.ID, "r1", e.wt)})
				if err != nil {
					t.Fatal(err)
				}
				before, _ := e.m.Get(e.ctx(), s.ID)
				pid := 0
				if before.State == StateConnected {
					pid = e.pid(s.ID)
				}
				if _, err := form.do(e, s.ID); err != nil {
					t.Fatal(err)
				}
				after, err := e.m.Snooze(e.ctx(), s.ID, time.Time{})
				if err != nil {
					t.Fatal(err)
				}
				if after.Snoozed() || !after.Pinned || after.State != before.State || after.Status != before.Status ||
					after.StatusReason != before.StatusReason || after.PendingRequestID != before.PendingRequestID {
					t.Errorf("after the undo %s %s %q pinned %v snoozed %v request %q; want as before: %s %s %q pinned, request %q",
						after.State, after.Status, after.StatusReason, after.Pinned, after.Snoozed(), after.PendingRequestID,
						before.State, before.Status, before.StatusReason, before.PendingRequestID)
				}
				if pid != 0 && e.pid(s.ID) != pid {
					t.Error("the round trip replaced the thread's process")
				}
				if term, err := e.terms.Get(e.ctx(), shell.ID); err != nil || term.State != terminal.StateRunning {
					t.Errorf("the thread's shell: %+v, %v; want it running", term, err)
				}
				if after.StatusReason == ReasonSnoozeEnded {
					t.Error("the undo asked for attention")
				}
			})
		}
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

// snoozed returns a stopped thread snoozed for an hour (a snooze leaves a running process
// running: snoozedLive).
func (e *env) snoozed() Thread {
	e.t.Helper()
	s := e.stopped("snoozed")
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
		act          func(e *env, id string) Thread
		wantState    State
		wantArchived bool
	}{
		{name: "snooze with no time only clears it", wantState: StateDisconnected, act: func(e *env, id string) Thread {
			s, err := e.m.Snooze(e.ctx(), id, time.Time{})
			if err != nil {
				e.t.Fatal(err)
			}
			return s
		}},
		{name: "reconnect", wantState: StateConnected, act: func(e *env, id string) Thread {
			if _, err := e.m.reconnect(e.ctx(), id); err != nil {
				e.t.Fatal(err)
			}
			return e.waitFor(id, "connected", func(s Thread) bool { return s.State == StateConnected })
		}},
		{name: "pin", wantState: StateDisconnected, act: func(e *env, id string) Thread {
			s, err := e.m.Pin(e.ctx(), id, true)
			if err != nil || !s.Pinned {
				e.t.Fatalf("Pin = %+v, %v", s, err)
			}
			return s
		}},
		{name: "archive", wantState: StateDisconnected, wantArchived: true, act: func(e *env, id string) Thread {
			s, err := e.m.Archive(e.ctx(), id, true)
			if err != nil {
				e.t.Fatal(err)
			}
			return s
		}},
		{name: "send", wantState: StateConnected, act: func(e *env, id string) Thread {
			// Snooze only commits on a disconnected thread; a live snoozed one is what
			// a send would meet after a race, so mark it by hand.
			if _, err := e.m.reconnect(e.ctx(), id); err != nil {
				e.t.Fatal(err)
			}
			e.waitFor(id, "connected", func(s Thread) bool { return s.State == StateConnected && s.Status != StatusUnknown })
			e.m.mu.Lock()
			e.m.recs[id].s.SnoozedUntil = time.Now().Add(time.Hour)
			e.m.mu.Unlock()
			if _, err := e.m.Send(e.ctx(), id, Message{Text: "again"}); err != nil {
				e.t.Fatal(err)
			}
			return e.waitFor(id, "unsnoozed", func(s Thread) bool { return s.SnoozedUntil.IsZero() })
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
		act  func(e *env, id string) (Thread, error)
	}{
		{name: "unpin", act: func(e *env, id string) (Thread, error) { return e.m.Pin(e.ctx(), id, false) }},
		{name: "unarchive", act: func(e *env, id string) (Thread, error) { return e.m.Archive(e.ctx(), id, false) }},
		{name: "rename", act: func(e *env, id string) (Thread, error) { return e.m.Rename(e.ctx(), id, "renamed") }},
		{name: "close", act: func(e *env, id string) (Thread, error) {
			if err := e.m.Close(e.ctx(), id); err != nil {
				return Thread{}, err
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
func (e *env) waitEvent(sub *bus.Subscription[Event], id, what string, cond func(Thread) bool) Thread {
	e.t.Helper()
	timeout := time.After(5 * time.Second)
	for {
		select {
		case ev := <-sub.C():
			if u, ok := ev.(Updated); ok && u.Thread.ID == id && cond(u.Thread) {
				return u.Thread
			}
		case <-timeout:
			e.t.Fatalf("timed out waiting for the %s event", what)
			return Thread{}
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
	ev := e.waitEvent(sub, s.ID, "wake", func(s Thread) bool { return s.SnoozedUntil.IsZero() })
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
	ev = e.waitEvent(sub, s.ID, "second wake", func(s Thread) bool { return s.SnoozedUntil.IsZero() })
	if !ev.StatusChangedAt.Equal(again) || ev.StatusReason != ReasonSnoozeEnded {
		t.Errorf("second wake = %q at %v, want %q at %v", ev.StatusReason, ev.StatusChangedAt, ReasonSnoozeEnded, again)
	}

	// A reconnect clears the attention like a finished turn's on a disconnected thread.
	if _, err := e.m.reconnect(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	got = e.waitFor(s.ID, "connected", func(s Thread) bool { return s.State == StateConnected && s.Status != StatusUnknown })
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

// snoozedLive returns a thread at its prompt, its process running, snoozed for an hour.
func (e *env) snoozedLive() Thread {
	e.t.Helper()
	s := e.connected(CreateOptions{Name: "live"})
	got, err := e.m.Snooze(e.ctx(), s.ID, e.m.opts.Now().Add(time.Hour))
	if err != nil || got.SnoozedUntil.IsZero() || got.State != StateConnected {
		e.t.Fatalf("Snooze = %+v, %v", got, err)
	}
	return got
}

// A snooze that ends while the thread's process runs at its prompt (a snooze stops
// nothing, and the idle stop has not come yet) wakes it as a stopped one wakes: needs
// attention "snooze ended", stamped with the wake, on the running process, which keeps it
// (its own status does not take it back). Clear turns it idle at its prompt; a message
// ends it as it starts a turn.
func TestSnoozeWakesALiveThread(t *testing.T) {
	clk := newTestClock()
	e := newEnv(t, clk.opts())
	s := e.snoozedLive()
	pid := e.pid(s.ID)
	woke := clk.advance(time.Hour + time.Second)
	got := e.waitFor(s.ID, "the wake", func(s Thread) bool { return s.StatusReason == ReasonSnoozeEnded })
	if got.State != StateConnected || got.Snoozed() || got.Status != StatusNeedsAttention || !got.StatusChangedAt.Equal(woke) {
		t.Errorf("woken = %s %s %q at %v snoozed %v; want connected, needs attention at %v, unsnoozed",
			got.State, got.Status, got.StatusReason, got.StatusChangedAt, got.Snoozed(), woke)
	}
	time.Sleep(100 * time.Millisecond) // the runner's ticks and debounce come and go
	if got, _ := e.m.Get(e.ctx(), s.ID); got.StatusReason != ReasonSnoozeEnded || e.pid(s.ID) != pid {
		t.Errorf("later = %s %q; want %q kept on the same process", got.Status, got.StatusReason, ReasonSnoozeEnded)
	}

	cleared, ok, err := e.m.ClearSnoozeEnded(e.ctx(), s.ID)
	if err != nil || !ok || cleared.Status != StatusIdle || cleared.StatusReason != "at prompt" || cleared.State != StateConnected {
		t.Errorf("ClearSnoozeEnded = %s %s %q, %v, %v; want connected, idle at its prompt", cleared.State, cleared.Status, cleared.StatusReason, ok, err)
	}

	// Snoozed and woken again: a message ends the wake's attention.
	if _, err := e.m.Snooze(e.ctx(), s.ID, clk.Now().Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	clk.advance(2 * time.Minute)
	e.waitFor(s.ID, "the second wake", func(s Thread) bool { return s.StatusReason == ReasonSnoozeEnded })
	// A re-snooze clears it, on the running process too.
	if again, err := e.m.Snooze(e.ctx(), s.ID, clk.Now().Add(time.Hour)); err != nil || again.StatusReason == ReasonSnoozeEnded {
		t.Errorf("re-snoozed = %s %q, %v; want the wake's attention gone", again.Status, again.StatusReason, err)
	}
	time.Sleep(50 * time.Millisecond)
	if got, _ := e.m.Get(e.ctx(), s.ID); got.StatusReason == ReasonSnoozeEnded {
		t.Errorf("re-snoozed, later = %s %q", got.Status, got.StatusReason)
	}
	if _, err := e.m.Snooze(e.ctx(), s.ID, clk.Now().Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	clk.advance(2 * time.Minute)
	e.waitFor(s.ID, "the third wake", func(s Thread) bool { return s.StatusReason == ReasonSnoozeEnded })
	if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "again"}); err != nil {
		t.Fatal(err)
	}
	e.waitFor(s.ID, "the message's turn", func(s Thread) bool { return s.StatusReason != ReasonSnoozeEnded })
}

// wokenThread is a snoozed thread whose snooze ended: disconnected, needs attention
// "snooze ended".
func (e *env) wokenThread(clk *testClock) Thread {
	e.t.Helper()
	s := e.snoozed()
	clk.advance(time.Hour + time.Second)
	return e.waitFor(s.ID, "wake", func(s Thread) bool { return s.StatusReason == ReasonSnoozeEnded })
}

func TestSnoozeEndedClearedBy(t *testing.T) {
	tests := []struct {
		name string
		put  func(e *env, clk *testClock, id string) (Thread, error)
	}{
		{name: "snooze", put: func(e *env, clk *testClock, id string) (Thread, error) {
			return e.m.Snooze(e.ctx(), id, clk.Now().Add(time.Hour))
		}},
		{name: "archive", put: func(e *env, _ *testClock, id string) (Thread, error) {
			return e.m.Archive(e.ctx(), id, true)
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			clk := newTestClock()
			e := newEnv(t, clk.opts())
			s := e.wokenThread(clk)
			got, err := tt.put(e, clk, s.ID)
			if err != nil {
				t.Fatal(err)
			}
			if got.Status != StatusIdle || got.StatusReason != "at prompt" {
				t.Errorf("after %s = %s %q; want idle %q", tt.name, got.Status, got.StatusReason, "at prompt")
			}
			// Persisted.
			e.restart(clk.opts(time.Hour))
			if got, _ := e.m.Get(e.ctx(), s.ID); got.StatusReason == ReasonSnoozeEnded {
				t.Errorf("after restart = %s %q; want the cleared status", got.Status, got.StatusReason)
			}
		})
	}
}

// Rows archived or snoozed again before Archive and Snooze cleared "snooze ended" are
// settled at startup; a woken thread left in the list keeps it.
func TestSnoozeEndedSettledAtStartup(t *testing.T) {
	clk := newTestClock()
	e := newEnv(t, clk.opts())
	listed := e.wokenThread(clk)
	stale := []func(*Thread){
		func(s *Thread) { s.ArchivedAt = clk.Now() },
		func(s *Thread) { s.SnoozedUntil = clk.Now().Add(time.Hour).Truncate(time.Millisecond) },
	}
	var ids []string
	for _, put := range stale {
		s := e.wokenThread(clk)
		put(&s)
		if err := saveThread(e.ctx(), e.m.opts.DB, s); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, s.ID)
	}
	e.restart(clk.opts(time.Hour))
	for _, id := range ids {
		got, err := e.m.Get(e.ctx(), id)
		if err != nil || got.Status != StatusIdle || got.StatusReason != "at prompt" {
			t.Errorf("%s after restart = %s %q, %v; want idle %q", id, got.Status, got.StatusReason, err, "at prompt")
		}
	}
	if got, _ := e.m.Get(e.ctx(), listed.ID); got.StatusReason != ReasonSnoozeEnded {
		t.Errorf("listed thread after restart = %s %q; want %q kept", got.Status, got.StatusReason, ReasonSnoozeEnded)
	}
}

// ClearSnoozeEnded turns a woken thread idle at its prompt, persisted and published, and
// leaves any other thread as it is.
func TestClearSnoozeEnded(t *testing.T) {
	tests := []struct {
		name        string
		make        func(e *env, clk *testClock) Thread
		wantCleared bool
		wantStatus  Status
		wantReason  string
	}{
		{name: "a woken thread", make: func(e *env, clk *testClock) Thread { return e.wokenThread(clk) },
			wantCleared: true, wantStatus: StatusIdle, wantReason: "at prompt"},
		{name: "a snoozed thread", make: func(e *env, _ *testClock) Thread { return e.snoozed() }},
		{name: "a connected thread", make: func(e *env, _ *testClock) Thread { return e.connected(CreateOptions{Name: "live"}) }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			clk := newTestClock()
			e := newEnv(t, clk.opts())
			s := tt.make(e, clk)
			sub := bus.Subscribe[Event](e.bus, 256)
			defer sub.Close()
			at := clk.advance(time.Minute)
			got, cleared, err := e.m.ClearSnoozeEnded(e.ctx(), s.ID)
			if err != nil {
				t.Fatal(err)
			}
			if cleared != tt.wantCleared {
				t.Fatalf("cleared = %v, want %v", cleared, tt.wantCleared)
			}
			if !tt.wantCleared {
				// A live thread's status is its process's; only the snooze is compared.
				if !got.SnoozedUntil.Equal(s.SnoozedUntil) || got.State != s.State {
					t.Errorf("changed: %s until %v; was %s until %v", got.State, got.SnoozedUntil, s.State, s.SnoozedUntil)
				}
				return
			}
			if got.Status != tt.wantStatus || got.StatusReason != tt.wantReason || !got.StatusChangedAt.Equal(at) || got.State != StateDisconnected {
				t.Errorf("after clear = %s %s %q at %v; want disconnected %s %q at %v", got.State, got.Status, got.StatusReason, got.StatusChangedAt, tt.wantStatus, tt.wantReason, at)
			}
			e.waitEvent(sub, s.ID, "clear", func(s Thread) bool { return s.StatusReason == tt.wantReason })
			e.restart(clk.opts(time.Hour))
			if got, _ := e.m.Get(e.ctx(), s.ID); got.StatusReason != tt.wantReason {
				t.Errorf("after restart = %s %q; want %q", got.Status, got.StatusReason, tt.wantReason)
			}
		})
	}
}

func TestClearSnoozeEndedUnknown(t *testing.T) {
	e := newEnv(t)
	if _, _, err := e.m.ClearSnoozeEnded(e.ctx(), "s-nope00000000"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}
