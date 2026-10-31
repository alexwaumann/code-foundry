package thread

import "time"

// Status is what Claude is doing. Values mirror codefoundry.v1.ThreadStatus, so a
// conversion is a cast.
type Status int

// Statuses.
const (
	StatusUnknown Status = iota
	StatusBusy
	StatusIdle
	// StatusNeedsAttention: Claude waits on the user (permission prompt, question,
	// dialog).
	StatusNeedsAttention
	// StatusError: the process ended while Claude was working (reason
	// ReasonInterrupted, or ReasonCrashed when it died on its own). Never reported by
	// streamStatus; set by the store on a disconnect (see disconnectedStatus).
	StatusError
)

func (s Status) String() string {
	switch s {
	case StatusBusy:
		return "busy"
	case StatusIdle:
		return "idle"
	case StatusNeedsAttention:
		return "needs attention"
	case StatusError:
		return "error"
	default:
		return "unknown"
	}
}

// setStatus sets the status and reason, stamping StatusChangedAt with now when either
// changes, and drops BusyTool once they no longer allow one (busyToolFor). It reports
// whether the status or reason changed.
func (s *Thread) setStatus(st Status, reason string, now time.Time) bool {
	s.BusyTool = busyToolFor(st, reason, s.BusyTool)
	if s.Status == st && s.StatusReason == reason {
		return false
	}
	s.Status, s.StatusReason, s.StatusChangedAt = st, reason, now
	return true
}

// disconnectedStatus is the status a thread keeps once its process is gone, whatever
// the disconnect reason (closed, exited, crashed, daemon stopped or restarted): a turn
// that was running is interrupted (StatusError ReasonInterrupted), or crashed
// (ReasonCrashed) when its process died on its own (crashed: no close, no daemon stop,
// no user's interrupt asked for it); anything else, including needs-attention with its
// reason, is kept so it survives a daemon restart.
func disconnectedStatus(st Status, reason string, crashed bool) (Status, string) {
	switch {
	case st != StatusBusy:
		return st, reason
	case crashed:
		return StatusError, ReasonCrashed
	}
	return StatusError, ReasonInterrupted
}

func (st Status) valid() bool { return st >= StatusUnknown && st <= StatusError }
