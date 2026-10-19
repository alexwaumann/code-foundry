package thread

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

// settle is longer than the status debounce plus a runner round trip: a status that
// would change has by then.
const settle = 300 * time.Millisecond

// attendedEnv is an env whose presence is attended or not as the returned flag says.
func attendedEnv(t *testing.T, attended bool) (*env, *atomic.Bool) {
	t.Helper()
	att := &atomic.Bool{}
	att.Store(attended)
	return newEnv(t, func(o *Options) { o.Attended = att.Load }), att
}

// setAttended flips presence the way the daemon does: the value first, then the call.
func setAttended(e *env, att *atomic.Bool, v bool) {
	att.Store(v)
	e.m.AttendedChanged(v)
}

// openViewer opens a viewer on thread id (WatchItems) and returns what closes it; the
// test's end closes it too.
func openViewer(t *testing.T, e *env, id string) func() {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if _, err := e.m.WatchItems(ctx, id); err != nil {
		t.Fatal(err)
	}
	return cancel
}

func isFinishedStatus(s Thread) bool {
	return s.Status == StatusNeedsAttention && s.StatusReason == "finished"
}

func isIdleStatus(s Thread) bool { return s.Status == StatusIdle && s.StatusReason == "at prompt" }

// The acknowledge rule against presence: a viewer acknowledges a finished turn only
// while presence is attended, and a rise to attended acknowledges the viewed threads.
func TestAttendedAcknowledge(t *testing.T) {
	type step string
	const (
		watch      step = "watch"     // open a viewer
		unwatch    step = "unwatch"   // close it
		attend     step = "attend"    // presence becomes attended
		leave      step = "leave"     // presence stops being attended
		turnEnds   step = "turn ends" // wait for the first turn's result to be processed
		isFinished step = "finished"  // the status is (and stays) NeedsAttention "finished"
		isIdle     step = "idle"      // the status becomes Idle "at prompt"
	)
	tests := []struct {
		name     string
		attended bool
		steps    []step
	}{
		{"attended, viewer during the turn: seen", true, []step{watch, turnEnds, isIdle}},
		{"away, viewer during the turn: finished", false, []step{watch, turnEnds, isFinished}},
		{"away, viewer during the turn, user returns: seen", false, []step{watch, turnEnds, isFinished, attend, isIdle}},
		{"away, no viewer, user returns: still finished", false, []step{turnEnds, isFinished, attend, isFinished}},
		{"away, viewer closed before the user returns: still finished", false, []step{watch, turnEnds, isFinished, unwatch, attend, isFinished}},
		{"finished unwatched, viewer opens while away: finished; user returns: seen", false, []step{turnEnds, isFinished, watch, isFinished, attend, isIdle}},
		{"finished unwatched, viewer opens while attended: seen", true, []step{turnEnds, isFinished, watch, isIdle}},
		{"attended viewer, user leaves before the turn ends: finished", true, []step{watch, leave, turnEnds, isFinished, attend, isIdle}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, att := attendedEnv(t, tt.attended)
			cancel := func() {}
			s := e.create(CreateOptions{InitialPrompt: "a table please"})
			for _, st := range tt.steps {
				switch st {
				case watch:
					cancel = openViewer(t, e, s.ID)
				case unwatch:
					cancel()
					deadline := time.Now().Add(5 * time.Second)
					for e.m.viewerCount(s.ID) > 0 {
						if time.Now().After(deadline) {
							t.Fatal("the viewer never left")
						}
						time.Sleep(5 * time.Millisecond)
					}
				case attend:
					setAttended(e, att, true)
				case leave:
					setAttended(e, att, false)
				case turnEnds:
					e.waitItems(s.ID, "turn end", hasTurnEnd)
					e.waitFor(s.ID, "the turn's end", func(s Thread) bool { return s.Status != StatusBusy && s.Status != StatusUnknown })
				case isFinished:
					e.waitFor(s.ID, "finished", isFinishedStatus)
					time.Sleep(settle)
					if got, _ := e.m.Get(e.ctx(), s.ID); !isFinishedStatus(got) {
						t.Fatalf("after %s: %s %q, want finished", st, got.Status, got.StatusReason)
					}
				case isIdle:
					e.waitFor(s.ID, "seen (idle)", isIdleStatus)
				}
			}
		})
	}
}

// Until-seen flags follow the same rule: a viewer sees them only while presence is
// attended, and a rise to attended sees the viewed threads' flags.
func TestAttendedUntilSeenFlags(t *testing.T) {
	type step string
	const (
		watch   step = "watch"
		unwatch step = "unwatch"
		flag    step = "flag" // an until-seen flag is raised
		attend  step = "attend"
		leave   step = "leave"
	)
	tests := []struct {
		name     string
		attended bool
		steps    []step
		want     int // flags left
	}{
		{"attended viewer: a new flag is seen at once", true, []step{watch, flag}, 0},
		{"away viewer: a new flag stays", false, []step{watch, flag}, 1},
		{"away viewer, user returns: seen", false, []step{watch, flag, attend}, 0},
		{"flag, viewer opens while attended: seen", true, []step{flag, watch}, 0},
		{"flag, viewer opens while away: stays", false, []step{flag, watch}, 1},
		{"flag, viewer opens while away, user returns: seen", false, []step{flag, watch, attend}, 0},
		{"flag, no viewer, user returns: stays", false, []step{flag, attend}, 1},
		{"flag, viewer closed before the user returns: stays", false, []step{flag, watch, unwatch, attend}, 1},
		{"attended viewer, user leaves, flag: stays", true, []step{watch, leave, flag}, 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, att := attendedEnv(t, tt.attended)
			s := e.stopped("flagged")
			cancel := func() {}
			for _, st := range tt.steps {
				switch st {
				case watch:
					cancel = openViewer(t, e, s.ID)
				case unwatch:
					cancel()
					deadline := time.Now().Add(5 * time.Second)
					for e.m.viewerCount(s.ID) > 0 {
						if time.Now().After(deadline) {
							t.Fatal("the viewer never left")
						}
						time.Sleep(5 * time.Millisecond)
					}
				case flag:
					if _, _, err := e.m.SetFlag(e.ctx(), s.ID, Flag{Source: "gh", Level: FlagAttention, Reason: "x", UntilSeen: true}); err != nil {
						t.Fatal(err)
					}
				case attend:
					setAttended(e, att, true)
				case leave:
					setAttended(e, att, false)
				}
			}
			got, err := e.m.Get(e.ctx(), s.ID)
			if err != nil {
				t.Fatal(err)
			}
			if len(got.Flags) != tt.want {
				t.Errorf("flags %v, want %d", flagSummary(got.Flags), tt.want)
			}
			// What the record says is what the database says.
			e.restart()
			if got, _ := e.m.Get(e.ctx(), s.ID); len(got.Flags) != tt.want {
				t.Errorf("after restart flags %v, want %d", flagSummary(got.Flags), tt.want)
			}
		})
	}
}
