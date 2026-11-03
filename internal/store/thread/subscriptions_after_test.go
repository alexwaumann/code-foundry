package thread

import (
	"errors"
	"strings"
	"testing"
	"time"
)

// statusAt commits a stopped thread as reading s, its status changed at at (as the
// runner's setStatus stamps it).
func (e *env) statusAt(id string, s step, at time.Time) {
	e.t.Helper()
	if _, ok := e.m.update(id, false, func(rec *record) {
		rec.s.State, rec.s.Status, rec.s.StatusReason, rec.s.PendingRequestID, rec.s.StatusChangedAt = s.st, s.status, s.reason, s.req, at
	}); !ok {
		e.t.Fatalf("no thread %s", id)
	}
}

// After: the target settled with a status from before it does not fire (a send's busy
// status not published yet); the first settle with a status changed since fires once,
// carrying the report and the note.
func TestSubscribeAfter(t *testing.T) {
	tests := []struct {
		name  string
		steps []step // after the subscription, each a status changed after the send
		want  int
	}{
		{name: "busy, then finished", steps: []step{busy, finished}, want: 1},
		{name: "finished straight from idle (busy debounced away)", steps: []step{finished}, want: 1},
		{name: "one-shot: a second turn wakes nothing more", steps: []step{busy, finished, busy, finished}, want: 1},
		{name: "still working", steps: []step{busy}, want: 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			parent, child := e.stopped("parent"), e.stopped("child")
			sent := time.Now()
			e.statusAt(child.ID, atPrompt, sent.Add(-time.Hour)) // its status from before the send
			res, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetThreadID: child.ID, After: sent, Note: "the task sent to child"})
			if err != nil || res.Fired || res.Existed {
				t.Fatalf("Subscribe = %+v, %v", res, err)
			}
			e.statusAt(child.ID, offIdle, sent.Add(-time.Minute)) // another publish of an old status: nothing
			if _, err := e.m.Report(e.ctx(), child.ID, Report{Status: ReportDone, Summary: "checks fixed"}); err != nil {
				t.Fatal(err)
			}
			for i, s := range tt.steps {
				e.statusAt(child.ID, s, sent.Add(time.Duration(i+1)*time.Second))
			}
			if tt.want == 0 {
				if w := wakes(e.items(parent.ID).Items); len(w) != 0 {
					t.Fatalf("woken: %+v", w)
				}
				if _, kept := e.subscription(res.Subscription.ID); !kept {
					t.Error("not kept while the target works")
				}
				return
			}
			items := e.waitItems(parent.ID, "the wake", func(items []Item) bool { return len(wakes(items)) >= 1 })
			if w := wakes(items); len(w) != tt.want || !strings.Contains(w[0].WakeTitle, "Report: done — checks fixed") || !strings.Contains(w[0].WakeJSON, "the task sent to child") {
				t.Errorf("wakes = %+v", w)
			}
			if _, kept := e.subscription(res.Subscription.ID); kept {
				t.Error("a one-shot was kept after it fired")
			}
		})
	}
}

// A turn that ended before the subscription (its status changed after the send): fired
// at once.
func TestSubscribeAfterAlreadySettled(t *testing.T) {
	e := newEnv(t)
	parent, child := e.stopped("parent"), e.stopped("child")
	sent := time.Now().Add(-time.Second)
	e.statusAt(child.ID, finished, sent.Add(500*time.Millisecond))
	res, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetThreadID: child.ID, After: sent})
	if err != nil || !res.Fired {
		t.Fatalf("Subscribe = %+v, %v; want fired at once", res, err)
	}
	e.waitItems(parent.ID, "the wake", func(items []Item) bool { return len(wakes(items)) == 1 })
}

// After over an existing subscription (thread.new --notify's repeat one): returned
// unchanged, still repeating, note kept. A run target refuses it.
func TestSubscribeAfterKeepsExisting(t *testing.T) {
	e := newEnv(t)
	parent, child := e.stopped("parent"), e.stopped("child")
	e.setStep(child.ID, busy)
	first, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetThreadID: child.ID, Repeat: true, Note: "notify"})
	if err != nil {
		t.Fatal(err)
	}
	again, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetThreadID: child.ID, After: time.Now(), Note: "forward"})
	if err != nil || !again.Existed || again.Fired || again.Subscription.ID != first.Subscription.ID {
		t.Fatalf("again = %+v, %v", again, err)
	}
	if got, _ := e.subscription(first.Subscription.ID); !got.Repeat || got.Note != "notify" {
		t.Errorf("existing = %+v, want repeat with its note", got)
	}
	if _, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetRunID: "r-1", After: time.Now()}); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("after on a run: err = %v, want invalid argument", err)
	}
}
