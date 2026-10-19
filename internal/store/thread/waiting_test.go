package thread

import (
	"slices"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

func TestWaitingReason(t *testing.T) {
	tests := []struct {
		reason string
		n      int
		ok     bool
	}{
		{waitingReason(2), 2, true},
		{waitingReason(1), 1, true},
		{waitingReason(0), 0, true},
		{"waiting on 1 child thread", 1, true},
		{"finished", 0, false},
		{"at prompt", 0, false},
		{"waitingroom", 0, false},
	}
	for _, tt := range tests {
		if n, ok := WaitingOn(tt.reason); n != tt.n || ok != tt.ok {
			t.Errorf("WaitingOn(%q) = %d, %v; want %d, %v", tt.reason, n, ok, tt.n, tt.ok)
		}
	}
	if got := waitingReason(2); got != "waiting on 2 child threads" {
		t.Errorf("waitingReason(2) = %q", got)
	}
}

// The overlay's rule: a plainly ended turn holding subscriptions on threads that will
// wake it shows waiting; anything that needs the user wins.
func TestWaitingRule(t *testing.T) {
	type sub struct {
		from, to string
		cond     Condition
	}
	errorTurn := step{StateConnected, StatusNeedsAttention, "error: 529", ""}
	// offBusy: working as far as the rule goes, and archivable (no process).
	offBusy := step{StateDisconnected, StatusBusy, "working", ""}
	tests := []struct {
		name string
		// steps set before the subscriptions (targets must not meet them, or they fire),
		// then after (stopped, so that a wake starts the thread).
		before map[string]step
		subs   []sub
		after  map[string]step
		// archive, remove are threads archived, or marked being removed, last.
		archive, removing []string
		want              map[string]step
	}{
		{name: "a busy child",
			before: map[string]step{"c1": busy}, subs: []sub{{"p", "c1", CondSettled}}, after: map[string]step{"p": finished},
			want: map[string]step{"p": waitingStep(1)}},
		{name: "two of three children busy",
			before: map[string]step{"c1": busy, "c2": busy, "c3": atPrompt},
			subs:   []sub{{"p", "c1", CondSettled}, {"p", "c2", CondIdle}, {"p", "c3", CondAttention}}, after: map[string]step{"p": finished},
			want: map[string]step{"p": waitingStep(2)}},
		{name: "seen: at its prompt it waits too",
			before: map[string]step{"c1": busy}, subs: []sub{{"p", "c1", CondSettled}}, after: map[string]step{"p": atPrompt},
			want: map[string]step{"p": waitingStep(1)}},
		{name: "no subscriptions",
			before: map[string]step{"c1": busy}, after: map[string]step{"p": finished},
			want: map[string]step{"p": finished}},
		{name: "the child settled",
			before: map[string]step{"c1": atPrompt}, subs: []sub{{"p", "c1", CondAttention}}, after: map[string]step{"p": finished},
			want: map[string]step{"p": finished}},
		{name: "a child asking a question is not pending",
			before: map[string]step{"c1": askWhich}, subs: []sub{{"p", "c1", CondIdle}}, after: map[string]step{"p": finished},
			want: map[string]step{"p": finished}},
		{name: "an archived child",
			before: map[string]step{"c1": offBusy}, subs: []sub{{"p", "c1", CondSettled}}, after: map[string]step{"p": finished},
			archive: []string{"c1"}, want: map[string]step{"p": finished}},
		{name: "a child being removed will wake it",
			before: map[string]step{"c1": atPrompt}, subs: []sub{{"p", "c1", CondAttention}}, after: map[string]step{"p": finished},
			removing: []string{"c1"}, want: map[string]step{"p": waitingStep(1)}},
		{name: "an error subscription is not waited on",
			before: map[string]step{"c1": busy}, subs: []sub{{"p", "c1", CondError}}, after: map[string]step{"p": finished},
			want: map[string]step{"p": finished}},
		{name: "a question wins",
			before: map[string]step{"c1": busy}, subs: []sub{{"p", "c1", CondSettled}}, after: map[string]step{"p": askWhich},
			want: map[string]step{"p": askWhich}},
		{name: "a permission prompt wins",
			before: map[string]step{"c1": busy}, subs: []sub{{"p", "c1", CondSettled}}, after: map[string]step{"p": askBash},
			want: map[string]step{"p": askBash}},
		{name: "a turn error wins",
			before: map[string]step{"c1": busy}, subs: []sub{{"p", "c1", CondSettled}}, after: map[string]step{"p": errorTurn},
			want: map[string]step{"p": errorTurn}},
		{name: "the budget stop wins",
			before: map[string]step{"c1": busy}, subs: []sub{{"p", "c1", CondSettled}}, after: map[string]step{"p": budget},
			want: map[string]step{"p": budget}},
		{name: "busy is busy",
			before: map[string]step{"c1": busy}, subs: []sub{{"p", "c1", CondSettled}}, after: map[string]step{"p": busy},
			want: map[string]step{"p": busy}},
		// The lead's waiting is idle: p's attention subscription does not fire.
		{name: "a lead waiting on its worker keeps its parent waiting",
			before: map[string]step{"w": busy, "lead": busy},
			subs:   []sub{{"p", "lead", CondAttention}, {"lead", "w", CondSettled}},
			after:  map[string]step{"lead": finished, "p": finished},
			want:   map[string]step{"lead": waitingStep(1), "p": waitingStep(1)}},
		// The worker gone, the lead's turn is finished: that wakes p, whose own turn
		// then ends finished, waiting on nothing.
		{name: "the worker archived: neither waits",
			before:  map[string]step{"w": offBusy, "lead": busy},
			subs:    []sub{{"p", "lead", CondAttention}, {"lead", "w", CondSettled}},
			after:   map[string]step{"lead": finished, "p": finished},
			archive: []string{"w"},
			want:    map[string]step{"lead": finished, "p": finished}},
		{name: "a cycle does not keep itself waiting",
			before: map[string]step{"a": busy, "b": busy, "c": busy},
			subs:   []sub{{"a", "b", CondAttention}, {"b", "c", CondAttention}, {"c", "a", CondAttention}},
			after:  map[string]step{"a": atPrompt, "b": atPrompt, "c": atPrompt},
			want:   map[string]step{"a": atPrompt, "b": atPrompt, "c": atPrompt}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			ids := map[string]string{}
			id := func(name string) string {
				if _, ok := ids[name]; !ok {
					ids[name] = e.stopped(name).ID
				}
				return ids[name]
			}
			for _, name := range []string{"p", "lead", "w", "a", "b", "c", "c1", "c2", "c3"} {
				if _, used := tt.want[name]; used || tt.before[name] != (step{}) || tt.after[name] != (step{}) {
					id(name)
				}
			}
			for _, s := range tt.subs {
				id(s.from)
				id(s.to)
			}
			for _, name := range sortedKeys(tt.before) {
				e.setStep(id(name), tt.before[name])
			}
			for _, s := range tt.subs {
				res, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: id(s.from), TargetThreadID: id(s.to), Condition: s.cond, Repeat: true})
				if err != nil || res.Fired {
					t.Fatalf("Subscribe %v = %+v, %v", s, res, err)
				}
			}
			for _, name := range sortedKeys(tt.after) {
				// Stopped: a wake that comes starts it for real.
				st := tt.after[name]
				st.st = StateDisconnected
				e.setStep(id(name), st)
			}
			for _, name := range tt.archive {
				if _, err := e.m.Archive(e.ctx(), id(name), true); err != nil {
					t.Fatal(err)
				}
			}
			for _, name := range tt.removing {
				e.m.update(id(name), false, func(rec *record) { rec.s.Removing = true })
			}
			for _, name := range sortedKeys(tt.want) {
				w := tt.want[name]
				e.waitFor(id(name), name+" "+w.status.String()+" ("+w.reason+")", func(s Thread) bool {
					return s.Status == w.status && s.StatusReason == w.reason
				})
			}
		})
	}
}

