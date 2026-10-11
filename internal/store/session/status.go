package session

import "time"

// setStatus sets the status and reason, stamping StatusChangedAt with now when either
// changes. It reports whether anything changed.
func (s *Session) setStatus(st Status, reason string, now time.Time) bool {
	if s.Status == st && s.StatusReason == reason {
		return false
	}
	s.Status, s.StatusReason, s.StatusChangedAt = st, reason, now
	return true
}

// disconnectedStatus is the status a session keeps once its process is gone, whatever
// the disconnect reason (closed, exited, crashed, daemon stopped or restarted): a turn
// that was running is interrupted (StatusError ReasonInterrupted); anything else,
// including needs-attention with its reason, is kept so it survives a daemon restart.
func disconnectedStatus(st Status, reason string) (Status, string) {
	if st == StatusBusy {
		return StatusError, ReasonInterrupted
	}
	return st, reason
}

func (st Status) valid() bool { return st >= StatusUnknown && st <= StatusError }
