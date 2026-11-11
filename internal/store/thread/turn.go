package thread

import "time"

// The start of a thread's latest turn (Thread.TurnStartedAt). A report older than it
// describes an earlier turn (Thread.ReportStale): thread.reports and thread.get say so
// from the row, without reading the thread's items. The log keeps it by lastTurn's rule
// (the wake's), re-read once a top-level message or turn end changed; the runner
// publishes and persists it with the status, as it does HandledThrough.

// turnStarted is lastTurn's start for the log's items.
func (t *threadLog) turnStarted() time.Time {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.turnDirty {
		t.turnStart, _, _ = lastTurn(t.items)
		t.turnDirty = false
	}
	return t.turnStart
}

// reportOlder reports whether r was made before a turn that started at started, at
// millisecond precision (a fire's time and a persisted time are cut to it). False without
// a report.
func reportOlder(r Report, started time.Time) bool {
	return r.Status != ReportNone && r.At.Before(started.Truncate(time.Millisecond))
}

// ReportStale reports whether t's report was made before its latest turn started (a
// follow-up or a wake, not a steer), so it describes an earlier turn.
func (t Thread) ReportStale() bool { return reportOlder(t.Report, t.TurnStartedAt) }