func waitingStep(n int) step { return step{StateConnected, StatusIdle, waitingReason(n), ""} }

func sortedKeys(m map[string]step) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}

// Waiting ends without needing the user: the subscriber shows waiting until the wake's
// turn starts (never "finished" in between), and that turn's end is finished as ever.
// Unsubscribing ends it too. A waiting row loads as the finished turn it stood for.
func TestWaitingUntilWake(t *testing.T) {
	for _, live := range []bool{true, false} {
		name := map[bool]string{true: "running subscriber", false: "stopped subscriber"}[live]
		t.Run(name, func(t *testing.T) {
			e := newEnv(t)
			var parent Thread
			if live {
				parent = e.connected(CreateOptions{Name: "parent"})
			} else {
				parent = e.stopped("parent")
			}
			child := e.stopped("child")
			e.setStep(child.ID, busy)
			sub := bus.Subscribe[Event](e.bus, 1024)
			defer sub.Close()
			if _, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetThreadID: child.ID, Repeat: true}); err != nil {
				t.Fatal(err)
			}
			e.waitFor(parent.ID, "waiting", func(s Thread) bool { return s.StatusReason == waitingReason(1) })
			e.setStep(child.ID, finished)
			e.waitItems(parent.ID, "the wake", func(items []Item) bool { return len(wakes(items)) == 1 })
			e.waitFor(parent.ID, "the wake's turn to end", func(s Thread) bool {
				return s.Status == StatusNeedsAttention && s.StatusReason == "finished"
			})
			var seen []string
			for len(sub.C()) > 0 {
				if u, ok := (<-sub.C()).(Updated); ok && u.Thread.ID == parent.ID {
					w := statusWords(u.Thread)
					if len(seen) == 0 || seen[len(seen)-1] != w {
						seen = append(seen, w)
					}
				}
			}
			// Waiting on the child, then on the queued wake alone, then the wake's turn.
			busyAt := slices.IndexFunc(seen, func(w string) bool { return strings.HasPrefix(w, "busy") })
			ok := busyAt > 0 && seen[len(seen)-1] == "needs attention (finished)"
			for _, w := range seen[:max(busyAt, 0)] {
				ok = ok && strings.HasPrefix(w, "idle (waiting")
			}
			if !ok {
				t.Errorf("parent statuses = %q; want waiting, then busy, then finished", seen)
			}
		})
	}

	t.Run("unsubscribe and restart", func(t *testing.T) {
		e := newEnv(t)
		parent, child := e.stopped("parent"), e.stopped("child")
		e.setStep(child.ID, busy)
		e.setStep(parent.ID, finished)
		res, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetThreadID: child.ID})
		if err != nil {
			t.Fatal(err)
		}
		e.waitFor(parent.ID, "waiting", func(s Thread) bool { return s.StatusReason == waitingReason(1) })
		e.restart()
		e.waitFor(parent.ID, "the finished turn after a restart", func(s Thread) bool {
			return s.Status == StatusNeedsAttention && s.StatusReason == "finished"
		})
		e.setStep(child.ID, busy)
		e.waitFor(parent.ID, "waiting again", func(s Thread) bool { return s.StatusReason == waitingReason(1) })
		if _, err := e.m.Unsubscribe(e.ctx(), UnsubscribeOptions{ID: res.Subscription.ID}); err != nil {
			t.Fatal(err)
		}
		e.waitFor(parent.ID, "finished once unsubscribed", func(s Thread) bool {
			return s.Status == StatusNeedsAttention && s.StatusReason == "finished"
		})
	})
}
