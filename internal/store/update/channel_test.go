package update_test

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/update"
	"github.com/alexwaumann/code-foundry/internal/store/update/updatetest"
)

// waitChecked waits until a check on ch has completed and returns the status.
func (r *rig) waitChecked(t *testing.T, ch update.Channel, calls int) update.Status {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		got := r.source.Channels()
		st := r.store.Snapshot()
		if len(got) >= calls && got[len(got)-1] == ch && !st.Checking && st.Channel == ch && !st.LastCheckedAt.IsZero() {
			return st
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for a %s check; calls %v, status %+v", ch, got, st)
		}
		time.Sleep(time.Millisecond)
	}
}

// TestChannelSwitches walks the three switches of decision 10 in
// docs/notes/release-channels-handoff.md (plus the right-after-promotion no-op and an
// offer withdrawn by switching back): Newer is the only rule, so no switch ever offers
// a downgrade.
func TestChannelSwitches(t *testing.T) {
	tests := []struct {
		name               string
		current            string
		stable, tip        string
		from, to           update.Channel
		wantBefore         update.State
		wantAfter          update.State
		wantTarget, latest string
	}{
		{
			name: "stable to tip, tip ahead: offered", current: "v0.14.41",
			stable: "v0.14.41", tip: "v0.15.0-tip.2", from: update.ChannelStable, to: update.ChannelTip,
			wantBefore: update.Idle, wantAfter: update.Available, wantTarget: "v0.15.0-tip.2", latest: "v0.15.0-tip.2",
		},
		{
			name: "stable to tip right after a promotion: up to date", current: "v0.15.0",
			stable: "v0.15.0", tip: "v0.15.0", from: update.ChannelStable, to: update.ChannelTip,
			wantBefore: update.Idle, wantAfter: update.Idle, latest: "v0.15.0",
		},
		{
			name: "tip to stable, tip ahead: nothing offered", current: "v0.15.0-tip.2",
			stable: "v0.14.41", tip: "v0.15.0-tip.2", from: update.ChannelTip, to: update.ChannelStable,
			wantBefore: update.Idle, wantAfter: update.Idle, latest: "v0.14.41",
		},
		{
			name: "tip to stable, tip behind (a promotion landed): offered", current: "v0.15.0-tip.2",
			stable: "v0.15.0", tip: "v0.15.0", from: update.ChannelTip, to: update.ChannelStable,
			wantBefore: update.Available, wantAfter: update.Available, wantTarget: "v0.15.0", latest: "v0.15.0",
		},
		{
			name: "tip offer withdrawn by switching back to stable", current: "v0.14.41",
			stable: "v0.14.41", tip: "v0.15.0-tip.2", from: update.ChannelTip, to: update.ChannelStable,
			wantBefore: update.Available, wantAfter: update.Idle, latest: "v0.14.41",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := newRig(t, tt.stable, func(o *update.Options) {
				o.Current = tt.current
				o.InstalledVersion = updatetest.NewOnDisk(tt.current).Version
				o.Channel = tt.from
			})
			r.source.SetTip(tt.tip)
			ctx := context.Background()
			st, err := r.store.Check(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if st.State != tt.wantBefore || st.Channel != tt.from {
				t.Fatalf("before the switch: %+v", st)
			}

			r.store.SetChannel(tt.to)
			st = r.waitChecked(t, tt.to, 2)
			if st.State != tt.wantAfter || st.Target != tt.wantTarget || st.Latest != tt.latest {
				t.Fatalf("after the switch: state %v target %q latest %q; want %v %q %q", st.State, st.Target, st.Latest, tt.wantAfter, tt.wantTarget, tt.latest)
			}
			if got := r.source.Channels(); !slices.Equal(got, []update.Channel{tt.from, tt.to}) {
				t.Fatalf("source asked for %v", got)
			}
		})
	}
}

func TestSetChannelSameChannelDoesNotCheck(t *testing.T) {
	r := newRig(t, "v0.1.0", nil)
	if st := r.store.Snapshot(); st.Channel != update.ChannelStable {
		t.Fatalf("default channel %q", st.Channel)
	}
	r.store.SetChannel(update.ChannelStable)
	time.Sleep(20 * time.Millisecond)
	if n := r.source.Calls(); n != 0 {
		t.Fatalf("source called %d times", n)
	}
}

func TestSetChannelClearsLatestAndPublishes(t *testing.T) {
	r := newRig(t, "v0.1.0", nil)
	r.source.SetTip("v0.2.0-tip.1")
	if _, err := r.store.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	// Hold the re-check back so the published switch can be seen on its own.
	r.source.Block()
	defer r.source.Unblock()
	r.store.SetChannel(update.ChannelTip)
	deadline := time.After(5 * time.Second)
	for {
		select {
		case ev := <-r.events.C():
			if ev.Status.Channel == update.ChannelTip {
				if ev.Status.Latest != "" {
					t.Fatalf("latest of the old channel kept: %+v", ev.Status)
				}
				return
			}
		case <-deadline:
			t.Fatal("channel change not published")
		}
	}
}

func TestSetChannelWhileDisabled(t *testing.T) {
	r := newRig(t, "v0.2.0", func(o *update.Options) {
		o.Current = "dev"
		o.DisabledReason = "dev build"
	})
	r.store.SetChannel(update.ChannelTip)
	time.Sleep(20 * time.Millisecond)
	if st := r.store.Snapshot(); st.Channel != update.ChannelTip || st.State != update.Idle {
		t.Fatalf("%+v", st)
	}
	if n := r.source.Calls(); n != 0 {
		t.Fatalf("source called %d times while disabled", n)
	}
}

// TestChannelChangeDuringCheck: a check that started on the old channel does not apply
// its answer; the queued re-check on the new channel does.
func TestChannelChangeDuringCheck(t *testing.T) {
	r := newRig(t, "v0.1.0", nil)
	r.source.SetTip("v0.2.0-tip.1")
	r.source.Block()
	done := make(chan update.Status, 1)
	go func() {
		st, _ := r.store.Check(context.Background())
		done <- st
	}()
	r.source.WaitBlocked(t)
	r.store.SetChannel(update.ChannelTip)
	r.source.Unblock()
	<-done
	st := r.waitChecked(t, update.ChannelTip, 2)
	if st.State != update.Available || st.Target != "v0.2.0-tip.1" {
		t.Fatalf("%+v", st)
	}
}
