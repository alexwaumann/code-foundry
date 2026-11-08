package thread

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// newGroupEnv is n children of one parent in wake group g, all working.
func newGroupEnv(t *testing.T, n int) *batchEnv {
	t.Helper()
	b := &batchEnv{env: newEnv(t, func(o *Options) { o.WakeBatch = 20 * time.Millisecond })}
	b.parent = b.stopped("parent")
	for i := range n {
		k := b.stopped("c" + string(rune('0'+i)))
		b.m.update(k.ID, false, func(rec *record) { rec.s.CreatedBy = b.parent.ID })
		b.setStep(k.ID, busy)
		res, err := b.m.Subscribe(b.ctx(), SubscribeOptions{SubscriberID: b.parent.ID, TargetThreadID: k.ID, Repeat: true, Group: "g"})
		if err != nil {
			t.Fatal(err)
		}
		k, _ = b.m.Snapshot().Thread(k.ID)
		b.kids, b.subs = append(b.kids, k), append(b.subs, res.Subscription.ID)
	}
	return b
}

// quiet waits out a batch window and says how many wake messages the parent got.
func (b *batchEnv) quiet() int {
	time.Sleep(120 * time.Millisecond)
	return len(wakes(b.items(b.parent.ID).Items))
}

func TestGroupWakeWaitsForTheLastThread(t *testing.T) {
	b := newGroupEnv(t, 3)
	b.setStep(b.kids[0].ID, finished)
	b.setStep(b.kids[1].ID, finished)
	if n := b.quiet(); n != 0 {
		t.Fatalf("%d wakes while one works", n)
	}
	b.setStep(b.kids[2].ID, finished)
	items := b.waitItems(b.parent.ID, "the group's wake", func(items []Item) bool { return len(wakes(items)) > 0 })
	if got := wakeSizes(t, items); len(got) != 1 || got[0] != 3 {
		t.Fatalf("wake sizes = %v, want one of 3:\n%s", got, describeItems(items))
	}
	// After that a follow-up to one child wakes on its own: the group is not working.
	b.setStep(b.kids[1].ID, busy)
	b.setStep(b.kids[1].ID, finished)
	b.waitItems(b.parent.ID, "the follow-up's wake", func(items []Item) bool { return len(wakes(items)) == 2 })
}

// What needs the parent does not wait, and does not let the others go.
func TestGroupWakeComesAtOnceWhenNeeded(t *testing.T) {
	tests := []struct {
		name string
		do   func(b *batchEnv, id string)
	}{
		{"a prompt", func(b *batchEnv, id string) {
			b.putItems(id, Item{ID: "p1", Kind: KindPermission, Request: &Request{RequestID: "r1", ToolName: "Bash", State: RequestPending, InputJSON: `{}`}})
			b.setStep(id, step{st: StateConnected, status: StatusNeedsAttention, reason: "permission: Bash x", req: "r1"})
		}},
		{"an error", func(b *batchEnv, id string) {
			b.setStep(id, step{st: StateConnected, status: StatusError, reason: "error: boom"})
		}},
		{"a blocked report", func(b *batchEnv, id string) {
			if _, err := b.m.Report(b.ctx(), id, Report{Status: ReportBlocked, Summary: "no key"}); err != nil {
				b.t.Fatal(err)
			}
			b.setStep(id, finished)
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			b := newGroupEnv(t, 2)
			tt.do(b, b.kids[0].ID)
			items := b.waitItems(b.parent.ID, "the wake", func(items []Item) bool { return len(wakes(items)) == 1 })
			if w := wakes(items)[0]; !strings.Contains(w.WakeTitle, b.kids[0].ID) {
				t.Errorf("wake = %s", w.WakeTitle)
			}
		})
	}
}

// The held wakes never strand: whatever stops the last working thread lets them go.
func TestGroupWakeReleasedWhenTheLastThreadStopsWorking(t *testing.T) {
	tests := []struct {
		name string
		end  func(b *batchEnv, id string)
		want int // threads in the wakes
	}{
		{"it errors", func(b *batchEnv, id string) {
			b.setStep(id, step{st: StateConnected, status: StatusError, reason: "error: boom"})
		}, 2},
		{"it is archived", func(b *batchEnv, id string) {
			b.m.update(id, false, func(rec *record) { rec.s.ArchivedAt = time.Now() })
		}, 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			b := newGroupEnv(t, 2)
			b.setStep(b.kids[0].ID, finished)
			if n := b.quiet(); n != 0 {
				t.Fatalf("%d wakes while one works", n)
			}
			tt.end(b, b.kids[1].ID)
			items := b.waitItems(b.parent.ID, "the held wake", func(items []Item) bool { return sum(wakeSizes(t, items)) >= tt.want })
			if !strings.Contains(strings.Join(titlesOf(wakes(items)), " "), b.kids[0].ID) {
				t.Errorf("the held thread's wake did not come:\n%s", describeItems(items))
			}
		})
	}
}

