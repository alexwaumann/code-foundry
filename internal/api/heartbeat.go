package api

import "time"

// HeartbeatInterval is how long every long-lived server stream the GUI holds
// (ThreadService.WatchThread, TerminalService.Attach, EventService.Watch and the others)
// may carry nothing before the daemon sends a StreamHeartbeat. After the Wails window was hidden,
// minimized or covered, WKWebView can hold back a stream's last bytes until more bytes
// arrive (docs/notes/thread-render-stall.md); a heartbeat releases them within one
// interval. The GUI's liveness watchdog (gui/frontend/src/api/stream.ts HEARTBEAT_MS)
// mirrors this value: keep them equal.
const HeartbeatInterval = 5 * time.Second

// snapshotFlushes are the silences after a snapshot before the next heartbeats. WKWebView
// holds back the end of a large message about one time in four, window focused or not,
// until later bytes arrive, so a thread would wait out HeartbeatInterval to open. A
// heartbeat right behind the snapshot does not release it (the two arrive together, as
// they still do at 3 ms); one 10 ms behind does. The second is the backstop for a busy
// machine: a miss costs seconds, a flush a few bytes (docs/notes/thread-open-stall.md).
var snapshotFlushes = []time.Duration{10 * time.Millisecond, 90 * time.Millisecond}

// heartbeat fires once a stream has been silent for its interval. Streams select on C
// next to their event sources and call Reset after every message they send (the
// heartbeat included), so a busy stream never sends one.
type heartbeat struct {
	every time.Duration
	// soon are the next silences, used up one per Reset before every applies again.
	soon []time.Duration
	t    *time.Timer
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
func (h *heartbeat) Reset() {
	d := h.every
	if len(h.soon) > 0 {
		d, h.soon = h.soon[0], h.soon[1:]
	}
	h.t.Reset(d)
}

// Flush makes the next silences snapshotFlushes: call it after sending a snapshot. Any
// message releases what is held, so one that comes first takes a flush's place.
func (h *heartbeat) Flush() {
	h.soon = snapshotFlushes
	h.Reset()
}

// Stop stops the timer; C never fires afterwards.
func (h *heartbeat) Stop() { h.t.Stop() }
