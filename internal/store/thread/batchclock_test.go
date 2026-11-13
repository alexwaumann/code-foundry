package thread

import (
	"slices"
	"sync"
	"time"
)

// manualClock is a batchClock that moves only when the test advances it: a batch window
// ends when the test says, however slowly a busy machine runs the steps between.
type manualClock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*manualTimer
}

type manualTimer struct {
	at time.Time
	c  chan time.Time
}

func newManualClock() *manualClock {
	return &manualClock{now: time.Date(2026, 11, 13, 9, 0, 0, 0, time.UTC)}
}

// withManualClock sets o's batch clock to c.
func withManualClock(c *manualClock) func(*Options) {
	return func(o *Options) { o.batchClock = c }
}

func (c *manualClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *manualClock) After(d time.Duration) (<-chan time.Time, func()) {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &manualTimer{at: c.now.Add(d), c: make(chan time.Time, 1)}
	if d <= 0 {
		t.c <- c.now
		return t.c, func() {}
	}
	c.timers = append(c.timers, t)
	return t.c, func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		c.timers = slices.DeleteFunc(c.timers, func(x *manualTimer) bool { return x == t })
	}
}

// Advance moves the clock by d and fires every timer due by then.
func (c *manualClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
	c.timers = slices.DeleteFunc(c.timers, func(t *manualTimer) bool {
		if t.at.After(c.now) {
			return false
		}
		t.c <- c.now
		return true
	})
}

// waitDrained waits until subscriber's wake queue is gone: everything queued for it was
// delivered (drain ends the queue once it is empty).
func (e *env) waitDrained(subscriber string) {
	e.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		e.m.subs.mu.Lock()
		_, queued := e.m.subs.queues[subscriber]
		e.m.subs.mu.Unlock()
		if !queued {
			return
		}
		if time.Now().After(deadline) {
			e.t.Fatalf("timed out waiting for %s's wakes to be delivered", subscriber)
		}
		time.Sleep(5 * time.Millisecond)
	}
}
