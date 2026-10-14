package api

import "time"

// HeartbeatInterval is how long a long-lived server stream the GUI holds
// (ThreadService.Watch, TerminalService.Attach, EventService.Watch) may carry nothing
// before the daemon sends a StreamHeartbeat. After the Wails window was hidden,
// minimized or covered, WKWebView can hold back a stream's last bytes until more bytes
// arrive (docs/notes/thread-render-stall.md); a heartbeat releases them within one
// interval. The GUI's liveness watchdog (gui/frontend/src/api/stream.ts HEARTBEAT_MS)
// mirrors this value: keep them equal.
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
