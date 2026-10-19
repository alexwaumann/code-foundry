package thread

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

// attended reports whether the user is looking at the app now; true without
// Options.Attended. Safe with m.mu held: the daemon's Options.Attended reads
// presence.Tracker.Current, which never waits on a subscriber.
func (m *Manager) attended() bool {
	return m.opts.Attended == nil || m.opts.Attended()
}

// AttendedChanged tells the store that presence became attended or stopped being so.
// On a rise every viewed thread is acknowledged and its until-seen flags are seen; a
// fall changes nothing (what is already seen stays seen). The daemon calls it from
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
		if m.seenFlagsLocked(rec) {
			m.commitLocked(rec, false)
		}
		if rec.run != nil {
			rec.run.attendedRose()
		}
	}
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
