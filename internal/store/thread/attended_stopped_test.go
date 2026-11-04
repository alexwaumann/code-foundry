package thread

import (
	"testing"
	"time"
)

// setSaved gives a stopped thread a status, persisted.
func (e *env) setSaved(id string, st Status, reason string) {
	e.t.Helper()
	if _, ok := e.m.update(id, true, func(rec *record) { rec.s.Status, rec.s.StatusReason = st, reason }); !ok {
		e.t.Fatalf("no thread %s", id)
	}
}

// Every saved status against every way a stopped thread may or may not be seen: what
// the runner's acknowledge clears goes, for good; anything else stays.
func TestStoppedSeenStatuses(t *testing.T) {
	statuses := []struct {
		st      Status
		reason  string
		cleared bool
	}{
		{StatusNeedsAttention, "finished", true},
		{StatusNeedsAttention, "error: 529", true},
		{StatusNeedsAttention, "error: error_max_turns", true},
		{StatusNeedsAttention, ReasonBudgetReached, true},
		{StatusNeedsAttention, ReasonWakeLimit, true},
		{StatusNeedsAttention, "permission: Bash ls", false},
		{StatusNeedsAttention, "permission: ExitPlanMode", false},
		{StatusNeedsAttention, "question: Which one?", false},
		{StatusNeedsAttention, ReasonSnoozeEnded, false},
		{StatusError, ReasonInterrupted, false},
		{StatusError, ReasonCrashed, false},
		{StatusIdle, "at prompt", false},
		{StatusIdle, ReasonArchived, false},
	}
	tests := []struct {
		name     string
		attended bool
		act      func(t *testing.T, e *env, setAtt func(bool), ids []string)
		seen     bool
	}{
		{"viewer opens while attended", true, func(t *testing.T, e *env, _ func(bool), ids []string) {
			for _, id := range ids {
				openViewer(t, e, id)
			}
		}, true},
		{"viewer opens while away", false, func(t *testing.T, e *env, _ func(bool), ids []string) {
			for _, id := range ids {
				openViewer(t, e, id)
			}
		}, false},
		{"user returns with a viewer open", false, func(t *testing.T, e *env, setAtt func(bool), ids []string) {
			for _, id := range ids {
				openViewer(t, e, id)
			}
			setAtt(true)
		}, true},
		{"user returns with no viewer", false, func(_ *testing.T, _ *env, setAtt func(bool), _ []string) {
			setAtt(true)
		}, false},
		{"attended, no viewer", true, func(*testing.T, *env, func(bool), []string) {}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, att := attendedEnv(t, tt.attended)
			ids := make([]string, len(statuses))
			for i, s := range statuses {
				ids[i] = e.stopped(s.reason).ID
				e.setSaved(ids[i], s.st, s.reason)
			}
			tt.act(t, e, func(v bool) { setAttended(e, att, v) }, ids)
			check := func(when string) {
				t.Helper()
				for i, s := range statuses {
					wantSt, wantReason := s.st, s.reason
					if tt.seen && s.cleared {
						wantSt, wantReason = StatusIdle, "at prompt"
					}
					got, err := e.m.Get(e.ctx(), ids[i])
					if err != nil {
						t.Fatal(err)
					}
					if got.Status != wantSt || got.StatusReason != wantReason {
						t.Errorf("%s: %s %q is %s %q, want %s %q", when, s.st, s.reason, got.Status, got.StatusReason, wantSt, wantReason)
					}
				}
			}
			check("now")
			e.restart()
			check("after a restart")
		})
	}
}

// The overlay stays: a stopped thread shown waiting keeps showing it, with its stamp,
// and only its raw status is seen. What it falls back to says so.
func TestStoppedSeenWaiting(t *testing.T) {
	tests := []struct {
		name     string
		attended bool
		want     func(Thread) bool
	}{
		{"attended: the finished turn under the overlay is seen", true, isIdleStatus},
		{"away: it stays finished", false, isFinishedStatus},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, _ := attendedEnv(t, tt.attended)
			parent, child := e.stopped("parent"), e.stopped("child")
			e.setStep(child.ID, step{StateConnected, StatusBusy, "working", ""})
			e.setSaved(parent.ID, StatusNeedsAttention, "finished")
			res, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetThreadID: child.ID, Repeat: true})
			if err != nil {
				t.Fatal(err)
			}
			before := e.waitFor(parent.ID, "waiting", func(s Thread) bool { return s.StatusReason == waitingReason(1) })
			openViewer(t, e, parent.ID)
			got, err := e.m.Get(e.ctx(), parent.ID)
			if err != nil {
				t.Fatal(err)
			}
			if got.Status != StatusIdle || got.StatusReason != waitingReason(1) || !got.StatusChangedAt.Equal(before.StatusChangedAt) {
				t.Errorf("with a viewer: %s %q at %s, want it as it was at %s", got.Status, got.StatusReason, got.StatusChangedAt, before.StatusChangedAt)
			}
			if _, err := e.m.Unsubscribe(e.ctx(), UnsubscribeOptions{ID: res.Subscription.ID}); err != nil {
				t.Fatal(err)
			}
			e.waitFor(parent.ID, "the status under the overlay", tt.want)
		})
	}
}

