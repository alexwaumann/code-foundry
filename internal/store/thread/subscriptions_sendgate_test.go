package thread

import (
	"errors"
	"strings"
	"testing"
)

// handledStep commits a stopped thread as reading s with its handled ordinal at handled
// (Thread.HandledThrough, as the runner publishes it with the status).
func (e *env) handledStep(id string, s step, handled int64) {
	e.t.Helper()
	if _, ok := e.m.update(id, false, func(rec *record) {
		rec.s.State, rec.s.Status, rec.s.StatusReason, rec.s.PendingRequestID = s.st, s.status, s.reason, s.req
		rec.s.HandledThrough = handled
	}); !ok {
		e.t.Fatalf("no thread %s", id)
	}
}

// forwardSteps is a step and the target's handled ordinal with it.
type forwardStep struct {
	s       step
	handled int64
}

// The send gate (pr.task's forward): subscribed before the send, armed with the sent
// message's ordinal (5), it fires once, when a turn that took the message in ended
// (HandledThrough reached 5) or on a request asked after the arming, never on a status
// change before that (the parent's waiting-on-children count, a viewed "finished"
// cleared, the turn that was running when the message came ending without reading it).
func TestSubscribeSendGate(t *testing.T) {
	const msg = 5
	tests := []struct {
		name   string
		before []forwardStep // between the subscription and the arming
		start  forwardStep   // the target as the arming finds it
		steps  []forwardStep // after the arming
		want   int
	}{
		{name: "the turn that handled it ends", start: forwardStep{busy, 3}, steps: []forwardStep{{finished, msg}}, want: 1},
		{name: "unarmed: a turn ending before the arming fires nothing", before: []forwardStep{{busy, 3}, {finished, msg}},
			start: forwardStep{finished, msg}, want: 1}, // fired by the arming itself: the turn already handled it
		{name: "early changes: a viewed finished cleared, idle, finished again by an older turn", start: forwardStep{finished, 3},
			steps: []forwardStep{{atPrompt, 3}, {busy, 3}, {finished, 4}}, want: 0},
		{name: "the running turn ends without reading it (queued), the next one does", start: forwardStep{busy, 3},
			steps: []forwardStep{{finished, 4}, {busy, 4}, {finished, msg + 2}}, want: 1},
		{name: "a turn ending with the same status (finished, finished)", start: forwardStep{finished, 3},
			steps: []forwardStep{{finished, msg}}, want: 1},
		{name: "one-shot: the next turn wakes nothing more", start: forwardStep{busy, 3},
			steps: []forwardStep{{finished, msg}, {busy, msg}, {finished, msg + 3}}, want: 1},
		{name: "a permission prompt after the arming (the parent may step in)", start: forwardStep{busy, 3},
			steps: []forwardStep{{askEdit1, 3}}, want: 1},
		{name: "the prompt pending at the arming does not", start: forwardStep{askEdit1, 3},
			steps: []forwardStep{{askEdit1, 3}, {busy, 3}}, want: 0},
		{name: "still working", start: forwardStep{busy, 3}, steps: []forwardStep{{busy, msg}}, want: 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			parent, child := e.stopped("parent"), e.stopped("child")
			e.handledStep(child.ID, finished, 3) // a finished turn from before the task
			res, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetThreadID: child.ID, BeforeSend: true, Note: "forwarded"})
			if err != nil || res.Fired || res.Existed {
				t.Fatalf("Subscribe before the send = %+v, %v", res, err)
			}
			for _, s := range tt.before {
				e.handledStep(child.ID, s.s, s.handled)
			}
			e.handledStep(child.ID, tt.start.s, tt.start.handled)
			armed, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetThreadID: child.ID, AfterOrdinal: msg, Note: "forwarded"})
			if err != nil || !armed.Existed || armed.Subscription.ID != res.Subscription.ID {
				t.Fatalf("arm = %+v, %v", armed, err)
			}
			if _, err := e.m.Report(e.ctx(), child.ID, Report{Status: ReportDone, Summary: "checks fixed"}); err != nil {
				t.Fatal(err)
			}
			for _, s := range tt.steps {
				e.handledStep(child.ID, s.s, s.handled)
			}
			if tt.want == 0 {
				if w := wakes(e.items(parent.ID).Items); len(w) != 0 {
					t.Fatalf("woken: %+v", w)
				}
				if _, kept := e.subscription(res.Subscription.ID); !kept {
					t.Error("not kept while the task is not handled")
				}
				return
			}
			items := e.waitItems(parent.ID, "the wake", func(items []Item) bool { return len(wakes(items)) >= 1 })
			if w := wakes(items); len(w) != tt.want || !strings.Contains(w[0].WakeJSON, "forwarded") {
				t.Errorf("wakes = %+v", w)
			}
			if _, kept := e.subscription(res.Subscription.ID); kept {
				t.Error("a one-shot was kept after it fired")
			}
		})
	}
}

// Unarmed (the send failed, or has not happened yet): never fires, whatever the target
// does. Armed without a subscription before it (AfterOrdinal alone): gated the same way.
func TestSubscribeSendGateUnarmed(t *testing.T) {
	e := newEnv(t)
	parent, child := e.stopped("parent"), e.stopped("child")
	e.handledStep(child.ID, busy, 0)
	res, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetThreadID: child.ID, BeforeSend: true})
	if err != nil || res.Fired {
		t.Fatalf("Subscribe = %+v, %v", res, err)
	}
	for _, s := range []forwardStep{{finished, 10}, {busy, 10}, {askEdit1, 10}, {offIdle, 12}} {
		e.handledStep(child.ID, s.s, s.handled)
	}
	if w := wakes(e.items(parent.ID).Items); len(w) != 0 {
		t.Fatalf("woken while unarmed: %+v", w)
	}

	other := e.stopped("other")
	e.handledStep(other.ID, finished, 9)
	direct, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetThreadID: other.ID, AfterOrdinal: 10})
	if err != nil || direct.Fired || direct.Existed {
		t.Fatalf("AfterOrdinal alone = %+v, %v", direct, err)
	}
	e.handledStep(other.ID, finished, 10)
	e.waitItems(parent.ID, "the wake", func(items []Item) bool { return len(wakes(items)) == 1 })
}

// The gate is for thread targets, one of the two at a time.
func TestSubscribeSendGateRefused(t *testing.T) {
	e := newEnv(t)
	parent, child := e.stopped("parent"), e.stopped("child")
	for name, o := range map[string]SubscribeOptions{
		"before_send on a run":   {SubscriberID: parent.ID, TargetRunID: "r-1", BeforeSend: true},
		"after_ordinal on a run": {SubscriberID: parent.ID, TargetRunID: "r-1", AfterOrdinal: 3},
		"both":                   {SubscriberID: parent.ID, TargetThreadID: child.ID, BeforeSend: true, AfterOrdinal: 3},
		"a negative ordinal":     {SubscriberID: parent.ID, TargetThreadID: child.ID, AfterOrdinal: -1},
	} {
		if _, err := e.m.Subscribe(e.ctx(), o); !errors.Is(err, ErrInvalidArgument) {
			t.Errorf("%s: err = %v, want invalid argument", name, err)
		}
	}
}
