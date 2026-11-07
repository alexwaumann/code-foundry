package thread

import (
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
