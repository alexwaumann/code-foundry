package thread

import (
	"testing"
	"time"
)

func TestIsTimerWake(t *testing.T) {
	for json, want := range map[string]bool{
		`{"kind": "timer", "subscription_id": "sub-1"}`:            true,
		`{"kind": "thread", "thread": {"kind": "timer"}}`:          false,
		`{"kind": "batch", "wakes": [{"kind": "timer"}]}`:          false,
		`{"kind": "restart", "restarted_at": "2026-10-21T01:00Z"}`: false,
		"":        false,
		"{nope":   false,
		`"timer"`: false,
	} {
		if got := isTimerWake(json); got != want {
			t.Errorf("isTimerWake(%s) = %v, want %v", json, got, want)
		}
	}
}

// Which turns are a timer's: a message that starts a turn decides; one that joins a
// running turn can only make it one.
func TestNoteTurnMessage(t *testing.T) {
	timer := &outgoing{origin: OriginWake, wakeJSON: `{"kind": "timer"}`}
	child := &outgoing{origin: OriginWake, wakeJSON: `{"kind": "thread"}`}
	user := &outgoing{text: "hi"}
	tests := []struct {
		name    string
		before  bool
		newTurn bool
		o       *outgoing
		want    bool
	}{
		{"a timer starts a turn", false, true, timer, true},
		{"the user starts a turn after a timer's", true, true, user, false},
		{"a child's wake starts a turn after a timer's", true, true, child, false},
		{"a child's wake joins a timer's turn", true, false, child, true},
		{"a timer joins a child's turn", false, false, timer, true},
		{"the user joins a plain turn", false, false, user, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			s := e.stopped("p")
			e.m.mu.Lock()
			e.m.recs[s.ID].wait.reminder = tt.before
			e.m.mu.Unlock()
			e.m.noteTurnMessage(s.ID, tt.newTurn, tt.o)
			e.m.mu.Lock()
			got := e.m.recs[s.ID].wait.reminder
			e.m.mu.Unlock()
			if got != tt.want {
				t.Errorf("reminder = %v, want %v", got, tt.want)
			}
		})
	}
}

// e13-1: a turn a timer started ends needing attention though the thread still waits on
// a working child; a turn the user started waits as before.
func TestTimerTurnNeedsAttention(t *testing.T) {
	clk := newTestClock()
	e := newEnv(t, clk.opts(), timerOpts)
	p := e.stopped("orchestrator")
	child := e.stopped("worker")
	e.setStep(child.ID, busy)
	if _, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: p.ID, TargetThreadID: child.ID, Repeat: true}); err != nil {
		t.Fatal(err)
	}
	e.waitFor(p.ID, "waiting", func(s Thread) bool { return s.StatusReason == waitingReason(1) })
	if _, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: p.ID, TargetAt: clk.Now().Add(3 * time.Minute)}); err != nil {
		t.Fatal(err)
	}
	clk.advance(4 * time.Minute)
	e.waitItems(p.ID, "the timer's wake", func(items []Item) bool { return len(e.timerWakes(p.ID)) == 1 })
	e.waitFor(p.ID, "the reminder's turn ended needing attention", func(s Thread) bool {
		return s.Status == StatusNeedsAttention && s.StatusReason == "finished"
	})
	time.Sleep(50 * time.Millisecond)
	if got := e.snapshot(p.ID); got.Status != StatusNeedsAttention || got.StatusReason != "finished" {
		t.Fatalf("after the reminder's turn: %v %q", got.Status, got.StatusReason)
	}
	// The user's turn waits as before (a new process: the fake replays one turn each).
	if err := e.m.Close(e.ctx(), p.ID); err != nil {
		t.Fatal(err)
	}
	e.waitFor(p.ID, "stopped", stopped)
	if _, err := e.m.Send(e.ctx(), p.ID, Message{Text: "how is it going"}); err != nil {
		t.Fatal(err)
	}
	e.sentUser("how is it going")
	e.waitFor(p.ID, "waiting after the user's turn", func(s Thread) bool {
		return s.StatusReason == waitingReason(1) && s.State == StateConnected
	})
}

// The overlay leaves only the unseen end of a timer's turn: once seen ("at prompt") or
// for any other turn, it waits as ever.
func TestReminderShows(t *testing.T) {
	tests := []struct {
		name     string
		reminder bool
		raw      statusVal
		want     bool
	}{
		{"a timer's turn, unseen", true, statusVal{st: StatusNeedsAttention, reason: "finished"}, true},
		{"a timer's turn, seen", true, statusVal{st: StatusIdle, reason: "at prompt"}, false},
		{"a timer's turn, still working", true, statusVal{st: StatusBusy, reason: "working"}, false},
		{"another turn", false, statusVal{st: StatusNeedsAttention, reason: "finished"}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := &record{wait: waitState{reminder: tt.reminder}}
			if got := reminderShows(rec, tt.raw); got != tt.want {
				t.Errorf("reminderShows = %v, want %v", got, tt.want)
			}
		})
	}
}
