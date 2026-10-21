package thread

import (
	"cmp"
	"context"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Wakes across a daemon restart (docs/notes/orch-restart-wakes.md).
//
// A daemon that stops takes its threads' processes with it: a child busy at the stop
// ends "error (interrupted)", disconnected "daemon stopped", and the settle that would
// wake its parent comes while the Manager is closed, so it is not sent
// (fireLaterLocked). Nothing after the start would send it either: the subscriptions
// are armed with the targets as loaded. So:
//
//   - a thread wake the stop suppressed is recorded on its subscription (SuppressedAt,
//     suppressLocked), and DeliverRestartWakes sends it once the daemon is up;
//   - a subscription whose target the stop (or a crash: "daemon restarted") left
//     interrupted, and that has not fired since, fires then too; a crash records
//     nothing at its stop;
//   - a subscription whose target the daemon's death cut after its final report
//     (restartcut.go: loaded finished, not interrupted) fires then too;
//   - each subscriber that gets one of those, or whose own turn the stop cut, is told
//     the app restarted, which of the threads it watches were interrupted, and how many
//     subscriptions it holds. The notice goes first, the thread wakes after it, as one
//     message (the batch path; one wake limit slot);
//   - a thread whose own turn the stop cut while it worked on the user's message gets
//     the notice too, subscriptions or not, unless a subscriber hears about it (that
//     one resumes it): the notice quotes the message it was handling
//     (restartWakes.selfOnly, checked when sent):
//
//	[code-foundry wake] The app restarted at 10:45 CDT; 2 of your child threads were interrupted: "Tests" (s-1), "Docs" (s-2); their sessions resume on your next send. 2 threads interrupted: Thread "Tests" (s-1) was interrupted when the app stopped. Report: progress — halfway. Thread "Docs" (s-2) was interrupted when the app stopped.
//	```json
//	{ "kind": "batch", "wakes": [ { "kind": "restart", "restarted_at": "…", "interrupted": [ … ], "subscriptions": 2 }, { "kind": "thread", "after_restart": true, … }, … ] }
//	```
//
// A subscriber with nothing to hear (its targets at rest, pull request and plugin
// subscriptions, which go on by themselves) and no cut turn of its own gets no restart
// wake: every app update would otherwise start a turn in every thread that ever used
// --notify, on a cold cache.

// restartWakes is what a restart sends one subscriber: the notice and the thread wakes
// that go with it (built when sent, like any thread wake).
type restartWakes struct {
	notice restartNotice
	parts  []func(context.Context) threadWakePart
	subs   []string // the parts' subscriptions, for the log
	// selfOnly: the notice is only about the subscriber's own cut turn (it holds no
	// subscription that fired); it goes only when that turn was the user's message.
	selfOnly bool
}

// restartNotice is the restart's own line: when, the watched threads the stop
// interrupted, the subscriber's live subscriptions, and whether its own turn was cut.
type restartNotice struct {
	at            time.Time
	interrupted   []Thread
	subscriptions int
	self          bool
	// message is the user's message the cut turn was handling (one line, cut at
	// maxRestartMessage runes); "" when the turn was a wake's, or unknown. Set when sent.
	message string
}

// maxRestartMessage bounds the user's message a restart notice quotes.
const maxRestartMessage = 200

// wakeRestartPayload is a restart notice's JSON.
type wakeRestartPayload struct {
	Kind          string            `json:"kind"` // "restart"
	RestartedAt   string            `json:"restarted_at"`
	Interrupted   []wakeInterrupted `json:"interrupted"`
	Subscriptions int               `json:"subscriptions"`
	// OwnTurnInterrupted: the subscriber was working when the app stopped;
	// OwnTurnMessage the user's message that turn was handling, when it was one.
	OwnTurnInterrupted bool   `json:"own_turn_interrupted,omitempty"`
	OwnTurnMessage     string `json:"own_turn_message,omitempty"`
}

type wakeInterrupted struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Reason string `json:"reason"` // the disconnect reason: "daemon stopped", "daemon restarted"
}

// interruptedByStop reports whether t's turn was cut by the daemon stopping (or dying):
// stopped, error "interrupted", disconnected "daemon stopped" or "daemon restarted".
func interruptedByStop(t Thread) bool {
	return t.State == StateDisconnected && t.Status == StatusError && t.StatusReason == ReasonInterrupted &&
		(t.DisconnectReason == ReasonDaemonStopped || t.DisconnectReason == ReasonDaemonRestarts)
}

