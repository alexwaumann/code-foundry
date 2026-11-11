package thread

import (
	"context"
	"slices"
	"testing"
	"time"
)

// Which wakes end a --notify subscription: a turn that ended plainly, with nothing of
// its own still running and no current blocked or failed report.
func TestFinishedTurn(t *testing.T) {
	started := time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)
	th := func(status Status, reason string) Thread {
		return Thread{State: StateConnected, Status: status, StatusReason: reason, TurnStartedAt: started}
	}
	report := func(t Thread, st ReportStatus, at time.Time) Thread {
		t.Report = Report{Status: st, Summary: "x", At: at}
		return t
	}
	finished := th(StatusNeedsAttention, "finished")
	current, stale := started.Add(time.Minute), started.Add(-time.Minute)
	tests := []struct {
		name string
		t    Thread
		kids wakeChildren
		want bool
	}{
		{"needs attention: finished", finished, wakeChildren{}, true},
		{"idle at prompt", th(StatusIdle, "at prompt"), wakeChildren{}, true},
		{"stopped idle", Thread{State: StateDisconnected, Status: StatusIdle, StatusReason: "at prompt"}, wakeChildren{}, true},
		{"done report", report(finished, ReportDone, current), wakeChildren{}, true},
		{"progress report", report(finished, ReportProgress, current), wakeChildren{}, true},
		{"the daemon's finished report", report(finished, ReportFinished, current), wakeChildren{}, true},
		{"a stale blocked report", report(finished, ReportBlocked, stale), wakeChildren{}, true},
		{"children all settled", finished, wakeChildren{Total: 2}, true},

		{"blocked report", report(finished, ReportBlocked, current), wakeChildren{}, false},
		{"failed report", report(finished, ReportFailed, current), wakeChildren{}, false},
		{"permission prompt", th(StatusNeedsAttention, "permission: Bash ls"), wakeChildren{}, false},
		{"question", th(StatusNeedsAttention, "question: Which?"), wakeChildren{}, false},
		{"turn error", th(StatusNeedsAttention, "error: 529"), wakeChildren{}, false},
		{"budget stop", th(StatusNeedsAttention, ReasonBudgetReached), wakeChildren{}, false},
		{"wake limit", th(StatusNeedsAttention, ReasonWakeLimit), wakeChildren{}, false},
		{"snooze ended", Thread{State: StateDisconnected, Status: StatusNeedsAttention, StatusReason: ReasonSnoozeEnded}, wakeChildren{}, false},
		{"interrupted", Thread{State: StateDisconnected, Status: StatusError, StatusReason: ReasonInterrupted}, wakeChildren{}, false},
		{"crashed", th(StatusError, "crashed"), wakeChildren{}, false},
		{"waiting on its child threads", th(StatusIdle, "waiting on 2 child threads"), wakeChildren{}, false},
		{"waiting on a shell", th(StatusIdle, "waiting on 1 shell"), wakeChildren{}, false},
		{"a child still works", finished, wakeChildren{Total: 2, Working: 1}, false},
		{"busy", th(StatusBusy, "working"), wakeChildren{}, false},
	}
	for _, tt := range tests {
		if got := finishedTurn(tt.t, tt.kids); got != tt.want {
			t.Errorf("%s: finishedTurn = %v, want %v", tt.name, got, tt.want)
		}
	}
}

// notifyEnv is a parent and a busy child the parent notifies on (thread new --notify).
type notifyEnv struct {
	*env
	parent, child Thread
	sub           string
}

func newNotifyEnv(t *testing.T, mutate ...func(*Options)) *notifyEnv {
	t.Helper()
	n := &notifyEnv{env: newEnv(t, mutate...)}
	n.parent, n.child = n.stopped("parent"), n.stopped("child")
	n.m.update(n.child.ID, false, func(rec *record) { rec.s.CreatedBy = n.parent.ID })
	n.setStep(n.child.ID, busy)
	n.m.notifyCreator(n.ctx(), n.parent.ID, n.child.ID, "", false)
	subs := n.subsOf(n.parent.ID)
	if len(subs) != 1 || !subs[0].UntilFinished() || !subs[0].Repeat {
		t.Fatalf("notify subscriptions = %+v", subs)
	}
	n.sub = subs[0].ID
	return n
}

