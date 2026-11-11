package thread

import (
	"context"
	"maps"
	"slices"
	"strconv"
	"strings"
)

// Notify subscriptions end when their thread finishes (docs/notes/notify-ends-on-finish.md).
//
// `thread new --notify` (and --notify-group) subscribes the creator to its child: settled,
// repeat. It used to live until the child was archived, so every turn the child ended woke
// the lead again, the user's own turns in the child included, and the lead's Waiting strip
// kept listing finished children. Now such a subscription (UntilFinished: "until":
// "finished" in its args, so it survives a restart without a column) ends by itself with
// the wake that reports its thread finished a turn (finishedTurn): the wake is queued as
// ever, then the subscription leaves the store and the database, like a one-shot. A wake
// the lead still has to act on while the child is not done (a pending prompt or question,
// an error, a budget stop, a current blocked or failed report, a child still waiting on
// its own workers or background work) keeps it, so the finish reaches the lead later.
//
// What ended is remembered (an ended record: the subscription's row with "ended" in its
// args, in memory in subscriptions.ended, never listed and never fired), so that when the
// subscriber sends the thread more work (Send with ByThreadID, not NoNotify), it is
// subscribed again the same way (UntilFinished, same group), armed with the message's
// ordinal (SubscribeOptions.AfterOrdinal): the turn that handles the message wakes it, and
// the finish it reported before does not fire again. The user's messages, wakes and other
// threads' sends do not re-subscribe anyone. Archiving or removing either thread forgets
// the record; so does an unsubscribe by target.
//
// An explicit `thread subscribe` never ends by itself: subscribing again to a thread the
// subscriber has a notify subscription to makes it an explicit one (today's Existed path).

// untilArg holds, in a subscription's args, that it ends when its thread finishes;
// endedArg marks an ended record.
const (
	untilArg      = "until"
	untilFinished = "finished"
	endedArg      = "ended"
)

// UntilFinished reports whether s ends by itself once its thread finished a turn (a
// --notify subscription's).
func (s Subscription) UntilFinished() bool { return s.Args[untilArg] == untilFinished }

// sameArgs compares two subscriptions' args for the same-subscription match, leaving out
// untilArg: a notify subscription and an explicit one to the same thread are one.
func sameArgs(a, b map[string]string) bool {
	return maps.EqualFunc(withoutUntil(a), withoutUntil(b), func(x, y string) bool { return x == y })
}

func withoutUntil(args map[string]string) map[string]string {
	if _, ok := args[untilArg]; !ok {
		return args
	}
	out := maps.Clone(args)
	delete(out, untilArg)
	if len(out) == 0 {
		return nil
	}
	return out
}

// finishedTurn reports whether t, as a wake fired about it, finished: its turn ended
// plainly (idle, or needs attention "finished"), it waits on nothing of its own (shown
// waiting on child threads, subagents or shells: they will wake it), none of its children
// works, and its report is no current blocked or failed one. Everything else that fires a
// settled subscription is something the subscriber has to deal with before the thread is
// done: a pending permission prompt or question, an error, "error: <code>", the budget
// stop, the wake limit, a snooze that ended.
func finishedTurn(t Thread, kids wakeChildren) bool {
	switch {
	case t.Status == StatusIdle && !shownWaiting(t.Status, t.StatusReason):
	case t.Status == StatusNeedsAttention && t.StatusReason == "finished":
	default:
		return false
	}
	if kids.Working > 0 {
		return false
	}
	return t.ReportStale() || (t.Report.Status != ReportBlocked && t.Report.Status != ReportFailed)
}

// firedThreadLocked keeps r, which fired about thread t (its wake queued): an
// UntilFinished subscription whose t finished, with no message of its subscriber's or
// note still waiting for a later turn, ends (endLocked); otherwise as firedLocked.
// Callers hold m.mu and m.subs.mu.
func (m *Manager) firedThreadLocked(r *subRec, t Thread) {
	if m.endsLocked(r, t) {
		m.endLocked(r)
		return
	}
	m.subs.firedLocked(r)
}

// endsLocked reports whether r's fire about t ends it: an UntilFinished subscription whose
// t finished, with no note for a later message's turn (a pr.task forward's) and no message
// its subscriber sent while it worked (keep) still waiting for a turn. Callers hold m.mu
// and m.subs.mu.
func (m *Manager) endsLocked(r *subRec, t Thread) bool {
	return r.s.UntilFinished() && len(r.extra) == 0 && t.HandledThrough >= r.keep && finishedTurn(t, m.childrenLocked(t.ID))
}

// answeredIntoFinishLocked reports whether r, an UntilFinished subscription last seen
// on a pending request (wasReq), sees t finished without having seen it work in between:
// a prompt answered and the turn's end published as one change (the status debounce).
// Its finish must still reach the subscriber, and end r. Callers hold m.mu and m.subs.mu.
func (m *Manager) answeredIntoFinishLocked(r *subRec, wasReq string, t Thread) bool {
	return r.s.UntilFinished() && wasReq != "" && requestKey(t) == "" && finishedTurn(t, m.childrenLocked(t.ID))
}

