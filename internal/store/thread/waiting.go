package thread

import (
	"strconv"
	"strings"
	"time"
)

// Waiting on child threads (docs/notes/orch-waiting-status.md). A thread that ended its
// turn while it holds wake subscriptions on threads still working needs nothing from
// the user: the daemon will wake it. It is shown StatusIdle "waiting on N child threads"
// instead of NeedsAttention "finished" (no badge, no bounce, sorted with the idle
// threads), until the last of them settles and its wake starts the next turn, whose end
// is "finished" as ever.
//
// The rule (waitingLocked): the thread's own status (raw: what its runner or the store
// last set) is a plainly ended turn, NeedsAttention "finished" or Idle "at prompt", and
// at least one target of its settled, idle or attention subscriptions is pending (it
// will wake the thread), or a wake to it is queued. A target is pending while it is not
// settled (working, starting, being removed), or while it is itself waiting on its own
// targets (a lead waiting on its workers). A question, a permission prompt, a turn
// error, the budget stop and the wake limit keep their reasons: they win over waiting.
//
// It is an overlay applied by every commit (commitLocked): the record keeps the raw
// status, the snapshot and the database have the one shown. A commit of a target
// re-evaluates its subscribers (rewaitLocked); so do Subscribe and Unsubscribe. The
// shown status is a function of the raw ones and the wake queues, so the re-evaluation
// settles after one pass, and a cycle of subscriptions cannot keep itself waiting
// (pendingLocked does not walk back to where it started).
//
// A wake sent to a running thread publishes its busy at once (stream.go): the queue
// holds the subscriber waiting until the wake went out, and the busy must be there
// when it is gone, or the subscriber would show "finished" for a debounce.

// ReasonWaiting starts the StatusReason, with StatusIdle, of a thread waiting on its
// child threads: "waiting on 2 child threads", or "waiting" alone while only a queued
// wake is left.
const ReasonWaiting = "waiting"

// IsWaitingReason reports whether a status reason is a waiting one.
func IsWaitingReason(reason string) bool {
	return reason == ReasonWaiting || strings.HasPrefix(reason, ReasonWaiting+" on ")
}

// waitingReason is the reason for n pending targets.
func waitingReason(n int) string {
	switch {
	case n <= 0:
		return ReasonWaiting
	case n == 1:
		return ReasonWaiting + " on 1 child thread"
	}
	return ReasonWaiting + " on " + strconv.Itoa(n) + " child threads"
}

// WaitingOn is the count a waiting reason names: 2 for "waiting on 2 child threads", 0
// for "waiting" alone; false when reason is not a waiting one.
func WaitingOn(reason string) (int, bool) {
	if !IsWaitingReason(reason) {
		return 0, false
	}
	rest := strings.TrimPrefix(reason, ReasonWaiting+" on ")
	n, err := strconv.Atoi(strings.Fields(rest + " ")[0])
	if err != nil {
		return 0, true
	}
	return n, true
}

// canWait reports whether a raw status is a plainly ended turn, which waiting replaces.
func canWait(st Status, reason string) bool {
	return (st == StatusNeedsAttention && reason == "finished") || (st == StatusIdle && reason == "at prompt")
}

// shownWaiting reports whether a shown status is the waiting overlay.
func shownWaiting(st Status, reason string) bool { return st == StatusIdle && IsWaitingReason(reason) }

// statusVal is a status, its reason and when it was set.
type statusVal struct {
	st     Status
	reason string
	at     time.Time
}

// waitState is a record's side of the overlay: its raw status while the overlay shows
// waiting, and the status last shown (for its StatusChangedAt).
type waitState struct {
	raw   statusVal
	shown statusVal
}

// rawStatus is the record's own status: the shown one, unless that is the overlay.
func (rec *record) rawStatus() statusVal {
	if shownWaiting(rec.s.Status, rec.s.StatusReason) {
		return rec.wait.raw
	}
	return statusVal{st: rec.s.Status, reason: rec.s.StatusReason, at: rec.s.StatusChangedAt}
}

// rawThread is rec's thread with its raw status.
func (rec *record) rawThread() Thread {
	t, raw := rec.s, rec.rawStatus()
	t.Status, t.StatusReason, t.StatusChangedAt = raw.st, raw.reason, raw.at
	return t
}

