package thread

import "strings"

// Attended: whether an open thread view counts as the user seeing the thread
// (docs/notes/alerts-foreground.md).
//
// A viewer (WatchItems) acknowledges what Claude produced (runner.acknowledge) and
// marks the thread's until-seen flags seen, but only while the daemon's presence is
// attended: a GUI window is visible and key. While it is not (the app is in the
// background, or its window is covered or minimized), a turn that ends in the open
// thread stays NeedsAttention "finished" like any other thread's, so it reaches the
// Dock badge and alerts. When presence becomes attended again, every thread with a
// viewer is acknowledged and its until-seen flags are seen, as if the view had just
// opened. Answering a request is an explicit act and always acknowledges.
//
// A thread with no runner follows the same rule on its saved status (seenStoppedLocked,
// docs/notes/done-on-stopped-threads.md): a viewer opening while attended, presence
// rising with one open, and a runner detaching with one open while attended each clear
// what the runner's acknowledge would have.

// attended reports whether the user is looking at the app now; true without
// Options.Attended. Safe with m.mu held: the daemon's Options.Attended reads
// presence.Tracker.Current, which never waits on a subscriber.
func (m *Manager) attended() bool {
	return m.opts.Attended == nil || m.opts.Attended()
}

// AttendedChanged tells the store that presence became attended or stopped being so.
// On a rise every viewed thread, running or not, is acknowledged and its until-seen
// flags are seen; a fall changes nothing (what is already seen stays seen). The daemon calls it from
// its presence subscriber, after Options.Attended already reports the new value.
func (m *Manager) AttendedChanged(attended bool) {
	m.log.Debug("thread attention follows presence", "attended", attended)
	if !attended {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for id := range m.viewers {
		rec, ok := m.recs[id]
		if !ok {
			continue
		}
		m.seenLocked(rec)
		if rec.run != nil {
			rec.run.attendedRose()
		}
	}
}

// seenLocked: the user sees rec, through a viewer, while presence is attended: its
// until-seen flags are seen, and so is its status when it has no runner (with one, the
// runner acknowledges). Callers hold m.mu.
func (m *Manager) seenLocked(rec *record) {
	flags, status := m.seenFlagsLocked(rec), m.seenStoppedLocked(rec)
	if flags || status {
		m.commitLocked(rec, status) // flags have their own table; the status must survive a restart
	}
}

// seenStoppedLocked is runner.acknowledge for a thread with no runner, with a viewer,
// while presence is attended: what streamStatus.Acknowledge would have cleared becomes
// Idle "at prompt". It reads the raw status: under the waiting overlay (waiting.go) the
// finished turn is seen and the thread keeps showing waiting. An archived thread keeps
// its status. It reports whether it changed the status; the caller commits, persisted.
// Callers hold m.mu.
func (m *Manager) seenStoppedLocked(rec *record) bool {
	if rec.run != nil || (rec.away != nil && rec.away.reason == ReasonArchived) || !rec.s.ArchivedAt.IsZero() || m.viewers[rec.s.ID] == 0 || !m.attended() {
		return false
	}
	if raw := rec.rawStatus(); !clearedWhenSeen(raw.st, raw.reason) {
		return false
	}
	return rec.s.setStatus(StatusIdle, "at prompt", m.opts.Now())
}

// clearedWhenSeen reports whether a stopped thread's status is one
// streamStatus.Acknowledge clears. The budget stop is always: with the process gone its
// turn has ended. Anything else stays: a request's reason, "snooze ended", an
// interrupted or crashed turn.
func clearedWhenSeen(st Status, reason string) bool {
	if st != StatusNeedsAttention {
		return false
	}
	return reason == "finished" || strings.HasPrefix(reason, "error:") ||
		reason == ReasonBudgetReached || reason == ReasonWakeLimit
}

// attendedRose tells the runner presence became attended while its thread is viewed.
// Non-blocking.
func (r *runner) attendedRose() {
	select {
	case r.st.seenSig <- struct{}{}:
	default:
	}
}

// onAttended: the user looks at the app again with this thread open: what Claude
// produced meanwhile is seen.
func (r *runner) onAttended() {
	r.viewers = r.m.viewerCount(r.id)
	if r.viewers > 0 && r.m.attended() {
		r.acknowledge()
		r.checkStatus()
	}
}