func (e *env) subsOf(id string) []Subscription {
	e.t.Helper()
	subs, err := e.m.Subscriptions(e.ctx(), id)
	if err != nil {
		e.t.Fatal(err)
	}
	return subs
}

// ended is the ended records of subscriber about target.
func (e *env) ended(subscriber, target string) []Subscription {
	e.m.subs.mu.Lock()
	defer e.m.subs.mu.Unlock()
	var out []Subscription
	for _, s := range e.m.subs.ended {
		if s.SubscriberID == subscriber && s.TargetID == target {
			out = append(out, s)
		}
	}
	return out
}

// storedSubs are the rows of thread_subscriptions.
func (e *env) storedSubs() []Subscription {
	e.t.Helper()
	rows, err := loadSubscriptions(e.ctx(), e.m.opts.DB)
	if err != nil {
		e.t.Fatal(err)
	}
	return rows
}

func TestNotifyEndsOnFinish(t *testing.T) {
	errored := step{StateConnected, StatusNeedsAttention, "error: 529", ""}
	type act func(n *notifyEnv)
	to := func(s step) act { return func(n *notifyEnv) { n.setStep(n.child.ID, s) } }
	reported := func(st ReportStatus) act {
		return func(n *notifyEnv) {
			if _, err := n.m.Report(n.ctx(), n.child.ID, Report{Status: st, Summary: "why"}); err != nil {
				n.t.Fatal(err)
			}
		}
	}
	tests := []struct {
		name  string
		acts  []act
		wakes int
		ended bool
	}{
		{"a finished turn", []act{to(finished)}, 1, true},
		{"idle at prompt", []act{to(atPrompt)}, 1, true},
		{"a done report", []act{reported(ReportDone), to(finished)}, 1, true},
		{"a permission prompt", []act{to(askBash)}, 1, false},
		{"a question", []act{to(askWhich)}, 1, false},
		{"a crash", []act{to(crashed)}, 1, false},
		{"a turn error", []act{to(errored)}, 1, false},
		{"the budget stop", []act{to(budget)}, 1, false},
		{"a blocked report", []act{reported(ReportBlocked), to(finished)}, 1, false},
		{"a failed report", []act{reported(ReportFailed), to(finished)}, 1, false},
		{"a finish after a prompt", []act{to(askEdit), to(busy), to(finished)}, 2, true},
		{"a finish after a blocked report", []act{reported(ReportBlocked), to(finished), to(busy), reported(ReportDone), to(finished)}, 2, true},
		{"a permission chain, then the finish", []act{to(askEdit1), to(askEdit2), to(busy), to(finished)}, 3, true},
		// A prompt answered and the turn's end in one published change: the finish still
		// comes (a plain settled subscription sees no transition there).
		{"a prompt straight into the finish", []act{to(askEdit), to(finished)}, 2, true},
		{"a question straight into idle", []act{to(askWhich), to(atPrompt)}, 2, true},
		{"a prompt, then an error", []act{to(askEdit), to(errored)}, 1, false},
		// Ended with the first finish: the user's next turn in the child wakes nobody.
		{"turns after the finish", []act{to(finished), to(busy), to(finished), to(busy), to(atPrompt)}, 1, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			n := newNotifyEnv(t)
			for _, a := range tt.acts {
				a(n)
			}
			n.waitItems(n.parent.ID, "the wakes", func(items []Item) bool { return len(wakes(items)) == tt.wakes })
			_, kept := n.subscription(n.sub)
			if kept == tt.ended {
				t.Errorf("kept = %v, want ended %v", kept, tt.ended)
			}
			stored := n.storedSubs()
			if live := slices.ContainsFunc(stored, func(s Subscription) bool { return s.ID == n.sub }); live == tt.ended {
				t.Errorf("row kept = %v, want ended %v", live, tt.ended)
			}
			if got := len(n.ended(n.parent.ID, n.child.ID)); got != map[bool]int{true: 1}[tt.ended] {
				t.Errorf("%d ended records, want ended %v", got, tt.ended)
			}
			time.Sleep(50 * time.Millisecond)
			if got := len(wakes(n.items(n.parent.ID).Items)); got != tt.wakes {
				t.Errorf("%d wakes, want %d", got, tt.wakes)
			}
		})
	}
}