// firesOnInterrupt reports whether a subscription with condition c hears that its
// target was interrupted by a stop: the conditions about a turn ending.
func firesOnInterrupt(c Condition) bool {
	return c == CondSettled || c == CondIdle || c == CondAttention || c == CondError
}

// suppressLocked records a thread wake the stopping daemon does not send, for the next
// start. Callers hold m.mu and m.subs.mu.
func (m *Manager) suppressLocked(r *subRec, now time.Time) {
	if r.s.TargetKind != TargetThread {
		m.log.Info("wake not fired: the daemon is stopping", "thread", r.s.SubscriberID, "subscription", r.s.ID)
		return
	}
	if r.s.SuppressedAt.IsZero() {
		r.s.SuppressedAt = now
	}
	if err := saveSubscription(context.Background(), m.subs.db, r.s); err != nil {
		m.log.Error("persist a wake the stop suppressed", "subscription", r.s.ID, "err", err)
	}
	m.log.Info("wake not fired: the daemon is stopping; it goes at the next start", "thread", r.s.SubscriberID,
		"subscription", r.s.ID, "target", r.s.TargetID, "condition", r.s.Condition)
}

// restartFire is one thread wake a restart sends: subscription sub about target t, as
// fired at (when the stop suppressed it, or when the target was interrupted).
type restartFire struct {
	sub     string
	t       Thread
	at      time.Time
	stopped bool // t was interrupted by the stop
}

// restartPlan is what a restart sends one subscriber.
type restartPlan struct {
	subscriber string
	notice     restartNotice
	fires      []restartFire
	// selfOnly: a notice about its own cut turn alone, for a thread no other plan
	// covers (restartWakes.selfOnly).
	selfOnly bool
}

// restartInput is what planRestartWakes plans from.
type restartInput struct {
	subs []Subscription
	// thread is a live thread (not archived or going) as loaded; false otherwise.
	thread func(string) (Thread, bool)
	// reported are the threads the daemon's death cut after their final report
	// (restartcut.go): loaded finished, their settle never fired.
	reported map[string]bool
	// cut are the live threads whose own turn the stop cut (interruptedByStop), ids
	// sorted: those with no plan otherwise get a notice alone (selfOnly).
	cut []string
}

