package thread

import "time"

// Wakes to a thread whose Claude does not start (docs/notes/thread-lifecycle-fixes.md).
//
// A wake to a stopped thread starts it (drain → Send → startStopped). When Claude
// cannot start (logged out, expired credentials, a broken install), every timer or
// notify wake would spawn a process and add its message, the error and a turn end to
// the timeline. So after a failed start a wake waits: the n-th consecutive failure
// holds the subscriber's queue for Options.WakeStartBackoff·2^(n-1), at most
// maxWakeStartBackoff, from the failure; wakes fired meanwhile wait in the queue,
// one per subscription (enqueueLocked keeps a subscription's latest), and thread wakes
// join one message as ever. The thread's status already says error "did not start"
// (one attention, not one per wake). A user's message always tries; a start that comes
// up ends the backoff. The count is in memory: a daemon restart tries again at once.

// maxWakeStartBackoff caps the wait.
const maxWakeStartBackoff = time.Hour

// wakeBackoffPoll is how often a held queue looks again (a user's message may have
// started the thread meanwhile); startingPoll while a start is under way.
const (
	wakeBackoffPoll = time.Second
	startingPoll    = 50 * time.Millisecond
)

// failedStarts counts a thread's consecutive failed starts.
type failedStarts struct {
	count int
	at    time.Time // the last one (monotonic)
}

// noteStartFailed records a failed start of rec. Callers hold m.mu.
func (rec *record) noteStartFailed() {
	rec.startFails.count++
	rec.startFails.at = time.Now()
}

// wakeHold is how long a wake to thread id must still wait: zero unless Claude failed
// to start for it last time and its backoff has not run out, or it is starting again
// (the next wake waits to see whether that start fails too).
func (m *Manager) wakeHold(id string) time.Duration {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.recs[id]
	switch {
	case !ok || rec.startFails.count == 0:
		return 0
	case rec.reserved != nil || rec.s.State == StateStarting:
		return startingPoll
	case rec.run != nil || rec.s.State != StateDisconnected:
		return 0
	}
	return wakeBackoff(m.opts.WakeStartBackoff, rec.startFails.count) - time.Since(rec.startFails.at)
}

// wakeBackoff is the wait after n consecutive failed starts: base·2^(n-1), at most
// maxWakeStartBackoff.
func wakeBackoff(base time.Duration, n int) time.Duration {
	d := base
	for i := 1; i < n && d < maxWakeStartBackoff; i++ {
		d *= 2
	}
	return min(d, maxWakeStartBackoff)
}

// holdWakes waits while wakes to subscriber are held (wakeHold), or until the Manager
// stops.
func (m *Manager) holdWakes(subscriber string) {
	logged := false
	for {
		wait := m.wakeHold(subscriber)
		if wait <= 0 {
			return
		}
		if !logged && wait > startingPoll { // not a start under way: a backoff
			logged = true
			m.log.Info("wakes held: Claude did not start last time", "thread", subscriber, "retry_in", wait.Round(time.Second).String())
		}
		t := time.NewTimer(min(wait, wakeBackoffPoll))
		select {
		case <-t.C:
		case <-m.ctx.Done():
			t.Stop()
			return
		}
	}
}

// heldLocked reports whether wakes to id are being held after failed starts (the
// queue keeps one per subscription meanwhile). Callers hold m.mu.
func (m *Manager) heldLocked(id string) bool {
	rec, ok := m.recs[id]
	return ok && rec.startFails.count > 0 && rec.run == nil
}

// coalesceLocked replaces a waiting wake of d's subscription in q with d, and reports
// whether it did. Only plain wakes (a timer's, a PR's, a plugin's): thread wakes batch,
// and the wake limit's note stays.
func (q *wakeQueue) coalesceLocked(d delivery) bool {
	if d.msg == nil || d.limit || d.sub == "" {
		return false
	}
	for i, x := range q.items {
		if x.msg != nil && !x.limit && x.sub == d.sub {
			q.items[i] = d
			return true
		}
	}
	return false
}
