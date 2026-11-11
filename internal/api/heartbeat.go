package api

import "time"

// HeartbeatInterval is how long every long-lived server stream the GUI holds
// (ThreadService.WatchThread, TerminalService.Attach, EventService.Watch and the others)
// may carry nothing before the daemon sends a StreamHeartbeat. It is the stream's only
// sign of life: a hung or stopped daemon keeps the socket open and says nothing, and the
// GUI's liveness watchdog (gui/frontend/src/api/stream.ts HEARTBEAT_MS, LIVENESS_MS)
// reconnects a stream that heartbeated and then went silent. Keep the two equal
// (docs/notes/ws-stall-workarounds.md).
const HeartbeatInterval = 5 * time.Second

// heartbeat fires once a stream has been silent for its interval. Streams select on C
// next to their event sources and call Reset after every message they send (the
// heartbeat included), so a busy stream never sends one.
type heartbeat struct {
	every time.Duration
	t     *time.Timer
}

// newHeartbeat starts the silence timer. Callers must Stop it when the stream ends.
func newHeartbeat(every time.Duration) *heartbeat {
	if every <= 0 {
		every = HeartbeatInterval
	}
	return &heartbeat{every: every, t: time.NewTimer(every)}
}

// C fires after the interval without a Reset.
func (h *heartbeat) C() <-chan time.Time { return h.t.C }

// Reset restarts the silence timer: call it after each message sent. Since Go 1.23 a
// Reset timer never delivers a stale tick from before the Reset.
func (h *heartbeat) Reset() { h.t.Reset(h.every) }

// Stop stops the timer; C never fires afterwards.
func (h *heartbeat) Stop() { h.t.Stop() }