func titlesOf(ws []Item) []string {
	var out []string
	for _, w := range ws {
		out = append(out, w.WakeTitle)
	}
	return out
}

func TestGroupWakeForgotten(t *testing.T) {
	b := newGroupEnv(t, 2)
	b.setStep(b.kids[0].ID, finished)
	if n := b.quiet(); n != 0 {
		t.Fatalf("%d wakes", n)
	}
	if _, err := b.m.Unsubscribe(b.ctx(), UnsubscribeOptions{ID: b.subs[0]}); err != nil {
		t.Fatal(err)
	}
	b.setStep(b.kids[1].ID, finished)
	items := b.waitItems(b.parent.ID, "the last wake", func(items []Item) bool { return len(wakes(items)) == 1 })
	if got := titlesOf(wakes(items))[0]; strings.Contains(got, b.kids[0].ID) {
		t.Errorf("a wake of a dropped subscription came: %s", got)
	}
}

// A thread held for its group that runs again, and settles last, comes once.
func TestGroupWakeThreadThatRanAgainComesOnce(t *testing.T) {
	b := newGroupEnv(t, 2)
	b.setStep(b.kids[0].ID, finished)
	if n := b.quiet(); n != 0 {
		t.Fatalf("%d wakes", n)
	}
	b.setStep(b.kids[0].ID, busy)
	b.setStep(b.kids[1].ID, finished)
	if n := b.quiet(); n != 0 {
		t.Fatalf("%d wakes while one works", n)
	}
	b.setStep(b.kids[0].ID, finished)
	items := b.waitItems(b.parent.ID, "the group's wake", func(items []Item) bool { return len(wakes(items)) > 0 })
	time.Sleep(120 * time.Millisecond)
	if got := wakeSizes(t, b.items(b.parent.ID).Items); sum(got) != 2 {
		t.Errorf("wake sizes = %v, want 2 threads in all:\n%s", got, describeItems(items))
	}
}

// A bad group name fails the create: after it, a child would run with no wake at all.
func TestGroupNameCheckedBeforeTheThreadExists(t *testing.T) {
	e := newEnv(t)
	parent := e.stopped("parent")
	if err := e.m.checkNotify(true, "not ok!", parent.ID); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("err = %v", err)
	}
	if err := e.m.checkNotify(true, "wave-1", parent.ID); err != nil {
		t.Errorf("err = %v", err)
	}
}

func TestGroupRefusals(t *testing.T) {
	e := newEnv(t)
	a, c := e.stopped("a"), e.stopped("c")
	tests := []struct {
		name string
		o    SubscribeOptions
	}{
		{"a bad name", SubscribeOptions{SubscriberID: a.ID, TargetThreadID: c.ID, Group: "not ok!"}},
		{"another condition", SubscribeOptions{SubscriberID: a.ID, TargetThreadID: c.ID, Condition: CondIdle, Group: "g"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := e.m.Subscribe(e.ctx(), tt.o); !errors.Is(err, ErrInvalidArgument) {
				t.Errorf("err = %v", err)
			}
		})
	}
}