// The subscriber's send renews an ended --notify subscription, armed on its message:
// the child's answer wakes it once more. Nobody else's message does, nor one sent
// with NoNotify.
func TestNotifyRenewedBySend(t *testing.T) {
	tests := []struct {
		name  string
		msg   func(n *notifyEnv) Message
		renew bool
	}{
		{"the creator's send", func(n *notifyEnv) Message { return Message{Text: "more", ByThreadID: n.parent.ID} }, true},
		{"with NoNotify", func(n *notifyEnv) Message { return Message{Text: "more", ByThreadID: n.parent.ID, NoNotify: true} }, false},
		{"the user's message", func(n *notifyEnv) Message { return Message{Text: "more"} }, false},
		{"a wake", func(n *notifyEnv) Message {
			return Message{Text: "wake", ByThreadID: n.parent.ID, Origin: OriginWake, WakeTitle: "x"}
		}, false},
		{"another thread's send", func(n *notifyEnv) Message {
			return Message{Text: "more", ByThreadID: n.stopped("other").ID}
		}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			n := newNotifyEnv(t)
			// Stopped, as a finished child is once its process went idle: the send starts it.
			n.setStep(n.child.ID, step{StateDisconnected, StatusNeedsAttention, "finished", ""})
			n.waitItems(n.parent.ID, "the finish's wake", func(items []Item) bool { return len(wakes(items)) == 1 })
			if subs := n.subsOf(n.parent.ID); len(subs) != 0 {
				t.Fatalf("subscriptions after the finish = %+v", subs)
			}
			it, err := n.m.Send(n.ctx(), n.child.ID, tt.msg(n))
			if err != nil {
				t.Fatal(err)
			}
			n.waitFor(n.child.ID, "the answer's turn ended", func(s Thread) bool {
				return s.HandledThrough >= it.Ordinal && Meets(CondSettled, s)
			})
			want := 1
			if tt.renew {
				want = 2
			}
			n.waitItems(n.parent.ID, "the wakes", func(items []Item) bool { return len(wakes(items)) == want })
			time.Sleep(50 * time.Millisecond)
			if got := len(wakes(n.items(n.parent.ID).Items)); got != want {
				t.Errorf("%d wakes, want %d", got, want)
			}
			if subs := n.subsOf(n.parent.ID); len(subs) != 0 {
				t.Errorf("subscriptions after the answer = %+v", subs)
			}
			if got := len(n.ended(n.parent.ID, n.child.ID)); got != 1 {
				t.Errorf("%d ended records, want 1", got)
			}
		})
	}
}