// waitingLocked is the overlay rule for rec: whether it shows waiting, and on how many
// pending targets. Callers hold m.mu (it takes m.subs.mu).
func (m *Manager) waitingLocked(rec *record) (int, bool) {
	raw := rec.rawStatus()
	if m.subs == nil || !rec.s.ArchivedAt.IsZero() || rec.s.Removing || !canWait(raw.st, raw.reason) {
		return 0, false
	}
	n := 0
	for _, id := range m.subs.waitTargets(rec.s.ID) {
		if m.pendingLocked(id, map[string]bool{rec.s.ID: true}) {
			n++
		}
	}
	return n, n > 0 || m.subs.wakeQueued(rec.s.ID)
}

// pendingLocked reports whether thread id will wake its subscribers: not settled (as its
// raw status has it), or itself waiting on a pending target, or with a wake queued to
// it. seen are the threads already on the walk. Callers hold m.mu.
func (m *Manager) pendingLocked(id string, seen map[string]bool) bool {
	rec, ok := m.recs[id]
	if !ok || !rec.s.ArchivedAt.IsZero() || seen[id] {
		return false
	}
	if rec.s.Removing {
		return true // its subscribers get a removed wake
	}
	t := rec.rawThread()
	if !Meets(CondSettled, t) {
		return true
	}
	if !canWait(t.Status, t.StatusReason) {
		return false
	}
	seen[id] = true
	if m.subs.wakeQueued(id) {
		return true
	}
	for _, target := range m.subs.waitTargets(id) {
		if m.pendingLocked(target, seen) {
			return true
		}
	}
	return false
}

// shownLocked is the status rec shows: the overlay, or its raw status. Callers hold
// m.mu.
func (m *Manager) shownLocked(rec *record) statusVal {
	raw := rec.rawStatus()
	if n, ok := m.waitingLocked(rec); ok {
		return statusVal{st: StatusIdle, reason: waitingReason(n)}
	}
	return raw
}

// applyWaitingLocked sets the shown status on rec before a commit: the raw status is
// what the commit's change left (unless it left the overlay), the shown one the
// overlay's verdict. StatusChangedAt is kept while the overlay shows the same waiting
// reason, is the change's own stamp when it set what is shown, else it is now. It
// reports whether it changed rec's status. Callers hold m.mu.
func (m *Manager) applyWaitingLocked(rec *record) bool {
	before := statusVal{st: rec.s.Status, reason: rec.s.StatusReason, at: rec.s.StatusChangedAt}
	raw := rec.rawStatus()
	rec.wait.raw = raw
	show := m.shownLocked(rec)
	prev := rec.wait.shown
	switch {
	case shownWaiting(show.st, show.reason) && !prev.at.IsZero() && show.st == prev.st && show.reason == prev.reason:
		show.at = prev.at // the change set a raw status the overlay hides
	case show.st == before.st && show.reason == before.reason:
		show.at = before.at
	default:
		show.at = m.opts.Now()
	}
	rec.s.Status, rec.s.StatusReason, rec.s.StatusChangedAt = show.st, show.reason, show.at
	rec.wait.shown = show
	return show != before
}

// rewaitLocked re-evaluates the overlay of threads ids (the subscribers of a thread that
// just changed) and commits each whose shown status changes. Callers hold m.mu, and not
// m.subs.mu.
func (m *Manager) rewaitLocked(ids []string) {
	for _, id := range ids {
		rec, ok := m.recs[id]
		if !ok {
			continue
		}
		show := m.shownLocked(rec)
		if show.st == rec.s.Status && show.reason == rec.s.StatusReason {
			continue
		}
		m.commitLocked(rec, true)
	}
}

// rewait is rewaitLocked for one thread, taking m.mu.
func (m *Manager) rewait(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rewaitLocked([]string{id})
}

// unwaitLoaded turns a waiting status loaded from the database back into the finished
// turn it stood for: nothing runs at startup, so nothing is waited on, and the raw
// status was not saved.
func (s *Thread) unwaitLoaded() {
	if shownWaiting(s.Status, s.StatusReason) {
		s.Status, s.StatusReason = StatusNeedsAttention, "finished"
	}
}
