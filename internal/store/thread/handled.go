package thread

// A turn's handled messages (docs/notes/pr-task-forward.md). pr.task's forward wakes the
// sender once the turn that handled the forwarded message ended. A message's ordinal
// alone does not say that: one sent while Claude works is queued (queued.go) and can be
// read by the running turn or only by the next one, whose turn end comes later. So the
// log keeps the highest ordinal of a top-level message Claude took in (not queued, or
// read since: consume), and, at each top-level turn end, that ordinal as it was then:
// every message up to it was in a turn that ended. The runner publishes the latter as
// Thread.HandledThrough with its status.

// noteHandledLocked updates taken and handled for it, just written. t.mu held (or t not
// shared yet).
func (t *threadLog) noteHandledLocked(it Item) {
	if it.ParentToolUseID != "" {
		return
	}
	switch it.Kind {
	case KindUserMessage:
		if !it.Queued {
			t.taken = max(t.taken, it.Ordinal)
		}
	case KindTurnEnd:
		t.handled = max(t.handled, t.taken)
	}
}

// handledThrough is the highest ordinal of a message a turn that ended took in (0 when
// none): Thread.HandledThrough.
func (t *threadLog) handledThrough() int64 {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.handled
}
