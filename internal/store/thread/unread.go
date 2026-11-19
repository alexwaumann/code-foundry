package thread

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// Mark as unread (docs/notes/thread-mark-unread.md). The user puts an idle thread back
// into the status a turn that ended unseen has, NeedsAttention "finished" (the sidebar's
// Done), to come back to it later. Nothing new is stored: from then on it is a Done
// thread, cleared as one is (runner.acknowledge, seenStoppedLocked), saved as one is.
//
// One thing differs: the thread may be showing when it is marked (it has a viewer and
// presence is attended), and that view must not see it at once. The mark is held
// (streamStatus.held on a runner, record.unreadHold on a stopped thread, carried over
// by detach) until:
//
//   - a new viewer opens it (addViewer; the runner's onViewers on a rise);
//   - the thread gains the focus in the layout (FocusGained: the daemon's glue,
//     internal/daemon/thread_focus.go, calls it when the focused pane's active tab of the
//     current space becomes the thread's);
//   - a message is sent or a turn starts (streamStatus.sent, turnStarted), or a spawn
//     starts the thread afresh.
//
// Presence rising with the view still open does not end the hold: the user marked the
// thread while looking at it, and leaving the app and coming back is not looking again.
//
// The mark fires nothing: the subscriptions to the thread take the new status as already
// seen (absorbLocked), so no attention wake goes. The GUI's Dock badge counts it as it
// counts any Done thread (stores/threads.ts attentionIds).

// MarkUnread implements Store.
func (m *Manager) MarkUnread(ctx context.Context, id string) (Thread, error) {
	for {
		live, closing, reserved, _, err := m.lifecycle(id)
		switch {
		case err != nil:
			return Thread{}, err
		case live != nil:
			rep, err := live.exchange(ctx, threadCmd{unread: true})
			if errors.Is(err, errProcessGone) {
				continue
			}
			if err != nil {
				return Thread{}, err
			}
			return rep.thread, rep.err
		case closing != nil:
			if err := waitDone(ctx, closing); err != nil {
				return Thread{}, err
			}
			continue
		case reserved != nil:
			select {
			case <-reserved:
			case <-ctx.Done():
				return Thread{}, ctx.Err()
			}
			continue
		}
		t, ok, err := m.markStopped(id)
		if !ok {
			continue // started meanwhile
		}
		return t, err
	}
}

// markStopped marks a thread with no runner. ok is false when it has one now.
func (m *Manager) markStopped(id string) (_ Thread, ok bool, _ error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, err := m.record(id)
	if err != nil {
		return Thread{}, true, err
	}
	if rec.reserved != nil || rec.run != nil {
		return rec.s, false, nil
	}
	if err := unreadRefusal(rec, rec.s.Status, rec.s.StatusReason); err != nil {
		return rec.s, true, err
	}
	rec.s.setStatus(StatusNeedsAttention, "finished", m.opts.Now())
	rec.unreadHold = true
	m.commitMarkedLocked(rec)
	m.log.Info("thread marked unread", "thread", id)
	return rec.s, true, nil
}

// onMarkUnread is MarkUnread on the runner's goroutine: refused unless the stream is idle
// at its prompt; otherwise "finished", held, published at once (no debounce) and saved.
func (r *runner) onMarkUnread() (Thread, error) {
	st, reason := r.st.sd.Status()
	if r.closing || r.puttingAway || !r.st.sd.AtPrompt() {
		st, reason = StatusBusy, "working" // on its way out or mid-turn: never at its prompt
	}
	var out Thread
	var refused error
	found := r.m.withRecord(r.id, func(rec *record) {
		out = rec.s
		if refused = unreadRefusal(rec, st, reason); refused != nil {
			return
		}
		// The viewers there now are the ones the hold is against: a rise after this is a
		// new one (onViewers).
		r.viewers = r.m.viewers[r.id]
		r.st.sd.markUnread()
		if r.debounce != nil {
			r.debounce.Stop()
			r.debounce = nil
		}
		r.readStatus()
		r.pubStatus, r.pubReason, r.pubAsk, r.pubTool, r.pubActivity, r.pubHandled, r.pubTurn = r.status, r.reason, r.ask, r.tool, r.activity, r.handled, r.turn
		rec.s.setStatus(r.status, r.reason, r.m.opts.Now())
		rec.s.PendingRequestID = r.ask
		rec.s.BusyTool = r.tool
		rec.s.LastActivityAt = r.activity
		rec.s.HandledThrough = r.handled
		rec.s.TurnStartedAt = r.turn
		r.m.commitMarkedLocked(rec)
		out = rec.s
	})
	switch {
	case !found:
		return Thread{}, r.m.notFound(r.id)
	case refused != nil:
		return out, refused
	}
	r.log().info("thread marked unread")
	return out, nil
}