// renotify on its own: the renewed subscription is the ended one's kind (its group
// too), armed on the message; a live one is left as it is, and does not end before the
// turn that handles the message.
func TestRenotify(t *testing.T) {
	t.Run("renews with the group, armed", func(t *testing.T) {
		b := newGroupEnv(t, 1)
		kid := b.kids[0].ID
		b.m.mu.Lock()
		b.m.subs.mu.Lock()
		b.m.subs.byID[b.subs[0]].s.Args[untilArg] = untilFinished
		b.m.subs.mu.Unlock()
		b.m.mu.Unlock()
		b.setStep(kid, finished)
		b.waitItems(b.parent.ID, "the wake", func(items []Item) bool { return len(wakes(items)) == 1 })
		b.m.renotify(b.ctx(), kid, Message{ByThreadID: b.parent.ID}, Item{Ordinal: 7})
		subs := b.subsOf(b.parent.ID)
		if len(subs) != 1 || subs[0].Group() != "g" || !subs[0].UntilFinished() || !subs[0].Repeat {
			t.Fatalf("renewed = %+v", subs)
		}
		if len(b.ended(b.parent.ID, kid)) != 0 {
			t.Errorf("the ended record is left")
		}
		// Armed: a settle before the message was handled does not fire.
		b.setStep(kid, busy)
		b.setStep(kid, finished)
		if n := b.quiet(); n != 1 {
			t.Fatalf("%d wakes before the message was handled", n)
		}
		b.setStep(kid, busy)
		b.m.update(kid, false, func(rec *record) { rec.s.HandledThrough = 7 })
		b.setStep(kid, finished)
		b.waitItems(b.parent.ID, "the answer's wake", func(items []Item) bool { return len(wakes(items)) == 2 })
		if subs := b.subsOf(b.parent.ID); len(subs) != 0 {
			t.Errorf("subscriptions after the answer = %+v", subs)
		}
	})
	t.Run("a live one waits for the message's turn", func(t *testing.T) {
		n := newNotifyEnv(t)
		n.m.renotify(n.ctx(), n.child.ID, Message{ByThreadID: n.parent.ID}, Item{Ordinal: 5})
		n.m.update(n.child.ID, false, func(rec *record) { rec.s.HandledThrough = 4 })
		n.setStep(n.child.ID, finished) // the turn before the message
		n.waitItems(n.parent.ID, "the wake", func(items []Item) bool { return len(wakes(items)) == 1 })
		if _, kept := n.subscription(n.sub); !kept {
			t.Fatal("ended before the turn that handles the message")
		}
		n.setStep(n.child.ID, busy)
		n.m.update(n.child.ID, false, func(rec *record) { rec.s.HandledThrough = 5 })
		n.setStep(n.child.ID, finished)
		n.waitItems(n.parent.ID, "the answer's wake", func(items []Item) bool { return len(wakes(items)) == 2 })
		if _, kept := n.subscription(n.sub); kept {
			t.Error("not ended by the answer's finish")
		}
	})
	t.Run("an explicit one is left alone", func(t *testing.T) {
		n := newNotifyEnv(t)
		// Subscribing explicitly makes the notify subscription an explicit one.
		res, err := n.m.Subscribe(n.ctx(), SubscribeOptions{SubscriberID: n.parent.ID, TargetThreadID: n.child.ID, Repeat: true})
		if err != nil || !res.Existed || res.Subscription.ID != n.sub || res.Subscription.UntilFinished() {
			t.Fatalf("explicit subscribe = %+v, %v", res, err)
		}
		n.m.renotify(n.ctx(), n.child.ID, Message{ByThreadID: n.parent.ID}, Item{Ordinal: 3})
		for range 2 {
			n.setStep(n.child.ID, finished)
			n.setStep(n.child.ID, busy)
		}
		n.waitItems(n.parent.ID, "the wakes", func(items []Item) bool { return len(wakes(items)) == 2 })
		if got := n.subsOf(n.parent.ID); len(got) != 1 || got[0].UntilFinished() || got[0].FiredCount != 2 {
			t.Errorf("subscriptions = %+v", got)
		}
		if rows := n.storedSubs(); len(rows) != 1 || rows[0].UntilFinished() {
			t.Errorf("stored = %+v", rows)
		}
	})
	t.Run("the answer came before the renewal", func(t *testing.T) {
		n := newNotifyEnv(t)
		n.setStep(n.child.ID, finished)
		n.waitItems(n.parent.ID, "the wake", func(items []Item) bool { return len(wakes(items)) == 1 })
		// The message's turn ended before renotify ran: it fires at once, and that finish
		// ends the renewed subscription too.
		n.setStep(n.child.ID, busy)
		n.m.update(n.child.ID, false, func(rec *record) { rec.s.HandledThrough = 9 })
		n.setStep(n.child.ID, finished)
		n.m.renotify(n.ctx(), n.child.ID, Message{ByThreadID: n.parent.ID}, Item{Ordinal: 9})
		n.waitItems(n.parent.ID, "the answer's wake", func(items []Item) bool { return len(wakes(items)) == 2 })
		if subs := n.subsOf(n.parent.ID); len(subs) != 0 {
			t.Errorf("subscriptions = %+v", subs)
		}
		if got := len(n.ended(n.parent.ID, n.child.ID)); got != 1 {
			t.Errorf("%d ended records, want 1", got)
		}
		if rows := n.storedSubs(); len(rows) != 1 || !isEnded(rows[0]) {
			t.Errorf("stored = %+v", rows)
		}
	})
	t.Run("no ended record, no subscription", func(t *testing.T) {
		e := newEnv(t)
		parent, child := e.stopped("parent"), e.stopped("child")
		e.m.update(child.ID, false, func(rec *record) { rec.s.CreatedBy = parent.ID })
		e.m.renotify(e.ctx(), child.ID, Message{ByThreadID: parent.ID}, Item{Ordinal: 1})
		if subs := e.subsOf(parent.ID); len(subs) != 0 {
			t.Errorf("a creator without --notify was subscribed: %+v", subs)
		}
	})
}

