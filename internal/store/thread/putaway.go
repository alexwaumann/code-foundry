package thread

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/alexwaumann/code-foundry/internal/claudestream"
)

// Putting a thread away: what archive and snooze share (docs/notes/self-put-away.md).
//
// Both close the thread, and a close that cuts off a turn must not read as a failure:
// record.away names what closes it, so the close's end (detach) publishes the cut-off
// turn idle "archived" or "snoozed", not error "interrupted".
//
// A thread can also ask this of itself, from its own Bash tool. Doing it at once cannot
// work: the close makes Claude kill that Bash call, which ends the very request the
// close runs in (status 499 about 30 ms after the close began, the process gone some
// 300 ms later), so the put-away fails and the thread reads Interrupted. So mid-turn the
// request only leaves a pending put-away (record.putAway) and returns. The turn ends
// normally, the thread gets to write its last message, and the end of the turn does the
// rest, with nothing about that turn asking for the user's attention.
//
// A pending put-away is in memory only: a daemon restart loses the turn it waits for.

// ReasonSnoozed is the StatusReason, with StatusIdle, of a thread whose turn (or pending
// request) a snooze cut off: stopped on purpose, not interrupted (Snooze, SaveForLater).
const ReasonSnoozed = "snoozed"

// PutAwayKind is how a thread is put away.
type PutAwayKind int

// The ways to put a thread away.
const (
	PutAwayArchive PutAwayKind = iota // Archive
	PutAwaySnooze                     // Snooze, until PutAway.Until
	PutAwaySave                       // SaveForLater
)

func (k PutAwayKind) String() string {
	switch k {
	case PutAwaySnooze:
		return "snooze"
	case PutAwaySave:
		return "save"
	}
	return "archive"
}

// PutAway is a put-away a thread asks of itself (Store.PutAwaySelf).
type PutAway struct {
	Kind  PutAwayKind
	Until time.Time // PutAwaySnooze's wake time
}

// PutAwaySelf is Archive, Snooze or SaveForLater as thread id asks them of itself. Mid-turn
// it only records p and reports deferred: the end of the turn carries it out, unless a
// message, an interrupt, an unarchive or an unsnooze came first, the turn failed, or the
// process ended. A second call replaces the first. Not mid-turn it is the plain call,
// run on the store's context: the caller may be a shell of the thread, which the close
// ends, and the request with it. What the plain call refuses is refused here at once.
func (m *Manager) PutAwaySelf(ctx context.Context, id string, p PutAway) (_ Thread, deferred bool, _ error) {
	if err := m.refusePutAway(id, &p); err != nil {
		return Thread{}, false, err
	}
	live, _, _, _, err := m.lifecycle(id)
	if err != nil {
		return Thread{}, false, err
	}
	if live != nil {
		rep, err := live.exchange(ctx, threadCmd{putAway: &p})
		if err != nil && !errors.Is(err, errProcessGone) { // gone: nothing to wait for
			return Thread{}, false, err
		}
		if err == nil && rep.deferred {
			m.log.Info("thread put-away waits for the turn's end", "thread", id, "what", p.Kind.String())
			s, err := m.Get(ctx, id)
			return s, true, err
		}
	}
	s, err := m.applyPutAway(m.ctx, id, p, nil)
	return s, false, err
}

// refusePutAway is what p's plain call would refuse before closing anything, with
// p.Until in the form Snooze keeps.
func (m *Manager) refusePutAway(id string, p *PutAway) error {
	if p.Kind == PutAwayArchive {
		return m.refuseResident(id, "archived")
	}
	if err := m.refuseResident(id, "snoozed"); err != nil {
		return err
	}
	if err := m.refuseSettingUp(id, "snoozed"); err != nil {
		return err
	}
	if p.Kind == PutAwaySnooze {
		until, err := m.snoozeTime(p.Until)
		if err != nil {
			return err
		}
		p.Until = until
	}
	return nil
}

// applyPutAway runs p. closing: as in archive; nil closes whatever process the thread has.
func (m *Manager) applyPutAway(ctx context.Context, id string, p PutAway, closing *runner) (Thread, error) {
	switch p.Kind {
	case PutAwaySnooze:
		return m.snooze(ctx, id, p.Until, closing)
	case PutAwaySave:
		return m.saveForLater(ctx, id, closing)
	}
	return m.archive(ctx, id, true, closing)
}