// endLocked ends r: it goes as a fired one-shot goes (its wake is on its way, or held for
// its group, and listed while held), and an ended record takes its place, replacing an
// older one for the same subscriber and thread. Callers hold m.mu and m.subs.mu.
func (m *Manager) endLocked(r *subRec) {
	s := m.subs
	s.removeLocked([]string{r.s.ID})
	id, err := newSubscriptionID()
	if err != nil {
		m.log.Error("record an ended notify subscription", "subscription", r.s.ID, "err", err)
		return
	}
	s.dropEndedLocked(r.s.SubscriberID, r.s.TargetID)
	e := Subscription{ID: id, SubscriberID: r.s.SubscriberID, TargetKind: TargetThread, TargetID: r.s.TargetID,
		Condition: r.s.Condition, Args: maps.Clone(r.s.Args), Repeat: true, CreatedAt: r.s.CreatedAt, FiredCount: r.s.FiredCount,
		LastFiredAt: r.s.LastFiredAt}
	e.Args[endedArg] = strconv.FormatInt(millis(m.opts.Now()), 10)
	if err := saveSubscription(context.Background(), s.db, e); err != nil {
		m.log.Error("record an ended notify subscription", "subscription", r.s.ID, "err", err)
		return
	}
	if s.ended == nil {
		s.ended = map[string]Subscription{}
	}
	s.ended[id] = e
	m.log.Info("notify subscription ended: its thread finished", "subscription", r.s.ID, "subscriber", r.s.SubscriberID,
		"target", r.s.TargetID, "fired_count", r.s.FiredCount)
}

// isEnded reports whether a stored subscription is an ended record.
func isEnded(s Subscription) bool { _, ok := s.Args[endedArg]; return ok }

// endedFor is subscriber's ended record about thread target. Callers hold s.mu.
func (s *subscriptions) endedFor(subscriber, target string) (Subscription, bool) {
	for _, e := range s.ended {
		if e.SubscriberID == subscriber && e.TargetID == target {
			return e, true
		}
	}
	return Subscription{}, false
}

// dropEndedLocked forgets the ended records of subscriber about target ("" for any
// subscriber or target; not both). Callers hold s.mu.
func (s *subscriptions) dropEndedLocked(subscriber, target string) {
	var ids []string
	for id, e := range s.ended {
		if (subscriber == "" || e.SubscriberID == subscriber) && (target == "" || e.TargetID == target) {
			ids = append(ids, id)
			delete(s.ended, id)
		}
	}
	if len(ids) == 0 {
		return
	}
	if err := deleteSubscriptions(context.Background(), s.db, ids); err != nil {
		s.log.Error("delete ended notify subscriptions", "subscriptions", ids, "err", err)
	}
}

// forgetEndedLocked forgets the ended records of thread id and those about it (archived
// or removed). Callers hold s.mu.
func (s *subscriptions) forgetEndedLocked(id string) {
	s.dropEndedLocked(id, "")
	s.dropEndedLocked("", id)
}

// renotify subscribes msg's sender again to thread id, which it just sent the message
// with item it (Send): only when the sender holds an ended record about id (its
// --notify subscription ended with a finish) and no live subscription to id that its
// answer meets. A live notify subscription is kept until the turn that handles the
// message ended (subRec.keep). The new subscription is the ended one's kind (UntilFinished, same
// group), armed with the message's ordinal: the turn that handles the message wakes the
// sender. A failure is logged: the message went out.
func (m *Manager) renotify(ctx context.Context, id string, msg Message, it Item) {
	by := strings.TrimSpace(msg.ByThreadID)
	if by == "" || by == id || msg.Origin != OriginUser || msg.NoNotify || msg.compact || m.subs == nil {
		return
	}
	s := m.subs
	s.mu.Lock()
	ended, ok := s.endedFor(by, id)
	live := false
	for _, r := range s.byID {
		if r.s.SubscriberID != by || r.s.TargetKind != TargetThread || r.s.TargetID != id || !slices.Contains(waitConditions, r.s.Condition) {
			continue
		}
		live = true
		if r.s.UntilFinished() && it.Ordinal > 0 {
			// The thread works on: the turn that handles this message wakes the sender, not
			// the end of one that ends before it read it.
			r.keep = max(r.keep, it.Ordinal)
		}
	}
	s.mu.Unlock()
	if !ok || live {
		return
	}
	if it.Ordinal <= 0 {
		// Nothing to arm with: a plain subscription would fire at once on the finish the
		// sender already heard about.
		m.log.Warn("notify not renewed: the send has no message ordinal", "thread", id, "by", by)
		return
	}
	res, err := m.Subscribe(ctx, SubscribeOptions{SubscriberID: by, TargetThreadID: id, Condition: ended.Condition, Repeat: true,
		Group: ended.Group(), endsOnFinish: true, AfterOrdinal: it.Ordinal})
	if err != nil {
		m.log.Warn("notify not renewed", "thread", id, "by", by, "err", err)
		return
	}
	s.mu.Lock()
	if _, still := s.ended[ended.ID]; still {
		// Renewed; a record the renewal itself made (it fired at once on a finish) stays.
		delete(s.ended, ended.ID)
		if err := deleteSubscriptions(context.Background(), s.db, []string{ended.ID}); err != nil {
			s.log.Error("delete an ended notify subscription", "subscription", ended.ID, "err", err)
		}
	}
	s.mu.Unlock()
	m.log.Info("notify renewed by a send", "thread", id, "by", by, "subscription", res.Subscription.ID, "fired", res.Fired,
		"existed", res.Existed, "ordinal", it.Ordinal)
}

// loadEnded keeps a loaded ended record whose threads are both live; false to delete it.
func (s *subscriptions) loadEnded(sub Subscription, live func(string) bool) bool {
	if !live(sub.SubscriberID) || !live(sub.TargetID) {
		return false
	}
	if s.ended == nil {
		s.ended = map[string]Subscription{}
	}
	s.ended[sub.ID] = sub
	return true
}