// A group's members end with the group's wake: one that finished while a sibling works
// is held (and listed) until the group settled, then all go together.
func TestNotifyGroupEnds(t *testing.T) {
	b := &batchEnv{env: newEnv(t, func(o *Options) { o.WakeBatch = 20 * time.Millisecond })}
	b.parent = b.stopped("parent")
	for i := range 2 {
		k := b.stopped("c" + string(rune('0'+i)))
		b.m.update(k.ID, false, func(rec *record) { rec.s.CreatedBy = b.parent.ID })
		b.setStep(k.ID, busy)
		b.m.notifyCreator(b.ctx(), b.parent.ID, k.ID, "g", false)
		b.kids = append(b.kids, k)
	}
	subs := b.subsOf(b.parent.ID)
	if len(subs) != 2 || subs[0].Group() != "g" || !subs[0].UntilFinished() {
		t.Fatalf("subscriptions = %+v", subs)
	}
	b.setStep(b.kids[0].ID, finished)
	if n := b.quiet(); n != 0 {
		t.Fatalf("%d wakes while a sibling works", n)
	}
	// Its subscription ended, its held wake is listed in its place.
	if got := b.subsOf(b.parent.ID); len(got) != 2 {
		t.Errorf("listed while held = %+v", got)
	}
	if len(b.ended(b.parent.ID, b.kids[0].ID)) != 1 {
		t.Errorf("no ended record for the held member")
	}
	b.setStep(b.kids[1].ID, finished)
	items := b.waitItems(b.parent.ID, "the group's wake", func(items []Item) bool { return len(wakes(items)) == 1 })
	if got := wakeSizes(t, items); len(got) != 1 || got[0] != 2 {
		t.Fatalf("wake sizes = %v, want one of 2", got)
	}
	if got := b.subsOf(b.parent.ID); len(got) != 0 {
		t.Errorf("subscriptions after the group's wake = %+v", got)
	}
}

