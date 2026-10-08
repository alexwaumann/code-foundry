package terminal

import "time"

// throttle limits how often metadata updates are published: at most one per interval,
// with the latest state always published eventually (trailing edge).
type throttle struct {
	interval time.Duration
	last     time.Time // zero: never published
}

// next decides what to do when a change is observed at now. If publishNow is true the
// caller publishes immediately (and the throttle records it); otherwise the caller
// should publish after wait, unless a timer is already pending.
func (th *throttle) next(now time.Time) (publishNow bool, wait time.Duration) {
	if th.last.IsZero() || now.Sub(th.last) >= th.interval {
		th.last = now
		return true, 0
	}
	return false, th.interval - now.Sub(th.last)
}

// fired records a trailing-edge publish at now.
func (th *throttle) fired(now time.Time) { th.last = now }