// A turn a timer started shows finished over the overlay; once seen it waits again
// (waiting_reminder.go), stopped or not.
func TestStoppedSeenReminderWaits(t *testing.T) {
	e, _ := attendedEnv(t, true)
	parent, child := e.stopped("parent"), e.stopped("child")
	e.setStep(child.ID, step{StateConnected, StatusBusy, "working", ""})
	e.m.update(parent.ID, true, func(rec *record) {
		rec.wait.reminder = true
		rec.s.Status, rec.s.StatusReason = StatusNeedsAttention, "finished"
	})
	if _, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetThreadID: child.ID, Repeat: true}); err != nil {
		t.Fatal(err)
	}
	if got, _ := e.m.Get(e.ctx(), parent.ID); !isFinishedStatus(got) {
		t.Fatalf("before the viewer: %s %q, want finished", got.Status, got.StatusReason)
	}
	openViewer(t, e, parent.ID)
	e.waitFor(parent.ID, "waiting", func(s Thread) bool { return s.StatusReason == waitingReason(1) })
}

// Seeing a stopped thread is no transition into a condition: a repeating subscription
// to it does not fire, and its subscriber gets no wake.
func TestStoppedSeenFiresNoWake(t *testing.T) {
	reasons := []string{"finished", "error: 529", ReasonBudgetReached, ReasonWakeLimit}
	for _, cond := range []Condition{CondSettled, CondIdle, CondAttention, CondError, CondDisconnected} {
		for _, reason := range reasons {
			t.Run(string(cond)+" "+reason, func(t *testing.T) {
				e, _ := attendedEnv(t, true)
				target, subscriber := e.stopped("target"), e.stopped("subscriber")
				e.setSaved(target.ID, StatusNeedsAttention, reason)
				res, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: subscriber.ID, TargetThreadID: target.ID, Condition: cond, Repeat: true})
				if err != nil {
					t.Fatal(err)
				}
				// The subscribe's own wake, when the target met the condition already.
				fired := 0
				if res.Fired {
					fired = 1
					e.waitItems(subscriber.ID, "the first wake", func(items []Item) bool { return len(wakes(items)) == 1 })
					e.waitFor(subscriber.ID, "the wake's turn", func(s Thread) bool { return s.Status != StatusBusy && s.Status != StatusUnknown })
				}
				openViewer(t, e, target.ID)
				e.waitFor(target.ID, "seen", isIdleStatus)
				time.Sleep(settle)
				if got, _ := e.subscription(res.Subscription.ID); got.FiredCount != fired {
					t.Errorf("fired %d times, want %d", got.FiredCount, fired)
				}
				if n := len(wakes(e.items(subscriber.ID).Items)); n != fired {
					t.Errorf("%d wakes, want %d", n, fired)
				}
			})
		}
	}
}

// The subscriber side of what a seen status changes: a turn error does not wait, the
// same thread at its prompt does, so a thread subscribed to it follows, exactly as
// when a running thread's error is seen.
func TestStoppedSeenRewaitsSubscribers(t *testing.T) {
	e, _ := attendedEnv(t, true)
	p, lead, w := e.stopped("p"), e.stopped("lead"), e.stopped("w")
	e.setStep(w.ID, step{StateConnected, StatusBusy, "working", ""})
	e.setStep(lead.ID, step{StateConnected, StatusBusy, "working", ""})
	for _, s := range [][2]string{{p.ID, lead.ID}, {lead.ID, w.ID}} {
		if _, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: s[0], TargetThreadID: s[1], Condition: CondSettled, Repeat: true}); err != nil {
			t.Fatal(err)
		}
	}
	e.setSaved(p.ID, StatusIdle, "at prompt")
	e.setStep(lead.ID, step{StateDisconnected, StatusNeedsAttention, "error: 529", ""})
	e.waitFor(lead.ID, "the error", func(s Thread) bool { return s.StatusReason == "error: 529" })
	openViewer(t, e, lead.ID)
	e.waitFor(lead.ID, "waiting", func(s Thread) bool { return s.StatusReason == waitingReason(1) })
	e.waitFor(p.ID, "waiting on the lead", func(s Thread) bool { return s.StatusReason == waitingReason(1) })
}