// planRestartWakes decides the restart's wakes from in, at now. A subscription fires
// when the stop suppressed its wake and its target still meets the condition or was
// interrupted, or (none suppressed) when its target was interrupted by a stop, or cut
// after its final report (in.reported) and meets the condition, after the subscription
// last fired; one fire per subscriber and target, the oldest subscription's. A
// subscriber gets a plan when it has a fire or the stop cut its own turn. A thread in
// in.cut with no plan of its own, about which no subscription fires, whose first message
// went out (no PendingFirst), gets a selfOnly plan. clear are the suppressed
// subscriptions, whether they fire or not.
func planRestartWakes(in restartInput, now time.Time) (plans []restartPlan, clear []string) {
	subs, thread := slices.Clone(in.subs), in.thread
	slices.SortFunc(subs, func(a, b Subscription) int {
		return cmp.Or(a.CreatedAt.Compare(b.CreatedAt), strings.Compare(a.ID, b.ID))
	})
	held := map[string]int{}
	fired := map[[2]string]bool{}
	var fires = map[string][]restartFire{}
	for _, sub := range subs {
		if !sub.SuppressedAt.IsZero() {
			clear = append(clear, sub.ID)
		}
		if _, ok := thread(sub.SubscriberID); !ok {
			continue
		}
		held[sub.SubscriberID]++
		if sub.TargetKind != TargetThread {
			continue
		}
		t, ok := thread(sub.TargetID)
		if !ok {
			continue
		}
		stopped := interruptedByStop(t)
		var at time.Time
		switch {
		case !sub.SuppressedAt.IsZero() && (stopped || Meets(sub.Condition, t)):
			at = sub.SuppressedAt
		case sub.SuppressedAt.IsZero() && stopped && firesOnInterrupt(sub.Condition) && t.StatusChangedAt.After(sub.LastFiredAt):
			at = t.StatusChangedAt
		case sub.SuppressedAt.IsZero() && in.reported[t.ID] && Meets(sub.Condition, t) && t.StatusChangedAt.After(sub.LastFiredAt):
			at = t.StatusChangedAt
		default:
			continue
		}
		key := [2]string{sub.SubscriberID, t.ID}
		if fired[key] {
			continue
		}
		fired[key] = true
		fires[sub.SubscriberID] = append(fires[sub.SubscriberID], restartFire{sub: sub.ID, t: t, at: at, stopped: stopped})
	}
	ids := make([]string, 0, len(held))
	for id := range held {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	for _, id := range ids {
		s, _ := thread(id)
		p := restartPlan{subscriber: id, fires: fires[id],
			notice: restartNotice{at: now, subscriptions: held[id], self: interruptedByStop(s)}}
		for _, f := range p.fires {
			if f.stopped {
				p.notice.interrupted = append(p.notice.interrupted, f.t)
			}
		}
		if len(p.fires) > 0 || p.notice.self {
			plans = append(plans, p)
		}
	}
	told := map[string]bool{} // threads a subscriber hears about
	for key := range fired {
		told[key[1]] = true
	}
	for _, id := range in.cut {
		s, ok := thread(id)
		if !ok || told[id] || s.PendingFirst != nil || !interruptedByStop(s) ||
			slices.ContainsFunc(plans, func(p restartPlan) bool { return p.subscriber == id }) {
			continue
		}
		plans = append(plans, restartPlan{subscriber: id, selfOnly: true,
			notice: restartNotice{at: now, subscriptions: held[id], self: true}})
	}
	return plans, clear
}

// DeliverRestartWakes sends the wakes a daemon restart owes (planRestartWakes): the
// daemon calls it once, when it is up (the store loaded, every thread stopped as the
// last stop left it, the API serving). Later calls do nothing.
func (m *Manager) DeliverRestartWakes() {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.subs
	s.mu.Lock()
	defer s.mu.Unlock()
	if m.closed || s.restarted {
		return
	}
	s.restarted = true
	now := m.opts.Now().Round(0).Truncate(time.Millisecond)
	all := make([]Subscription, 0, len(s.byID))
	for _, r := range s.byID {
		all = append(all, r.s)
	}
	live := func(id string) (Thread, bool) {
		rec, ok := m.recs[id]
		if !ok || !rec.s.ArchivedAt.IsZero() || rec.s.Removing || rec.s.State == StateClosing {
			return Thread{}, false
		}
		return rec.s, true
	}
	var cut []string
	for id, rec := range m.recs {
		if t, ok := live(id); ok && interruptedByStop(t) {
			cut = append(cut, rec.s.ID)
		}
	}
	slices.Sort(cut)
	plans, clear := planRestartWakes(restartInput{subs: all, thread: live, reported: s.reportedAtStop, cut: cut}, now)
	s.reportedAtStop = nil
	for _, p := range plans {
		if !s.allowLocked(p.subscriber, now, m.opts.WakeLimit) {
			m.log.Warn("restart wake dropped: the subscriber reached the wake limit", "thread", p.subscriber)
			continue
		}
		rw := &restartWakes{notice: p.notice, selfOnly: p.selfOnly}
		for _, f := range p.fires {
			r := s.byID[f.sub]
			r.s.FiredCount++
			r.s.LastFiredAt = now
			r.s.SuppressedAt = time.Time{}
			sub, t, at, stopped, kids := r.s, f.t, f.at, f.stopped, m.childrenLocked(f.t.ID)
			rw.parts = append(rw.parts, func(ctx context.Context) threadWakePart {
				p := m.threadPart(ctx, sub, t, at, kids)
				p.d.afterRestart, p.d.appStopped = true, stopped
				return p
			})
			rw.subs = append(rw.subs, sub.ID)
			m.log.Info("wake subscription fired after the restart", "subscription", sub.ID, "subscriber", p.subscriber,
				"target", t.ID, "condition", sub.Condition, "interrupted", stopped, "fired_count", sub.FiredCount)
			s.firedLocked(r)
		}
		m.enqueueLocked(p.subscriber, delivery{restart: rw, queued: time.Now(), slot: now})
		m.log.Info("restart wake queued", "thread", p.subscriber, "interrupted", len(p.notice.interrupted),
			"wakes", len(p.fires), "own_turn_interrupted", p.notice.self, "subscriptions", p.notice.subscriptions,
			"own_turn_only", p.selfOnly)
	}
	for _, id := range clear {
		if r, ok := s.byID[id]; ok && !r.s.SuppressedAt.IsZero() {
			r.s.SuppressedAt = time.Time{}
			if err := saveSubscription(context.Background(), s.db, r.s); err != nil {
				m.log.Error("clear a suppressed wake", "subscription", id, "err", err)
			}
		}
	}
}

// keepLive drops what a restart's wakes say about threads archived or removed since
// they were planned: the parts about them and their names in the notice. It reports
// whether anything is left to say: a selfOnly notice only when its cut turn was the
// user's message (message, set by ownTurn).
func (rw *restartWakes) keepLive(snap *Snapshot, parts []threadWakePart) ([]threadWakePart, bool) {
	live := func(id string) bool {
		t, ok := snap.Thread(id)
		return ok && t.ArchivedAt.IsZero() && !t.Removing
	}
	parts = slices.DeleteFunc(parts, func(p threadWakePart) bool { return !live(p.t.ID) })
	rw.notice.interrupted = slices.DeleteFunc(rw.notice.interrupted, func(t Thread) bool { return !live(t.ID) })
	if rw.selfOnly {
		return parts, rw.notice.message != ""
	}
	return parts, len(parts) > 0 || len(rw.notice.interrupted) > 0 || rw.notice.self
}

// ownTurn sets the notice's message from the subscriber's items when its own turn was
// cut: the user's message that turn was handling (its last top-level user message, when
// that is not a wake). Read when sent, off the locks.
func (rw *restartWakes) ownTurn(items []Item) {
	if !rw.notice.self {
		return
	}
	if last, ok := lastUserMessage(items); ok && last.Origin == OriginUser {
		rw.notice.message = oneLine(last.Text, maxRestartMessage)
	}
}

// restartLine is the notice's header sentence: "The app restarted at 10:45 CDT; 2 of
// your child threads were interrupted: "A" (s-1), "B" (s-2); their sessions resume on
// your next send." With "; your own turn was interrupted" when it was, and "while
// handling the user's message: "…"" when the turn was one; a thread with no
// subscriptions hears nothing about child threads.
func restartLine(n restartNotice) string {
	line := "The app restarted at " + n.at.Format("15:04 MST")
	if n.self {
		line += "; your own turn was interrupted"
		if n.message != "" {
			line += " while handling the user's message: " + strconv.Quote(n.message)
		}
	}
	switch len(n.interrupted) {
	case 0:
		if n.subscriptions == 0 {
			return line + "."
		}
		return line + "; none of your child threads were interrupted."
	case 1:
		t := n.interrupted[0]
		return line + "; 1 of your child threads was interrupted: " + siblingLabel(t.ID, t.Name) + "; its session resumes on your next send."
	}
	names := make([]string, 0, len(n.interrupted))
	for _, t := range n.interrupted {
		names = append(names, siblingLabel(t.ID, t.Name))
	}
	return line + "; " + strconv.Itoa(len(n.interrupted)) + " of your child threads were interrupted: " + listNames(names) +
		"; their sessions resume on your next send."
}

// restartPayload is the notice's JSON.
func restartPayload(n restartNotice) wakeRestartPayload {
	p := wakeRestartPayload{Kind: "restart", RestartedAt: wakeTime(n.at), Interrupted: []wakeInterrupted{},
		Subscriptions: n.subscriptions, OwnTurnInterrupted: n.self, OwnTurnMessage: n.message}
	for _, t := range n.interrupted {
		p.Interrupted = append(p.Interrupted, wakeInterrupted{ID: t.ID, Name: t.Name, Reason: t.DisconnectReason})
	}
	return p
}

// restartWake is the one message of a restart notice and the thread wakes after it:
// the notice's line first, then the thread wakes' header (batchWake's, without the
// siblings sentence: every child is stopped after a restart); the JSON is the notice's
// alone, or a batch with the notice first.
func restartWake(n restartNotice, parts []threadWakePart) Message {
	if len(parts) == 0 {
		return wakeMessage(restartLine(n), restartPayload(n))
	}
	var head string
	if len(parts) == 1 {
		p := parts[0]
		head = threadWakeTitle(p.sub.Condition, p.t, p.d)
	} else {
		head, _ = batchHeader(parts)
	}
	wakes := []any{restartPayload(n)}
	for _, p := range parts {
		wakes = append(wakes, threadWakePayload(p.sub, p.t, p.at, p.d))
	}
	return wakeMessage(restartLine(n)+" "+head, wakeBatchPayload{Kind: "batch", Wakes: wakes})
}
