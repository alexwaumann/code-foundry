package thread

import (
	"testing"
	"time"
)

// e12-2: archiving a child its creator watches wakes no one: its subscriptions go
// before the close settles it, and a wake about it already fired is dropped; the
// subscriber no longer waits on it.
func TestArchiveWakesNoOne(t *testing.T) {
	tests := []struct {
		name string
		// fireFirst: the child settles (its wake queued, in a batch window) before the
		// archive; else the archive's own close is the settle.
		fireFirst bool
		batch     time.Duration
	}{
		// No batch window: a wake the close fired would go at once.
		{name: "the archive's close settles a busy child", batch: -1},
		{name: "a wake about it waits in a batch window", fireFirst: true, batch: 300 * time.Millisecond},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newFixtureEnvAt(t, hangFixture(t), nil, func(o *Options) { o.WakeBatch = tt.batch })
			parent := e.stopped("Ember")
			var kid Thread
			if tt.fireFirst {
				kid = e.stopped("Streak freeze")
				e.setStep(kid.ID, busy)
				if _, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetThreadID: kid.ID, Repeat: true}); err != nil {
					t.Fatal(err)
				}
				e.setStep(kid.ID, offIdle) // settles: the wake waits out its window
			} else {
				kid = e.create(CreateOptions{Name: "Streak freeze", InitialPrompt: "go", CreatedBy: parent.ID, Notify: true})
				e.waitFor(kid.ID, "busy", func(s Thread) bool { return s.Status == StatusBusy && s.State == StateConnected })
				e.waitFor(parent.ID, "waiting on it", func(s Thread) bool { return s.StatusReason == waitingReason(1) })
			}
			if _, err := e.m.Archive(e.ctx(), kid.ID, true); err != nil {
				t.Fatal(err)
			}
			time.Sleep(600 * time.Millisecond) // past the batch window
			if n := len(wakes(e.items(parent.ID).Items)); n != 0 {
				t.Errorf("the subscriber got %d wakes about the thread archived", n)
			}
			if subs, err := e.m.Subscriptions(e.ctx(), parent.ID); err != nil || len(subs) != 0 {
				t.Errorf("subscriptions left: %+v, %v", subs, err)
			}
			if got := e.snapshot(parent.ID); IsWaitingReason(got.StatusReason) {
				t.Errorf("the subscriber still waits: %q", got.StatusReason)
			}
		})
	}
}