// withRecord runs fn on the thread's record under m.mu; false when there is none.
func (m *Manager) withRecord(id string, fn func(*record)) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.recs[id]
	if ok {
		fn(rec)
	}
	return ok
}

// commitMarkedLocked commits a thread just marked unread, persisted, after its
// subscriptions took the new status as already seen: the attention condition becomes
// true with no transition to fire on (observeLocked), so the mark wakes no one, and the
// thread's next real attention fires as ever. Callers hold m.mu.
func (m *Manager) commitMarkedLocked(rec *record) {
	m.applyWaitingLocked(rec)
	m.absorbLocked(rec.s)
	m.commitLocked(rec, true)
}

// absorbLocked sets every thread subscription to t to what t meets now, without firing.
// Callers hold m.mu.
func (m *Manager) absorbLocked(t Thread) {
	if m.subs == nil {
		return
	}
	s := m.subs
	s.mu.Lock()
	defer s.mu.Unlock()
	req := requestKey(t)
	for _, r := range s.byID {
		if r.s.TargetKind == TargetThread && r.s.TargetID == t.ID {
			r.sat, r.req = r.meets(t), req
		}
	}
}

// unreadRefusal says why rec, whose status is st and reason (the runner's own when it has
// one), cannot be marked unread, or nil: only an idle thread at its prompt can, one not
// archived, snoozed, saved, setting up, waiting or being removed. Callers hold m.mu.
func unreadRefusal(rec *record, st Status, reason string) error {
	s := rec.s
	var why string
	switch {
	case s.Removing:
		why = "being removed"
	case !s.ArchivedAt.IsZero() || rec.archiving || (rec.away != nil && rec.away.reason == ReasonArchived):
		why = "archived"
	case !s.SavedAt.IsZero():
		why = "saved for later"
	case s.Snoozed() || rec.away != nil:
		why = "snoozed"
	case s.setupUnfinished() || rec.setup != nil:
		why = "setting up"
	case s.State == StateStarting || (st == StatusUnknown && reason == "starting"):
		why = "starting"
	case st == StatusBusy:
		why = "working"
	case st == StatusError:
		why = "in error (" + reason + ")"
	case st == StatusNeedsAttention && (strings.HasPrefix(reason, "permission:") || strings.HasPrefix(reason, "question:")):
		why = "waiting on an answer"
	case st == StatusNeedsAttention && reason == "finished":
		why = "already unread"
	case st == StatusNeedsAttention:
		why = "needing attention (" + reason + ")"
	case s.Status != StatusIdle || s.StatusReason != "at prompt":
		// The row shows more than the runner: the waiting overlay (waiting.go), or a
		// status the debounce has not published yet.
		why = "not at its prompt (" + s.StatusReason + ")"
	case st != StatusIdle || reason != "at prompt":
		why = "not at its prompt (" + reason + ")"
	default:
		return nil
	}
	return fmt.Errorf("%w: thread %s is %s; only an idle thread at its prompt can be marked unread", ErrFailedPrecondition, s.ID, why)
}

// FocusGained tells the store the thread became the focused tab of the window's current
// space (the daemon's layout glue). A mark held against the view that was there ends
// (unread.go): the user looks at the thread again, so with a viewer while presence is
// attended it is seen, as any Done thread would be.
func (m *Manager) FocusGained(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.recs[id]
	if !ok {
		return
	}
	if rec.run != nil {
		rec.run.focused()
		return
	}
	rec.unreadHold = false
	if m.seenStoppedLocked(rec) {
		m.commitLocked(rec, true)
	}
}

// focused tells the runner its thread gained the focus. Non-blocking.
func (r *runner) focused() {
	select {
	case r.st.focusSig <- struct{}{}:
	default:
	}
}

// onFocused: the thread gained the focus; a held mark ends, and a viewed thread is seen
// while presence is attended.
func (r *runner) onFocused() {
	r.st.sd.held = false
	r.onAttended()
}

// holdUnreadLocked carries a held mark from the runner r that detaches onto rec, so a
// view that was open when the thread was marked still does not see it once its process
// stops (detach's seenStoppedLocked). Callers hold m.mu.
func (m *Manager) holdUnreadLocked(rec *record, r *runner) {
	raw := rec.rawStatus()
	rec.unreadHold = r.st != nil && r.st.sd.held && raw.st == StatusNeedsAttention && raw.reason == "finished"
}
