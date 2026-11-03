package thread

import (
	"errors"
	"strings"
	"testing"
)

// Next: the target settled already does not fire at once; its next settle fires once
// (one-shot), carrying the report; a second settle fires nothing.
func TestSubscribeNext(t *testing.T) {
	e := newEnv(t)
	parent, child := e.stopped("parent"), e.stopped("child")
	e.setStep(child.ID, atPrompt) // a send's busy status not published yet
	res, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetThreadID: child.ID, Next: true, Note: "the task sent to child"})
	if err != nil || res.Fired || res.Existed {
		t.Fatalf("Subscribe = %+v, %v", res, err)
	}
	if _, kept := e.subscription(res.Subscription.ID); !kept {
		t.Fatal("not kept")
	}
	e.setStep(child.ID, atPrompt) // still settled: nothing
	if w := wakes(e.items(parent.ID).Items); len(w) != 0 {
		t.Fatalf("woken before the next settle: %+v", w)
	}
	e.setStep(child.ID, busy)
	if _, err := e.m.Report(e.ctx(), child.ID, Report{Status: ReportDone, Summary: "checks fixed"}); err != nil {
		t.Fatal(err)
	}
	e.setStep(child.ID, finished)
	items := e.waitItems(parent.ID, "the wake", func(items []Item) bool { return len(wakes(items)) == 1 })
	if w := wakes(items)[0]; !strings.Contains(w.WakeTitle, "Report: done — checks fixed") || !strings.Contains(w.WakeJSON, "the task sent to child") {
		t.Errorf("wake = %q %s", w.WakeTitle, w.WakeJSON)
	}
	if _, kept := e.subscription(res.Subscription.ID); kept {
		t.Error("a one-shot was kept after it fired")
	}
	e.setStep(child.ID, busy)
	e.setStep(child.ID, finished)
	if w := wakes(e.items(parent.ID).Items); len(w) != 1 {
		t.Errorf("woken %d times, want once", len(w))
	}
}

// Next over an existing subscription (thread.new --notify's repeat one): returned
// unchanged, still repeating, note kept.
func TestSubscribeNextKeepsExisting(t *testing.T) {
	e := newEnv(t)
	parent, child := e.stopped("parent"), e.stopped("child")
	e.setStep(child.ID, busy)
	first, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetThreadID: child.ID, Repeat: true, Note: "notify"})
	if err != nil {
		t.Fatal(err)
	}
	again, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetThreadID: child.ID, Next: true, Note: "forward"})
	if err != nil || !again.Existed || again.Fired || again.Subscription.ID != first.Subscription.ID {
		t.Fatalf("again = %+v, %v", again, err)
	}
	if got, _ := e.subscription(first.Subscription.ID); !got.Repeat || got.Note != "notify" {
		t.Errorf("existing = %+v, want repeat with its note", got)
	}
	if _, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetRunID: "r-1", Next: true}); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("next on a run: err = %v, want invalid argument", err)
	}
}