// A wake held for its group, or for a lead's workers, is in memory only: the stop records
// it, and the next start sends it with its notice, the held thread's last message in it
// (the busy sibling interrupted, or the idle one waiting on its shell; a lead whose
// workers the stop cut).
func TestHeldWakesSurviveARestart(t *testing.T) {
	batch := func(o *Options) { o.WakeBatch = 20 * time.Millisecond }
	tests := []struct {
		name string
		// hold holds a wake to the returned subscriber about the returned thread, whose
		// last message is "HELD-DONE"; restart is what the reopen needs.
		hold    func(t *testing.T) (e *env, subscriber, held string, restart []func(*Options))
		inTitle string
	}{
		{"group, its sibling busy", func(t *testing.T) (*env, string, string, []func(*Options)) {
			b := newGroupEnv(t, 2)
			b.finishWith(b.kids[0].ID, "HELD-DONE")
			if n := b.quiet(); n != 0 {
				t.Fatalf("%d wakes while one works", n)
			}
			// As the stop leaves them (these threads have no runner to stop).
			b.leftByStop(b.kids[0].ID, offIdle)
			b.leftByStop(b.kids[1].ID, crashed)
			return b.env, b.parent.ID, b.kids[0].ID, []func(*Options){batch}
		}, "1 of your child threads was interrupted"},
		{"group, its sibling waiting on a shell", func(t *testing.T) (*env, string, string, []func(*Options)) {
			b := newGroupEnv(t, 2)
			b.finishWith(b.kids[0].ID, "HELD-DONE")
			b.setStep(b.kids[1].ID, step{StateConnected, StatusIdle, Waiting{Shells: 1}.Reason(), ""})
			if n := b.quiet(); n != 0 {
				t.Fatalf("%d wakes while one waits on its shell", n)
			}
			b.leftByStop(b.kids[0].ID, offIdle)
			b.leftByStop(b.kids[1].ID, offIdle)
			return b.env, b.parent.ID, b.kids[0].ID, []func(*Options){batch}
		}, "none of your child threads were interrupted"},
		{"a lead, its workers busy", func(t *testing.T) (*env, string, string, []func(*Options)) {
			l := newLeadEnv(t)
			l.putItems(l.lead.ID, Item{ID: "u1", Kind: KindUserMessage, Text: "lead it", CreatedAt: l.m.opts.Now()},
				Item{ID: "a1", Kind: KindAssistantText, Text: "HELD-DONE", CreatedAt: l.m.opts.Now()})
			l.setStep(l.lead.ID, finished)
			l.settled(1)
			if !l.held() {
				t.Fatal("the lead's wake was not held")
			}
			l.leftByStop(l.lead.ID, offIdle)
			for _, w := range l.workers {
				l.leftByStop(w.ID, crashed)
			}
			clock := l.clock
			return l.env, l.top.ID, l.lead.ID, []func(*Options){func(o *Options) { o.Now = func() time.Time { return time.Unix(0, clock.Load()).UTC() } }}
		}, "none of your child threads were interrupted"},
		{"a lead's one-shot, gone when it fired", func(t *testing.T) (*env, string, string, []func(*Options)) {
			l := newLeadEnv(t)
			if _, err := l.m.Unsubscribe(l.ctx(), UnsubscribeOptions{ID: l.sub}); err != nil {
				t.Fatal(err)
			}
			if _, err := l.m.Subscribe(l.ctx(), SubscribeOptions{SubscriberID: l.top.ID, TargetThreadID: l.lead.ID}); err != nil {
				t.Fatal(err)
			}
			l.putItems(l.lead.ID, Item{ID: "u1", Kind: KindUserMessage, Text: "lead it", CreatedAt: l.m.opts.Now()},
				Item{ID: "a1", Kind: KindAssistantText, Text: "HELD-DONE", CreatedAt: l.m.opts.Now()})
			l.setStep(l.lead.ID, finished)
			deadline := time.Now().Add(5 * time.Second)
			for !l.held() {
				if time.Now().After(deadline) {
					t.Fatal("the lead's wake was not held")
				}
				time.Sleep(5 * time.Millisecond)
			}
			l.leftByStop(l.lead.ID, offIdle)
			for _, w := range l.workers {
				l.leftByStop(w.ID, crashed)
			}
			clock := l.clock
			return l.env, l.top.ID, l.lead.ID, []func(*Options){func(o *Options) { o.Now = func() time.Time { return time.Unix(0, clock.Load()).UTC() } }}
		}, "none of your child threads were interrupted"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, subscriber, held, restart := tt.hold(t)
			e.restart(restart...)
			e.m.DeliverRestartWakes()
			items := e.waitItems(subscriber, "the restart wake", func(items []Item) bool { return len(wakes(items)) > 0 })
			time.Sleep(100 * time.Millisecond) // nothing more comes
			ws := wakes(e.items(subscriber).Items)
			if len(ws) != 1 {
				t.Fatalf("wakes = %d, want 1:\n%s", len(ws), describeItems(items))
			}
			w := ws[0]
			if !strings.HasPrefix(w.WakeTitle, "The app restarted at ") || !strings.Contains(w.WakeTitle, tt.inTitle) ||
				!strings.Contains(w.WakeTitle, held) {
				t.Errorf("title = %s", w.WakeTitle)
			}
			if !strings.Contains(w.WakeJSON, `"last_message": "HELD-DONE"`) {
				t.Errorf("the held thread's last message is not in the wake:\n%s", w.WakeJSON)
			}
			// The fire took a one-shot; a repeat one stays, nothing suppressed.
			subs, err := e.m.Subscriptions(e.ctx(), subscriber)
			if err != nil {
				t.Fatal(err)
			}
			for _, sub := range subs {
				if !sub.Repeat || !sub.SuppressedAt.IsZero() {
					t.Errorf("after delivery: %+v", sub)
				}
			}
		})
	}
}

// finishWith ends thread id's turn with text as its last message.
func (b *batchEnv) finishWith(id, text string) {
	b.t.Helper()
	now := time.Now()
	b.putItems(id, Item{ID: "u-" + id, Kind: KindUserMessage, Text: "go", CreatedAt: now},
		Item{ID: "a-" + id, Kind: KindAssistantText, Text: text, CreatedAt: now})
	b.setStep(id, finished)
}

// leftByStop saves thread id as a daemon stop leaves it: disconnected "daemon stopped",
// reading s. Only the row: a commit now would fire, and the stop's fires come after
// Shutdown closed the Manager.
func (e *env) leftByStop(id string, s step) {
	e.t.Helper()
	th, ok := e.m.Snapshot().Thread(id)
	if !ok {
		e.t.Fatalf("no thread %s", id)
	}
	th.State, th.Status, th.StatusReason, th.DisconnectReason = s.st, s.status, s.reason, ReasonDaemonStopped
	th.StatusChangedAt = time.Now()
	if err := saveThread(context.Background(), e.m.opts.DB, th); err != nil {
		e.t.Fatal(err)
	}
}