// closeAway closes thread id for a put-away: Close, or with closing (the process a turn's
// end began closing) only the wait for it. Whatever process the thread has after that was
// started by a message sent since, which wins: closing it would cut off the user's turn,
// so the put-away fails, before it touches the thread's shells.
func (m *Manager) closeAway(ctx context.Context, id string, closing *runner) error {
	if closing == nil {
		return m.Close(ctx, id)
	}
	select {
	case <-closing.done:
	case <-ctx.Done():
		return ctx.Err()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, err := m.record(id)
	if err != nil {
		return err
	}
	if rec.run != nil || rec.s.State != StateDisconnected {
		return fmt.Errorf("%w: thread %s was started again after its turn's end", ErrFailedPrecondition, id)
	}
	return nil
}

// onPutAway takes a thread's put-away of itself on the runner goroutine, where whether a
// turn is running is exact (the published status lags by the debounce), and reports
// whether it waits for the turn's end.
func (r *runner) onPutAway(p PutAway) bool {
	if r.closing || r.restarting() || !r.st.sd.midTurn() {
		return false
	}
	r.m.mu.Lock()
	defer r.m.mu.Unlock()
	rec, ok := r.m.recs[r.id]
	if !ok {
		return false
	}
	rec.putAway = &p // a second call replaces the first
	return true
}

// putAwayAtTurnEnd carries out a pending put-away when Claude's turn ended at its prompt.
// A turn the user (or the budget stop) interrupted drops it, as does one that failed: its
// status says what happened. So does a snooze whose time passed meanwhile. A result with
// a turn queued behind it is not the end: the last one decides.
//
// The close begins here, before anything is published: acknowledged first, the turn
// ends idle, with no "finished" to raise attention, and a message sent from now on finds
// the process closing and starts it again (Send), which the put-away then gives way to.
func (r *runner) putAwayAtTurnEnd(e *claudestream.Result) {
	if e.Interrupted() {
		r.m.dropPutAway(r.id, "the turn was interrupted")
		return
	}
	if r.closing || !r.st.sd.AtPrompt() {
		return
	}
	p := r.m.takePutAway(r.id)
	switch {
	case p == nil:
		return
	case e.IsError:
		r.log().info("thread put-away dropped: the turn failed", "what", p.Kind.String())
		return
	case p.Kind == PutAwaySnooze && !p.Until.After(r.m.opts.Now()):
		r.log().info("thread put-away dropped: the snooze time passed during the turn", "until", p.Until)
		return
	}
	if p.Kind == PutAwayArchive {
		r.m.unwatchForArchive(r.id, r.id) // before the close: its settle must wake no one
	}
	r.acknowledge()
	r.puttingAway = true
	r.beginClose()
	r.m.finishPutAway(r, *p)
}

// finishPutAway runs the put-away the end of a turn began. Off the runner goroutine: it
// waits for the runner to finish. The request that asked for it is long gone, so a
// failure can only be logged; the thread stays stopped, idle, in the main list.
func (m *Manager) finishPutAway(r *runner, p PutAway) {
	m.wg.Add(1) // this runner is still counted: no race with Shutdown's Wait
	go func() {
		defer m.wg.Done()
		_, err := m.applyPutAway(m.ctx, r.id, p, r)
		if err != nil {
			m.log.Warn("put a thread away at its turn's end", "thread", r.id, "what", p.Kind.String(), "err", err)
		}
		m.endArchiving(r.id, err != nil) // a failure before the archive's own end left the mark (archive_group.go)
	}()
}

// takePutAway removes and returns thread id's pending put-away; nil without one.
func (m *Manager) takePutAway(id string) *PutAway {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.recs[id]
	if !ok {
		return nil
	}
	p := rec.putAway
	rec.putAway = nil
	return p
}

// dropPutAway is dropPutAwayLocked, taking m.mu.
func (m *Manager) dropPutAway(id, why string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if rec, ok := m.recs[id]; ok {
		m.dropPutAwayLocked(rec, why)
	}
}

// dropPutAwayLocked forgets rec's pending put-away, if any: someone took the thread over,
// or the turn it waits for will not end. Callers hold m.mu.
func (m *Manager) dropPutAwayLocked(rec *record, why string) {
	if rec.putAway == nil {
		return
	}
	m.log.Info("thread put-away dropped", "thread", rec.s.ID, "what", rec.putAway.Kind.String(), "why", why)
	rec.putAway = nil
}

// awayClose is record.away: an archive or a snooze is closing the thread.
type awayClose struct {
	reason string // the idle status reason of a turn it cuts off
	cut    bool   // detach published one
}

// markPuttingAway notes that an archive or a snooze (reason: ReasonArchived,
// ReasonSnoozed) is about to close thread id, unless it was interrupted before: the
// close's end (detach) then publishes the turn it cuts off as idle reason rather than
// error "interrupted", which a board showed for the seconds the shells and strays took
// to stop. endPuttingAway clears it.
func (m *Manager) markPuttingAway(id string, wasInterrupted bool, reason string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if rec, ok := m.recs[id]; ok && !wasInterrupted {
		rec.away = &awayClose{reason: reason}
	}
}

// endPuttingAway clears record.away; when the put-away failed and the thread did not
// start again, a turn it cut off reads error "interrupted" after all.
func (m *Manager) endPuttingAway(id string, failed bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.recs[id]
	if !ok || rec.away == nil {
		return
	}
	a := rec.away
	rec.away = nil
	if failed && a.cut && rec.run == nil && rec.s.ArchivedAt.IsZero() && !rec.s.Snoozed() && rec.s.Status == StatusIdle && rec.s.StatusReason == a.reason {
		rec.s.setStatus(StatusError, ReasonInterrupted, m.opts.Now())
		m.commitLocked(rec, true)
	}
}

// putAwayStatus turns a turn a put-away's close cut off (error "interrupted") into idle
// reason.
func putAwayStatus(s *Thread, reason string, now time.Time) bool {
	if s.Status != StatusError || s.StatusReason != ReasonInterrupted {
		return false
	}
	return s.setStatus(StatusIdle, reason, now)
}

// snoozeTime is until as Snooze keeps it, refused unless it is in the future. Wall clock
// only (see wakeSnoozed); persisted at millisecond precision.
func (m *Manager) snoozeTime(until time.Time) (time.Time, error) {
	until = until.Round(0).Truncate(time.Millisecond)
	if !until.After(m.opts.Now()) {
		return time.Time{}, fmt.Errorf("%w: snooze time %s is not in the future", ErrInvalidArgument, until.Format(time.RFC3339))
	}
	return until, nil
}
