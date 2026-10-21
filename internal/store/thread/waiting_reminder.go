package thread

import "encoding/json"

// A turn a timer started still asks for the user (docs/notes/ember-fixes-2-wakes.md,
// e13-1 of the 2026-10-21 battle test). The waiting overlay (waiting.go) shows a thread
// that ended its turn while its child threads work as idle "waiting on N child threads":
// no bell, no badge. Right for a turn that only waits; wrong for a reminder: "remind me
// in 3 minutes" fired while a worker ran, the orchestrator wrote "Time to call Sam", and
// the row read "Waiting". So a turn a timer wake started (or joined) ends needs attention
// "finished" as it would with nothing to wait on; once seen ("at prompt") it waits again.

// isTimerWake reports whether a wake's JSON is a timer's (subscriptions_timer.go).
func isTimerWake(wakeJSON string) bool {
	var p struct {
		Kind string `json:"kind"`
	}
	return wakeJSON != "" && json.Unmarshal([]byte(wakeJSON), &p) == nil && p.Kind == "timer"
}

// noteTurnMessage records on thread id whether its turn is a timer's: a message that
// starts a turn (newTurn) sets it to whether it is a timer wake; one that joins a turn
// already running only sets it. Not committed: the status the send publishes is.
func (m *Manager) noteTurnMessage(id string, newTurn bool, o *outgoing) {
	timer := o.origin == OriginWake && isTimerWake(o.wakeJSON)
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.recs[id]
	if !ok {
		return
	}
	if newTurn {
		rec.wait.reminder = timer
	} else {
		rec.wait.reminder = rec.wait.reminder || timer
	}
}

// reminderShows reports whether rec's raw status is the end of a turn a timer started,
// which the waiting overlay leaves alone.
func reminderShows(rec *record, raw statusVal) bool {
	return rec.wait.reminder && raw.st == StatusNeedsAttention && raw.reason == "finished"
}