// Ended records survive a restart (the stored args), and so does a live notify
// subscription's until; archiving the child forgets both.
func TestNotifyPersists(t *testing.T) {
	e := newEnv(t)
	parent, a, b := e.stopped("parent"), e.stopped("a"), e.stopped("b")
	for _, k := range []Thread{a, b} {
		e.m.update(k.ID, false, func(rec *record) { rec.s.CreatedBy = parent.ID })
		e.setStep(k.ID, busy)
		e.m.notifyCreator(e.ctx(), parent.ID, k.ID, "", false)
	}
	e.setStep(a.ID, finished)
	e.waitItems(parent.ID, "a's wake", func(items []Item) bool { return len(wakes(items)) == 1 })
	e.restart()
	if subs := e.subsOf(parent.ID); len(subs) != 1 || subs[0].TargetID != b.ID || !subs[0].UntilFinished() {
		t.Fatalf("after the restart = %+v", subs)
	}
	if len(e.ended(parent.ID, a.ID)) != 1 {
		t.Fatalf("the ended record did not survive the restart")
	}
	e.m.renotify(e.ctx(), a.ID, Message{ByThreadID: parent.ID}, Item{Ordinal: 1})
	if subs := e.subsOf(parent.ID); len(subs) != 2 {
		t.Fatalf("not renewed after the restart: %+v", subs)
	}
	// Archive cleans up the live subscriptions and the records.
	e.setStep(b.ID, busy) // the restart left it interrupted
	e.setStep(b.ID, finished)
	e.waitItems(parent.ID, "b's wake", func(items []Item) bool { return len(wakes(items)) == 2 })
	if len(e.ended(parent.ID, b.ID)) != 1 {
		t.Fatalf("b's ended record missing")
	}
	for _, k := range []Thread{a, b} {
		e.setStep(k.ID, offIdle) // no process: the archive closes nothing
		if _, err := e.m.Archive(e.ctx(), k.ID, true); err != nil {
			t.Fatal(err)
		}
	}
	if subs := e.subsOf(parent.ID); len(subs) != 0 {
		t.Errorf("after the archive = %+v", subs)
	}
	if rows := e.storedSubs(); len(rows) != 0 {
		t.Errorf("rows after the archive = %+v", rows)
	}
	if len(e.ended(parent.ID, a.ID))+len(e.ended(parent.ID, b.ID)) != 0 {
		t.Errorf("ended records left after the archive")
	}
}

// A finish the wake limit dropped is no wake: the subscription stays, so the next
// finish (or the next transition) still reaches the subscriber.
func TestNotifyFinishDroppedByTheWakeLimit(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.WakeLimit = 1 })
	parent, a, b := e.stopped("parent"), e.stopped("a"), e.stopped("b")
	for _, k := range []Thread{a, b} {
		e.m.update(k.ID, false, func(rec *record) { rec.s.CreatedBy = parent.ID })
		e.setStep(k.ID, busy)
		e.m.notifyCreator(e.ctx(), parent.ID, k.ID, "", false)
	}
	e.setStep(a.ID, finished)
	e.waitItems(parent.ID, "a's wake", func(items []Item) bool { return len(wakes(items)) == 1 })
	e.setStep(b.ID, finished) // over the limit: dropped
	subs := e.subsOf(parent.ID)
	if len(subs) != 1 || subs[0].TargetID != b.ID || subs[0].FiredCount != 0 {
		t.Fatalf("after the dropped finish = %+v", subs)
	}
	if len(e.ended(parent.ID, b.ID)) != 0 {
		t.Errorf("a dropped finish ended the subscription")
	}
}

// Ember's workers (notify-repeat) keep today's subscription: every settle, until archived.
func TestNotifyRepeatNeverEnds(t *testing.T) {
	e := newEnv(t)
	parent, child := e.stopped("parent"), e.stopped("child")
	e.setStep(child.ID, busy)
	e.m.notifyCreator(context.Background(), parent.ID, child.ID, "", true)
	for range 2 {
		e.setStep(child.ID, finished)
		e.setStep(child.ID, busy)
	}
	e.waitItems(parent.ID, "the wakes", func(items []Item) bool { return len(wakes(items)) == 2 })
	if subs := e.subsOf(parent.ID); len(subs) != 1 || subs[0].UntilFinished() || subs[0].FiredCount != 2 {
		t.Errorf("subscriptions = %+v", subs)
	}
}
