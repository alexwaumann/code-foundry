package thread

import "time"

// Closing a turn whose process ended without a result (docs/notes/thread-fold-1-daemon.md).
//
// Claude ends every turn it runs with a result (project.go writes the turn_end), an
// interrupt included. When the process itself ends while a turn is open there is no
// result: a close or archive of a busy thread (beginClose interrupts and closes stdin;
// the process is gone before it answers), a crash, a daemon stop, a daemon that died
// with threads busy. The daemon then ends the turn itself, so every turn in a timeline
// ends with a turn_end the GUI can draw its footer from and fold.

// SubtypeProcessEnded is the TurnEnd.Subtype of a turn end the daemon wrote because
// the thread's process ended before Claude's result (closeOpenTurn): Interrupted, no
// usage, no cost (CostUSD 0, TurnCostUSD nil), DurationMS from the turn's first item to
// the process's end.
const SubtypeProcessEnded = "process_ended"

// synthTurnPrefix starts the id of a turn end the daemon wrote: the prefix and the id of
// the turn's first item, so the id is unique (an item starts one turn) and stable (a
// second close of the same turn rewrites the item instead of adding one).
const synthTurnPrefix = "turn-synth-"

// openTurn finds the turn the log ends in while it has no turn end (see openTurn).
func (t *threadLog) openTurn() (start Item, last time.Time, ok bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return openTurn(t.items)
}

// openTurn finds the turn items end in while it has no turn end. The turn is the
// top-level items after the last turn end or note (the GUI's turn grouping, where a
// note stands alone and closes what came before it; a fork's copied history ends with
// one). It starts at the first of them that is not an error: errors alone (a failed
// start) are not a turn, and a message sent while Claude works is part of the running
// turn. ok is false when there is no such turn. last is the latest time any item after
// the boundary was created or changed.
func openTurn(items []Item) (start Item, last time.Time, ok bool) {
	from := len(items)
	for i := len(items) - 1; i >= 0; i-- {
		it := items[i]
		if it.ParentToolUseID == "" && (it.Kind == KindTurnEnd || it.Kind == KindNote) {
			break
		}
		from = i
		last = latest(last, it.CreatedAt, it.UpdatedAt)
	}
	for _, it := range items[from:] {
		if it.ParentToolUseID == "" && it.Kind != KindError {
			return it, last, true
		}
	}
	return Item{}, time.Time{}, false
}

func latest(ts ...time.Time) time.Time {
	var out time.Time
	for _, t := range ts {
		if t.After(out) {
			out = t
		}
	}
	return out
}

// closeOpenTurn ends the log's open turn, if any, with a turn end of subtype
// SubtypeProcessEnded whose duration runs from the turn's first item to end (0 when end
// is not after it). It returns the item written.
func closeOpenTurn(w itemWriter, end time.Time) (Item, bool) {
	start, _, ok := w.log.openTurn()
	if !ok {
		return Item{}, false
	}
	var ms int64
	if !start.CreatedAt.IsZero() && end.After(start.CreatedAt) {
		ms = end.Sub(start.CreatedAt).Milliseconds()
	}
	return w.add(Item{ID: synthTurnPrefix + start.ID, Kind: KindTurnEnd, Turn: &TurnEnd{
		Subtype: SubtypeProcessEnded, Interrupted: true, DurationMS: ms,
	}}), true
}

// closeLostRun completes what a run the daemon lost (it died with the process running)
// left open: items still streaming or running (closeUnfinished), then the turn, whose
// duration ends at the last thing the run recorded.
func closeLostRun(w itemWriter, why string) {
	_, last, _ := w.log.openTurn()
	closeUnfinished(w, why)
	closeOpenTurn(w, last)
}

// isSynthTurn reports whether t is a turn end the daemon wrote (closeOpenTurn).
func isSynthTurn(t *TurnEnd) bool { return t != nil && t.Subtype == SubtypeProcessEnded }
